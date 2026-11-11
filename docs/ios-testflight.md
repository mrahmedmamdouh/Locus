# Getting the field-test app onto iPhones with TestFlight

An iPhone only installs apps signed with an Apple Developer account, so iOS builds go through TestFlight. Builds run on EAS Build (Expo's cloud Macs), so **you do not need a Mac**. Setup is once; after that, a GitHub Action builds and uploads new versions.

## What you need

| Item | Cost | Notes |
| --- | --- | --- |
| [Apple Developer Program](https://developer.apple.com/programs/enroll/) | USD 99 / year | Individual enrollment is fastest. A company needs a D-U-N-S number and takes longer. |
| [Expo account](https://expo.dev/signup) | Free | The free plan includes a limited number of low-priority cloud builds each month. |
| Node.js 22.13+ on any computer | Free | Windows, macOS or Linux; no Mac or Xcode needed. |

## One-time setup (done once on 2026-10-29; repeat only for a new Mac or a new key)

Already done for this repo: the app record in App Store Connect (`com.locus.field`, Apple app ID `6827325977`, set as `ascAppId` in `app/eas.json`) and the Expo project `@evolvetech-venture/locus-field` (ID in `app/app.json`).

1. **Tools:** Node.js **22.13 or newer** (Expo SDK 58 requires it; v26 works) and Git.
2. **Get the code:**
   ```bash
   git clone https://github.com/mrahmedmamdouh/Locus.git
   cd Locus && npm ci && cd app
   npx eas-cli@latest login        # Expo account with access to evolvetech-venture
   ```
3. **Create an App Store Connect API key** (used instead of an Apple ID password, which `eas` often cannot log in with):
   App Store Connect → Users and Access → Integrations → App Store Connect API → **Team Keys** → **+**, name `Locus EAS`, access **Admin** → Generate → **Download** the `AuthKey_<KEYID>.p8` file (only once). Note the **Key ID** and the **Issuer ID**. Your **Team ID** is under developer.apple.com → Account → Membership details. Keep the key outside the repo:
   ```bash
   mkdir -p ~/.appstoreconnect/private_keys
   mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/private_keys/
   ```
   `*.p8` files are git-ignored, but never paste a key's contents anywhere.

## Build and send a new version to TestFlight

In one Terminal window (the exports last only for that window):

```bash
export EXPO_ASC_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8"
export EXPO_ASC_KEY_ID="<KEYID>"
export EXPO_ASC_ISSUER_ID="<ISSUER-ID>"
export EXPO_APPLE_TEAM_ID="<TEAMID>"
export EXPO_APPLE_TEAM_TYPE="COMPANY_OR_ORGANIZATION"

cd ~/Locus && git pull && cd app
npx eas-cli@latest build --platform ios --profile production
```

The build takes 15–30 minutes on Expo's free queue (watch the link it prints). The "expo doctor" warning in the build log does not stop the build. When it shows **Finished**, submit it with the local key:

```bash
node -e '
const fs=require("fs"),e=process.env,f="eas.json";
if(!e.EXPO_ASC_API_KEY_PATH||!e.EXPO_ASC_KEY_ID||!e.EXPO_ASC_ISSUER_ID){console.error("Missing EXPO_ASC_* values");process.exit(1)}
const j=JSON.parse(fs.readFileSync(f));
Object.assign(j.submit.production.ios,{ascApiKeyPath:e.EXPO_ASC_API_KEY_PATH,ascApiKeyId:e.EXPO_ASC_KEY_ID,ascApiKeyIssuerId:e.EXPO_ASC_ISSUER_ID});
fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");'
npx eas-cli@latest submit --platform ios --latest
git checkout -- eas.json          # never commit the local key path
```

Apple then processes the build for 10–30 minutes before it appears in TestFlight.

**Troubleshooting**

| Message | Fix |
| --- | --- |
| `Invalid username and password combination` | Use the API key route above instead of the Apple ID login. |
| `Ensuring your app exists on App Store Connect… Apple ID:` | `ascAppId` is missing from `app/eas.json` (it is set to `6827325977`). Press Ctrl+C; the build continues. |
| `App Store Connect rejected the API authentication credentials` on submit | The key stored on Expo's servers is wrong. Submit with the local key as above, or fix it in `npx eas-cli@latest credentials -p ios` → production → App Store Connect API Key. |

## Publishing 0.4.0 (what differs from 0.3.1)

0.4.0 adds a new package (`expo-task-manager`), background geofencing with **Always** location, and the barometer permission. The steps above still apply, with three changes:

1. **Install packages after pulling.** Run `npm ci` in the repo root (not in `app/`) before building:
   ```bash
   cd ~/Locus && git pull && npm ci && cd app
   ```
   Skipping it gives `Unable to resolve module expo-task-manager` (or a similar "module not found") in the build log.
2. **No new Apple capability is needed.** The build's Info.plist now has `UIBackgroundModes` = `location` (from `expo-location`) and `fetch` (added automatically by `expo-task-manager`'s plugin). Background modes are Info.plist keys, not entitlements, and EAS only syncs capabilities from entitlements, so the App ID and provisioning profile do not change. If `eas build` still asks to sync capabilities or to regenerate the provisioning profile, answer **Yes**; it is harmless. Do not set `EXPO_NO_CAPABILITY_SYNC`.
3. **On the iPhone, allow Always location.** Background location is requested only when Auto mode is switched on. If iOS offers only "While Using", later choose **Change to Always Allow**, or set Settings → Locus Field → Location → **Always**, with **Precise Location** on. Also allow Motion & Fitness for the barometer.

**Check the iPhone has it:** in TestFlight, the Locus Field page shows **Version 0.4.0 (build number)**. The build number is set by EAS and is higher than 0.3.1's.

| Problem | Fix |
| --- | --- |
| Build log: `Unable to resolve module expo-task-manager` | Run `npm ci` in the repo root, then build again. |
| `Provisioning profile ... doesn't include ...` / profile out of date | `npx eas-cli@latest credentials -p ios` → production → Provisioning Profile → remove it, then build again and let EAS create a new one. |
| Submit fails with an authentication error | Make sure the five `export` lines ran in this same Terminal window, then rerun the `node -e` step and submit. |
| TestFlight shows **Missing Compliance** | Should not happen (`usesNonExemptEncryption: false` in `app.json`). If it does: open the build → Manage → choose "None of the algorithms mentioned above" → Save. |

Internal testing of 0.4.0 needs no Apple review. Only external testing or an App Store release is reviewed; see [ios-app-store-release.md](ios-app-store-release.md).

## Install on your iPhone

1. In App Store Connect → your app → **TestFlight** → Internal Testing, create a group and add yourself (and up to 100 team members with App Store Connect access). Internal testing needs no Apple review.
2. Install **TestFlight** from the App Store on the iPhone and accept the invite email.
3. Open the build in TestFlight and tap **Install**. TestFlight builds expire after 90 days.

## New versions

Build numbers increase automatically (`appVersionSource: remote` in `app/eas.json`), and testers get the update in TestFlight. Use the commands above. The GitHub workflow **iOS build to TestFlight** also works once the repository secret `EXPO_TOKEN` is set *and* a working submission key is stored on Expo's servers (see Troubleshooting).

## Testers outside your team

External testers (anyone with an email address, up to 10,000) need a short Apple beta review of the first build. Add them under TestFlight → External Testing, or share a public link.
