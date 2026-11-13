# Locus SDK: integration guide for banks and fintechs

The Locus SDK tells your app **which pilot mall** a customer has arrived at and, on phones with a barometer, **which floor** they are on. It then asks the Locus API for **your own** offers there and tells you which one (at most one per floor per visit) to show. You decide how to show it.

| | iOS | Android |
| --- | --- | --- |
| Package | Swift Package `LocusSDK` (this repository) | `locus-sdk` AAR (+ `locus-core`) |
| Minimum OS | iOS 15 | Android 7.0 (API 24) |
| Mall arrival | Region monitoring (works while the app is closed) | Play services geofencing (works while the app is closed) |
| Floor | Barometer (`CMAltimeter`), every iPhone since 6 | Pressure sensor when the phone has one; mall-level otherwise |
| Dependencies | none | Play services location, AndroidX core and lifecycle |

## What the SDK does and does not do

- **It never asks for permissions.** Your app asks, with your own wording, at a moment that makes sense.
- **It never sends coordinates.** It sends results: "arrived at Mall of Oman", "now on Level 2", "offer X shown/opened", with a random install id. A rough position (two decimals, about 1 km) is sent once a day to pick the nearest malls to monitor.
- **It takes the floor baseline at the mall doors**, automatically, from the arrival event. The rules from the field tests are built in:
  - an arrival reported while the visit is still open is ignored;
  - an arrival with a location fix worse than the mall circle is ignored;
  - a "left" followed by "arrived" within 15 minutes resumes the same visit;
  - a phone found already inside when monitoring starts gets **mall-level** offers (it may be upstairs);
  - floor changes are reported after 10 seconds on the new floor, so escalator rides do not flicker.
- **In the background** it detects the arrival, takes the baseline and reports the entrance floor. Floor changes are tracked while your app is open, or in the background too if you turn on `backgroundFloorTracking` (more battery; needs a background-location reason for App Review / a foreground service on Android).

The floor logic is one state machine, written once in TypeScript ([`packages/altitude-core/src/visit.ts`](../packages/altitude-core/src/visit.ts)) and ported to Swift and Kotlin. All three run the same [test vectors](../sdk/spec/vectors/visit-engine.json) in CI, including a replay of the 13 November 2026 Mall of Oman visit (37 of 38 readings on the right floor; the one miss is a tester tap slip).

## Keys

Locus gives each client two keys:

| Key | Starts with | Where it goes |
| --- | --- | --- |
| Publishable | `lk_pub_` | Inside your mobile app (SDK). It can only read malls and your active offers and report events. |
| Secret | `lk_sec_` | Your servers and the [Locus Console](https://mrahmedmamdouh.github.io/Locus/console/). Never in the app. |

## iOS

**1. Add the package.** Xcode → File → Add Package Dependencies… → `https://github.com/mrahmedmamdouh/Locus` → product **LocusSDK**.

**2. Info.plist.**

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>To show your card offers in the mall you are visiting.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>To tell you about card offers when you arrive at a mall, even when the app is closed.</string>
<key>NSMotionUsageDescription</key>
<string>To tell which floor of the mall you are on, so offers match the shops around you.</string>
```

Add `UIBackgroundModes` → `location` only if you turn on `backgroundFloorTracking`.

**3. Start it at launch** (iOS relaunches the app in the background for mall arrivals):

```swift
import LocusSDK

func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    var options = LocusOptions(apiBaseURL: URL(string: "https://locus-api.example.workers.dev")!)
    options.postLocalNotifications = false   // true: the SDK posts the notification itself
    Locus.shared.configure(publishableKey: "lk_pub_…", options: options)
    Locus.shared.delegate = offersCoordinator
    if CLLocationManager().authorizationStatus == .authorizedAlways { Locus.shared.start() }
    return true
}
```

After your app gets location permission (ideally **Always**), call `Locus.shared.start()`.

**4. React to events:**

```swift
final class OffersCoordinator: LocusDelegate {
    func locus(_ locus: Locus, didArriveAt mall: LocusMall) { /* e.g. show "Offers at Mall of Oman" in the app */ }
    func locus(_ locus: Locus, didChange place: LocusPlace) { /* place.floor?.label == "Level 2" */ }
    func locus(_ locus: Locus, shouldPresent offer: LocusOffer, at place: LocusPlace) -> Bool {
        scheduleNotification(title: offer.title, body: offer.body, offerId: offer.id)
        return true                         // counted as delivered
    }
    func locus(_ locus: Locus, didLeave mall: LocusMall) {}
    func locus(_ locus: Locus, didFailWith error: Error) { log(error) }
}
```

When the customer opens or dismisses the offer: `Locus.shared.recordOfferOpened(offer)` / `recordOfferDismissed(offer)`. For an "offers here" screen: `Locus.shared.offersHere { result in … }`. For "delete my data": `Locus.shared.reset()`.

## Android

**1. Add the libraries.** Until the SDK is on a Maven repository, take `locus-sdk-release.aar` and `locus-core.jar` from the latest **Android SDK** workflow run (Actions → Android SDK → Artifacts), put them in `app/libs/` and:

```kotlin
dependencies {
    implementation(files("libs/locus-sdk-release.aar", "libs/locus-core.jar"))
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
}
```

**2. Manifest.** The SDK declares internet, location and boot permissions and its receivers. Your app adds background location (and notifications, if the SDK posts them):

```xml
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

**3. Configure in `Application.onCreate`** (geofence events can start your process in the background):

```kotlin
class BankApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Locus.configure(this, "lk_pub_…", LocusOptions(apiBaseUrl = "https://locus-api.example.workers.dev"))
        Locus.listener = object : LocusListener {
            override fun onPlaceChanged(place: LocusPlace) { /* place.floor?.label */ }
            override fun shouldPresent(offer: LocusOffer, place: LocusPlace): Boolean {
                showOfferNotification(offer)
                return true
            }
        }
    }
}
```

After the customer grants fine location and then background location, call `Locus.start()`. The SDK re-registers its geofences after a reboot or app update on its own.

Phones without a pressure sensor (for example the Samsung A72 used in the field tests) get **mall-level** offers: arrival works the same, `place.floor` stays `null`, and the API only returns offers you set for the whole mall.

## Testing without going to a mall

- Point the SDK at a local API (`npm run dev --workspace api`, see [api.md](api.md)) and create a test mall around your office with the platform route `PUT /v1/platform/malls/{id}` (status `pilot`).
- iOS Simulator: Features → Location → Custom Location to cross the boundary. The simulator has no barometer, so visits stay mall-level.
- Android emulator: Extended controls → Location. Emulators have a virtual pressure sensor (Extended controls → Virtual sensors → Environment) to simulate floors.

## App Store and Play review notes

- Ask for "Always" / background location only after the customer understands the benefit (for example after they turn on "Mall offers" in settings).
- Describe the feature in the review notes: "Detects arrival at partner malls to show the bank's card offers; no location history leaves the device."
- Leave `backgroundFloorTracking` off unless you need floor offers while the app is closed; it keeps location updates running inside malls.
