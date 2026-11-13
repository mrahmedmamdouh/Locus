import Foundation

public enum LocusError: Error, Equatable {
    case notConfigured
    case http(status: Int, code: String?, message: String?)
    case transport(String)
    case decoding(String)
}

/// Thin client for the Locus SDK routes. Completion handlers run on the main queue.
public final class LocusAPIClient {
    public let baseURL: URL
    private let key: String
    private let session: URLSession

    public init(baseURL: URL, publishableKey: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.key = publishableKey
        self.session = session
    }

    private struct ErrorBody: Decodable {
        struct E: Decodable { let code: String?; let message: String? }
        let error: E
    }

    private func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, completion: @escaping (Result<T, LocusError>) -> Void) {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!, timeoutInterval: 15)
        req.httpMethod = method
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        if let body = body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let done = { (r: Result<T, LocusError>) in DispatchQueue.main.async { completion(r) } }
        session.dataTask(with: req) { data, response, error in
            if let error = error { return done(.failure(.transport(error.localizedDescription))) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let data = data ?? Data()
            guard (200..<300).contains(status) else {
                let e = try? JSONDecoder().decode(ErrorBody.self, from: data)
                return done(.failure(.http(status: status, code: e?.error.code, message: e?.error.message)))
            }
            do {
                done(.success(try JSONDecoder().decode(T.self, from: data)))
            } catch {
                done(.failure(.decoding(String(describing: error))))
            }
        }.resume()
    }

    /// Pilot malls, nearest first. Pass a rough position only (2 decimals ≈ 1 km).
    func malls(nearLat lat: Double?, lon: Double?, limit: Int, completion: @escaping (Result<MallsResponse, LocusError>) -> Void) {
        var q = [URLQueryItem(name: "limit", value: String(limit))]
        if let lat = lat, let lon = lon {
            q.append(URLQueryItem(name: "lat", value: String(format: "%.2f", lat)))
            q.append(URLQueryItem(name: "lon", value: String(format: "%.2f", lon)))
        }
        request("GET", "v1/sdk/malls", query: q, completion: completion)
    }

    func offers(installId: String, mallId: String, floorIndex: Int?, completion: @escaping (Result<LocusOffersResponse, LocusError>) -> Void) {
        struct Body: Encodable {
            let installId: String
            let mallId: String
            let floorIndex: Int?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(installId, forKey: .installId)
                try c.encode(mallId, forKey: .mallId)
                try c.encode(floorIndex, forKey: .floorIndex) // explicit null = floor unknown
            }
            enum CodingKeys: String, CodingKey { case installId, mallId, floorIndex }
        }
        let body = try? JSONEncoder().encode(Body(installId: installId, mallId: mallId, floorIndex: floorIndex))
        request("POST", "v1/sdk/offers", body: body, completion: completion)
    }

    func send(events: [LocusEvent], installId: String, platform: String, completion: @escaping (Result<Void, LocusError>) -> Void) {
        struct Body: Encodable { let installId: String; let platform: String; let events: [LocusEvent] }
        struct Accepted: Decodable { let accepted: Int }
        let body = try? JSONEncoder().encode(Body(installId: installId, platform: platform, events: events))
        request("POST", "v1/sdk/events", body: body) { (r: Result<Accepted, LocusError>) in completion(r.map { _ in () }) }
    }
}
