import { DEFAULT_GATE } from '@locus/altitude-core';
import type { AltitudeSource, GateCriteria } from '@locus/altitude-core';

export interface Settings {
  floorHeightM: number;
  source: AltitudeSource;
  gate: GateCriteria;
}

export const DEFAULT_FLOOR_HEIGHT_M = 4.5;

export const DEFAULT_SETTINGS: Settings = {
  floorHeightM: DEFAULT_FLOOR_HEIGHT_M,
  source: 'baro',
  gate: { ...DEFAULT_GATE },
};

/** Bounds keep user-typed values physically meaningful. */
export const LIMITS = {
  floorHeightM: { min: 2, max: 15 },
  minFloorAccuracyPct: { min: 0, max: 100 },
  maxP90FractionOfFloor: { min: 0.05, max: 2 },
  minReadings: { min: 1, max: 1_000_000 },
  minVenues: { min: 1, max: 1000 },
  minReadingsPerVenue: { min: 1, max: 1_000_000 },
} as const;

/** Parse a user-typed number; returns null when empty, non-numeric or out of [min, max]. */
export function parseBounded(raw: string, min: number, max: number, integer = false): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (integer && !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** Parsers for each editable setting (module-level so NumberField's sync effect stays stable). */
export const PARSE = {
  floorHeightM: (s: string) => parseBounded(s, LIMITS.floorHeightM.min, LIMITS.floorHeightM.max),
  minFloorAccuracyPct: (s: string) =>
    parseBounded(s, LIMITS.minFloorAccuracyPct.min, LIMITS.minFloorAccuracyPct.max),
  maxP90FractionOfFloor: (s: string) =>
    parseBounded(s, LIMITS.maxP90FractionOfFloor.min, LIMITS.maxP90FractionOfFloor.max),
  minReadings: (s: string) => parseBounded(s, LIMITS.minReadings.min, LIMITS.minReadings.max, true),
  minVenues: (s: string) => parseBounded(s, LIMITS.minVenues.min, LIMITS.minVenues.max, true),
  minReadingsPerVenue: (s: string) =>
    parseBounded(s, LIMITS.minReadingsPerVenue.min, LIMITS.minReadingsPerVenue.max, true),
} as const;

/** Problems with a set of gate criteria (empty when every field is within its limits). */
export function validateGateCriteria(c: GateCriteria): string[] {
  const problems: string[] = [];
  const check = (name: string, v: number, min: number, max: number, integer: boolean) => {
    if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      problems.push(`${name} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
    }
  };
  check('Min floor accuracy', c.minFloorAccuracy * 100, LIMITS.minFloorAccuracyPct.min, LIMITS.minFloorAccuracyPct.max, false);
  check('p90 limit', c.maxP90FractionOfFloor, LIMITS.maxP90FractionOfFloor.min, LIMITS.maxP90FractionOfFloor.max, false);
  check('Min readings', c.minReadings, LIMITS.minReadings.min, LIMITS.minReadings.max, true);
  check('Min venues', c.minVenues, LIMITS.minVenues.min, LIMITS.minVenues.max, true);
  check('Min readings per venue', c.minReadingsPerVenue, LIMITS.minReadingsPerVenue.min, LIMITS.minReadingsPerVenue.max, true);
  return problems;
}
