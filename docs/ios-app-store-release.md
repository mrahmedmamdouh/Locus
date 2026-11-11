# What a public App Store release of Locus Field would take

Checked on 2026-11-12 against Apple's App Review Guidelines (last updated 16 Oct 2026) and the pages under Sources. Rules change; re-check them before you submit.

## Recommendation: stay on TestFlight

Locus Field is a field-test tool, not a product for the public. Guideline **2.2** says: "Demos, betas, and trial versions of your app don't belong on the App Store – use TestFlight instead." A public listing would also attract the hardest review question (Always location, below) for an app that does not need to be public.

| Option | Who | Apple review | Notes |
| --- | --- | --- | --- |
| TestFlight internal (current) | Up to 100 people with an App Store Connect role | None | Builds last 90 days. |
| TestFlight external | Up to 10,000 people by email or public link | First build reviewed by Apple (beta review) | Use this for mall testers outside the team. Same privacy questions, lighter than a full release. |
| App Store | Anyone | Full App Review | Only if Locus Field becomes a product people use on their own. |

## If you do release publicly later

1. **Justify background location (2.5.4, 5.1.5).** 2.5.4: background services may be used only "for their intended purposes", and location is one of them. 5.1.5: use location "only when it is directly relevant to the features and services provided by the app" and explain the purpose in the app. Apple rejects apps whose background location only serves the developer (for example, tracking employees) instead of the user. Auto mode must be visibly a user feature: the user draws a mall boundary, switches Auto mode on, and gets an automatic floor reading on arrival.
2. **Ask for Always only when needed (5.1.1, HIG Privacy).** 5.1.1 asks that purpose strings "clearly and completely describe your use of the data", that apps not "manipulate, trick, or force people" to consent, and that they offer alternatives when permission is declined. The app already asks for Always only when Auto mode is switched on, and manual mode works without it. Keep it that way.
3. **Prepare the reviewer.** Guideline 2.1 asks for "detailed explanations of non-obvious features" in the App Review notes, and the guidelines say generic descriptions of new features are rejected. Prepare:
   - notes that explain Auto mode, why it needs Always location (geofence entry while the app is closed) and that data stays on the phone;
   - a short screen recording on a real iPhone: set a boundary, turn on Auto mode, grant Always, walk in, get the automatic baseline;
   - a way to test without visiting a mall (for example, let the reviewer draw a boundary around where they are).
4. **Account/demo.** The app has no login, so no demo account is needed (2.1 asks for one only for account-based features).
5. **Privacy policy (5.1.1(i)).** Required for every app: a public URL in App Store Connect and a link inside the app. It must say what data is collected, how it is used, how long it is kept and how to delete it.
6. **App Privacy labels.** Apple counts data as "collected" only when it leaves the device; data processed only on the device need not be disclosed. Locus Field keeps location and barometer readings on the phone and shares them only when the tester exports a file, so today the answer can be "Data Not Collected". If a future version uploads readings, declare **Precise Location** (and any device or usage data) and whether it is linked to the user. Data use and sharing must follow 5.1.2 (permission before use or sharing).
7. **Screenshots.** At least one iPhone screenshot set; Apple's current table requires the "iPhone with Dynamic Island (medium display)" size (1179×2556 or 1206×2622 portrait), up to 10 images. Apple scales the largest size down for smaller iPhones.
8. **Export compliance.** Already handled: `usesNonExemptEncryption: false` in `app/app.json` writes `ITSAppUsesNonExemptEncryption = NO`, so App Store Connect does not ask the encryption questions on each upload.
9. **Store listing.** Name, description, keywords, support URL, age rating, category, and a minimum-functionality check (4.2): the app must be useful to a stranger without explanation from you.

## The real product is an SDK inside banks' apps

App Review judges each bank's app, not Locus. Every bank that embeds the Locus SDK must justify background location in its own submission, list Locus's data in its own App Privacy labels, and cover Locus in its own privacy policy (5.1.1(i) requires that third-party SDKs give "the same or equal protection" of user data). Design implications:

- **Default to no background location.** Work in the foreground (app open) or When-In-Use first. Make geofence/Always an opt-in the bank switches on only when it has a user-facing feature (such as "tell me about offers when I arrive at the mall") that it can defend under 2.5.4 and 5.1.5.
- **Never request permission from inside the SDK by surprise.** Let the bank's app decide when to ask, with its own purpose string.
- **Prefer region monitoring over continuous tracking.** Geofence entry plus a short barometer baseline is lighter and easier to justify than continuous background updates.
- **Process on the device; minimise uploads (5.1.1(iii)).** If floor or offer data must reach a server, send the result (venue, floor, offer), not raw location traces, so banks' privacy labels stay small.
- **Give banks a ready pack:** sample purpose strings, App Review note text, a demo video, the App Privacy answers for the SDK, and a privacy-manifest file for the SDK.

## Sources (pages opened on 2026-11-12)

- Apple, App Review Guidelines (2.1, 2.2, 2.5.4, 4.2, 5.1.1, 5.1.2, 5.1.5): https://developer.apple.com/app-store/review/guidelines/
- Apple, App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
- Apple, Screenshot specifications: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
- Apple, TestFlight: https://developer.apple.com/testflight/
- Apple, Add internal testers: https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/
- Apple, Complying with Encryption Export Regulations: https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations
- Apple, Human Interface Guidelines: Privacy: https://developer.apple.com/design/human-interface-guidelines/privacy
- Apple Developer Forums, rejection under 2.5.4 for background location: https://developer.apple.com/forums/thread/771202
- Expo, iOS capabilities (EAS capability sync): https://docs.expo.dev/build-reference/ios-capabilities/
- Expo, Location: https://docs.expo.dev/versions/latest/sdk/location/
- Expo, TaskManager: https://docs.expo.dev/versions/latest/sdk/task-manager/
