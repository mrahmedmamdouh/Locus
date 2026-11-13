import Foundation
import LocusCore

/// What the SDK keeps on the device (UserDefaults suite "com.locus.sdk"): a random install id,
/// the mall list, the visit snapshot and unsent events. No location history.
final class LocusStore {
    private let defaults: UserDefaults
    static let maxQueuedEvents = 500

    init(defaults: UserDefaults? = UserDefaults(suiteName: "com.locus.sdk")) {
        self.defaults = defaults ?? .standard
    }

    var installId: String {
        if let id = defaults.string(forKey: "installId") { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: "installId")
        return id
    }

    func resetInstallId() {
        defaults.removeObject(forKey: "installId")
    }

    private func load<T: Decodable>(_ key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func save<T: Encodable>(_ value: T?, _ key: String) {
        if let value = value, let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    var malls: [LocusMall] {
        get { load("malls") ?? [] }
        set { save(newValue, "malls") }
    }

    var mallsFetchedAt: Date? {
        get { defaults.object(forKey: "mallsFetchedAt") as? Date }
        set { defaults.set(newValue, forKey: "mallsFetchedAt") }
    }

    var snapshot: VisitSnapshot? {
        get { load("snapshot") }
        set { save(newValue, "snapshot") }
    }

    var queue: [LocusEvent] {
        get { load("queue") ?? [] }
        set { save(Array(newValue.suffix(LocusStore.maxQueuedEvents)), "queue") }
    }

    func clearAll() {
        for k in ["installId", "malls", "mallsFetchedAt", "snapshot", "queue"] { defaults.removeObject(forKey: k) }
    }
}
