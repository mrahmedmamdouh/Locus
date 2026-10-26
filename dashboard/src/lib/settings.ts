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
