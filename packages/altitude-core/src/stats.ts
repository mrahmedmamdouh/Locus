import { mean, median, percentile } from './smoothing';
import type { AltitudeSource, Reading } from './types';

/** Altitude estimate for a reading from the chosen source (meters relative to entrance). */
export function altitudeFor(r: Reading, source: AltitudeSource): number | null {
  const v = source === 'baro' ? r.baroRelAltM : source === 'gps' ? r.gpsRelAltM : r.osRelAltM;
  return v === null || !Number.isFinite(v) ? null : v;
}

/**
 * Floor height to judge a reading against: the true floor's own band height
 * recorded at capture, else the caller's fallback.
 */
export function floorHeightFor(r: Reading, fallbackM: number): number {
  const h = r.trueFloorHeightM;
  return h !== null && h !== undefined && Number.isFinite(h) && h > 0 ? h : fallbackM;
}

/**
 * Whether the estimated floor matches the true floor. Baro and GPS use the
 * floor estimated on the phone; the iOS OS altimeter has no stored estimate,
 * so it counts as correct when within half of the true floor's height.
 */
function floorCorrect(r: Reading, source: AltitudeSource, fallbackFloorM: number): boolean | null {
  if (source === 'baro') return r.estFloorIndexBaro === null ? null : r.estFloorIndexBaro === r.trueFloorIndex;
  if (source === 'gps') return r.estFloorIndexGps === null ? null : r.estFloorIndexGps === r.trueFloorIndex;
  const alt = altitudeFor(r, source);
  return alt === null ? null : Math.abs(alt - r.trueFloorCenterM) < floorHeightFor(r, fallbackFloorM) / 2;
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
  /** 90th percentile of |error| measured in floors (|error| / that reading's floor height). */
  p90AbsErrorFloors: number | null;
  /** Share of readings with |error| below half of their own floor's height (0–1). */
  withinHalfFloor: number | null;
}

/** Readings that have a value for the given altitude source. */
export function usableReadings(readings: Reading[], source: AltitudeSource): Reading[] {
  return readings.filter((r) => altitudeFor(r, source) !== null);
}

/**
 * Accuracy of one altitude source over a set of readings.
 * @param floorHeightM fallback floor height for rows exported without `trueFloorHeightM`
 */
export function summarize(readings: Reading[], source: AltitudeSource, floorHeightM: number): AccuracySummary {
  const usable = usableReadings(readings, source);
  const errors = usable.map((r) => altitudeFor(r, source)! - r.trueFloorCenterM);
  const abs = errors.map(Math.abs);
  const inFloors = usable.map((r, i) => abs[i]! / floorHeightFor(r, floorHeightM));
  const verdicts = usable.map((r) => floorCorrect(r, source, floorHeightM)).filter((v) => v !== null);
  const correct = verdicts.filter(Boolean).length;
  return {
    source,
    n: usable.length,
    floorAccuracy: verdicts.length ? correct / verdicts.length : null,
    meanErrorM: mean(errors),
    medianAbsErrorM: median(abs),
    p90AbsErrorM: percentile(abs, 90),
    maxAbsErrorM: abs.length ? abs.reduce((m, e) => (e > m ? e : m), -Infinity) : null,
    p90AbsErrorFloors: percentile(inFloors, 90),
    withinHalfFloor: inFloors.length ? inFloors.filter((e) => e < 0.5).length / inFloors.length : null,
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
  /** Minimum distinct venues, each with at least `minReadingsPerVenue` usable readings. */
  minVenues: number;
  /** A venue only counts towards `minVenues` with at least this many usable readings. */
  minReadingsPerVenue: number;
}

/** Gate 1 of the roadmap: "floors separable". Defaults match the strategy doc's 85% target. */
export const DEFAULT_GATE: GateCriteria = {
  minFloorAccuracy: 0.85,
  maxP90FractionOfFloor: 0.5,
  minReadings: 200,
  minVenues: 2,
  minReadingsPerVenue: 30,
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
  // Only venues with enough readings FOR THIS SOURCE count.
  const perVenue = new Map<string, number>();
  for (const r of usableReadings(readings, source)) perVenue.set(r.venueId, (perVenue.get(r.venueId) ?? 0) + 1);
  const venues = [...perVenue.values()].filter((n) => n >= criteria.minReadingsPerVenue).length;
  const reasons: string[] = [];
  if (summary.n < criteria.minReadings) {
    reasons.push(`Only ${summary.n} readings; need at least ${criteria.minReadings}.`);
  }
  if (venues < criteria.minVenues) {
    reasons.push(
      `Only ${venues} venue(s) with at least ${criteria.minReadingsPerVenue} readings; need ${criteria.minVenues}.`,
    );
  }
  if (reasons.length > 0) return { verdict: 'insufficient-data', reasons, summary, venues };

  if (summary.floorAccuracy === null || summary.floorAccuracy < criteria.minFloorAccuracy) {
    reasons.push(
      `Floor accuracy ${pct(summary.floorAccuracy)} is below ${pct(criteria.minFloorAccuracy)}.`,
    );
  }
  if (summary.p90AbsErrorFloors === null || summary.p90AbsErrorFloors >= criteria.maxP90FractionOfFloor) {
    reasons.push(
      `90th-percentile error is ${fmt(summary.p90AbsErrorFloors)} of a floor (${fmt(summary.p90AbsErrorM)} m); must be below ${fmt(criteria.maxP90FractionOfFloor)}.`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      `Floor accuracy ${pct(summary.floorAccuracy)} and 90th-percentile error ${fmt(summary.p90AbsErrorFloors)} of a floor (${fmt(summary.p90AbsErrorM)} m) meet the gate.`,
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
