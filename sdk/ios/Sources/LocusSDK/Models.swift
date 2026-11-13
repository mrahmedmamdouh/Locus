import Foundation
import LocusCore

/// A mall from the Locus catalogue (served by GET /v1/sdk/malls).
public struct LocusMall: Codable, Equatable, Sendable {
    public struct FloorInfo: Codable, Equatable, Sendable {
        public let index: Int
        public let label: String
        public let zMinM: Double
        public let zMaxM: Double
    }

    public let id: String
    public let name: String
    public let city: String
    public let country: String
    public let boundary: VenueBoundary
    public let entranceFloorIndex: Int
    public let floors: [FloorInfo]

    public func floor(_ index: Int?) -> FloorInfo? {
        guard let index = index else { return nil }
        return floors.first { $0.index == index }
    }

    var engineVenue: EngineVenue {
        EngineVenue(
            id: id,
            floors: floors.map { Floor(label: $0.label, index: $0.index, zMinM: $0.zMinM, zMaxM: $0.zMaxM) },
            entranceFloorIndex: entranceFloorIndex,
            boundary: boundary
        )
    }
}

/// Where the shopper is: a mall and, when the phone can tell, a floor.
public struct LocusPlace: Equatable, Sendable {
    public let mall: LocusMall
    /// Nil when the floor is unknown (no baseline yet, or the visit is mall-level only).
    public let floor: LocusMall.FloorInfo?
}

/// An offer from the bank's own catalogue, ranked for this shopper by the Locus API.
public struct LocusOffer: Codable, Equatable, Sendable {
    public struct Merchant: Codable, Equatable, Sendable {
        public let id: String
        public let name: String?
    }

    public let id: String
    public let merchant: Merchant
    public let floorIndex: Int?
    public let floorLabel: String?
    public let storeName: String?
    public let title: String
    public let body: String
    public let ctaUrl: String?
    public let endsAt: String
}

/// One result the SDK reports. Never coordinates.
public struct LocusEvent: Codable, Equatable, Sendable {
    public let type: String
    public let mallId: String
    public let floorIndex: Int?
    public let offerId: String?
    public let t: String

    public init(type: String, mallId: String, floorIndex: Int? = nil, offerId: String? = nil, t: Date = Date()) {
        self.type = type
        self.mallId = mallId
        self.floorIndex = floorIndex
        self.offerId = offerId
        self.t = LocusEvent.iso.string(from: t)
    }

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

public struct LocusOffersResponse: Codable, Equatable, Sendable {
    public let mallId: String
    public let floorIndex: Int?
    public let offers: [LocusOffer]
    /// The one offer to show now, or nil (none, already notified on this floor, or daily caps reached).
    public let push: LocusOffer?
    public let reason: String
}

struct MallsResponse: Codable {
    let malls: [LocusMall]
    let refreshAfterSeconds: Int
}
