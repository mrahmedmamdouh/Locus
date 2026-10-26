# Locus

[![CI](https://github.com/mrahmedmamdouh/Locus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mrahmedmamdouh/Locus/actions/workflows/ci.yml)
[![Deploy dashboard](https://github.com/mrahmedmamdouh/Locus/actions/workflows/pages.yml/badge.svg?branch=main)](https://github.com/mrahmedmamdouh/Locus/actions/workflows/pages.yml)

Locus is a location-based offers platform for banks in Egypt and Oman: when a cardholder walks into a mall, the bank can show an offer from the merchant they are actually standing next to. Malls stack many merchants on top of each other, so knowing the shopper's **floor** matters as much as knowing their latitude and longitude. This repository is the MVP that tests whether a phone can tell which floor it is on, before anything else gets built.

**Live dashboard:** https://mrahmedmamdouh.github.io/Locus/

## The hypothesis

> A phone's barometer, calibrated once at the mall entrance, can place a shopper on the correct floor at least 85% of the time. GPS altitude cannot.

Air pressure drops by about 0.12 hPa per metre near sea level (roughly 8.6 m per hPa at 24 °C), so one 4.5 m mall floor is about 0.5 hPa, which modern phone barometers resolve easily. Weather moves absolute pressure by several hPa a day, so we never use absolute altitude: we record the pressure at the entrance and compute height **relative** to it with the hypsometric equation. GPS altitude is recorded alongside as the baseline to beat. The reasoning is in [ADR 0001](docs/adr/0001-barometer-relative-altitude.md).

## Repository structure

| Path | What it is |
| --- | --- |
| [`packages/altitude-core`](packages/altitude-core) | Shared TypeScript library: pressure to altitude, floor bands, 3D geofences, CSV schema, accuracy stats and the go/no-go gate. |
| [`app/`](app) | Expo (SDK 58) field-test app. Testers pick a venue, calibrate at the entrance, record readings on a known floor and export CSV. |
| [`dashboard/`](dashboard) | Vite + React static site. Load exported CSVs and see accuracy per source, device and venue, plus the gate verdict. |
| [`docs/`](docs) | [Field-test protocol](docs/field-test-protocol.md), [architecture](docs/architecture.md) and [decision records](docs/adr). |
| [`.github/`](.github) | CI, Pages deployment, optional EAS Update workflow, Dependabot. |

## Quick start

Requires Node 22 (see [`.nvmrc`](.nvmrc); Node 20+ works) and npm.

```bash
git clone https://github.com/mrahmedmamdouh/Locus.git
cd Locus
npm ci                                   # installs all workspaces

npm test --workspaces --if-present       # unit tests (vitest)
npm run typecheck --workspaces --if-present
```

**Dashboard locally**

```bash
npm run dev -w dashboard                 # http://localhost:5173
npm run build -w dashboard               # static output in dashboard/dist
```

**Field-test app on a phone (Expo Go)**

Install Expo Go from the App Store or Play Store, then:

```bash
cd app
npx expo start --tunnel
```

Scan the QR code with the camera (iPhone) or Expo Go (Android). `--tunnel` works even when the phone and laptop are on different networks, which is the normal case in a mall. Before going out, read the [field-test protocol](docs/field-test-protocol.md).

## Deployment

| What | How | Cost |
| --- | --- | --- |
| Dashboard | [`pages.yml`](.github/workflows/pages.yml) builds `dashboard/` and deploys it to GitHub Pages on every push to `main` that touches `dashboard/**` or `packages/**` (or run it manually). | Free |
| App | Testers run it through Expo Go from `npx expo start --tunnel`. Optionally publish with [`eas-update.yml`](.github/workflows/eas-update.yml) (manual trigger). | Free tier |
| CI | [`ci.yml`](.github/workflows/ci.yml) runs tests, typechecks and the dashboard build on every push and pull request to `main`. | Free |

**One-time setup for the repository owner**

1. **GitHub Pages:** Settings → Pages → Build and deployment → Source: **GitHub Actions**. Then run "Deploy dashboard to Pages" once from the Actions tab (or push to `main`).
2. **EAS Update (optional):** create a free account at [expo.dev](https://expo.dev); in `app/` run `npx eas-cli@latest login`, `npx eas-cli@latest init` (adds `extra.eas.projectId` to `app/app.json`, commit it) and `npx eas-cli@latest update:configure`; create a token at expo.dev → Settings → Access tokens and add it as the repository secret `EXPO_TOKEN` (Settings → Secrets and variables → Actions). Without the secret the workflow skips with a notice; CI never depends on it.

## CSV schema

The app exports one row per reading; the dashboard reads the same format. The column list and parser live in [`packages/altitude-core/src/csv.ts`](packages/altitude-core/src/csv.ts) (`READING_COLUMNS`), with field meanings in [`types.ts`](packages/altitude-core/src/types.ts). In short:

| Group | Columns |
| --- | --- |
| Identity | `id`, `sessionId`, `venueId`, `venueName`, `deviceModel`, `platform`, `timestamp`, `secondsSinceCalibration` |
| Ground truth | `trueFloorLabel`, `trueFloorIndex`, `trueFloorCenterM` |
| Barometer | `pressureHpa`, `baselinePressureHpa`, `temperatureC`, `baroRelAltM`, `osRelAltM` (iOS only) |
| GPS | `gpsLat`, `gpsLon`, `gpsAltM`, `gpsAccuracyM`, `gpsAltAccuracyM`, `gpsRelAltM` |
| Estimates | `estFloorIndexBaro`, `estFloorIndexGps`, `sampleCount`, `notes` |

All heights are metres relative to the calibration entrance (entrance floor = 0). The format is RFC 4180 with a header row; text cells that start with `= + - @` are prefixed with `'` so the file is safe to open in Excel or Sheets.

## The gate

The dashboard applies `evaluateGate` with `DEFAULT_GATE` from [`stats.ts`](packages/altitude-core/src/stats.ts). Barometric altitude **passes** only if all four hold. Each reading is judged against the height of its own floor, which the app stores in every row (`trueFloorHeightM`).

| Criterion | Threshold |
| --- | --- |
| Floor accuracy (estimated floor = true floor) | ≥ 85% |
| 90th-percentile absolute height error | < 0.5 of that reading's floor height |
| Readings | ≥ 200 |
| Distinct venues, each with ≥ 30 readings for the evaluated source | ≥ 2 |

Fewer than 200 readings, or fewer than 2 venues with 30+ readings each, gives **insufficient data**, not a fail. What to do with each verdict is in the [protocol](docs/field-test-protocol.md#8-reading-the-dashboard-verdict).

## Privacy

There is no server. The app keeps readings on the phone until the tester chooses to export a CSV, and the dashboard parses CSVs entirely in the browser; nothing is uploaded. Readings contain GPS coordinates of mall floors, a device model and free-text notes, never names, phone numbers or card data. Keep it that way: do not write personal data in notes and do not commit field CSVs to this repository.

## License

[MIT](LICENSE) © 2026 Ahmed Mamdouh
