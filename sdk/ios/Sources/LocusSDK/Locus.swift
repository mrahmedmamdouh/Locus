#if os(iOS)
import CoreLocation
import CoreMotion
import CryptoKit
import Foundation
import LocusCore
import UIKit
import UserNotifications

/// Settings for `Locus.shared.configure(publishableKey:options:)`.
public struct LocusOptions {
    /// The Locus API (your deployment).
    public var apiBaseURL: URL
    /// Malls to monitor at once, nearest first. iOS allows 20 regions per app in total, so leave room for your own.
    public var maxMonitoredMalls: Int = 15
    /// Keep tracking floors while the app is in the background inside a mall. Uses background location
    /// updates while inside (needs UIBackgroundModes "location" and a clear reason for App Review). Off by
    /// default: in the background the SDK still detects arrival, takes the baseline and reports the entrance floor.
    public var backgroundFloorTracking: Bool = false
    /// Post a local notification for the offer the API says to show (when the delegate does not decline it).
    /// Your app must have notification permission.
    public var postLocalNotifications: Bool = false
    public var engineConfig: EngineConfig = EngineConfig()
    /// True when your bank records consent in its own systems (Locus console: consent mode "bank") and
    /// only starts the SDK afterwards. False (default): call `setConsent` first; `start` needs it.
    public var consentManagedByBank: Bool = false

    public init(apiBaseURL: URL) {
        self.apiBaseURL = apiBaseURL
    }
}

/// Callbacks on the main thread. All methods are optional.
public protocol LocusDelegate: AnyObject {
    func locus(_ locus: Locus, didArriveAt mall: LocusMall)
    /// The floor changed (or became known). `place.floor` is nil for a mall-level visit.
    func locus(_ locus: Locus, didChange place: LocusPlace)
    func locus(_ locus: Locus, didLeave mall: LocusMall)
    /// The API picked this offer to show now. Return false to skip it (it is then not counted as delivered).
    func locus(_ locus: Locus, shouldPresent offer: LocusOffer, at place: LocusPlace) -> Bool
    func locus(_ locus: Locus, didFailWith error: Error)
}

public extension LocusDelegate {
    func locus(_ locus: Locus, didArriveAt mall: LocusMall) {}
    func locus(_ locus: Locus, didChange place: LocusPlace) {}
    func locus(_ locus: Locus, didLeave mall: LocusMall) {}
    func locus(_ locus: Locus, shouldPresent offer: LocusOffer, at place: LocusPlace) -> Bool { true }
    func locus(_ locus: Locus, didFailWith error: Error) {}
}

/// The Locus SDK. Use from the main thread.
///
/// Your app asks for location permission ("Always" for arrivals while the app is closed) and Motion &
/// Fitness permission (barometer); the SDK never prompts. Call `configure` and `start` early in
/// `application(_:didFinishLaunchingWithOptions:)`, because iOS relaunches the app in the background
/// for mall arrivals.
public final class Locus: NSObject {
    public static let shared = Locus()

    public weak var delegate: LocusDelegate?
    public private(set) var isRunning = false
    /// Where the shopper is now, or nil when not inside a pilot mall.
    public private(set) var currentPlace: LocusPlace?

    private static let regionPrefix = "locus."
    private let manager = CLLocationManager()
    private let altimeter = CMAltimeter()
    private let store = LocusStore()
    private var api: LocusAPIClient?
    private var options: LocusOptions?
    private var engine = VisitEngine(venues: [])
    private var malls: [String: LocusMall] = [:]
    private var altimeterOn = false
    private var captureUntil: Date?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var pendingStateChecks = Set<String>()
    private var flushing = false

