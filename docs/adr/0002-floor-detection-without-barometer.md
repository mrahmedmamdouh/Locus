# ADR 0002: Floor detection on phones without a barometer

- **Status:** Proposed (to be confirmed by the field test)
- **Date:** 2026-10-27
- **Related:** [ADR 0001](0001-barometer-relative-altitude.md)

## Context

ADR 0001 uses the phone barometer to tell mall floors apart. Many Android phones have no barometer, including popular budget models such as the Samsung Galaxy A15, Galaxy A06 and Redmi Note 13 ([GSMArena A15](https://m.gsmarena.com/samsung_galaxy_a15-12637.php), [A06](https://m.gsmarena.com/samsung_galaxy_a06-13265.php), [Redmi Note 13](https://m.gsmarena.com/xiaomi_redmi_note_13-12776.php)). Samsung's A series is 60% of Samsung's African shipments ([Business Today Egypt](https://www.businesstodayegypt.com/amp/4/6390/Egypt-leads-North-Africa’s-smartphone-market-with-34-shipment-growth)). We found no source for the share of phones in Egypt or Oman that have a barometer, so the field app now records it per phone (device check).

GPS altitude is not an alternative: even outdoors, vertical error at 95% is about 11 m with dual-frequency and 19 m with single-frequency receivers, 2–3 times the horizontal error ([Sensors 22:9879](https://mdpi-res.com/d_attachment/sensors/sensors-22-09879/article_deploy/sensors-22-09879.pdf)). Indoors it is worse. Android exposes no floor level in its location APIs that we could find. iOS `CLFloor` is only populated in Apple Indoor Maps venues ([Apple](https://developer.apple.com/documentation/corelocation/clfloor.md)).

## Options

| Method | Floor accuracy reported | Mall infrastructure | Android constraints | Verdict |
| --- | --- | --- | --- | --- |
| **Wi-Fi fingerprinting** (signal strengths per floor) | 91–94% correct floor on the UJIIndoorLoc dataset ([arXiv 1712.01990](https://arxiv.org/pdf/1712.01990)) | None: uses the mall's existing access points; floors must be surveyed or crowd-labelled | Fine location permission and Location on (Android 10+); foreground apps get 4 scans per 2 minutes, all background apps share 1 per 30 minutes ([Android](https://developer.android.com/develop/connectivity/wifi/wifi-scan)) | **Primary** |
| **Crowd-calibrated Wi-Fi** (barometer phones label the fingerprints) | BarFi: 96.3% with only 12% of phones having a barometer ([UMN](https://experts.umn.edu/en/publications/barfi-barometer-aided-wi-fi-floor-localization-using-crowdsourcin/)) | None | As above | **Primary, later phase**: fits Locus's mixed phone base and removes manual surveys |
| **Inertial floor changes** (elevator, escalator, stairs from accelerometer) | Activity recognition 98–100% over 152 traces ([CrowdInside](https://arxiv.org/pdf/1209.3794)); elevator height error 0.06–0.09 m per floor ([Columbia](https://www.cs.columbia.edu/~jae/papers/indopos-wowmom-2014.pdf)) | None | Continuous sampling is hard in the background | **Supporting signal**: starts from the known entrance floor; drift is reset by Wi-Fi |
| **Commercial SDKs** (IndoorAtlas, Situm, Mapsted, Oriient) | Vendors claim floor detection; none we checked publishes a floor-accuracy figure ([IndoorAtlas](https://support.indooratlas.com/support/solutions/articles/36000051240-automatic-floor-detection-with-android)) | Venue mapping walk | Third-party SDK inside a bank app: vendor and data-processing review | **Evaluate** on barometer-less phones before building our own |
| **Wi-Fi RTT** (802.11mc/az distance) | 1–2 m horizontal with 3+ capable access points ([Android](https://developer.android.com/develop/connectivity/wifi/wifi-rtt)); no floor figure | RTT-capable access points, which many installed ones are not ([MIT](https://people.csail.mit.edu/bkph/ftmrtt_issues)) | Android 9+ and phone support; foreground only | **Opportunistic**: use where present |
| **BLE beacons** | Within 2.6 m at 95% with 1 beacon per 30 m² ([Cambridge](https://www.cl.cam.ac.uk/~rkh23/site/publication/pub42)) | Beacons per shop or floor, battery swaps | `BLUETOOTH_SCAN` (Android 12+), scan rate limits | **Targeted**: only for high-value merchants or zones where Wi-Fi fails |
| **Confirmations** (QR/NFC at the shop, card transaction at the merchant) | Exact by design | QR or NFC tag; nothing for card matching | None | **Must-have**: redemption never depends on the floor estimate |

## Decision (proposed)

Use a layered floor estimate with a confidence score, and only push an offer when confidence is high:

1. **Barometer** when the phone has a working one (ADR 0001).
2. **Wi-Fi fingerprint** when it does not, trained first from field-test surveys and later crowd-labelled by barometer phones and verified card transactions.
3. **Inertial floor changes** from the entrance floor as a supporting signal.
4. **Low confidence:** show the offer in the in-app feed without a push, or ask "Which floor are you on?"
5. **Redemption** is always confirmed by the card transaction (or a shop QR code), never by location.

Run a proof of concept with one commercial SDK (IndoorAtlas or Situm) on barometer-less phones in parallel, to decide build versus buy.

## Consequences

- Phones without a barometer still get offers, at mall level when floor confidence is low.
- The SDK needs Wi-Fi scan results, which require fine location permission on Android; the bank's consent screen must say so.
- iOS does not let apps scan Wi-Fi, but every recent iPhone has a barometer, so the Wi-Fi layer is Android only.
- More data to collect in the field test (below), and more backend work for crowd-labelled fingerprints.

## What the field test must add to evaluate this

1. **Device checks** on every phone (done): share of phones with a working barometer, by model.
2. **A Wi-Fi scan with every ground-truth reading** on Android (access point IDs, signal strength, frequency, RTT capability), within the 4-scans-per-2-minutes limit. This needs a native Wi-Fi module and is the next app change.
3. **Floor accuracy from Wi-Fi alone**, including at atriums and escalator voids where signals leak between floors; compare with the barometer on the same readings.
4. **Holdout test:** on barometer phones, hide the barometer and score Wi-Fi only, to simulate budget phones.
5. **Motion sensor logs** during floor changes, to score inertial transition detection.
