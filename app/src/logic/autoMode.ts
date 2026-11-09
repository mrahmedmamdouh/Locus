import {
  G0,
  R_DRY_AIR,
  classifyFloor,
  floorCenterM,
  haversineM,
  median,
  relativeAltitudeFromPressure,
  typicalFloorHeightM,
  type AutoCalibrationSource,
  type Floor,
  type Reading,
  type Venue,
  type VenueBoundary,
} from '@locus/altitude-core';
import { roundOrNull } from './numbers';

/**
 * Automatic mode (v0.4): floor detection with NO manual calibration, as a customer would get it.
 *
 * 1. Entering the mall boundary (geofence) triggers a short barometer capture at the entrance.
 * 2. The median pressure becomes the automatic baseline, referred to height 0 of the floor table
 *    (the entrance floor may not be floor 0).
 * 3. While the app is open, a drift tracker (floor snapping) corrects slow pressure drift.
 *
 * Everything here is pure so it can be unit-tested; sensors and storage live in the provider.
 */

export const DEFAULT_BOUNDARY_RADIUS_M = 150;
export const BOUNDARY_RADIUS_LIMITS = { min: 30, max: 2000 } as const;
/** Barometer capture after a geofence entry. */
export const AUTO_BASELINE_CAPTURE_MS = 3_000;

/** The automatic baseline currently in use (persisted). */
export interface AutoBaseline {
  venueId: string;
  venueName: string;
  source: Exclude<AutoCalibrationSource, 'none'>;
  /** When the boundary entry was detected (ISO). */
  enteredAt: string;
  /** When the baseline pressure was taken (ISO); null while waiting for a foreground barometer sample. */
  calibratedAt: string | null;
  /** Pressure referred to height 0 of the floor table (hPa); null while pending. */
  baselinePressureHpa: number | null;
  /** Median pressure measured at the entrance (hPa); null while pending. */
  entrancePressureHpa: number | null;
  /** Height of the entrance floor in the floor table (m). */
  entranceHeightM: number;
  sampleCount: number;
  temperatureC: number;
  gpsAccuracyM: number | null;
  /** Last drift offset, so an app restart does not lose the correction. */
  driftOffsetM: number;
  /** Set when the phone left the boundary; the next entry takes a new baseline. */
  exitedAt: string | null;
}

/**
 * Whether a foreground entry should take a new baseline. Not when the current baseline is for
 * the same venue and no exit was seen since (e.g. the app was restarted inside the mall:
 * re-baselining on an upper floor would be wrong).
 */
export function shouldCaptureOnEnter(current: AutoBaseline | null, venueId: string): boolean {
  return !(current && current.venueId === venueId && current.exitedAt === null);
}

/** A baseline is usable once its pressure is known. */
export function baselineReady(b: AutoBaseline | null): b is AutoBaseline & { baselinePressureHpa: number; calibratedAt: string } {
  return !!b && b.baselinePressureHpa !== null && b.calibratedAt !== null;
}

// ---------------------------------------------------------------------------
// Venue geometry
// ---------------------------------------------------------------------------

/** Floor index of the main entrances (default 0, falling back to the lowest floor ≥ 0). */
export function entranceFloorIndex(venue: Pick<Venue, 'floors' | 'entranceFloorIndex'>): number {
  const want = venue.entranceFloorIndex ?? 0;
  if (venue.floors.some((f) => f.index === want)) return want;
  const sorted = [...venue.floors].sort((a, b) => a.index - b.index);
  return (sorted.find((f) => f.index >= 0) ?? sorted[0])?.index ?? 0;
}

/**
 * Height of the entrance floor in the floor table: its band centre, or
 * index × typical floor height when that floor is not in the table.
 */
