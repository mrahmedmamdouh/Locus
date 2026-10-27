/**
 * Dashboard-specific pure logic: loading/merging files, row exclusion, table
 * filters, pagination and chart-shaping. All accuracy maths lives in
 * @locus/altitude-core; this module only arranges data around it.
 */
import {
  altitudeFor,
  csvToDeviceChecks,
  csvToReadings,
  driftByMinutes,
  floorHeightFor,
  csvToWifiScans,
  isDeviceCheckCsv,
  isWifiScanCsv,
} from '@locus/altitude-core';
import type { AltitudeSource, DeviceCheck, Reading, WifiScan } from '@locus/altitude-core';

/* ------------------------------------------------------------------ */
/* Loading and merging                                                 */
/* ------------------------------------------------------------------ */

/** What a loaded CSV contains: field readings, device capability checks or Wi-Fi scans. */
export type FileKind = 'readings' | 'device-checks' | 'wifi-scans';

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  readings: 'Readings',
  'device-checks': 'Device checks',
  'wifi-scans': 'Wi-Fi scans',
};

export interface FileReport {
  /** Display name of the file (or "Synthetic sample"). */
  name: string;
  /** Which kind of export this file was detected as. */
  kind: FileKind;
  /** Rows parsed successfully (for Wi-Fi scan files: scans, i.e. distinct reading ids). */
  parsed: number;
  /** Parsed rows actually added (not duplicates of an already-loaded id). */
  added: number;
  /** Parsed rows skipped because their id was already loaded. */
  duplicates: number;
  /** Parse problems reported by csvToReadings (rows skipped). */
  errors: string[];
  /** True for generated demo data. */
  synthetic: boolean;
}

export interface Dataset {
  readings: Reading[];
  deviceChecks: DeviceCheck[];
  /** Wi-Fi scans, one per reading (joined to readings by readingId). */
  wifiScans: WifiScan[];
  files: FileReport[];
}

export const EMPTY_DATASET: Dataset = { readings: [], deviceChecks: [], wifiScans: [], files: [] };

/**
 * Merge new rows into an existing list, de-duplicating by id.
 * The first occurrence of an id wins, so re-uploading a file is a no-op.
 * Rows with an empty id cannot be de-duplicated and are always kept.
 */
export function mergeById<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): { items: T[]; added: number; duplicates: number } {
  const seen = new Set<string>();
  for (const r of existing) if (r.id) seen.add(r.id);
  const items = existing.slice();
  let added = 0;
  let duplicates = 0;
  for (const r of incoming) {
    if (r.id) {
      if (seen.has(r.id)) {
        duplicates++;
        continue;
      }
      seen.add(r.id);
    }
    items.push(r);
    added++;
  }
  return { items, added, duplicates };
}

/** Merge readings by reading id (see `mergeById`). */
export function mergeReadings(
  existing: readonly Reading[],
  incoming: readonly Reading[],
): { readings: Reading[]; added: number; duplicates: number } {
  const m = mergeById(existing, incoming);
  return { readings: m.items, added: m.added, duplicates: m.duplicates };
}

/** Merge device checks by check id (see `mergeById`). */
export function mergeDeviceChecks(
  existing: readonly DeviceCheck[],
  incoming: readonly DeviceCheck[],
): { deviceChecks: DeviceCheck[]; added: number; duplicates: number } {
  const m = mergeById(existing, incoming);
  return { deviceChecks: m.items, added: m.added, duplicates: m.duplicates };
}

/** Merge Wi-Fi scans by reading id (one scan per reading; first occurrence wins). */
export function mergeWifiScans(
  existing: readonly WifiScan[],
  incoming: readonly WifiScan[],
): { wifiScans: WifiScan[]; added: number; duplicates: number } {
  const m = mergeById(
    existing.map((s) => ({ id: s.readingId, s })),
    incoming.map((s) => ({ id: s.readingId, s })),
  );
  return { wifiScans: m.items.map((x) => x.s), added: m.added, duplicates: m.duplicates };
}

