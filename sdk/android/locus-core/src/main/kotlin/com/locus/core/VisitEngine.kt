package com.locus.core

import kotlin.math.abs

// Port of packages/altitude-core/src/visit.ts (the reference). Behaviour must match the shared
// vectors in sdk/spec/vectors/visit-engine.json; change the TypeScript first, then port.

data class VenueBoundary(val lat: Double, val lon: Double, val radiusM: Double)

data class EngineVenue(
    val id: String,
    val floors: List<Floor>,
    val entranceFloorIndex: Int? = 0,
    val boundary: VenueBoundary,
) {
    /** The configured entrance floor if it is in the table, else the lowest floor ≥ 0. */
    val entranceFloor: Floor?
        get() {
            val want = entranceFloorIndex ?: 0
            floors.firstOrNull { it.index == want }?.let { return it }
            val sorted = floors.sortedBy { it.index }
            return sorted.firstOrNull { it.index >= 0 } ?: sorted.firstOrNull()
        }
}

data class EngineConfig(
    val captureMs: Long = 3_000,
    val maxPendingMs: Long = 120_000,
    val reentryWindowMs: Long = 15 * 60_000,
    val suspectWindowMs: Long = 60 * 60_000,
    val floorDwellMs: Long = 10_000,
    val temperatureC: Double = 24.0,
    val driftAlpha: Double = 0.5,
    val driftWindowMs: Long = 8_000,
    val driftMaxRangeM: Double = 0.4,
)

sealed class EngineInput {
    abstract val tMs: Long

    /** [crossing] false: the phone was found already inside (monitoring just started); the visit is mall-level only. */
    data class Enter(override val tMs: Long, val venueId: String, val accuracyM: Double?, val crossing: Boolean = true) : EngineInput()
    data class Exit(override val tMs: Long, val venueId: String) : EngineInput()
    data class Pressure(override val tMs: Long, val hPa: Double) : EngineInput()

    /** The app was killed and relaunched: the engine is rebuilt from its own snapshot. */
    data class Restart(override val tMs: Long) : EngineInput()
}

enum class IgnoreReason(val wire: String) { UNKNOWN_VENUE("unknown-venue"), POOR_ACCURACY("poor-accuracy"), ALREADY_INSIDE("already-inside") }

enum class BaselineStatus(val wire: String) { NEW("new"), KEPT("kept"), UNAVAILABLE("unavailable") }

sealed class EngineOutput {
    abstract val tMs: Long
    abstract val venueId: String

    data class Arrived(override val tMs: Long, override val venueId: String, val resumed: Boolean) : EngineOutput()
    data class Ignored(override val tMs: Long, override val venueId: String, val reason: IgnoreReason) : EngineOutput()
    data class Baseline(
        override val tMs: Long,
        override val venueId: String,
        val status: BaselineStatus,
        val baselinePressureHpa: Double?,
        val sampleCount: Int,
    ) : EngineOutput()
    data class FloorChanged(override val tMs: Long, override val venueId: String, val floorIndex: Int) : EngineOutput()
    data class Left(override val tMs: Long, override val venueId: String) : EngineOutput()
}

/** What the SDK persists so a relaunched app continues the same visit. */
data class VisitSnapshot(
    val venueId: String,
    val phase: Phase,
    val enteredAtMs: Long,
    val exitedAtMs: Long?,
    val baselineHpa: Double?,
    val driftOffsetM: Double,
    val emittedFloor: Int?,
) {
    enum class Phase(val wire: String) {
        CAPTURING("capturing"), ACTIVE("active"), NO_BASELINE("no-baseline");

        companion object {
            fun fromWire(s: String): Phase = entries.first { it.wire == s }
        }
    }
}

class VisitEngine(venues: List<EngineVenue>, val config: EngineConfig = EngineConfig()) {
    private class Visit(val venue: EngineVenue, var phase: VisitSnapshot.Phase, val enteredAtMs: Long) {
        var exitedAtMs: Long? = null
        var captureStartMs: Long? = null
        val samples = mutableListOf<Double>()
        var baselineHpa: Double? = null
        var tracker: DriftTracker? = null
        var lastCorrectedM: Double? = null
        var emittedFloor: Int? = null
        var candidate: Int? = null
        var candidateSinceMs: Long = 0
        var previous: Visit? = null
    }

    private var venues: Map<String, EngineVenue> = venues.associateBy { it.id }
    private var visit: Visit? = null