    private override init() {
        super.init()
        manager.delegate = self
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(appDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(appDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    /// The random id this install reports with (no personal data). Your app may send it to your servers to join reports.
    public var installId: String { store.installId }

    public func configure(publishableKey: String, options: LocusOptions) {
        self.options = options
        api = LocusAPIClient(baseURL: options.apiBaseURL, publishableKey: publishableKey)
        engine = VisitEngine(venues: [], config: options.engineConfig)
        setMalls(store.malls)
        engine.restore(store.snapshot)
        refreshPlace()
    }

    /// Starts mall monitoring. Safe to call on every launch.
    public func start() {
        guard api != nil else {
            delegate?.locus(self, didFailWith: LocusError.notConfigured)
            return
        }
        guard options?.consentManagedByBank == true || consentGranted else {
            delegate?.locus(self, didFailWith: LocusError.noConsent)
            return
        }
        isRunning = true
        updateMonitoredRegions(checkState: true)
        refreshMallsIfNeeded(force: store.malls.isEmpty)
        if engine.currentVenueId != nil, UIApplication.shared.applicationState == .active { startAltimeter() }
        flush()
    }

    /// Stops monitoring and forgets the current visit. Unsent events are kept.
    public func stop() {
        isRunning = false
        for r in manager.monitoredRegions where r.identifier.hasPrefix(Locus.regionPrefix) { manager.stopMonitoring(for: r) }
        stopAltimeter()
        stopBackgroundLocation()
        engine.restore(nil)
        store.snapshot = nil
        currentPlace = nil
    }

    /// Removes everything the SDK stored on the device, including the install id.
    public func reset() {
        stop()
        store.clearAll()
    }

    // MARK: - Consent

    /// Whether the customer's latest recorded choice is "yes" to mall offers.
    public var consentGranted: Bool { store.consent?.status == "granted" }

    /// Records the customer's choice about mall offers, with your version label of the wording and,
    /// ideally, the exact text shown (only its SHA-256 is sent). "No" stops monitoring at once.
    /// The record reaches Locus now, or with the next upload if offline.
    public func setConsent(granted: Bool, policyVersion: String, shownText: String? = nil) {
        let hash = shownText.map { SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined() }
        store.consent = LocusAPIClient.ConsentRecord(status: granted ? "granted" : "withdrawn", policyVersion: policyVersion, textHash: hash, language: resolvedLanguage, t: LocusEvent.iso.string(from: Date()))
        store.consentPending = true
        if !granted {
            stop()
            store.queue = []
        }
        flush()
    }

    /// "Delete my data": asks Locus to erase this install's data, then clears the SDK's storage
    /// (the next install id is new). Consent records stay with Locus as proof.
    public func forgetMe(completion: @escaping (Result<Void, LocusError>) -> Void) {
        guard let api = api else { return completion(.failure(.notConfigured)) }
        api.forget(installId: store.installId) { [weak self] result in
            if case .success = result { self?.reset() }
            completion(result)
        }
    }

    /// Offers here for an in-app list (not only the one to push).
    public func offersHere(completion: @escaping (Result<LocusOffersResponse, LocusError>) -> Void) {
        guard let api = api, let place = currentPlace else {
            completion(.failure(.notConfigured))
            return
        }
        var q = query(place)
        q.listOnly = true
        api.offers(q, completion: completion)
    }

    /// The bank's own pseudonymous reference for the signed-in customer (never a national ID, card or
    /// account number). Needed for webhook delivery and for matching card purchases. Nil when signed out.
    public func setCustomerRef(_ ref: String?) { store.customerRef = ref }

    /// Segment tags for offer eligibility, e.g. ["visa-infinite", "salary"] (lowercase letters, digits, dashes).
    public func setSegments(_ segments: [String]) { store.segments = segments }

    /// Offer language: "ar" or "en". Nil (default) follows the phone's preferred language.
    public var language: String?

    private var resolvedLanguage: String {
        if let l = language { return l == "ar" ? "ar" : "en" }
        return (Locale.preferredLanguages.first ?? "en").hasPrefix("ar") ? "ar" : "en"
    }

    private func query(_ place: LocusPlace) -> LocusAPIClient.OffersQuery {
        LocusAPIClient.OffersQuery(installId: store.installId, mallId: place.mall.id, floorIndex: place.floor?.index, customerRef: store.customerRef, segments: store.segments, locale: resolvedLanguage)
    }

    public func recordOfferOpened(_ offer: LocusOffer) { recordOffer("offer_opened", offer) }
    public func recordOfferDismissed(_ offer: LocusOffer) { recordOffer("offer_dismissed", offer) }

    // MARK: - Malls and regions

    private func setMalls(_ list: [LocusMall]) {
        malls = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        engine.setVenues(list.map(\.engineVenue))
    }

    private func refreshMallsIfNeeded(force: Bool = false) {
        guard let api = api, let options = options else { return }
        if !force, let at = store.mallsFetchedAt, Date().timeIntervalSince(at) < 86_400 { return }
        let loc = manager.location
        api.malls(nearLat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, limit: min(max(options.maxMonitoredMalls, 1), 20)) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case let .success(r):
                self.store.malls = r.malls
                self.store.mallsFetchedAt = Date()
                self.setMalls(r.malls)
                if self.isRunning { self.updateMonitoredRegions(checkState: true) }
            case let .failure(e):
                self.delegate?.locus(self, didFailWith: e)
            }
        }
    }

    private func updateMonitoredRegions(checkState: Bool) {
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        let wanted = Dictionary(malls.values.map { (Locus.regionPrefix + $0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for r in manager.monitoredRegions where r.identifier.hasPrefix(Locus.regionPrefix) && wanted[r.identifier] == nil {
            manager.stopMonitoring(for: r)
        }
        let have = Set(manager.monitoredRegions.map(\.identifier))
        for (id, mall) in wanted {
            let region = CLCircularRegion(
                center: CLLocationCoordinate2D(latitude: mall.boundary.lat, longitude: mall.boundary.lon),
                radius: min(mall.boundary.radiusM, manager.maximumRegionMonitoringDistance),
                identifier: id
            )
            region.notifyOnEntry = true
            region.notifyOnExit = true
            if !have.contains(id) { manager.startMonitoring(for: region) }
            if checkState {
                pendingStateChecks.insert(id)
                manager.requestState(for: region)
            }
        }
    }

    private func mallId(of region: CLRegion) -> String? {
        guard region.identifier.hasPrefix(Locus.regionPrefix) else { return nil }
        return String(region.identifier.dropFirst(Locus.regionPrefix.count))
    }

    // MARK: - Engine

    private var nowMs: Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

    /// Horizontal accuracy of a recent fix (≤ 2 minutes old), or nil when unknown.
    private var recentAccuracy: Double? {
        guard let loc = manager.location, loc.horizontalAccuracy >= 0, Date().timeIntervalSince(loc.timestamp) < 120 else { return nil }
        return loc.horizontalAccuracy
    }

    private func feed(_ input: EngineInput) {
        let outputs = engine.handle(input)
        guard !outputs.isEmpty else { return }
        store.snapshot = engine.snapshot()
        for o in outputs { handle(o) }
    }

    private func handle(_ output: EngineOutput) {
        switch output {
        case let .arrived(_, venueId, resumed):
            guard let mall = malls[venueId] else { return }
            refreshPlace()
            if !resumed {
                enqueue(LocusEvent(type: "arrived", mallId: venueId))
                delegate?.locus(self, didArriveAt: mall)
                startAltimeter(capture: true)
                if !CMAltimeter.isRelativeAltitudeAvailable() { fetchOffers() }
            }
        case let .baseline(_, _, status, _, _):
            if status == .unavailable { fetchOffers() }
        case let .floor(_, venueId, floorIndex):
            refreshPlace()
            enqueue(LocusEvent(type: "floor", mallId: venueId, floorIndex: floorIndex))
            if let place = currentPlace { delegate?.locus(self, didChange: place) }
            fetchOffers()
        case let .left(_, venueId):
            enqueue(LocusEvent(type: "left", mallId: venueId))
            refreshPlace()
            if let mall = malls[venueId] { delegate?.locus(self, didLeave: mall) }
            if engine.currentVenueId == nil {
                stopAltimeter()
                stopBackgroundLocation()
            }
            flush()
        case .ignored:
            break
        }
    }

    private func refreshPlace() {
        if let id = engine.currentVenueId, let mall = malls[id] {
            currentPlace = LocusPlace(mall: mall, floor: mall.floor(engine.currentFloorIndex))
        } else {
            currentPlace = nil
        }
    }

    // MARK: - Offers and events

    private func fetchOffers() {
        guard let api = api, let place = currentPlace else { return }
        api.offers(query(place)) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case let .success(r):
                // Still in the same place?
                guard let now = self.currentPlace, now.mall.id == r.mallId, now.floor?.index == r.floorIndex, let offer = r.push else { return }
                // Webhook delivery: the bank's server pushes it and Locus already counted it as delivered.
                guard r.delivery != "webhook" else { return }
                let show = self.delegate?.locus(self, shouldPresent: offer, at: now) ?? self.options?.postLocalNotifications ?? false
                guard show else { return }
                self.enqueue(LocusEvent(type: "offer_delivered", mallId: now.mall.id, floorIndex: now.floor?.index, offerId: offer.id))
                if self.options?.postLocalNotifications == true { self.postNotification(offer, at: now) }
                self.flush()
            case let .failure(e):
                self.delegate?.locus(self, didFailWith: e)
            }
        }
    }

    private func postNotification(_ offer: LocusOffer, at place: LocusPlace) {
        let content = UNMutableNotificationContent()
        content.title = offer.title
        content.body = offer.body.isEmpty ? (offer.storeName.map { "\($0), \(place.mall.name)" } ?? place.mall.name) : offer.body
        content.userInfo = ["locusOfferId": offer.id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "locus-\(offer.id)", content: content, trigger: nil))
    }

    private func recordOffer(_ type: String, _ offer: LocusOffer) {
        guard let place = currentPlace else { return }
        enqueue(LocusEvent(type: type, mallId: place.mall.id, floorIndex: place.floor?.index, offerId: offer.id))
        flush()
    }

    private func enqueue(_ e: LocusEvent) {
        store.queue.append(e)
        if store.queue.count >= 20 { flush() }
    }

    private func flush() {
        guard let api = api, !flushing else { return }
        // The consent record goes first: the API refuses events without it.
        if store.consentPending, let record = store.consent {
            flushing = true
            api.sendConsent(record, installId: store.installId, customerRef: store.customerRef) { [weak self] result in
                guard let self = self else { return }
                self.flushing = false
                switch result {
                case .success:
                    if self.store.consent == record { self.store.consentPending = false }
                    self.flush()
                case let .failure(e):
                    if case let .http(status, _, _) = e, status == 400 { self.store.consentPending = false }
                    self.delegate?.locus(self, didFailWith: e)
                }
            }
            return
        }
        let batch = Array(store.queue.prefix(50))
        guard !batch.isEmpty else { return }
        flushing = true
        api.send(events: batch, installId: store.installId, platform: "ios") { [weak self] result in
            guard let self = self else { return }
            self.flushing = false
            switch result {
            case .success:
                self.store.queue = Array(self.store.queue.dropFirst(batch.count))
                if !self.store.queue.isEmpty { self.flush() }
            case let .failure(e):
                // A 400 means the batch can never be accepted; drop it rather than retry forever.
                if case let .http(status, _, _) = e, status == 400 { self.store.queue = Array(self.store.queue.dropFirst(batch.count)) }
                self.delegate?.locus(self, didFailWith: e)
            }
        }
    }

    // MARK: - Barometer

    /// Runs the barometer while inside a mall and the app is active, during a baseline capture, or always
    /// inside with backgroundFloorTracking.
    private func startAltimeter(capture: Bool = false) {
        if capture, let cfg = options?.engineConfig {
            captureUntil = Date().addingTimeInterval(Double(cfg.captureMs) / 1000 + 2)
            if UIApplication.shared.applicationState != .active { beginBackgroundTime() }
        }
        if options?.backgroundFloorTracking == true { startBackgroundLocation() }
        guard !altimeterOn, CMAltimeter.isRelativeAltitudeAvailable() else { return }
        altimeterOn = true
        altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, error in
            guard let self = self else { return }
            if let error = error {
                self.delegate?.locus(self, didFailWith: error)
                return
            }
            guard let kPa = data?.pressure.doubleValue else { return }
            self.feed(.pressure(tMs: self.nowMs, hPa: kPa * 10))
            self.stopAltimeterIfIdle()
        }
    }

