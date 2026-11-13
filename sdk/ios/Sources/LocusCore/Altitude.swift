import Foundation

// Port of packages/altitude-core/src/{pressure,floors,smoothing}.ts. Keep the arithmetic in the
// same order as the TypeScript reference so the shared vectors match.

/// Specific gas constant for dry air, J/(kg·K).
public let rDryAir = 287.053
/// Standard gravity, m/s².
public let g0 = 9.80665

/// One floor of a mall as a vertical band, metres relative to height 0 of the floor table.
public struct Floor: Codable, Equatable, Sendable {
    public var label: String
    public var index: Int
    public var zMinM: Double
    public var zMaxM: Double

    public init(label: String, index: Int, zMinM: Double, zMaxM: Double) {
        self.label = label
        self.index = index
        self.zMinM = zMinM
        self.zMaxM = zMaxM
    }

    public var centerM: Double { (zMinM + zMaxM) / 2 }
}

/// Height of `pressureHpa` above the point where `baselinePressureHpa` was measured (hypsometric equation).
public func relativeAltitude(pressureHpa: Double, baselinePressureHpa: Double, temperatureC: Double) -> Double {
    let tK = temperatureC + 273.15
    return ((rDryAir * tK) / g0) * log(baselinePressureHpa / pressureHpa)
}

/// Pressure at height 0 of the floor table, from the pressure measured at height `heightM`.
public func pressureAtTableZero(entrancePressureHpa: Double, heightM: Double, temperatureC: Double) -> Double {
    let scale = (rDryAir * (temperatureC + 273.15)) / g0
    return entrancePressureHpa * exp(heightM / scale)
}

public func median(_ values: [Double]) -> Double? {
    let v = values.filter { $0.isFinite }.sorted()
    if v.isEmpty { return nil }
    let mid = v.count / 2
    return v.count % 2 == 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/// The floor whose band contains the height; in a gap, the nearest centre; nil when more than
/// half a floor beyond the lowest or highest band.
public func classifyFloor(_ relAltM: Double, _ floors: [Floor]) -> Floor? {
    if !relAltM.isFinite || floors.isEmpty { return nil }
    if let inside = floors.first(where: { relAltM >= $0.zMinM && relAltM < $0.zMaxM }) { return inside }
    var lowest = floors[0]
    var highest = floors[0]
    for f in floors {
        if f.zMinM < lowest.zMinM { lowest = f }
        if f.zMaxM > highest.zMaxM { highest = f }
    }
    if relAltM >= highest.zMaxM + (highest.zMaxM - highest.zMinM) / 2 { return nil }
    if relAltM < lowest.zMinM - (lowest.zMaxM - lowest.zMinM) / 2 { return nil }
    var best: Floor?
    var bestDist = Double.infinity
    for f in floors {
        let d = abs(relAltM - f.centerM)
        if d < bestDist {
            bestDist = d
            best = f
        }
    }
    return best
}
