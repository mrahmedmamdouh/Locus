import { buildUniformFloors, classifyFloor, floorCenterM } from './floors';
import { relativeAltitudeFromPressure } from './pressure';
import type { Reading } from './types';
import { cleanAccessPoints, type WifiScan } from './wifi';

/** Deterministic pseudo-random generator (mulberry32) so sample data is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box–Muller. */
function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * SYNTHETIC readings for demos and tests only — not field data.
 * Models barometer noise (~0.6 m), slow drift, and much noisier GPS altitude.
 */
export function generateSampleReadings(seed = 42, perFloor = 12): Reading[] {
  const rand = rng(seed);
  const venues = [
    { id: 'demo-muscat', name: 'Demo Mall Muscat (synthetic)', floors: buildUniformFloors(1, 2, 5) },
    { id: 'demo-cairo', name: 'Demo Mall Cairo (synthetic)', floors: buildUniformFloors(2, 3, 4.5) },
  ];
  const devices = [
    { model: 'iPhone 15', platform: 'ios', baroNoise: 0.5, gpsNoise: 9 },
    { model: 'Pixel 8', platform: 'android', baroNoise: 0.7, gpsNoise: 12 },
    { model: 'Galaxy A54', platform: 'android', baroNoise: 1.0, gpsNoise: 15 },
  ];
  const out: Reading[] = [];
  let id = 0;
  for (const venue of venues) {
    for (const device of devices) {
      const sessionId = `${venue.id}-${device.model.replace(/\s+/g, '-').toLowerCase()}`;
      const baseline = 1008 + rand() * 6;
      const tempC = 24;
      const driftPerMin = (rand() - 0.5) * 0.004; // hPa per minute of weather drift
      let seconds = 30;
      for (const floor of venue.floors) {
        for (let k = 0; k < perFloor; k++) {
          seconds += 20 + Math.floor(rand() * 40);
          const trueZ = floorCenterM(floor) + (rand() - 0.5) * 1.0;
          const ideal = baseline * Math.exp((-trueZ * 9.80665) / (287.053 * (tempC + 273.15)));
          const pressure = ideal + (seconds / 60) * driftPerMin + (gauss(rand) * device.baroNoise) / 8.7;
          const baro = relativeAltitudeFromPressure(pressure, baseline, tempC);
          const gpsRel = trueZ + gauss(rand) * device.gpsNoise;
          out.push({
            id: `s${++id}`,
            sessionId,
            venueId: venue.id,
            venueName: venue.name,
            deviceModel: device.model,
            platform: device.platform,
            timestamp: new Date(Date.UTC(2026, 9, 27, 10, 0, seconds)).toISOString(),
            secondsSinceCalibration: seconds,
            trueFloorLabel: floor.label,
            trueFloorIndex: floor.index,
            trueFloorCenterM: floorCenterM(floor),
            trueFloorHeightM: floor.zMaxM - floor.zMinM,
            pressureHpa: round(pressure, 3),
            baselinePressureHpa: round(baseline, 3),
            temperatureC: tempC,
            baroRelAltM: round(baro, 2),
            osRelAltM: device.platform === 'ios' ? round(baro + gauss(rand) * 0.2, 2) : null,
            gpsLat: 23.588 + rand() * 0.0005,
            gpsLon: 58.383 + rand() * 0.0005,
            gpsAltM: round(20 + gpsRel, 1),
            gpsAccuracyM: round(8 + rand() * 25, 1),
            gpsAltAccuracyM: round(6 + rand() * 20, 1),
            gpsRelAltM: round(gpsRel, 1),
            estFloorIndexBaro: classifyFloor(baro, venue.floors)?.index ?? null,
            estFloorIndexGps: classifyFloor(gpsRel, venue.floors)?.index ?? null,
            sampleCount: 50,
            wifiScanStatus: device.platform === 'android' ? 'ok' : 'unsupported',
            wifiApCount: null, // filled by generateSampleWifiScans
            notes: 'synthetic',
          });
        }
      }
    }
  }
  return out;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f || 0; // || 0 turns -0 into 0
}

/**
 * SYNTHETIC Wi-Fi scans for the Android sample readings (demos and tests only).
 * Each venue has a few access points per floor; signal falls with distance and
 * by ~15 dB per floor slab, plus noise. Mutates `wifiApCount` on the readings.
 */
export function generateSampleWifiScans(readings: Reading[], seed = 7): WifiScan[] {
  const rand = rng(seed);
  const apsByVenue = new Map<string, { bssid: string; floor: number; x: number; y: number; freq: number }[]>();
  for (const r of readings) {
    if (apsByVenue.has(r.venueId)) continue;
    const floors = [...new Set(readings.filter((x) => x.venueId === r.venueId).map((x) => x.trueFloorIndex))];
    const aps: { bssid: string; floor: number; x: number; y: number; freq: number }[] = [];
    let n = 0;
    for (const f of floors) {
      for (let i = 0; i < 4; i++) {
        n++;
        const hex = (v: number) => v.toString(16).padStart(2, '0');
        aps.push({
          bssid: `a4:${hex(r.venueId.length)}:${hex(f + 10)}:${hex(i)}:${hex(n)}:${hex(Math.floor(rand() * 255))}`,
          floor: f,
          x: rand() * 120,
          y: rand() * 60,
          freq: rand() < 0.5 ? 2437 : 5180,
        });
      }
    }
    apsByVenue.set(r.venueId, aps);
  }
  const scans: WifiScan[] = [];
  for (const r of readings) {
    if (r.platform !== 'android') continue;
    const px = rand() * 120;
    const py = rand() * 60;
    const raw = (apsByVenue.get(r.venueId) ?? []).map((ap) => {
      const d = Math.max(1, Math.hypot(ap.x - px, ap.y - py));
      const rssi = -35 - 25 * Math.log10(d) - 15 * Math.abs(ap.floor - r.trueFloorIndex) + gauss(rand) * 4;
      return { bssid: ap.bssid, rssiDbm: Math.round(rssi), frequencyMhz: ap.freq, rttResponder: false, ageMs: Math.floor(rand() * 4000) };
    });
    const { aps } = cleanAccessPoints(raw.filter((a) => a.rssiDbm > -92));
    r.wifiApCount = aps.length;
    scans.push({
      readingId: r.id,
      sessionId: r.sessionId,
      venueId: r.venueId,
      trueFloorIndex: r.trueFloorIndex,
      scannedAt: r.timestamp,
      status: 'ok',
      aps,
    });
  }
  return scans;
}
