import Foundation
import XCTest
@testable import LocusSDK

/// Stubs URLSession so the client can be tested on macOS without a server.
final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            stream.close()
            StubProtocol.lastBody = data
        } else {
            StubProtocol.lastBody = request.httpBody
        }
        let (status, body) = StubProtocol.handler?(request) ?? (500, Data())
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    private func client() -> LocusAPIClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubProtocol.self]
        return LocusAPIClient(baseURL: URL(string: "https://api.example/")!, publishableKey: "lk_pub_test", session: URLSession(configuration: cfg))
    }

    func testMallsSendsKeyAndRoughPosition() {
        var seen: URLRequest?
        StubProtocol.handler = { req in
            seen = req
            let json = #"{"malls":[{"id":"mall-of-oman","name":"Mall of Oman","city":"Muscat","country":"OM","status":"pilot","boundary":{"lat":23.5718,"lon":58.4045,"radiusM":400},"entranceFloorIndex":0,"floors":[{"index":0,"label":"Level 1","zMinM":-2.875,"zMaxM":2.875}],"updatedAt":"x"}],"refreshAfterSeconds":86400}"#
            return (200, Data(json.utf8))
        }
        let done = expectation(description: "malls")
        client().malls(nearLat: 23.571234, lon: 58.404567, limit: 15) { result in
            let malls = try? result.get().malls
            XCTAssertEqual(malls?.first?.engineVenue.floors.first?.label, "Level 1")
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(seen?.value(forHTTPHeaderField: "Authorization"), "Bearer lk_pub_test")
        let q = URLComponents(url: seen!.url!, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(q.first { $0.name == "lat" }?.value, "23.57")
        XCTAssertEqual(q.first { $0.name == "lon" }?.value, "58.40")
        XCTAssertEqual(seen?.url?.path, "/v1/sdk/malls")
    }

    func testOffersSendsExplicitNullFloorAndDecodesPush() {
        StubProtocol.handler = { _ in
            let json = #"{"mallId":"mall-of-oman","floorIndex":null,"offers":[{"id":"o1","merchant":{"id":"m1","name":"Costa"},"floorIndex":null,"floorLabel":null,"storeName":null,"title":"20% off","body":"","ctaUrl":null,"endsAt":"2026-12-31T00:00:00.000Z"}],"push":{"id":"o1","merchant":{"id":"m1","name":"Costa"},"floorIndex":null,"floorLabel":null,"storeName":null,"title":"20% off","body":"","ctaUrl":null,"endsAt":"2026-12-31T00:00:00.000Z"},"delivery":"sdk","reason":"ok","language":"ar"}"#
            return (200, Data(json.utf8))
        }
        let done = expectation(description: "offers")
        let q = LocusAPIClient.OffersQuery(installId: "install-0001", mallId: "mall-of-oman", floorIndex: nil, customerRef: "cust-7f3a", segments: ["visa-infinite"], locale: "ar")
        client().offers(q) { result in
            XCTAssertEqual(try? result.get().push?.id, "o1")
            XCTAssertEqual(try? result.get().delivery, "sdk")
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        let body = try! JSONSerialization.jsonObject(with: StubProtocol.lastBody!) as! [String: Any]
        XCTAssertTrue(body["floorIndex"] is NSNull)
        XCTAssertEqual(body["installId"] as? String, "install-0001")
        XCTAssertEqual(body["customerRef"] as? String, "cust-7f3a")
        XCTAssertEqual(body["segments"] as? [String], ["visa-infinite"])
        XCTAssertEqual(body["locale"] as? String, "ar")
        XCTAssertEqual(body["platform"] as? String, "ios")
    }

    func testErrorsCarryTheApiMessage() {
        StubProtocol.handler = { _ in (401, Data(#"{"error":{"code":"unauthorized","message":"Unknown or revoked key."}}"#.utf8)) }
        let done = expectation(description: "events")
        client().send(events: [LocusEvent(type: "arrived", mallId: "mall-of-oman")], installId: "install-0001", platform: "ios") { result in
            if case let .failure(.http(status, code, _)) = result {
                XCTAssertEqual(status, 401)
                XCTAssertEqual(code, "unauthorized")
            } else {
                XCTFail("expected an http error")
            }
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
    }

    func testPrivacyManifestShipsWithTheSDK() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/LocusSDK/PrivacyInfo.xcprivacy")
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as! [String: Any]
        XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false)
        let types = (plist["NSPrivacyCollectedDataTypes"] as! [[String: Any]]).map { $0["NSPrivacyCollectedDataType"] as! String }
        XCTAssertTrue(types.contains("NSPrivacyCollectedDataTypeCoarseLocation"))
        XCTAssertFalse(types.contains("NSPrivacyCollectedDataTypePreciseLocation"))
    }

    func testEventsNeverContainCoordinates() throws {
        let data = try JSONEncoder().encode(LocusEvent(type: "floor", mallId: "mall-of-oman", floorIndex: 1))
        let keys = Set((try JSONSerialization.jsonObject(with: data) as! [String: Any]).keys)
        XCTAssertEqual(keys, ["type", "mallId", "floorIndex", "t"])
    }
}
