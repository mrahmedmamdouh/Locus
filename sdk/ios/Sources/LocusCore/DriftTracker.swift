import Foundation

/// Port of packages/altitude-core/src/drift.ts: barometric drift correction by floor snapping
/// while the phone is stationary.
public final class DriftTracker {
    public struct Update: Equatable {
        public let correctedM: Double
        public let floorIndex: Int?
        public let offsetM: Double
        public let stationary: Bool
    }

    private struct Sample {
        let tMs: Int64
        let relAltM: Double
    }

    private let floors: [Floor]
    private let alpha: Double
    private let windowMs: Int64
    private let maxRange: Double
    private var buf: [Sample] = []
    private var lastUpdateMs: Int64?
    public private(set) var offsetM: Double

    public init(floors: [Floor], alpha: Double = 0.5, stationaryWindowMs: Int64 = 8000, stationaryMaxRangeM: Double = 0.4, initialOffsetM: Double = 0) {
        precondition(alpha > 0 && alpha <= 1, "alpha must be in (0, 1]")
        precondition(stationaryWindowMs > 0, "stationaryWindowMs must be > 0")
        precondition(stationaryMaxRangeM >= 0, "stationaryMaxRangeM must be >= 0")
        self.floors = floors
        self.alpha = alpha
        self.windowMs = stationaryWindowMs
        self.maxRange = stationaryMaxRangeM
        self.offsetM = initialOffsetM.isFinite ? initialOffsetM : 0
    }

    public func reset() {
        offsetM = 0
        buf = []
        lastUpdateMs = nil
    }

    private func nearestFloor(_ z: Double) -> Floor? {
        var best: Floor?
        var bestD = Double.infinity
        for f in floors {
            let d = abs(z - f.centerM)
            if d < bestD {
                bestD = d
                best = f
            }
        }
        return best
    }

    private func result(_ rawM: Double, _ stationary: Bool) -> Update {
        let corrected = rawM - offsetM
        return Update(correctedM: corrected, floorIndex: classifyFloor(corrected, floors)?.index, offsetM: offsetM, stationary: stationary)
    }

    public func update(tMs: Int64, relAltM: Double) -> Update {
        if !relAltM.isFinite {
            return Update(correctedM: .nan, floorIndex: nil, offsetM: offsetM, stationary: false)
        }
        if let prev = buf.last, tMs < prev.tMs || tMs - prev.tMs > windowMs { buf = [] }
        buf.append(Sample(tMs: tMs, relAltM: relAltM))
        let cutoff = tMs - windowMs
        while buf.count >= 2 && buf[1].tMs <= cutoff { buf.removeFirst() }

        let covered = buf[0].tMs <= cutoff
        var lo = Double.infinity
        var hi = -Double.infinity
        var sum = 0.0
        for s in buf {
            if s.relAltM < lo { lo = s.relAltM }
            if s.relAltM > hi { hi = s.relAltM }
            sum += s.relAltM
        }
        let stationary = covered && hi - lo <= maxRange

        if stationary && (lastUpdateMs == nil || tMs - lastUpdateMs! >= windowMs) {
            let corrected = sum / Double(buf.count) - offsetM
            if let f = nearestFloor(corrected) {
                let residual = corrected - f.centerM
                if abs(residual) < (f.zMaxM - f.zMinM) / 2 {
                    offsetM += alpha * residual
                    lastUpdateMs = tMs
                }
            }
        }
        return result(relAltM, stationary)
    }
}
