/**
 * Wi-Fi floor test: arranges the shared fingerprint evaluation
 * (@locus/altitude-core `evaluateWifiFloors`) into what the dashboard shows.
 * No classifier maths lives here.
 */
import { DEFAULT_FINGERPRINT_OPTIONS, barometerAccuracyOn, evaluateWifiFloors } from '@locus/altitude-core';
import type { FingerprintOptions, Reading, WifiEvaluation, WifiPrediction, WifiScan, WifiScanStatus } from '@locus/altitude-core';
import { parseBounded } from './settings';

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface WifiSettings {
  k: number;
  /** Max access-point age in seconds (the library takes milliseconds). */
  maxApAgeS: number;
  minAps: number;
}

export const DEFAULT_WIFI_SETTINGS: WifiSettings = {
  k: DEFAULT_FINGERPRINT_OPTIONS.k,
  maxApAgeS: DEFAULT_FINGERPRINT_OPTIONS.maxApAgeMs / 1000,
  minAps: DEFAULT_FINGERPRINT_OPTIONS.minAps,
};

export const WIFI_LIMITS = {
  k: { min: 1, max: 50 },
  maxApAgeS: { min: 0, max: 3600 },
  minAps: { min: 1, max: 100 },
} as const;

export const WIFI_PARSE = {
  k: (s: string) => parseBounded(s, WIFI_LIMITS.k.min, WIFI_LIMITS.k.max, true),
  maxApAgeS: (s: string) => parseBounded(s, WIFI_LIMITS.maxApAgeS.min, WIFI_LIMITS.maxApAgeS.max),
  minAps: (s: string) => parseBounded(s, WIFI_LIMITS.minAps.min, WIFI_LIMITS.minAps.max, true),
} as const;

export function toFingerprintOptions(s: WifiSettings): Partial<FingerprintOptions> {
  return { k: s.k, maxApAgeMs: s.maxApAgeS * 1000, minAps: s.minAps };
}

/** Predictions kept by the "only act when confident" view. */
export const CONFIDENCE_THRESHOLD = 0.7;

/** Above this share of throttled + stale scans, suggest disabling scan throttling. */
export const THROTTLE_TIP_SHARE = 0.2;

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface WifiVenueRow {
  venueId: string;
  venueName: string;
  evaluated: number;
  wifiAccuracy: number | null;
  baroAccuracy: number | null;
}

export interface WifiAnalysis {
  evaluation: WifiEvaluation;
  /** All evaluated readings. */
  overall: { n: number; wifiAccuracy: number | null; baroAccuracy: number | null };
  /** Evaluated readings from phones without a barometer (baroRelAltM is null). */
  noBarometer: { n: number; wifiAccuracy: number | null };
  holdout: { session: number; time: number };
  byVenue: WifiVenueRow[];
}

/** Share of predictions on the right floor; null when there are none. */
export function predictionAccuracy(ps: readonly WifiPrediction[]): number | null {
  return ps.length ? ps.filter((p) => p.predictedFloorIndex === p.trueFloorIndex).length / ps.length : null;
}

export function analyzeWifi(scans: WifiScan[], readings: Reading[], settings: WifiSettings): WifiAnalysis {
  const evaluation = evaluateWifiFloors(scans, toFingerprintOptions(settings));
  const ps = evaluation.predictions;
  const byId = new Map(readings.map((r) => [r.id, r]));
  const names = new Map<string, string>();
  for (const r of readings) if (!names.has(r.venueId)) names.set(r.venueId, r.venueName || r.venueId);

  const noBaroPs = ps.filter((p) => {
    const r = byId.get(p.readingId);
    return r !== undefined && r.baroRelAltM === null;
  });

  return {
    evaluation,
    overall: { n: ps.length, wifiAccuracy: evaluation.accuracy, baroAccuracy: barometerAccuracyOn(readings, ps) },
    noBarometer: { n: noBaroPs.length, wifiAccuracy: predictionAccuracy(noBaroPs) },
    holdout: {
      session: ps.filter((p) => p.holdout === 'session').length,
      time: ps.filter((p) => p.holdout === 'time').length,
    },
    byVenue: evaluation.byVenue
      .map((v) => {
        const vps = ps.filter((p) => p.venueId === v.venueId);
        return {
          venueId: v.venueId,
          venueName: names.get(v.venueId) ?? v.venueId,
          evaluated: v.evaluated,
          wifiAccuracy: v.accuracy,
          baroAccuracy: barometerAccuracyOn(readings, vps),
        };
      })
      .sort((a, b) => a.venueName.localeCompare(b.venueName)),
  };
}

/* ------------------------------------------------------------------ */
/* Confidence filter                                                   */
/* ------------------------------------------------------------------ */