    /** Replace the mall list (e.g. after a catalogue refresh). An open visit to a mall that is still listed continues. */
    fun setVenues(list: List<EngineVenue>) {
        val snap = snapshot()
        venues = list.associateBy { it.id }
        restore(snap)
    }

    val currentVenueId: String?
        get() = visit?.takeIf { it.exitedAtMs == null }?.venue?.id

    val currentFloorIndex: Int?
        get() = visit?.takeIf { it.exitedAtMs == null }?.emittedFloor

    fun handle(input: EngineInput): List<EngineOutput> {
        val out = mutableListOf<EngineOutput>()
        when (input) {
            is EngineInput.Enter -> onEnter(input, out)
            is EngineInput.Exit -> onExit(input, out)
            is EngineInput.Pressure -> onPressure(input.tMs, input.hPa, out)
            is EngineInput.Restart -> restore(snapshot())
        }
        return out
    }

    fun snapshot(): VisitSnapshot? {
        val v = visit ?: return null
        return VisitSnapshot(v.venue.id, v.phase, v.enteredAtMs, v.exitedAtMs, v.baselineHpa, v.tracker?.offsetM ?: 0.0, v.emittedFloor)
    }

    fun restore(s: VisitSnapshot?) {
        val venue = s?.let { venues[it.venueId] }
        if (s == null || venue == null) {
            visit = null
            return
        }
        val active = s.phase == VisitSnapshot.Phase.ACTIVE && s.baselineHpa != null
        val phase = when {
            active -> VisitSnapshot.Phase.ACTIVE
            s.phase == VisitSnapshot.Phase.NO_BASELINE -> VisitSnapshot.Phase.NO_BASELINE
            else -> VisitSnapshot.Phase.CAPTURING
        }
        visit = Visit(venue, phase, s.enteredAtMs).apply {
            exitedAtMs = s.exitedAtMs
            baselineHpa = if (active) s.baselineHpa else null
            tracker = if (active) makeTracker(venue, s.driftOffsetM) else null
            emittedFloor = if (active) s.emittedFloor else null
            candidate = if (active) s.emittedFloor else null
            candidateSinceMs = s.enteredAtMs
        }
    }

    private fun makeTracker(venue: EngineVenue, initialOffsetM: Double = 0.0) =
        DriftTracker(venue.floors, config.driftAlpha, config.driftWindowMs, config.driftMaxRangeM, initialOffsetM)

    private fun onEnter(e: EngineInput.Enter, out: MutableList<EngineOutput>) {
        val venue = venues[e.venueId]
        if (venue == null) {
            out += EngineOutput.Ignored(e.tMs, e.venueId, IgnoreReason.UNKNOWN_VENUE)
            return
        }
        val acc = e.accuracyM
        if (acc != null && acc.isFinite() && acc > venue.boundary.radiusM) {
            out += EngineOutput.Ignored(e.tMs, e.venueId, IgnoreReason.POOR_ACCURACY)
            return
        }
        val v = visit
        if (v != null && v.venue.id == venue.id && v.exitedAtMs == null) {
            out += EngineOutput.Ignored(e.tMs, e.venueId, IgnoreReason.ALREADY_INSIDE)
            return
        }
        var previous: Visit? = null
        val exited = v?.exitedAtMs
        if (v != null && v.venue.id == venue.id && exited != null) {
            val gap = e.tMs - exited
            if (gap >= 0 && gap <= config.reentryWindowMs) {
                v.exitedAtMs = null
                out += EngineOutput.Arrived(e.tMs, venue.id, resumed = true)
                return
            }
            if (gap >= 0 && gap <= config.suspectWindowMs && v.phase == VisitSnapshot.Phase.ACTIVE) previous = v
        }
        if (v != null && v.venue.id != venue.id && v.exitedAtMs == null) {
            out += EngineOutput.Left(e.tMs, v.venue.id)
        }
        visit = Visit(venue, if (e.crossing) VisitSnapshot.Phase.CAPTURING else VisitSnapshot.Phase.NO_BASELINE, e.tMs).also { it.previous = previous }
        out += EngineOutput.Arrived(e.tMs, venue.id, resumed = false)
        if (!e.crossing) out += EngineOutput.Baseline(e.tMs, venue.id, BaselineStatus.UNAVAILABLE, null, 0)
    }