/** Add one parsed source (a CSV file or the synthetic sample) to a dataset. */
export function addSource(
  dataset: Dataset,
  name: string,
  incoming: readonly Reading[],
  errors: readonly string[],
  synthetic = false,
): Dataset {
  const merged = mergeReadings(dataset.readings, incoming);
  return {
    ...dataset,
    readings: merged.readings,
    files: [
      ...dataset.files,
      {
        name,
        kind: 'readings',
        parsed: incoming.length,
        added: merged.added,
        duplicates: merged.duplicates,
        errors: [...errors],
        synthetic,
      },
    ],
  };
}

/** Add one parsed device-check source (a CSV file or the synthetic sample) to a dataset. */
export function addDeviceCheckSource(
  dataset: Dataset,
  name: string,
  incoming: readonly DeviceCheck[],
  errors: readonly string[],
  synthetic = false,
): Dataset {
  const merged = mergeDeviceChecks(dataset.deviceChecks, incoming);
  return {
    ...dataset,
    deviceChecks: merged.deviceChecks,
    files: [
      ...dataset.files,
      {
        name,
        kind: 'device-checks',
        parsed: incoming.length,
        added: merged.added,
        duplicates: merged.duplicates,
        errors: [...errors],
        synthetic,
      },
    ],
  };
}

/** Add one parsed Wi-Fi scan source (a CSV file or the synthetic sample) to a dataset. */
export function addWifiScanSource(
  dataset: Dataset,
  name: string,
  incoming: readonly WifiScan[],
  errors: readonly string[],
  synthetic = false,
): Dataset {
  const merged = mergeWifiScans(dataset.wifiScans, incoming);
  return {
    ...dataset,
    wifiScans: merged.wifiScans,
    files: [
      ...dataset.files,
      {
        name,
        kind: 'wifi-scans',
        parsed: incoming.length,
        added: merged.added,
        duplicates: merged.duplicates,
        errors: [...errors],
        synthetic,
      },
    ],
  };
}

/** Which kind of export a CSV is, from its header row. Wi-Fi scans are checked first. */
export function detectFileKind(text: string): FileKind {
  try {
    if (isWifiScanCsv(text)) return 'wifi-scans';
    return isDeviceCheckCsv(text) ? 'device-checks' : 'readings';
  } catch {
    return 'readings';
  }
}

const parseFailure = (err: unknown) => `Could not parse file: ${err instanceof Error ? err.message : String(err)}`;

/**
 * Parse CSV text and add it to a dataset, routing device-check exports to the
 * device-check list and everything else to readings. Never throws: problems
 * land in the file report.
 */
export function addCsvText(dataset: Dataset, name: string, text: string): Dataset {
  const kind = detectFileKind(text);
  if (kind === 'wifi-scans') {
    let result: { scans: WifiScan[]; errors: string[] };
    try {
      result = csvToWifiScans(text);
    } catch (err) {
      result = { scans: [], errors: [parseFailure(err)] };
    }
    return addWifiScanSource(dataset, name, result.scans, result.errors);
  }
  if (kind === 'device-checks') {
    let result: { checks: DeviceCheck[]; errors: string[] };
    try {
      result = csvToDeviceChecks(text);
    } catch (err) {
      result = { checks: [], errors: [parseFailure(err)] };
    }
    return addDeviceCheckSource(dataset, name, result.checks, result.errors);
  }
  let result: { readings: Reading[]; errors: string[] };
  try {
    result = csvToReadings(text);
  } catch (err) {
    result = { readings: [], errors: [parseFailure(err)] };
  }
  return addSource(dataset, name, result.readings, result.errors);
}

/* ------------------------------------------------------------------ */
/* Row exclusion (DEMO / synthetic notes)                              */
/* ------------------------------------------------------------------ */

export interface ExclusionOptions {
  /** Exclude rows whose notes start with "DEMO" (app demo mode). */
  excludeDemo: boolean;
  /** Exclude rows whose notes equal "synthetic" (generated sample data). */
  excludeSynthetic: boolean;
}

