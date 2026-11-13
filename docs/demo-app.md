# Locus Demo Bank (iOS and Android)

A small app that uses the Locus SDK the way a bank app would. Bank developers read it as sample code; QA and field testers use it to try arrivals, floors, offers and consent in a real mall. One screen, in the order a tester needs:

1. **Settings:** API address, publishable key, a customer reference, segments, and language (English or العربية).
2. **Consent:** the opt-in text in the chosen language, with "I agree" and "No thanks / withdraw". It calls `setConsent` with the exact text shown.
3. **Permissions and start:**
    - location while using, then always;
    - notifications;
    - Start / Stop mall offers.
4. **Offers here:** the offers for the current mall and floor.
5. **What happened:** a log of settings, consent, arrivals, floors, offers shown and errors, including those that happened while the app was closed.
6. **Privacy:** "Delete my mall-offer data" (`forgetMe`).

Offers the API picks are posted as notifications by the SDK (`postLocalNotifications`).

| | Android | iPhone |
| --- | --- | --- |
| Code | [`sdk/android/demo-app`](../sdk/android/demo-app) (Kotlin, `com.locus.demobank`) | [`sdk/ios/DemoBank`](../sdk/ios/DemoBank) (SwiftUI) |
| Get it | GitHub → Releases → **Locus Demo Bank … (Android build N)** → download the APK on the phone | On your Mac: `brew install xcodegen`, then `cd sdk/ios/DemoBank && xcodegen && open DemoBank.xcodeproj`, choose your team under Signing & Capabilities, select your iPhone and Run |
| Built by CI | **Demo bank app (Android)** workflow: APK + release on every SDK change | **iOS SDK** workflow: simulator build on every SDK change |

## Field test with the demo

1. Put the API online: run the Cloudflare setup (see [api.md](api.md#deploy-to-cloudflare-free-tier)). Note the API address and the demo client's publishable and secret keys.
2. In the console (`/Locus/console/`, signed in with the secret key):
    - add a merchant with a branch in a pilot mall, for example Starbucks at Mall of Oman, Level 2;
    - create an active offer for it, with the control group at 0% so the tester always gets it.
3. In the app:
    1. Enter the address and key, plus a customer reference such as `cust-ahmed`. Tap **Save settings**.
    2. Tap **I agree**.
    3. Allow location (then **always**) and notifications, and tap **Start mall offers**.
4. Arrive at the mall with the phone locked. The log should show "Arrived at Mall of Oman". On an iPhone, it then shows a floor, and the offer arrives as a notification once you reach the offer's floor.
5. In the console, check Reports (visits, floors, offers shown) and Settings → Consent records (look up `cust-ahmed`).

Samsung phones without a barometer get mall-level offers only: set the offer to "Whole mall" to see one on those.
