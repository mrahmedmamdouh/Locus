# ADR 0001: Use barometric altitude relative to an entrance calibration for floor detection

- **Status:** Accepted (for the MVP field test; revisit after the gate verdict)
- **Date:** 2026-10-27
- **Deciders:** Ahmed Mamdouh

## Context

Locus delivers bank offers tied to merchants inside malls in Egypt and Oman. Merchants in a mall overlap horizontally across floors, so a 2D geofence around a shop also covers the shops above and below it. To target the right merchant we need the shopper's **floor**, from a normal customer phone, without installing hardware in every mall at the start.

Constraints:

- Must work on phones customers already have (iOS and mid-range Android), inside a bank's app, with no extra hardware.
- Mall floors are typically 4.5–6 m apart. To pick the right floor reliably we need height error well under half a floor (about ±2.25 m).
- Cairo and Muscat malls are air-conditioned, have large atriums and sit near or moderately above sea level; outdoor weather changes pressure by several hPa over a day.
- The MVP has no server and must be cheap to test.

## Decision

Estimate height as **barometric altitude relative to a calibration taken at the mall entrance**:

1. On entering, record the barometer pressure `p0` at the entrance (defined as height 0, floor index 0).
2. For each later pressure `p`, compute height with the hypsometric equation:

   `h = (R_d · T / g) · ln(p0 / p)`

   with `R_d = 287.053 J/(kg·K)`, `g = 9.80665 m/s²` and `T` the indoor air temperature (default 24 °C). See [`pressure.ts`](../../packages/altitude-core/src/pressure.ts).
3. Map `h` to a floor through per-venue floor bands ([`floors.ts`](../../packages/altitude-core/src/floors.ts)), and to a merchant through a 3D geofence (lat/lon radius plus a height band).
4. Recalibrate on re-entry and every ~20 minutes to cancel weather drift.

At 24 °C near sea level this gives about **8.6 m per hPa**, so a 4.5 m floor is about **0.5 hPa**. Phone barometers (Bosch BMP/BMP3xx, TDK ICP-series and similar) have relative accuracy around ±0.06–0.12 hPa (roughly ±0.5–1 m), well inside half a floor. Because only the *difference* from `p0` matters, the sensor's absolute offset and the day's sea-level pressure cancel out.

GPS altitude is recorded in parallel as the comparison baseline, and on iOS the OS-fused `CMAltimeter` relative altitude is recorded as a third source.

The decision is validated, not assumed: the field test must pass the gate in [`stats.ts`](../../packages/altitude-core/src/stats.ts) (≥ 85% floor accuracy, p90 error < half a floor, ≥ 200 readings, ≥ 2 venues).

## Alternatives considered

| Option | Why not (for now) |
| --- | --- |
| **Raw GPS altitude** | GNSS vertical error is typically 1.5–3× the horizontal error because satellites are all above the horizon (poor vertical geometry). Outdoors that is often 10–20 m; indoors, with attenuated and reflected signals, fixes are often missing or off by tens of metres. That is several floors. Kept only as a baseline in the test. |
| **Absolute barometric altitude** (international barometric formula with standard or reported sea-level pressure) | Needs the current local sea-level pressure (QNH). Weather moves it by several hPa per day (tens of metres), the nearest airport report (Cairo, Muscat) can be kilometres away and an hour old, and each phone sensor has its own absolute offset of up to ~±1 hPa (~8 m). Errors of one or more floors are common. Calibrating at the entrance removes all three problems at once. Still used for display only. |
| **BLE beacons per floor** | Accurate floor and even shop-level location, but needs hardware installed and maintained in every mall, battery replacement and a partnership with each mall operator. Too slow and costly to validate the product. It is the **fallback** if the gate fails. |
| **Wi-Fi RTT (IEEE 802.11mc FTM)** | Metre-level ranging, but requires RTT-capable access points (rare in Egyptian and Omani malls today) and is Android-only; iOS does not expose it to apps. Wi-Fi fingerprinting (RSSI) needs per-mall survey work and drifts as APs change. Considered together with BLE as the fallback. |

## Consequences

**Positive**

- No hardware or mall partnership needed to start; works on most phones already in customers' hands.
- Cheap, fast to validate with the field-test app and dashboard; the same library runs on phone and in the browser.
- Relative measurement cancels weather and per-device offset.

**Negative / risks**

- **Calibration dependency:** the app must know when the shopper crosses the entrance. In the MVP the tester taps Calibrate; in production this needs geofence-triggered calibration at known entrances, and entrances on several levels need their own known heights.
- **Drift:** weather and building HVAC change pressure over time; requires periodic recalibration or a correction model. The field test measures drift explicitly.
- **Indoor pressure disturbances:** doors, air curtains, atriums, car parks and lifts cause short pressure swings of ~0.1–0.3 hPa (1–3 m). Mitigated by averaging and by the protocol.
- **Device coverage:** many budget Androids have no barometer. Those users need the GPS/Wi-Fi fallback or get 2D-only offers.
- **Temperature assumption:** using 24 °C when the actual air is 30 °C changes the metres-per-hPa factor by about 2%, negligible at mall heights.
- **Per-venue data:** each mall needs a floor table (count, heights, entrance level). That is cheap but must be maintained.

**Revisit when:** the gate verdict is FAIL, a target segment's phones mostly lack barometers, or partner malls offer existing beacon or Wi-Fi infrastructure.