    private func stopAltimeterIfIdle() {
        if let until = captureUntil, Date() < until { return }
        captureUntil = nil
        endBackgroundTime()
        let active = UIApplication.shared.applicationState == .active
        if engine.currentVenueId == nil || (!active && options?.backgroundFloorTracking != true) { stopAltimeter() }
    }

    private func stopAltimeter() {
        guard altimeterOn else { return }
        altimeter.stopRelativeAltitudeUpdates()
        altimeterOn = false
    }

    private func beginBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "locus.baseline") { [weak self] in self?.endBackgroundTime() }
    }

    private func endBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func startBackgroundLocation() {
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 50
        manager.startUpdatingLocation()
    }

    private func stopBackgroundLocation() {
        guard options?.backgroundFloorTracking == true else { return }
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
    }

    @objc private func appDidBecomeActive() {
        guard isRunning else { return }
        if engine.currentVenueId != nil { startAltimeter() }
        refreshMallsIfNeeded()
        flush()
    }

    @objc private func appDidEnterBackground() {
        store.snapshot = engine.snapshot()
        stopAltimeterIfIdle()
        flush()
    }
}

extension Locus: CLLocationManagerDelegate {
    public func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard let id = mallId(of: region) else { return }
        pendingStateChecks.remove(region.identifier)
        feed(.enter(tMs: nowMs, venueId: id, accuracyM: recentAccuracy, crossing: true))
    }

    public func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard let id = mallId(of: region) else { return }
        pendingStateChecks.remove(region.identifier)
        feed(.exit(tMs: nowMs, venueId: id))
    }

    /// Only answers to our own requestState calls (iOS also calls this around real crossings, handled above).
    public func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard let id = mallId(of: region), pendingStateChecks.remove(region.identifier) != nil else { return }
        switch state {
        case .inside:
            if engine.currentVenueId != id { feed(.enter(tMs: nowMs, venueId: id, accuracyM: recentAccuracy, crossing: false)) }
        case .outside:
            if engine.currentVenueId == id { feed(.exit(tMs: nowMs, venueId: id)) }
        default:
            break
        }
    }

    public func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        delegate?.locus(self, didFailWith: error)
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if isRunning, manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse {
            updateMonitoredRegions(checkState: true)
        }
    }
}
#endif