export function entranceHeightM(venue: Pick<Venue, 'floors' | 'entranceFloorIndex'>): number {
  const idx = venue.entranceFloorIndex ?? 0;
  const f = venue.floors.find((x) => x.index === idx);
  if (f) return floorCenterM(f);
  return idx * (typicalFloorHeightM(venue.floors) ?? 0);
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export interface BaselineResult {
  /** Pressure referred to height 0 of the floor table (hPa). */
  baselinePressureHpa: number;
  /** Median of the captured samples (hPa). */
  entrancePressureHpa: number;
  entranceHeightM: number;
  sampleCount: number;
}

/**
 * Median pressure of the capture = pressure at the entrance floor's height. Refer it to
 * height 0 with the hypsometric equation, so heights come out relative to the floor table.
 * Returns null when there are no valid samples.
 */
export function computeAutoBaseline(args: {
  pressures: number[];
  entranceHeightM: number;
  temperatureC: number;
}): BaselineResult | null {
  const valid = args.pressures.filter((p) => Number.isFinite(p) && p > 0);
  const med = median(valid);
  if (med === null) return null;
  const scale = (R_DRY_AIR * (args.temperatureC + 273.15)) / G0;
  // Lower floors have higher pressure: p(0) = p(z) · exp(z / scale).
  const p0 = med * Math.exp(args.entranceHeightM / scale);
  return {
    baselinePressureHpa: roundOrNull(p0, 4)!,
    entrancePressureHpa: roundOrNull(med, 4)!,
    entranceHeightM: args.entranceHeightM,
    sampleCount: valid.length,
  };
}

// ---------------------------------------------------------------------------
// Reading fields
// ---------------------------------------------------------------------------

export type AutoFields = Pick<
  Reading,
  | 'autoCalibrationSource'
  | 'autoCalibratedAt'
  | 'autoBaselinePressureHpa'
  | 'minutesSinceAutoCalibration'
  | 'autoRelAltM'
  | 'autoDriftOffsetM'
  | 'autoEstFloorIndex'
>;

export const NO_AUTO_FIELDS: AutoFields = {
  autoCalibrationSource: null,
  autoCalibratedAt: null,
  autoBaselinePressureHpa: null,
  minutesSinceAutoCalibration: null,
  autoRelAltM: null,
  autoDriftOffsetM: null,
  autoEstFloorIndex: null,
};

/**
 * Automatic-mode columns of a reading at capture time.
 * - Auto mode off → all null.
 * - Auto mode on but no usable baseline for this venue → source 'none', the rest null.
 * - Otherwise height vs the automatic baseline, the tracker's drift offset, and the floor of
 *   the corrected height.
 */
export function buildAutoFields(args: {
  enabled: boolean;
  baseline: AutoBaseline | null;
  venueId: string;
  floors: Floor[];
  /** Pressure of the reading window (same value as the manual barometer column). */
  pressureHpa: number | null;
  /** Drift offset from the tracker at capture (m). */
  driftOffsetM: number;
  now: Date;
}): AutoFields {
  if (!args.enabled) return NO_AUTO_FIELDS;
  const b = args.baseline;
  if (!baselineReady(b) || b.venueId !== args.venueId) {
    return { ...NO_AUTO_FIELDS, autoCalibrationSource: 'none' };
  }
  const p = args.pressureHpa;
  const raw = p !== null && Number.isFinite(p) && p > 0 ? relativeAltitudeFromPressure(p, b.baselinePressureHpa, b.temperatureC) : null;
  const offset = Number.isFinite(args.driftOffsetM) ? args.driftOffsetM : 0;
  const floor = raw !== null ? classifyFloor(raw - offset, args.floors) : null;
  const minutes = (args.now.getTime() - Date.parse(b.calibratedAt)) / 60_000;
  return {
    autoCalibrationSource: b.source,
    autoCalibratedAt: b.calibratedAt,
    autoBaselinePressureHpa: b.baselinePressureHpa,
    minutesSinceAutoCalibration: Number.isFinite(minutes) ? roundOrNull(Math.max(0, minutes), 2) : null,
    autoRelAltM: roundOrNull(raw, 3),
    autoDriftOffsetM: raw !== null ? roundOrNull(offset, 3) : null,
    autoEstFloorIndex: floor ? floor.index : null,
  };
}

// ---------------------------------------------------------------------------
// Entry detection from location fixes (foreground)
// ---------------------------------------------------------------------------

export interface PresenceState {
  inside: boolean;
  /** Consecutive good fixes outside the exit distance. */
  outsideCount: number;
}

export const INITIAL_PRESENCE: PresenceState = { inside: false, outsideCount: 0 };

export interface PresenceFix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

/** Extra distance beyond the radius before an exit counts (hysteresis). */
export function exitMarginM(radiusM: number): number {
  return Math.max(30, radiusM * 0.25);
}

/** Fixes needed in a row outside the exit distance before an exit counts. */
export const EXIT_FIXES = 3;

/**
 * Update inside/outside for one boundary from a fix.
 * Enter: inside the radius with horizontal accuracy ≤ radius / 2.
 * Exit: EXIT_FIXES fixes in a row beyond radius + exitMarginM, each with accuracy ≤ radius
 * (indoor fixes jump around; one bad fix must not end the visit).
 * Fixes without a usable accuracy are ignored.
 */
export function updatePresence(
  state: PresenceState,
  fix: PresenceFix,
  boundary: VenueBoundary,
): { state: PresenceState; event: 'enter' | 'exit' | null } {
  const acc = fix.accuracy;
  if (acc === null || !Number.isFinite(acc) || acc < 0 || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) {
    return { state, event: null };
  }
  const d = haversineM(fix.latitude, fix.longitude, boundary.lat, boundary.lon);
  if (!state.inside) {
    if (d <= boundary.radiusM && acc <= boundary.radiusM / 2) return { state: { inside: true, outsideCount: 0 }, event: 'enter' };
    return { state, event: null };
  }
  if (d > boundary.radiusM + exitMarginM(boundary.radiusM) && acc <= boundary.radiusM) {
    const n = state.outsideCount + 1;
    if (n >= EXIT_FIXES) return { state: { inside: false, outsideCount: 0 }, event: 'exit' };
    return { state: { inside: true, outsideCount: n }, event: null };
  }
  if (d <= boundary.radiusM + exitMarginM(boundary.radiusM)) return { state: { inside: true, outsideCount: 0 }, event: null };
  return { state, event: null };
}

// ---------------------------------------------------------------------------
// Boundary input
// ---------------------------------------------------------------------------

/** Parse the venue editor's boundary fields. All empty = no boundary (allowed). */
export function parseBoundary(
  latText: string,
  lonText: string,
  radiusText: string,
  parse: (t: string) => number | null,
): { boundary: VenueBoundary | null; problems: string[] } {
  if (!latText.trim() && !lonText.trim()) return { boundary: null, problems: [] };
  const problems: string[] = [];
  const lat = parse(latText);
  const lon = parse(lonText);
  const r = radiusText.trim() ? parse(radiusText) : DEFAULT_BOUNDARY_RADIUS_M;
  if (lat === null || lat < -90 || lat > 90) problems.push('Boundary latitude must be between -90 and 90.');
  if (lon === null || lon < -180 || lon > 180) problems.push('Boundary longitude must be between -180 and 180.');
  if (r === null || r < BOUNDARY_RADIUS_LIMITS.min || r > BOUNDARY_RADIUS_LIMITS.max) {
    problems.push(`Boundary radius must be ${BOUNDARY_RADIUS_LIMITS.min}–${BOUNDARY_RADIUS_LIMITS.max} m.`);
  }
  if (problems.length) return { boundary: null, problems };
  return { boundary: { lat: lat!, lon: lon!, radiusM: r! }, problems };
}
