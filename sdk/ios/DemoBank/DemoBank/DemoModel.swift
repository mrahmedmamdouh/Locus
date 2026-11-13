import CoreLocation
import Foundation
import LocusSDK
import UserNotifications

/// The demo's settings, event log and SDK callbacks. Settings and the log live in UserDefaults so
/// events from background wake-ups show up when the app is opened.
final class DemoModel: NSObject, ObservableObject, LocusDelegate, CLLocationManagerDelegate {
    static let shared = DemoModel()
    static let policyVersion = "demo-mall-offers-2026-11"

    static let consentEN = "Mall offers: when you visit a partner mall, Demo Bank shows you card offers from shops near you, including on your floor. To do this, the app detects when you arrive at partner malls, even when it is closed. Your location history never leaves your phone. You can turn this off at any time."
    static let consentAR = "عروض المراكز التجارية: عند زيارتك لمركز تجاري شريك، يعرض لك بنك العرض عروض البطاقات من المتاجر القريبة منك، بما في ذلك الطابق الذي أنت فيه. لذلك يكتشف التطبيق وصولك إلى المراكز الشريكة حتى عندما يكون مغلقاً. لا يغادر سجل مواقعك هاتفك. يمكنك إيقاف ذلك في أي وقت."

    private let defaults = UserDefaults.standard
    private let location = CLLocationManager()

    @Published var apiURL: String
    @Published var publishableKey: String
    @Published var customerRef: String
    @Published var segments: String
    @Published var arabic: Bool
    @Published private(set) var log: [String]
    @Published private(set) var offersText = ""
    @Published private(set) var tick = 0 // bump to refresh status

