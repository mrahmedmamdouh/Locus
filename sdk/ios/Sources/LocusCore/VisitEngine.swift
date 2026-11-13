import Foundation

// Port of packages/altitude-core/src/visit.ts (the reference). Behaviour must match the shared
// vectors in sdk/spec/vectors/visit-engine.json; change the TypeScript first, then port.

public struct VenueBoundary: Codable, Equatable, Sendable {
    public var lat: Double
    public var lon: Double
    public var radiusM: Double

    public init(lat: Double, lon: Double, radiusM: Double) {
        self.lat = lat
        self.lon = lon
        self.radiusM = radiusM
    }
}

public struct EngineVenue: Codable, Equatable, Sendable {
    public var id: String
    public var floors: [Floor]
    public var entranceFloorIndex: Int?
    public var boundary: VenueBoundary

    public init(id: String, floors: [Floor], entranceFloorIndex: Int? = 0, boundary: VenueBoundary) {
        self.id = id
        self.floors = floors
        self.entranceFloorIndex = entranceFloorIndex
        self.boundary = boundary
    }

    /// The configured entrance floor if it is in the table, else the lowest floor ≥ 0.
    public var entranceFloor: Floor? {
        let want = entranceFloorIndex ?? 0
        if let exact = floors.first(where: { $0.index == want }) { return exact }
        let sorted = floors.sorted { $0.index < $1.index }
        return sorted.first(where: { $0.index >= 0 }) ?? sorted.first
    }
}

public struct EngineConfig: Codable, Equatable, Sendable {
    public var captureMs: Int64 = 3_000
    public var maxPendingMs: Int64 = 120_000
    public var reentryWindowMs: Int64 = 15 * 60_000
    public var suspectWindowMs: Int64 = 60 * 60_000
    public var floorDwellMs: Int64 = 10_000
    public var temperatureC: Double = 24
    public var driftAlpha: Double = 0.5
    public var driftWindowMs: Int64 = 8_000
    public var driftMaxRangeM: Double = 0.4

    public init() {}
}

public enum EngineInput: Equatable, Sendable {
    /// `crossing` false: the phone was found already inside (monitoring just started); the visit is mall-level only.
    case enter(tMs: Int64, venueId: String, accuracyM: Double?, crossing: Bool = true)
    case exit(tMs: Int64, venueId: String)
    case pressure(tMs: Int64, hPa: Double)
    /// The app was killed and relaunched: the engine is rebuilt from its own snapshot.
    case restart(tMs: Int64)
}

public enum IgnoreReason: String, Codable, Sendable {
    case unknownVenue = "unknown-venue"
    case poorAccuracy = "poor-accuracy"
    case alreadyInside = "already-inside"
}

public enum BaselineStatus: String, Codable, Sendable {
    case new
    case kept
    case unavailable
}

public enum EngineOutput: Equatable, Sendable {
    case arrived(tMs: Int64, venueId: String, resumed: Bool)
    case ignored(tMs: Int64, venueId: String, reason: IgnoreReason)
    case baseline(tMs: Int64, venueId: String, status: BaselineStatus, baselinePressureHpa: Double?, sampleCount: Int)
    case floor(tMs: Int64, venueId: String, floorIndex: Int)
    case left(tMs: Int64, venueId: String)
}

/// What the SDK persists so a relaunched app continues the same visit.
public struct VisitSnapshot: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Sendable {
        case capturing
        case active
        case noBaseline = "no-baseline"
    }

    public var venueId: String
    public var phase: Phase
    public var enteredAtMs: Int64
    public var exitedAtMs: Int64?
    public var baselineHpa: Double?
    public var driftOffsetM: Double
    public var emittedFloor: Int?
}

public final class VisitEngine {
    private final class Visit {
        let venue: EngineVenue
        var phase: VisitSnapshot.Phase
        let enteredAtMs: Int64
        var exitedAtMs: Int64?
        var captureStartMs: Int64?
        var samples: [Double] = []
        var baselineHpa: Double?
        var tracker: DriftTracker?
        var lastCorrectedM: Double?
        var emittedFloor: Int?
        var candidate: Int?
        var candidateSinceMs: Int64 = 0
        var previous: Visit?

        init(venue: EngineVenue, phase: VisitSnapshot.Phase, enteredAtMs: Int64) {
            self.venue = venue
            self.phase = phase
            self.enteredAtMs = enteredAtMs
        }
    }

    private var venues: [String: EngineVenue] = [:]
    public let config: EngineConfig
    private var visit: Visit?