export const DEFAULT_EXCLUSION: ExclusionOptions = { excludeDemo: true, excludeSynthetic: false };

/** Rows with free-text notes: readings and device checks share the exclusion rules. */
type WithNotes = { notes?: string | null };

export function isDemoRow(r: WithNotes): boolean {
  return (r.notes ?? '').trim().startsWith('DEMO');
}

export function isSyntheticRow(r: WithNotes): boolean {
  return (r.notes ?? '').trim().toLowerCase() === 'synthetic';
}

export function applyExclusions<T extends WithNotes>(readings: readonly T[], opts: ExclusionOptions): T[] {
  return readings.filter(
    (r) => !(opts.excludeDemo && isDemoRow(r)) && !(opts.excludeSynthetic && isSyntheticRow(r)),
  );
}

/**
 * Wi-Fi scans carry no notes, so the DEMO / synthetic exclusion is applied by
 * joining to readings: a scan is dropped when its reading is loaded and
 * excluded. Scans whose reading is not loaded are kept (nothing to judge by).
 */
export function applyScanExclusions(
  scans: readonly WifiScan[],
  readings: readonly Reading[],
  opts: ExclusionOptions,
): WifiScan[] {
  const kept = new Set(applyExclusions(readings, opts).map((r) => r.id));
  const excluded = new Set(readings.filter((r) => !kept.has(r.id)).map((r) => r.id));
  return scans.filter((s) => !excluded.has(s.readingId));
}

/* ------------------------------------------------------------------ */
/* Readings table                                                      */
/* ------------------------------------------------------------------ */

export type Correctness = 'all' | 'correct' | 'incorrect' | 'no-estimate';

export interface TableFilter {
  venue: string; // '' = all
  device: string; // '' = all
  correctness: Correctness;
}

export const DEFAULT_TABLE_FILTER: TableFilter = { venue: '', device: '', correctness: 'all' };

/** On-device floor estimate stored in the CSV (barometer and GPS only; the OS altimeter has none). */
export function estFloor(r: Reading, source: AltitudeSource): number | null {
  if (source === 'os') return null;
  const v = source === 'gps' ? r.estFloorIndexGps : r.estFloorIndexBaro;
  return v === null || !Number.isFinite(v) ? null : v;
}

/**
 * Whether a reading is on the correct floor for a source, matching the rule
 * `summarize` uses for floor accuracy: barometer and GPS compare the stored
 * on-device floor estimate; the iOS OS altimeter is correct when its |error|
 * is below half of the reading's own floor height (`floorHeightFor`, falling
 * back to `fallbackFloorM`). null = no estimate / no value.
 */
export function isCorrect(r: Reading, source: AltitudeSource, fallbackFloorM: number): boolean | null {
  if (source !== 'os') {
    const est = estFloor(r, source);
    return est === null ? null : est === r.trueFloorIndex;
  }
  const alt = altitudeFor(r, source);
  return alt === null ? null : Math.abs(alt - r.trueFloorCenterM) < floorHeightFor(r, fallbackFloorM) / 2;
}

export function filterReadings(
  readings: readonly Reading[],
  filter: TableFilter,
  source: AltitudeSource,
  fallbackFloorM: number,
): Reading[] {
  return readings.filter((r) => {
    if (filter.venue && r.venueId !== filter.venue) return false;
    if (filter.device && r.deviceModel !== filter.device) return false;
    if (filter.correctness === 'all') return true;
    const c = isCorrect(r, source, fallbackFloorM);
    if (filter.correctness === 'correct') return c === true;
    if (filter.correctness === 'incorrect') return c === false;
    return c === null;
  });
}

/**
 * Readings judged against the fallback floor height because they carry no
 * usable `trueFloorHeightM` (CSVs from older app builds). Delegates the
 * "usable height" rule to `floorHeightFor` (a NaN fallback comes back as NaN).
 */