    private fun onExit(e: EngineInput.Exit, out: MutableList<EngineOutput>) {
        val v = visit ?: return
        if (v.venue.id != e.venueId || v.exitedAtMs != null) return
        v.exitedAtMs = e.tMs
        out += EngineOutput.Left(e.tMs, v.venue.id)
    }

    private fun onPressure(tMs: Long, hPa: Double, out: MutableList<EngineOutput>) {
        val v = visit ?: return
        if (v.exitedAtMs != null || !hPa.isFinite() || hPa <= 0) return
        if (v.phase == VisitSnapshot.Phase.NO_BASELINE) return
        if (v.phase == VisitSnapshot.Phase.CAPTURING) {
            if (v.captureStartMs == null) {
                if (tMs - v.enteredAtMs > config.maxPendingMs) {
                    giveUpBaseline(v, tMs, out)
                    return
                }
                v.captureStartMs = tMs
            }
            val elapsed = tMs - v.captureStartMs!!
            if (elapsed <= config.captureMs) v.samples += hPa
            if (elapsed < config.captureMs) return
            if (!finishCapture(v, tMs, out)) return
        }
        track(visit!!, tMs, hPa, out)
    }

    private fun giveUpBaseline(v: Visit, tMs: Long, out: MutableList<EngineOutput>) {
        if (v.previous != null) {
            restorePrevious(v, tMs, out)
            return
        }
        v.phase = VisitSnapshot.Phase.NO_BASELINE
        out += EngineOutput.Baseline(tMs, v.venue.id, BaselineStatus.UNAVAILABLE, null, 0)
    }

    private fun restorePrevious(v: Visit, tMs: Long, out: MutableList<EngineOutput>) {
        val prev = v.previous!!
        prev.exitedAtMs = null
        prev.previous = null
        visit = prev
        out += EngineOutput.Baseline(tMs, prev.venue.id, BaselineStatus.KEPT, prev.baselineHpa, 0)
    }

    private fun finishCapture(v: Visit, tMs: Long, out: MutableList<EngineOutput>): Boolean {
        val med = median(v.samples)
        val entrance = v.venue.entranceFloor
        if (med == null || entrance == null) {
            giveUpBaseline(v, tMs, out)
            return visit !== v && visit?.phase == VisitSnapshot.Phase.ACTIVE
        }
        val entranceM = entrance.centerM
        val prev = v.previous
        val prevBaseline = prev?.baselineHpa
        val prevTracker = prev?.tracker
        if (prev != null && prevBaseline != null && prevTracker != null) {
            val hByPrev = relativeAltitude(med, prevBaseline, config.temperatureC) - prevTracker.offsetM
            if (abs(hByPrev - entranceM) > (entrance.zMaxM - entrance.zMinM) / 2) {
                restorePrevious(v, tMs, out)
                return true
            }
        }
        v.previous = null
        val baseline = pressureAtTableZero(med, entranceM, config.temperatureC)
        v.baselineHpa = baseline
        v.tracker = makeTracker(v.venue)
        v.phase = VisitSnapshot.Phase.ACTIVE
        v.emittedFloor = null
        out += EngineOutput.Baseline(tMs, v.venue.id, BaselineStatus.NEW, baseline, v.samples.size)
        return true
    }

    private fun track(v: Visit, tMs: Long, hPa: Double, out: MutableList<EngineOutput>) {
        val baseline = v.baselineHpa
        val tracker = v.tracker
        if (v.phase != VisitSnapshot.Phase.ACTIVE || baseline == null || tracker == null) return
        val raw = relativeAltitude(hPa, baseline, config.temperatureC)
        val upd = tracker.update(tMs, raw)
        v.lastCorrectedM = upd.correctedM
        val fi = upd.floorIndex
        val emitted = v.emittedFloor
        if (emitted == null) {
            if (fi == null) return
            v.emittedFloor = fi
            v.candidate = fi
            v.candidateSinceMs = tMs
            out += EngineOutput.FloorChanged(tMs, v.venue.id, fi)
            return
        }
        if (fi != v.candidate) {
            v.candidate = fi
            v.candidateSinceMs = tMs
        }
        val c = v.candidate
        if (c != null && c != emitted && tMs - v.candidateSinceMs >= config.floorDwellMs) {
            v.emittedFloor = c
            out += EngineOutput.FloorChanged(tMs, v.venue.id, c)
        }
    }
}