    public init(venues: [EngineVenue], config: EngineConfig = EngineConfig()) {
        for v in venues { self.venues[v.id] = v }
        self.config = config
    }

    /// Replace the mall list (e.g. after a catalogue refresh). An open visit to a mall that is still listed continues.
    public func setVenues(_ list: [EngineVenue]) {
        let snap = snapshot()
        venues = [:]
        for v in list { venues[v.id] = v }
        restore(snap)
    }

    public var currentVenueId: String? {
        guard let v = visit, v.exitedAtMs == nil else { return nil }
        return v.venue.id
    }

    public var currentFloorIndex: Int? {
        guard let v = visit, v.exitedAtMs == nil else { return nil }
        return v.emittedFloor
    }

    @discardableResult
    public func handle(_ input: EngineInput) -> [EngineOutput] {
        var out: [EngineOutput] = []
        switch input {
        case let .enter(tMs, venueId, accuracyM, crossing): onEnter(tMs, venueId, accuracyM, crossing, &out)
        case let .exit(tMs, venueId): onExit(tMs, venueId, &out)
        case let .pressure(tMs, hPa): onPressure(tMs, hPa, &out)
        case .restart: restore(snapshot())
        }
        return out
    }

    public func snapshot() -> VisitSnapshot? {
        guard let v = visit else { return nil }
        return VisitSnapshot(
            venueId: v.venue.id,
            phase: v.phase,
            enteredAtMs: v.enteredAtMs,
            exitedAtMs: v.exitedAtMs,
            baselineHpa: v.baselineHpa,
            driftOffsetM: v.tracker?.offsetM ?? 0,
            emittedFloor: v.emittedFloor
        )
    }

    public func restore(_ s: VisitSnapshot?) {
        guard let s = s, let venue = venues[s.venueId] else {
            visit = nil
            return
        }
        let active = s.phase == .active && s.baselineHpa != nil
        let v = Visit(venue: venue, phase: active ? .active : (s.phase == .noBaseline ? .noBaseline : .capturing), enteredAtMs: s.enteredAtMs)
        v.exitedAtMs = s.exitedAtMs
        v.baselineHpa = active ? s.baselineHpa : nil
        v.tracker = active ? makeTracker(venue, initialOffsetM: s.driftOffsetM) : nil
        v.emittedFloor = active ? s.emittedFloor : nil
        v.candidate = active ? s.emittedFloor : nil
        v.candidateSinceMs = s.enteredAtMs
        visit = v
    }

    private func makeTracker(_ venue: EngineVenue, initialOffsetM: Double = 0) -> DriftTracker {
        DriftTracker(floors: venue.floors, alpha: config.driftAlpha, stationaryWindowMs: config.driftWindowMs, stationaryMaxRangeM: config.driftMaxRangeM, initialOffsetM: initialOffsetM)
    }

    private func onEnter(_ tMs: Int64, _ venueId: String, _ accuracyM: Double?, _ crossing: Bool, _ out: inout [EngineOutput]) {
        guard let venue = venues[venueId] else {
            out.append(.ignored(tMs: tMs, venueId: venueId, reason: .unknownVenue))
            return
        }
        if let acc = accuracyM, acc.isFinite, acc > venue.boundary.radiusM {
            out.append(.ignored(tMs: tMs, venueId: venueId, reason: .poorAccuracy))
            return
        }
        let v = visit
        if let v = v, v.venue.id == venue.id, v.exitedAtMs == nil {
            out.append(.ignored(tMs: tMs, venueId: venueId, reason: .alreadyInside))
            return
        }
        var previous: Visit?
        if let v = v, v.venue.id == venue.id, let exited = v.exitedAtMs {
            let gap = tMs - exited
            if gap >= 0 && gap <= config.reentryWindowMs {
                v.exitedAtMs = nil
                out.append(.arrived(tMs: tMs, venueId: venue.id, resumed: true))
                return
            }
            if gap >= 0 && gap <= config.suspectWindowMs && v.phase == .active { previous = v }
        }
        if let v = v, v.venue.id != venue.id, v.exitedAtMs == nil {
            out.append(.left(tMs: tMs, venueId: v.venue.id))
        }
        let nv = Visit(venue: venue, phase: crossing ? .capturing : .noBaseline, enteredAtMs: tMs)
        nv.previous = previous
        visit = nv
        out.append(.arrived(tMs: tMs, venueId: venue.id, resumed: false))
        if !crossing {
            out.append(.baseline(tMs: tMs, venueId: venue.id, status: .unavailable, baselinePressureHpa: nil, sampleCount: 0))
        }
    }

