import Foundation
import XCTest
@testable import LocusCore

/// Replays sdk/spec/vectors/visit-engine.json (generated from the TypeScript reference) and checks
/// that the Swift engine produces exactly the same outputs.
final class VectorTests: XCTestCase {
    private static let vectorsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // LocusCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // sdk
        .appendingPathComponent("spec/vectors/visit-engine.json")

    private struct Doc: Decodable {
        let format: String
        let version: Int
        let config: Config
        let scenarios: [Scenario]
    }

    private struct Config: Decodable {
        let captureMs: Int64
        let maxPendingMs: Int64
        let reentryWindowMs: Int64
        let suspectWindowMs: Int64
        let floorDwellMs: Int64
        let temperatureC: Double
        let driftAlpha: Double
        let driftWindowMs: Int64
        let driftMaxRangeM: Double
    }

    private struct Scenario: Decodable {
        let name: String
        let venues: [EngineVenue]
        let inputs: [Event]
        let expected: [Event]
    }

    /// Inputs and outputs share one flat shape in the JSON.
    private struct Event: Decodable {
        let type: String
        let tMs: Int64
        let venueId: String?
        let accuracyM: Double?
        let crossing: Bool?
        let hPa: Double?
        let resumed: Bool?
        let reason: String?
        let status: String?
        let baselinePressureHpa: Double?
        let sampleCount: Int?
        let floorIndex: Int?
    }

    private func loadDoc() throws -> Doc {
        let data = try Data(contentsOf: Self.vectorsURL)
        return try JSONDecoder().decode(Doc.self, from: data)
    }

    private func input(_ e: Event) -> EngineInput {
        switch e.type {
        case "enter": return .enter(tMs: e.tMs, venueId: e.venueId!, accuracyM: e.accuracyM, crossing: e.crossing ?? true)
        case "exit": return .exit(tMs: e.tMs, venueId: e.venueId!)
        case "pressure": return .pressure(tMs: e.tMs, hPa: e.hPa!)
        case "restart": return .restart(tMs: e.tMs)
        default: fatalError("unknown input \(e.type)")
        }
    }

    private func describe(_ o: EngineOutput) -> String {
        switch o {
        case let .arrived(t, v, r): return "arrived \(t) \(v) resumed=\(r)"
        case let .ignored(t, v, r): return "ignored \(t) \(v) \(r.rawValue)"
        case let .baseline(t, v, s, _, n): return "baseline \(t) \(v) \(s.rawValue) n=\(n)"
        case let .floor(t, v, f): return "floor \(t) \(v) \(f)"
        case let .left(t, v): return "left \(t) \(v)"
        }
    }

    private func describe(_ e: Event) -> String {
        switch e.type {
        case "arrived": return "arrived \(e.tMs) \(e.venueId!) resumed=\(e.resumed!)"
        case "ignored": return "ignored \(e.tMs) \(e.venueId!) \(e.reason!)"
        case "baseline": return "baseline \(e.tMs) \(e.venueId!) \(e.status!) n=\(e.sampleCount!)"
        case "floor": return "floor \(e.tMs) \(e.venueId!) \(e.floorIndex!)"
        case "left": return "left \(e.tMs) \(e.venueId!)"
        default: return "unknown \(e.type)"
        }
    }

    func testAllScenariosMatchTheReference() throws {
        let doc = try loadDoc()
        XCTAssertEqual(doc.format, "locus-visit-engine-vectors")
        XCTAssertEqual(doc.version, 1)
        var config = EngineConfig()
        XCTAssertEqual(config.captureMs, doc.config.captureMs)
        XCTAssertEqual(config.maxPendingMs, doc.config.maxPendingMs)
        XCTAssertEqual(config.reentryWindowMs, doc.config.reentryWindowMs)
        XCTAssertEqual(config.suspectWindowMs, doc.config.suspectWindowMs)
        XCTAssertEqual(config.floorDwellMs, doc.config.floorDwellMs)
        XCTAssertEqual(config.temperatureC, doc.config.temperatureC)
        XCTAssertEqual(config.driftAlpha, doc.config.driftAlpha)
        XCTAssertEqual(config.driftWindowMs, doc.config.driftWindowMs)
        XCTAssertEqual(config.driftMaxRangeM, doc.config.driftMaxRangeM)
        config = EngineConfig()
        XCTAssertGreaterThanOrEqual(doc.scenarios.count, 17)

        for s in doc.scenarios {
            let engine = VisitEngine(venues: s.venues, config: config)
            let got = s.inputs.flatMap { engine.handle(input($0)) }
            XCTAssertEqual(got.map(describe), s.expected.map(describe), "scenario \(s.name)")
            for (g, e) in zip(got, s.expected) {
                if case let .baseline(_, _, _, p, _) = g {
                    if let want = e.baselinePressureHpa {
                        XCTAssertEqual(p ?? .nan, want, accuracy: 1e-6, "baseline pressure in \(s.name)")
                    } else {
                        XCTAssertNil(p, "baseline pressure in \(s.name)")
                    }
                }
            }
        }
    }

    func testSnapshotRoundTripsThroughJSON() throws {
        let doc = try loadDoc()
        let s = try XCTUnwrap(doc.scenarios.first { $0.name == "drift-is-corrected-while-standing" })
        let a = VisitEngine(venues: s.venues)
        s.inputs.forEach { a.handle(input($0)) }
        let data = try JSONEncoder().encode(a.snapshot())
        let b = VisitEngine(venues: s.venues)
        b.restore(try JSONDecoder().decode(VisitSnapshot?.self, from: data))
        XCTAssertEqual(b.snapshot(), a.snapshot())
        XCTAssertEqual(b.currentFloorIndex, 1)
        XCTAssertGreaterThan(a.snapshot()?.driftOffsetM ?? 0, 1)
    }

    func testClassifyFloorEdges() {
        let floors = [Floor(label: "G", index: 0, zMinM: -2.875, zMaxM: 2.875), Floor(label: "1", index: 1, zMinM: 2.875, zMaxM: 8.625)]
        XCTAssertEqual(classifyFloor(2.875, floors)?.index, 1)
        XCTAssertEqual(classifyFloor(-5.7, floors)?.index, 0)
        XCTAssertNil(classifyFloor(-5.8, floors))
        XCTAssertNil(classifyFloor(11.5, floors))
        XCTAssertNil(classifyFloor(.nan, floors))
    }
}
