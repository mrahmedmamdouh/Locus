# Getting the field-test app onto iPhones with TestFlight

An iPhone only installs apps signed with an Apple Developer account, so iOS builds go through TestFlight. Builds run on EAS Build (Expo's cloud Macs), so **you do not need a Mac**. Setup is once; after that, a GitHub Action builds and uploads new versions.

## What you need

| Item | Cost | Notes |
| --- | --- | --- |
| [Apple Developer Program](https://developer.apple.com/programs/enroll/) | USD 99 / year | Individual enrollment is fastest. A company needs a D-U-N-S number and takes longer. |
| [Expo account](https://expo.dev/signup) | Free | The free plan includes a limited number of low-priority cloud builds each month. |
| Node.js 20+ on any computer | Free | Windows, macOS or Linux. |

## One-time setup (about 30 minutes once Apple approves your membership)

1. **Create the app in App Store Connect.** In [App Store Connect](https://appstoreconnect.apple.com) → Apps → **+** → New App: platform iOS, name "Locus Field", bundle ID `com.locus.field` (register it under Certificates, Identifiers & Profiles → Identifiers if it is not in the list), SKU `locus-field`. If Apple says the bundle ID is taken, pick another (for example `com.<yourname>.locus`), and change `ios.bundleIdentifier` in `app/app.json` to match.
2. **Get the code and install:**
   ```bash
   git clone https://github.com/mrahmedmamdouh/Locus.git
   cd Locus && npm ci && cd app
   ```
3. **Link the app to Expo:**
   ```bash
   npx eas-cli@26.0.0 login
   npx eas-cli@26.0.0 init
   ```
   `init` adds `extra.eas.projectId` to `app/app.json`. Commit and push that change (or send the project ID and it can be added for you).
4. **First iOS build, interactive:**
   ```bash
   npx eas-cli@26.0.0 build --platform ios --profile production --auto-submit
   ```
   Answer **yes** to logging in to your Apple account and letting EAS create the distribution certificate and provisioning profile. When asked about an App Store Connect API key for submissions, let EAS create one. The build takes about 15–30 minutes on the free plan's queue, then it is uploaded to TestFlight. Apple then needs 5–15 minutes to process it.
5. **Let GitHub run future builds:** at [expo.dev](https://expo.dev) → Account settings → Access tokens, create a token. In GitHub → the repo → Settings → Secrets and variables → Actions, add it as `EXPO_TOKEN`.

## Install on your iPhone

1. In App Store Connect → your app → **TestFlight** → Internal Testing, create a group and add yourself (and up to 100 team members with App Store Connect access). Internal testing needs no Apple review.
2. Install **TestFlight** from the App Store on the iPhone and accept the invite email.
3. Open the build in TestFlight and tap **Install**. TestFlight builds expire after 90 days.

## New versions

GitHub → Actions → **iOS build to TestFlight** → Run workflow. Build numbers increase automatically (`appVersionSource: remote` in `app/eas.json`). Testers get the update in TestFlight.

## Testers outside your team

External testers (anyone with an email address, up to 10,000) need a short Apple beta review of the first build. Add them under TestFlight → External Testing, or share a public link.
