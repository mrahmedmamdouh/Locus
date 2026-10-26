import { escapeCsvCell, parseCsvRows, unescapeCsvText } from './csv';

/**
 * Device capability check: which altitude sources a phone actually offers.
 * One row per check. Exported as its own CSV (different header from readings),
 * so the dashboard can report sensor coverage across the phones tested,
 * including phones that cannot take part in the barometer test.
 */
export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'not-required' | 'unknown';

export interface DeviceCheck {
  id: string;
  timestamp: string; // ISO 8601
  deviceModel: string;
  brand: string;
  platform: 'ios' | 'android' | 'web' | string;
  osVersion: string;
  appVersion: string;

  /** The OS reports a barometer sensor. */
  hasBarometer: boolean;
  /** iOS Motion & Fitness permission (Android needs none for the barometer). */
  barometerPermission: PermissionState;
  /** Median pressure over the check window, proving the sensor really reports. */
  barometerSampleHpa: number | null;
  /** Observed barometer update rate. */
  barometerRateHz: number | null;
  /** iOS only: the OS altimeter returned a relative altitude. */
  osAltimeterAvailable: boolean;

  locationPermission: PermissionState;
  /** A GPS/fused fix was obtained during the check. */
  gpsFix: boolean;
  /** That fix included an altitude value. */
  gpsAltitudeAvailable: boolean;
  gpsAccuracyM: number | null;
  gpsAltAccuracyM: number | null;

  notes: string;
}

export const DEVICE_CHECK_COLUMNS = [
  'id',
  'timestamp',
  'deviceModel',
  'brand',
  'platform',
  'osVersion',
  'appVersion',
  'hasBarometer',
  'barometerPermission',
  'barometerSampleHpa',
  'barometerRateHz',
  'osAltimeterAvailable',
  'locationPermission',
  'gpsFix',
  'gpsAltitudeAvailable',
  'gpsAccuracyM',
  'gpsAltAccuracyM',
  'notes',
] as const satisfies readonly (keyof DeviceCheck)[];

const BOOLEAN: ReadonlySet<keyof DeviceCheck> = new Set<keyof DeviceCheck>([
  'hasBarometer',
  'osAltimeterAvailable',
  'gpsFix',
  'gpsAltitudeAvailable',
]);
const NUMERIC: ReadonlySet<keyof DeviceCheck> = new Set<keyof DeviceCheck>([
  'barometerSampleHpa',
  'barometerRateHz',
  'gpsAccuracyM',
  'gpsAltAccuracyM',
]);

/** True when a CSV header row is a device-check export (not a readings export). */
export function isDeviceCheckCsv(text: string): boolean {
  const header = parseCsvRows(text.slice(0, 4096))[0] ?? [];
  return header.includes('hasBarometer') && header.includes('osVersion');
}

export function deviceChecksToCsv(checks: DeviceCheck[]): string {
  const lines = [DEVICE_CHECK_COLUMNS.join(',')];
  for (const c of checks) lines.push(DEVICE_CHECK_COLUMNS.map((k) => escapeCsvCell(c[k])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function csvToDeviceChecks(text: string): { checks: DeviceCheck[]; errors: string[] } {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { checks: [], errors: ['File is empty.'] };
  const header = rows[0]!.map((h) => h.trim());
  const missing = DEVICE_CHECK_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { checks: [], errors: [`Missing columns: ${missing.join(', ')}`] };
  const idx = new Map(header.map((h, i) => [h, i] as const));
  const checks: DeviceCheck[] = [];
  const errors: string[] = [];
  rows.slice(1).forEach((cells, n) => {
    const line = n + 2;
    if (cells.length !== header.length) {
      errors.push(`Row ${line}: has ${cells.length} cells, expected ${header.length}`);
      return;
    }
    const out: Record<string, unknown> = {};
    const bad: string[] = [];
    for (const col of DEVICE_CHECK_COLUMNS) {
      const cell = cells[idx.get(col)!] ?? '';
      if (BOOLEAN.has(col)) {
        const v = cell.trim().toLowerCase();
        if (v === 'true') out[col] = true;
        else if (v === 'false') out[col] = false;
        else bad.push(col);
      } else if (NUMERIC.has(col)) {
        const v = cell.trim();
        const num = v === '' ? null : /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) ? Number(v) : NaN;
        if (num !== null && !Number.isFinite(num)) bad.push(col);
        out[col] = num;
      } else {
        out[col] = unescapeCsvText(cell);
      }
    }
    if (bad.length) {
      errors.push(`Row ${line}: invalid value in ${bad.join(', ')}`);
      return;
    }
    checks.push(out as unknown as DeviceCheck);
  });
  return { checks, errors };
}

export interface CoverageRow {
  group: string;
  /** Distinct phones (by model + OS version) checked in this group. */
  devices: number;
  withBarometer: number;
  withGpsAltitude: number;
  /** Share of phones with a working barometer (0–1). */
  barometerShare: number;
}

/**
 * Sensor coverage. Repeated checks of the same phone (same model + OS version)
 * count once; the latest check wins.
 */
export function summarizeCoverage(
  checks: DeviceCheck[],
  key: (c: DeviceCheck) => string = (c) => c.deviceModel,
): { overall: CoverageRow; groups: CoverageRow[] } {
  const latest = new Map<string, DeviceCheck>();
  for (const c of checks) {
    const id = `${c.platform}|${c.deviceModel}|${c.osVersion}`;
    const prev = latest.get(id);
    if (!prev || c.timestamp > prev.timestamp) latest.set(id, c);
  }
  const phones = [...latest.values()];
  const row = (group: string, list: DeviceCheck[]): CoverageRow => {
    const withBarometer = list.filter(barometerWorks).length;
    return {
      group,
      devices: list.length,
      withBarometer,
      withGpsAltitude: list.filter((c) => c.gpsAltitudeAvailable).length,
      barometerShare: list.length ? withBarometer / list.length : 0,
    };
  };
  const groups = new Map<string, DeviceCheck[]>();
  for (const c of phones) {
    const k = key(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  return {
    overall: row('All phones', phones),
    groups: [...groups.entries()].map(([g, l]) => row(g, l)).sort((a, b) => a.group.localeCompare(b.group)),
  };
}

/** A barometer only counts if it exists, is permitted, and actually reported a pressure. */
export function barometerWorks(c: DeviceCheck): boolean {
  return (
    c.hasBarometer &&
    c.barometerPermission !== 'denied' &&
    c.barometerSampleHpa !== null &&
    c.barometerSampleHpa > 300 &&
    c.barometerSampleHpa < 1100
  );
}
