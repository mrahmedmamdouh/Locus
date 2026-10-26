# Field-test protocol: floor detection in malls

Practical instructions for testers collecting altitude readings in malls in **Cairo** and **Muscat**. The goal is a dataset that lets the dashboard give an honest verdict on one question: *can a calibrated phone barometer tell which floor a shopper is on?* Background: [ADR 0001](adr/0001-barometer-relative-altitude.md).

A good session takes about 60–90 minutes per venue for one tester with one phone.

## 1. Equipment

- **At least 3 phone models** across the team, including:
  - one **iPhone** (iPhone 8 or newer; all have a barometer),
  - one **mid-range Android** (e.g. Samsung Galaxy A5x, Xiaomi Redmi Note, Oppo Reno), because that is what most bank customers carry,
  - ideally one flagship Android (Pixel or Galaxy S).
  Check the Android phone has a pressure sensor before you go: the app shows "barometer unavailable" if not. Many budget Androids have none; record that as a finding, not a failure.
- The Locus app installed through Expo Go (see the [README](../README.md#quick-start)), on the latest build.
- Phones charged above 80%, plus a power bank. Battery saver **off** (it throttles sensors).
- Location permission set to "While using the app", precise location on.
- A notebook or a notes app for the venue sheet (section 2).
- Optional: a laser distance meter for floor heights.

## 2. Venue setup (once per venue)

Do this before the first calibration, using the mall directory and a quick walk.

1. **Count the floors**, including basements, parking levels you will test, and mezzanines. Use the mall's own labels (G, 1, 2, B1, "Food court"...).
2. **Floor height** (slab to slab). In order of preference:
   - measure it: laser meter from a balcony edge to the floor below, or count stair steps × riser height (typically 15–17 cm);
   - estimate from escalators: a mall escalator at 30° covering about 9 m of horizontal run rises about 5.2 m;
   - fall back to **4.5 m** for retail floors and **5–6 m** for the ground floor of large malls.
   Note whether floor heights differ (ground floors are often taller). If they do, enter per-floor bands in the app rather than a uniform height.
3. **Entrance level:** note which entrance you calibrate at and which floor it opens onto. That floor is index 0; everything else is relative to it. If the mall has entrances on several levels (common in Cairo malls built on slopes), always use the **same** entrance for a venue.
4. Create or select the venue in the app with its city and country (EG or OM) and the floor table.

Venue sheet to keep in your notes:

```
Venue: <name>, <city>, <country>
Date / tester / phone model:
Calibration entrance: <gate name>, opens onto floor <label>
Floors and heights: B1 -4.5 | G 0 | 1 +5.0 | 2 +9.5 ...
How heights were obtained: measured / escalator / default
Weather: clear / windy / front passing; outside temperature
```

## 3. Calibration

Calibration records the entrance pressure as height 0. Every later reading is relative to it, so a bad calibration spoils the whole session.

1. Stand **just inside** the entrance, on the entrance floor, at least **3 m away from doors**, revolving doors and HVAC supply vents or air curtains.
2. Hold the phone in your hand at chest height, screen up.
3. Tap **Calibrate** and **stand still for 10 seconds**. Do not walk, wave the phone or put it away until the app confirms.
4. **Recalibrate**:
   - every **20 minutes**,
   - whenever you **leave the building** (even briefly, e.g. to the parking deck outside),
   - after any noticeable weather change (rain, wind gusts, sandstorm),
   - if a reading on the entrance floor shows more than about 1.5 m of height.
   To recalibrate, walk back to the same entrance. If that is impractical, calibrate at another point on the **entrance floor** and note it.

## 4. Recording readings

The rule: **you must know the true floor with certainty** before you tap Record. A wrong ground-truth label is worse than a missing reading.

Per floor, take **at least 10 readings at different spots**, spread across:

| Spot | Why |
| --- | --- |
| Next to escalators (top and bottom landings) | Where shoppers change floors; tests edge cases |
| Atrium edges and open voids | Air moves between floors; pressure can mix |
| Far corners and shop fronts away from atriums | Typical merchant locations |
| Near the food court, cinema and car-park lifts | Heavy HVAC, door traffic |
| Middle of corridors | Baseline |

For each reading:

1. Walk to the spot, **stop, and stand still for about 5 seconds** with the phone in your hand.
2. Confirm the floor from a directory sign, a lift lobby label or the shop unit number (e.g. "F1-23").
3. Select the true floor in the app and tap **Record**. The app averages several sensor samples into one reading.
4. Add a short note only if something unusual happened (`near door`, `escalator moving`, `phone in pocket`). See section 6 for what never goes in notes.

**Mezzanines and split levels:** record them as their own floor with their own measured band if the mall signs them as a level. If you cannot tell whether you are on the mezzanine or the floor below, do not record there.

**Order:** vary the route (e.g. G → 2 → 1 → B1 → G) so drift since calibration does not line up with one floor. End every session back on the entrance floor with 3 readings; they show how much the calibration drifted.

**Phone posture:** most readings in hand. Take a deliberate few (about 10% of the session) in a trouser pocket and in a bag, and note `pocket` or `bag`, so we learn whether posture matters.

## 5. Sample size and coverage

The gate needs **at least 200 readings across at least 2 venues**. Aim higher so each phone and each country can be judged on its own:

| Target | Minimum | Aim |
| --- | --- | --- |
| Venues | 2 total | **2 in Cairo + 2 in Muscat** |
| Floors per venue | 3 | All public floors, including one basement or car park |
| Readings per floor per phone | 10 | 15 |
| Readings total | 200 | 400+ |
| Phone models | 3 | 3–5, at least 1 iOS and 1 mid-range Android |

Example: a 4-floor mall × 15 readings × 3 phones = 180 readings in one visit. Two such malls per country is plenty.

Suggested venues are large multi-level malls with atriums (in Cairo: e.g. Mall of Arabia, City Stars, Cairo Festival City; in Muscat: e.g. Mall of Oman, Muscat Grand Mall, Avenues Mall). Get mall management permission if security asks; you are only standing around with a phone.

## 6. Data handling

- **Export a CSV at the end of every test day** (and before uninstalling or updating the app). Data lives only on the phone until exported.
- **File name:** `locus_<country>_<venue-slug>_<yyyy-mm-dd>_<device>_<tester-initials>.csv`, e.g. `locus_EG_city-stars_2026-11-14_pixel8_am.csv`.
- Upload to the team's shared drive folder for the test. **Do not commit CSVs to this repository** and do not post them in public channels; they contain precise indoor GPS fixes.
- **Never put personal data in notes:** no names, phone numbers, faces, card numbers, or descriptions of other shoppers. Notes are for conditions only.
- Keep your venue sheet with the CSV (same file name, `.txt`).

## 7. Known pitfalls

| Pitfall | Effect | What to do |
| --- | --- | --- |
| **Doors opening, air curtains, AC** | Malls run slightly over-pressured; main doors and car-park doors cause pressure pulses of 0.1–0.3 hPa (1–3 m) | Calibrate and record ≥ 3 m from doors and vents; wait 5 s after a door bank opens; note `near door` |
| **Elevators** | Lift cars are pressurised differently and moving; readings inside are meaningless | Never record inside a lift. Step out, walk a few metres, wait 5 s |
| **Moving escalators** | You are changing height during the averaging window | Record at the landing after stepping off, not on the escalator |
| **Weather fronts** | Outdoor pressure can move 1–2 hPa in a few hours (10–20 m); also leaks into the building | Recalibrate every 20 min; avoid days with sandstorms (khamaseen in Cairo, shamal in Muscat) or note them |
| **Phone in pocket or bag** | Body heat and a closed pocket smooth or delay the reading; can add offset | Default to in-hand; tag pocket/bag readings |
| **Holding the phone over your head or squatting** | ±1 m directly | Chest height every time |
| **Thermal drift** | Coming in from 40 °C outside, the sensor warms down for minutes | After entering, wait 2 minutes inside before calibrating |
| **GPS indoors** | No fix or a fix tens of metres off; that is expected | Still record; empty GPS columns are valid data |
| **Mislabelled ground truth** | Kills accuracy for that reading | When unsure, skip |

## 8. Reading the dashboard verdict

Open the dashboard ([live](https://mrahmedmamdouh.github.io/Locus/)), load all CSVs from the test, and set the floor height you used. It shows accuracy per source (barometer, OS altitude on iOS, GPS), per device and per venue, plus a drift chart by minutes since calibration, and one verdict:

| Verdict | Meaning | Next step |
| --- | --- | --- |
| **PASS** | Barometer floor accuracy ≥ 85% and p90 error < half a floor, on ≥ 200 readings from ≥ 2 venues | Proceed: build 3D geofences on barometric relative altitude. Check that each country and each phone class also passes on its own before relying on it there. |
| **INSUFFICIENT DATA** | Under 200 readings or under 2 venues | Collect more (section 5). Do not read anything into the numbers yet. |
| **FAIL** | Enough data, but accuracy or p90 error misses the bar | Diagnose, then decide (below). |

**On FAIL, diagnose first.** Look for a fixable cause before abandoning the approach:

- Error grows with minutes since calibration → drift; shorten the recalibration interval and retest.
- One device model is far worse → exclude that sensor class (or phones without a barometer) and retest on the rest.
- One venue or one floor is far worse → check its floor table and heights; atrium-heavy or car-park floors may need wider bands.
- Readings tagged `near door` or `pocket` dominate the errors → tighten the protocol.

**If it still fails**, fall back as the strategy doc describes: use **Wi-Fi fingerprinting and/or BLE beacons** placed per floor in partner malls to identify the floor, with the barometer only as a tie-breaker for floor changes. This costs hardware and mall partnerships, so record the barometer results anyway; they size how many beacons are needed.
