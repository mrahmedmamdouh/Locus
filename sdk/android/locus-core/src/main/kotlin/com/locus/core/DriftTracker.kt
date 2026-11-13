package com.locus.core

import kotlin.math.abs

/** Port of packages/altitude-core/src/drift.ts: drift correction by floor snapping while stationary. */
class DriftTracker(
    private val floors: List<Floor>,
    private val alpha: Double = 0.5,
    private val windowMs: Long = 8000,
    private val maxRange: Double = 0.4,
    initialOffsetM: Double = 0.0,
) {
    data class Update(val correctedM: Double, val floorIndex: Int?, val offsetM: Double, val stationary: Boolean)

    private data class Sample(val tMs: Long, val relAltM: Double)

    private val buf = ArrayDeque<Sample>()
    private var lastUpdateMs: Long? = null
    var offsetM: Double = if (initialOffsetM.isFinite()) initialOffsetM else 0.0
        private set

    init {
        require(alpha > 0 && alpha <= 1) { "alpha must be in (0, 1]" }
        require(windowMs > 0) { "windowMs must be > 0" }
        require(maxRange >= 0) { "maxRange must be >= 0" }
    }

    fun reset() {
        offsetM = 0.0
        buf.clear()
        lastUpdateMs = null
    }

    private fun nearestFloor(z: Double): Floor? {
        var best: Floor? = null
        var bestD = Double.POSITIVE_INFINITY
        for (f in floors) {
            val d = abs(z - f.centerM)
            if (d < bestD) {
                bestD = d
                best = f
            }
        }
        return best
    }

    private fun result(rawM: Double, stationary: Boolean): Update {
        val corrected = rawM - offsetM
        return Update(corrected, classifyFloor(corrected, floors)?.index, offsetM, stationary)
    }

    fun update(tMs: Long, relAltM: Double): Update {
        if (!relAltM.isFinite()) return Update(Double.NaN, null, offsetM, false)
        val prev = buf.lastOrNull()
        if (prev != null && (tMs < prev.tMs || tMs - prev.tMs > windowMs)) buf.clear()
        buf.addLast(Sample(tMs, relAltM))
        val cutoff = tMs - windowMs
        while (buf.size >= 2 && buf[1].tMs <= cutoff) buf.removeFirst()

        val covered = buf[0].tMs <= cutoff
        var lo = Double.POSITIVE_INFINITY
        var hi = Double.NEGATIVE_INFINITY
        var sum = 0.0
        for (s in buf) {
            if (s.relAltM < lo) lo = s.relAltM
            if (s.relAltM > hi) hi = s.relAltM
            sum += s.relAltM
        }
        val stationary = covered && hi - lo <= maxRange

        val last = lastUpdateMs
        if (stationary && (last == null || tMs - last >= windowMs)) {
            val corrected = sum / buf.size - offsetM
            val f = nearestFloor(corrected)
            if (f != null) {
                val residual = corrected - f.centerM
                if (abs(residual) < (f.zMaxM - f.zMinM) / 2) {
                    offsetM += alpha * residual
                    lastUpdateMs = tMs
                }
            }
        }
        return result(relAltM, stationary)
    }
}
