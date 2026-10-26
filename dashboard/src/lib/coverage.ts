/**
 * Sensor coverage: shaping device checks for the dashboard. The coverage
 * maths (de-duplication, "barometer works") lives in @locus/altitude-core;
 * this module only arranges rows around it.
 */
import { barometerWorks, summarizeCoverage } from '@locus/altitude-core';
import type { CoverageRow, DeviceCheck, Reading } from '@locus/altitude-core';

export type BarometerState = 'works' | 'blocked' | 'no-signal' | 'none';

export const BAROMETER_STATE_LABEL: Record<BarometerState, string> = {
  works: 'Yes',
  blocked: 'Blocked by permission',
  'no-signal': 'No valid reading',
  none: 'No',
};

/** Why a phone's barometer does or does not count, using the library's `barometerWorks` rule. */
export function barometerState(c: DeviceCheck): BarometerState {
  if (barometerWorks(c)) return 'works';
  if (!c.hasBarometer) return 'none';
  if (c.barometerPermission === 'denied') return 'blocked';
  return 'no-signal';
}

/** Same identity `summarizeCoverage` uses for a phone. */
const phoneKey = (c: DeviceCheck) => `${c.platform}|${c.deviceModel}|${c.osVersion}`;

export interface PhoneRow {
  key: string;
  check: DeviceCheck;
  /** How many checks were loaded for this phone (latest one shown). */
  checks: number;
  barometer: BarometerState;
}

/**
 * One row per phone (model + OS version), latest check wins, sorted by brand
 * then model. Matches the de-duplication `summarizeCoverage` applies.
 */
export function phoneRows(checks: readonly DeviceCheck[]): PhoneRow[] {
  const latest = new Map<string, { check: DeviceCheck; checks: number }>();
  for (const c of checks) {
    const k = phoneKey(c);
    const prev = latest.get(k);
    if (!prev) latest.set(k, { check: c, checks: 1 });
    else latest.set(k, { check: c.timestamp > prev.check.timestamp ? c : prev.check, checks: prev.checks + 1 });
  }
  return [...latest.entries()]
    .map(([key, v]) => ({ key, ...v, barometer: barometerState(v.check) }))
    .sort(
      (a, b) =>
        a.check.brand.localeCompare(b.check.brand) ||
        a.check.deviceModel.localeCompare(b.check.deviceModel) ||
        a.check.osVersion.localeCompare(b.check.osVersion),
    );
}

export const PLATFORM_LABEL: Record<string, string> = { ios: 'iOS', android: 'Android', web: 'Web' };
export const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? (p || 'Unknown');
const brandLabel = (b: string) => b.trim() || 'Unknown';

export interface Coverage {
  overall: CoverageRow;
  byPlatform: CoverageRow[];
  byBrand: CoverageRow[];
  phones: PhoneRow[];
}

export function coverage(checks: DeviceCheck[]): Coverage {
  const byPlatform = summarizeCoverage(checks, (c) => platformLabel(c.platform));
  return {
    overall: byPlatform.overall,
    byPlatform: byPlatform.groups,
    byBrand: summarizeCoverage(checks, (c) => brandLabel(c.brand)).groups,
    phones: phoneRows(checks),
  };
}

/* ------------------------------------------------------------------ */
/* Cross-check with readings                                           */
/* ------------------------------------------------------------------ */

const modelKey = (m: string) => m.trim().toLowerCase();

export interface CrossCheck {
  /** Models seen in readings with no device check loaded. */
  readingsWithoutCheck: string[];
  /** Models with a device check but no readings loaded. */
  checksWithoutReadings: string[];
}