    private func onExit(_ tMs: Int64, _ venueId: String, _ out: inout [EngineOutput]) {
        guard let v = visit, v.venue.id == venueId, v.exitedAtMs == nil else { return }
        v.exitedAtMs = tMs
        out.append(.left(tMs: tMs, venueId: v.venue.id))
    }

    private func onPressure(_ tMs: Int64, _ hPa: Double, _ out: inout [EngineOutput]) {
        guard let v = visit, v.exitedAtMs == nil, hPa.isFinite, hPa > 0 else { return }
        if v.phase == .noBaseline { return }
        if v.phase == .capturing {
            if v.captureStartMs == nil {
                if tMs - v.enteredAtMs > config.maxPendingMs {
                    giveUpBaseline(v, tMs, &out)
                    return
                }
                v.captureStartMs = tMs
            }
            let elapsed = tMs - v.captureStartMs!
            if elapsed <= config.captureMs { v.samples.append(hPa) }
            if elapsed < config.captureMs { return }
            if !finishCapture(v, tMs, &out) { return }
        }
        track(visit!, tMs, hPa, &out)
    }

    private func giveUpBaseline(_ v: Visit, _ tMs: Int64, _ out: inout [EngineOutput]) {
        if v.previous != nil {
            restorePrevious(v, tMs, &out)
            return
        }
        v.phase = .noBaseline
        out.append(.baseline(tMs: tMs, venueId: v.venue.id, status: .unavailable, baselinePressureHpa: nil, sampleCount: 0))
    }

    private func restorePrevious(_ v: Visit, _ tMs: Int64, _ out: inout [EngineOutput]) {
        let prev = v.previous!
        prev.exitedAtMs = nil
        prev.previous = nil
        visit = prev
        out.append(.baseline(tMs: tMs, venueId: prev.venue.id, status: .kept, baselinePressureHpa: prev.baselineHpa, sampleCount: 0))
    }

    private func finishCapture(_ v: Visit, _ tMs: Int64, _ out: inout [EngineOutput]) -> Bool {
        guard let med = median(v.samples), let entrance = v.venue.entranceFloor else {
            giveUpBaseline(v, tMs, &out)
            return visit !== v && visit?.phase == .active
        }
        let entranceM = entrance.centerM
        if let prev = v.previous, let prevBaseline = prev.baselineHpa, let prevTracker = prev.tracker {
            let hByPrev = relativeAltitude(pressureHpa: med, baselinePressureHpa: prevBaseline, temperatureC: config.temperatureC) - prevTracker.offsetM
            if abs(hByPrev - entranceM) > (entrance.zMaxM - entrance.zMinM) / 2 {
                restorePrevious(v, tMs, &out)
                return true
            }
        }
        v.previous = nil
        let baseline = pressureAtTableZero(entrancePressureHpa: med, heightM: entranceM, temperatureC: config.temperatureC)
        v.baselineHpa = baseline
        v.tracker = makeTracker(v.venue)
        v.phase = .active
        v.emittedFloor = nil
        out.append(.baseline(tMs: tMs, venueId: v.venue.id, status: .new, baselinePressureHpa: baseline, sampleCount: v.samples.count))
        return true
    }

    private func track(_ v: Visit, _ tMs: Int64, _ hPa: Double, _ out: inout [EngineOutput]) {
        guard v.phase == .active, let baseline = v.baselineHpa, let tracker = v.tracker else { return }
        let raw = relativeAltitude(pressureHpa: hPa, baselinePressureHpa: baseline, temperatureC: config.temperatureC)
        let upd = tracker.update(tMs: tMs, relAltM: raw)
        v.lastCorrectedM = upd.correctedM
        let fi = upd.floorIndex
        guard let emitted = v.emittedFloor else {
            guard let fi = fi else { return }
            v.emittedFloor = fi
            v.candidate = fi
            v.candidateSinceMs = tMs
            out.append(.floor(tMs: tMs, venueId: v.venue.id, floorIndex: fi))
            return
        }
        if fi != v.candidate {
            v.candidate = fi
            v.candidateSinceMs = tMs
        }
        if let c = v.candidate, c != emitted, tMs - v.candidateSinceMs >= config.floorDwellMs {
            v.emittedFloor = c
            out.append(.floor(tMs: tMs, venueId: v.venue.id, floorIndex: c))
        }
    }
}