    private override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        apiURL = defaults.string(forKey: "apiURL") ?? (info["LOCUSDefaultAPIURL"] as? String ?? "")
        publishableKey = defaults.string(forKey: "publishableKey") ?? (info["LOCUSDefaultPublishableKey"] as? String ?? "")
        customerRef = defaults.string(forKey: "customerRef") ?? ""
        segments = defaults.string(forKey: "segments") ?? ""
        arabic = defaults.object(forKey: "arabic") as? Bool ?? (Locale.preferredLanguages.first ?? "en").hasPrefix("ar")
        log = defaults.stringArray(forKey: "log") ?? []
        super.init()
        location.delegate = self
    }

    var consentText: String { arabic ? Self.consentAR : Self.consentEN }
    var wasRunning: Bool { defaults.bool(forKey: "running") }

    // MARK: - Settings

    func save() {
        defaults.set(apiURL.trimmingCharacters(in: .whitespaces), forKey: "apiURL")
        defaults.set(publishableKey.trimmingCharacters(in: .whitespaces), forKey: "publishableKey")
        defaults.set(customerRef.trimmingCharacters(in: .whitespaces), forKey: "customerRef")
        defaults.set(segments, forKey: "segments")
        defaults.set(arabic, forKey: "arabic")
        add(apply() ? "Settings saved" : "Settings saved, but the API address or key is missing")
    }

    /// Configures the SDK from the saved settings. False until the address and key are set.
    @discardableResult
    func apply() -> Bool {
        let url = (defaults.string(forKey: "apiURL") ?? apiURL).trimmingCharacters(in: .whitespaces)
        let key = (defaults.string(forKey: "publishableKey") ?? publishableKey).trimmingCharacters(in: .whitespaces)
        guard let base = URL(string: url), base.scheme == "https" || base.host == "localhost", key.hasPrefix("lk_pub_") else { return false }
        var options = LocusOptions(apiBaseURL: base)
        options.postLocalNotifications = true
        Locus.shared.configure(publishableKey: key, options: options)
        Locus.shared.delegate = self
        let ref = (defaults.string(forKey: "customerRef") ?? "").trimmingCharacters(in: .whitespaces)
        Locus.shared.setCustomerRef(ref.isEmpty ? nil : ref)
        Locus.shared.setSegments((defaults.string(forKey: "segments") ?? "").lowercased().split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init))
        Locus.shared.language = arabic ? "ar" : "en"
        return true
    }

    // MARK: - Actions

    func consent(_ granted: Bool) {
        guard apply() else { return add("Save the settings first") }
        Locus.shared.setConsent(granted: granted, policyVersion: Self.policyVersion, shownText: consentText)
        if !granted { defaults.set(false, forKey: "running") }
        add(granted ? "Consent: agreed (\(Self.policyVersion))" : "Consent: withdrawn; monitoring stopped")
    }

    func askWhenInUse() { location.requestWhenInUseAuthorization() }
    func askAlways() { location.requestAlwaysAuthorization() }

    func askNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { ok, _ in
            DispatchQueue.main.async { self.add("Notifications: \(ok ? "allowed" : "not allowed")") }
        }
    }

    func start() {
        guard apply() else { return add("Save the settings first") }
        Locus.shared.start()
        defaults.set(Locus.shared.isRunning, forKey: "running")
        add(Locus.shared.isRunning ? "Monitoring started" : "Not started (see the error above)")
    }

    func stop() {
        Locus.shared.stop()
        defaults.set(false, forKey: "running")
        add("Monitoring stopped")
    }

    func loadOffers() {
        Locus.shared.offersHere { result in
            switch result {
            case let .success(r):
                if r.reason == "no-consent" {
                    self.offersText = "No consent recorded for this install yet."
                } else if r.offers.isEmpty {
                    self.offersText = "No offers here right now."
                } else {
                    self.offersText = r.offers.map { o in
                        var s = "• \(o.title)"
                        if !o.body.isEmpty { s += "\n  \(o.body)" }
                        s += "\n  " + [o.merchant.name, o.storeName, o.floorLabel].compactMap { $0 }.joined(separator: " · ")
                        return s
                    }.joined(separator: "\n\n")
                }
            case .failure:
                self.offersText = "Not inside a pilot mall (or not started)."
            }
        }
    }

    func forget() {
        guard apply() else { return add("Save the settings first") }
        Locus.shared.forgetMe { result in
            switch result {
            case .success: self.add("Data erased; this install now has a new id")
            case let .failure(e): self.add("Erase failed: \(e)")
            }
        }
    }

    func clearLog() {
        log = []
        defaults.set(log, forKey: "log")
    }

    func add(_ line: String) {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        log.insert("\(f.string(from: Date()))  \(line)", at: 0)
        log = Array(log.prefix(100))
        defaults.set(log, forKey: "log")
        tick += 1
    }

    var statusLines: [String] {
        _ = tick
        let place = Locus.shared.currentPlace
        let auth: String
        switch location.authorizationStatus {
        case .authorizedAlways: auth = "allowed, always"
        case .authorizedWhenInUse: auth = "allowed, only while using"
        case .denied, .restricted: auth = "not allowed"
        default: auth = "not asked yet"
        }
        return [
            "Mall: \(place?.mall.name ?? "not in a pilot mall")",
            "Floor: \(place?.floor?.label ?? (place != nil ? "unknown (mall-level)" : "—"))",
            "Consent: \(Locus.shared.consentGranted ? "agreed" : "not given")",
            "Monitoring: \(Locus.shared.isRunning ? "on" : "off")",
            "Location: \(auth)",
            "Install id: \(Locus.shared.installId)",
        ]
    }

    // MARK: - LocusDelegate

    func locus(_ locus: Locus, didArriveAt mall: LocusMall) { add("Arrived at \(mall.name)") }

    func locus(_ locus: Locus, didChange place: LocusPlace) {
        add("Floor: \(place.floor?.label ?? "unknown (mall-level)") in \(place.mall.name)")
    }

    func locus(_ locus: Locus, didLeave mall: LocusMall) { add("Left \(mall.name)") }

    func locus(_ locus: Locus, shouldPresent offer: LocusOffer, at place: LocusPlace) -> Bool {
        add("Offer shown: \(offer.title)\(offer.storeName.map { " (\($0))" } ?? "")")
        return true
    }

    func locus(_ locus: Locus, didFailWith error: Error) { add("Error: \(error)") }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { tick += 1 }
}