export interface ConfidenceView {
  threshold: number;
  kept: number;
  total: number;
  /** kept / total; null when nothing was evaluated. */
  keptShare: number | null;
  accuracy: number | null;
}

/** Accuracy when only predictions with confidence ≥ threshold are acted on. */
export function confidenceFilter(ps: readonly WifiPrediction[], threshold = CONFIDENCE_THRESHOLD): ConfidenceView {
  const kept = ps.filter((p) => p.confidence !== null && p.confidence >= threshold);
  return {
    threshold,
    kept: kept.length,
    total: ps.length,
    keptShare: ps.length ? kept.length / ps.length : null,
    accuracy: predictionAccuracy(kept),
  };
}

/* ------------------------------------------------------------------ */
/* Confusion matrix                                                    */
/* ------------------------------------------------------------------ */

export interface ConfusionMatrix {
  /** Floor indices on both axes, ascending (union of true and predicted). */
  floors: number[];
  /** counts[i][j] = readings on floors[i] predicted as floors[j]. */
  counts: number[][];
  /** Per true floor: number of readings. */
  rowTotals: number[];
  total: number;
}

/** True floor × predicted floor counts. venueId '' = all venues. Predictions without a floor are skipped. */
export function confusionMatrix(ps: readonly WifiPrediction[], venueId = ''): ConfusionMatrix {
  const sel = ps.filter((p) => (!venueId || p.venueId === venueId) && p.predictedFloorIndex !== null);
  const floors = [...new Set(sel.flatMap((p) => [p.trueFloorIndex, p.predictedFloorIndex!]))].sort((a, b) => a - b);
  const idx = new Map(floors.map((f, i) => [f, i]));
  const counts = floors.map(() => floors.map(() => 0));
  for (const p of sel) counts[idx.get(p.trueFloorIndex)!]![idx.get(p.predictedFloorIndex!)!]!++;
  return { floors, counts, rowTotals: counts.map((row) => row.reduce((a, b) => a + b, 0)), total: sel.length };
}

/** Floor display label for a venue (from readings), falling back to the index. */
export function floorLabels(readings: readonly Reading[], venueId: string): Map<number, string> {
  const m = new Map<number, string>();
  if (!venueId) return m;
  for (const r of readings) if (r.venueId === venueId && !m.has(r.trueFloorIndex)) m.set(r.trueFloorIndex, r.trueFloorLabel);
  return m;
}

/* ------------------------------------------------------------------ */
/* Scan health                                                         */
/* ------------------------------------------------------------------ */

export const SCAN_STATUSES: readonly WifiScanStatus[] = [
  'ok',
  'stale',
  'throttled',
  'no-permission',
  'location-off',
  'wifi-off',
  'unsupported',
  'skipped',
  'error',
];

export const SCAN_STATUS_LABEL: Record<WifiScanStatus, string> = {
  ok: 'OK (fresh scan)',
  stale: 'Stale (cached results)',
  throttled: 'Throttled (no results)',
  'no-permission': 'No permission',
  'location-off': 'Location off',
  'wifi-off': 'Wi-Fi off',
  unsupported: 'Unsupported',
  skipped: 'Skipped by tester',
  error: 'Error',
};

export interface ScanHealth {
  scans: number;
  byStatus: { status: WifiScanStatus; count: number; share: number }[];
  /** Median access points per usable (ok / stale) scan. */
  medianAps: number | null;
  /** Share of access points (with a known RTT flag) that are RTT responders. */
  rttShare: number | null;
  /** Median access-point age in seconds (where reported). */
  medianApAgeS: number | null;
  /** Share of scans that were throttled or stale. */
  throttledShare: number | null;
  showThrottleTip: boolean;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function scanHealth(scans: readonly WifiScan[]): ScanHealth {
  const n = scans.length;
  const counts = new Map<WifiScanStatus, number>();
  for (const s of scans) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  const usable = scans.filter((s) => s.status === 'ok' || s.status === 'stale');
  const aps = scans.flatMap((s) => s.aps);
  const rttKnown = aps.filter((a) => a.rttResponder !== null);
  const ages = aps.flatMap((a) => (a.ageMs === null ? [] : [a.ageMs / 1000]));
  const throttled = (counts.get('throttled') ?? 0) + (counts.get('stale') ?? 0);
  const throttledShare = n ? throttled / n : null;
  return {
    scans: n,
    byStatus: SCAN_STATUSES.map((status) => {
      const count = counts.get(status) ?? 0;
      return { status, count, share: n ? count / n : 0 };
    }),
    medianAps: median(usable.map((s) => s.aps.length)),
    rttShare: rttKnown.length ? rttKnown.filter((a) => a.rttResponder).length / rttKnown.length : null,
    medianApAgeS: median(ages),
    throttledShare,
    showThrottleTip: throttledShare !== null && throttledShare > THROTTLE_TIP_SHARE,
  };
}