/** Compare device models across the two exports (trimmed, case-insensitive). */
export function crossCheck(readings: readonly Reading[], checks: readonly DeviceCheck[]): CrossCheck {
  const distinct = (models: string[]) => {
    const m = new Map<string, string>();
    for (const x of models) if (x.trim() && !m.has(modelKey(x))) m.set(modelKey(x), x.trim());
    return m;
  };
  const inReadings = distinct(readings.map((r) => r.deviceModel));
  const inChecks = distinct(checks.map((c) => c.deviceModel));
  const missing = (a: Map<string, string>, b: Map<string, string>) =>
    [...a.entries()].filter(([k]) => !b.has(k)).map(([, v]) => v).sort((x, y) => x.localeCompare(y));
  return {
    readingsWithoutCheck: missing(inReadings, inChecks),
    checksWithoutReadings: missing(inChecks, inReadings),
  };
}

/* ------------------------------------------------------------------ */
/* Synthetic sample                                                    */
/* ------------------------------------------------------------------ */

type SamplePhone = [
  model: string,
  brand: string,
  platform: 'ios' | 'android',
  os: string,
  baro: boolean,
  extra?: Partial<DeviceCheck>,
];

// iPhones and flagship Androids carry a barometer; many budget Androids sold in Egypt do not.
const SAMPLE_PHONES: SamplePhone[] = [
  ['iPhone 15', 'Apple', 'ios', '17.5', true],
  ['iPhone 13', 'Apple', 'ios', '18.1', true],
  ['iPhone 11', 'Apple', 'ios', '17.2', true, { barometerPermission: 'denied', barometerSampleHpa: null, barometerRateHz: null, osAltimeterAvailable: false }],
  ['Pixel 8', 'Google', 'android', '14', true],
  ['Galaxy S24', 'Samsung', 'android', '14', true],
  ['Galaxy A15', 'Samsung', 'android', '14', false],
  ['Redmi Note 13', 'Xiaomi', 'android', '13', false],
  ['Redmi 13C', 'Xiaomi', 'android', '13', false, { gpsAltitudeAvailable: false, gpsAltAccuracyM: null }],
  ['Oppo A58', 'Oppo', 'android', '13', false],
  ['Infinix Hot 40', 'Infinix', 'android', '13', false],
  ['Tecno Spark 20', 'Tecno', 'android', '13', false, { gpsFix: false, gpsAltitudeAvailable: false, gpsAccuracyM: null, gpsAltAccuracyM: null }],
];

/**
 * Deterministic synthetic device checks for the demo. Notes are "synthetic"
 * so the existing exclusion applies; one phone is checked twice to show the
 * latest-check-wins de-duplication.
 */
export function generateSampleDeviceChecks(): DeviceCheck[] {
  const out: DeviceCheck[] = SAMPLE_PHONES.map(([model, brand, platform, os, baro, extra], i) => {
    const day = String(10 + i).padStart(2, '0');
    return {
      id: `synthetic-dc-${String(i + 1).padStart(2, '0')}`,
      timestamp: `2026-10-${day}T09:${String(10 + i * 3).padStart(2, '0')}:00.000Z`,
      deviceModel: model,
      brand,
      platform,
      osVersion: os,
      appVersion: '0.1.0',
      hasBarometer: baro,
      barometerPermission: platform === 'ios' ? 'granted' : 'not-required',
      barometerSampleHpa: baro ? Math.round((1009.2 + i * 0.37) * 10) / 10 : null,
      barometerRateHz: baro ? (platform === 'ios' ? 1 : 10) : null,
      osAltimeterAvailable: platform === 'ios' && baro,
      locationPermission: 'granted',
      gpsFix: true,
      gpsAltitudeAvailable: true,
      gpsAccuracyM: 6 + (i % 4) * 3,
      gpsAltAccuracyM: 8 + (i % 5) * 4,
      notes: 'synthetic',
      ...extra,
    };
  });
  // Earlier re-check of the Pixel 8: superseded by the later one above.
  out.push({ ...out[3]!, id: 'synthetic-dc-12', timestamp: '2026-10-01T08:00:00.000Z', gpsAltAccuracyM: 30 });
  return out;
}
