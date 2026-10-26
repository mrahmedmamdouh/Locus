import { mean, median, percentile } from './smoothing';
import type { AltitudeSource, Reading } from './types';

/** Altitude estimate for a reading from the chosen source (meters relative to entrance). */
export function altitudeFor(r: Reading, source: AltitudeSource): number | null {
  const v = source === 'baro' ? r.baroRelAltM : source === 'gps' ? r.gpsRelAltM : r.osRelAltM;
  return v === null || !Number.isFinite(v) ? null : v;
}

function estFloorFor(r: Reading, source: AltitudeSource): number | null {
  if (source === 'baro') return r.estFloorIndexBaro;
  if (source === 'gps') return r.estFloorIndexGps;
  return null;
}

export interface AccuracySummary {
  source: AltitudeSource;
  /** Readings that had a value for this source. */
  n: number;
  /** Share of readings whose estimated floor matched the true floor (0–1); null if no floor estimates. */
  floorAccuracy: number | null;
  /** Signed error = estimate − true floor centre (meters). */
  meanErrorM: number | null;
  medianAbsErrorM: number | null;
  p90AbsErrorM: number | null;
  maxAbsErrorM: number | null;
  /** Share of readings with |error| below half a floor height (0–1). */
  withinHalfFloor: number | null;
}

/** Accuracy of one altitude source over a set of readings. */
export function summarize(readings: Reading[], source: AltitudeSource, floorHeightM: number): AccuracySummary {
  const usable = readings.filter((r) => altitudeFor(r, source) !== null);
  const errors = usable.map((r) => altitudeFor(r, source)! - r.trueFloorCenterM);
  const abs = errors.map(Math.abs);
  const withFloor = usable.filter((r) => estFloorFor(r, source) !== null);
  const correct = withFloor.filter((r) => estFloorFor(r, source) === r.trueFloorIndex).length;
  return {
    source,
    n: usable.length,
    floorAccuracy: withFloor.length ? correct / withFloor.length : null,
    meanErrorM: mean(errors),
    medianAbsErrorM: median(abs),
    p90AbsErrorM: percentile(abs, 90),
    maxAbsErrorM: abs.length ? Math.max(...abs) : null,
    withinHalfFloor: abs.length ? abs.filter((e) => e < floorHeightM / 2).length / abs.length : null,
  };
}

/** Group readings by a key and summarise each group. */
export function summarizeBy(
  readings: Reading[],
  key: (r: Reading) => string,
  source: AltitudeSource,
  floorHeightM: number,
): { group: string; summary: AccuracySummary }[] {
  const groups = new Map<string, Reading[]>();
  for (const r of readings) {
    const k = key(r);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.entries()]
    .map(([group, rs]) => ({ group, summary: summarize(rs, source, floorHeightM) }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

/** Absolute error by minutes since calibration, to show barometric drift. */
export function driftByMinutes(
  readings: Reading[],
  source: AltitudeSource,
  bucketMinutes = 5,
): { minutesFrom: number; n: number; medianAbsErrorM: number | null; p90AbsErrorM: number | null }[] {
  const buckets = new Map<number, number[]>();
  for (const r of readings) {
    const alt = altitudeFor(r, source);
    if (alt === null) continue;
    const b = Math.floor(r.secondsSinceCalibration / 60 / bucketMinutes) * bucketMinutes;
    const list = buckets.get(b) ?? [];
    list.push(Math.abs(alt - r.trueFloorCenterM));
    buckets.set(b, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minutesFrom, errs]) => ({
      minutesFrom,
      n: errs.length,
      medianAbsErrorM: median(errs),
      p90AbsErrorM: percentile(errs, 90),
    }));
}

export interface GateCriteria {
  /** Minimum share of readings on the correct floor. */
  minFloorAccuracy: number;
  /** p90 absolute error must be below this fraction of a floor height. */
  maxP90FractionOfFloor: number;
  /** Minimum readings for a verdict to count. */
  minReadings: number;
  /** Minimum distinct venues. */
  minVenues: number;
}

/** Gate 1 of the roadmap: "floors separable". Defaults match the strategy doc's 85% target. */
export const DEFAULT_GATE: GateCriteria = {
  minFloorAccuracy: 0.85,
  maxP90FractionOfFloor: 0.5,
  minReadings: 200,
  minVenues: 2,
};

export type GateVerdict = 'pass' | 'fail' | 'insufficient-data';

export interface GateResult {
  verdict: GateVerdict;
  reasons: string[];
  summary: AccuracySummary;
  venues: number;
}

/** Decide whether the altitude test passes the "floors separable" gate. */
export function evaluateGate(
  readings: Reading[],
  floorHeightM: number,
  source: AltitudeSource = 'baro',
  criteria: GateCriteria = DEFAULT_GATE,
): GateResult {
  const summary = summarize(readings, source, floorHeightM);
  const venues = new Set(readings.map((r) => r.venueId)).size;
  const reasons: string[] = [];
  if (summary.n < criteria.minReadings) {
    reasons.push(`Only ${summary.n} readings; need at least ${criteria.minReadings}.`);
  }
  if (venues < criteria.minVenues) {
    reasons.push(`Only ${venues} venue(s); need at least ${criteria.minVenues}.`);
  }
  if (reasons.length > 0) return { verdict: 'insufficient-data', reasons, summary, venues };

  const limit = criteria.maxP90FractionOfFloor * floorHeightM;
  if (summary.floorAccuracy === null || summary.floorAccuracy < criteria.minFloorAccuracy) {
    reasons.push(
      `Floor accuracy ${pct(summary.floorAccuracy)} is below ${pct(criteria.minFloorAccuracy)}.`,
    );
  }
  if (summary.p90AbsErrorM === null || summary.p90AbsErrorM >= limit) {
    reasons.push(`90th-percentile error ${fmt(summary.p90AbsErrorM)} m is not below ${fmt(limit)} m.`);
  }
  if (reasons.length === 0) {
    reasons.push(
      `Floor accuracy ${pct(summary.floorAccuracy)} and 90th-percentile error ${fmt(summary.p90AbsErrorM)} m meet the gate.`,
    );
    return { verdict: 'pass', reasons, summary, venues };
  }
  return { verdict: 'fail', reasons, summary, venues };
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
function fmt(x: number | null): string {
  return x === null ? 'n/a' : x.toFixed(2);
}