export function countFallbackFloorHeight(readings: readonly Reading[]): number {
  let n = 0;
  for (const r of readings) if (Number.isNaN(floorHeightFor(r, Number.NaN))) n++;
  return n;
}

/** Distinct venues (id + display name), sorted by name. */
export function venueOptions(readings: readonly Reading[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const r of readings) if (!m.has(r.venueId)) m.set(r.venueId, r.venueName || r.venueId);
  return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function distinctSorted(readings: readonly Reading[], key: (r: Reading) => string): string[] {
  return [...new Set(readings.map(key))].sort((a, b) => a.localeCompare(b));
}

export interface Page<T> {
  items: T[];
  page: number; // 0-based, clamped
  pageCount: number; // >= 1
  total: number;
  from: number; // 1-based index of first item, 0 when empty
  to: number;
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const start = p * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: p,
    pageCount,
    total: items.length,
    from: slice.length ? start + 1 : 0,
    to: start + slice.length,
  };
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

export interface ScatterPoint {
  id: string;
  x: number; // true floor centre (m)
  y: number; // estimated relative altitude (m)
  floor: string;
  venue: string;
  device: string;
}

/** Points of estimated altitude vs true floor centre for one source (rows without a value are skipped). */
export function scatterPoints(readings: readonly Reading[], source: AltitudeSource): ScatterPoint[] {
  const out: ScatterPoint[] = [];
  for (const r of readings) {
    const y = altitudeFor(r, source);
    if (y === null || !Number.isFinite(r.trueFloorCenterM)) continue;
    out.push({
      id: r.id,
      x: r.trueFloorCenterM,
      y,
      floor: r.trueFloorLabel,
      venue: r.venueName || r.venueId,
      device: r.deviceModel,
    });
  }
  return out;
}

/** Evenly thin a list to at most `max` items (keeps charts responsive on large uploads). */
export function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return items.slice();
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

export type DriftRow = ReturnType<typeof driftByMinutes>[number];

export interface RecalibrationAdvice {
  kind: 'no-data' | 'stable' | 'recalibrate' | 'exceeds-from-start';
  /** Recommended max minutes between calibrations (for 'recalibrate'). */
  minutes: number | null;
  /** Half a floor height in meters (the threshold used). */
  thresholdM: number;
}

/**
 * Recommend a recalibration interval from drift buckets: the start of the first
 * well-populated bucket whose p90 |error| reaches half a floor. Buckets with
 * fewer than `minN` readings are ignored as too noisy to act on.
 */
export function recalibrationAdvice(
  drift: readonly DriftRow[],
  floorHeightM: number,
  minN = 5,
): RecalibrationAdvice {
  const thresholdM = floorHeightM / 2;
  const usable = drift.filter((d) => d.n >= minN && d.p90AbsErrorM !== null);
  if (usable.length === 0) return { kind: 'no-data', minutes: null, thresholdM };
  const firstBad = usable.find((d) => d.p90AbsErrorM! >= thresholdM);
  if (!firstBad) return { kind: 'stable', minutes: null, thresholdM };
  if (firstBad === usable[0]) return { kind: 'exceeds-from-start', minutes: null, thresholdM };
  return { kind: 'recalibrate', minutes: firstBad.minutesFrom, thresholdM };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function fmtPct(x: number | null | undefined, dp = 1): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(dp)}%`;
}

export function fmtM(x: number | null | undefined, dp = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x.toFixed(dp)} m`;
}

/** Error expressed in floors, e.g. "0.27 floors". */
export function fmtFloors(x: number | null | undefined, dp = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x.toFixed(dp)} floors`;
}

export function fmtNum(x: number | null | undefined, dp = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(dp);
}

export const SOURCE_LABEL: Record<AltitudeSource, string> = {
  baro: 'Barometer',
  gps: 'GPS',
  os: 'iOS OS altitude',
};

/** Safe file name for CSV export: locus-readings-YYYYMMDD-HHMM.csv */
export function exportFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `locus-readings-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.csv`;
}
