/**
 * Per-venue floor height override. Testers sometimes leave the app's floor
 * height at its default, so every reading stores floor centres, heights and
 * on-device floor estimates built from the wrong height. Given the venue's
 * real floor height, re-derive those fields from the raw relative altitudes.
 */
import { buildUniformFloors, classifyFloor } from '@locus/altitude-core';
import type { Floor, Reading } from '@locus/altitude-core';
import { LIMITS } from './settings';

/** Floor height (m) per canonical venue id; venues not listed keep their recorded heights. */
export type FloorHeightOverrides = Readonly<Record<string, number>>;

/** Whether an override value is usable (finite and within the settings limits). */
export function isValidFloorHeight(h: number): boolean {
  return Number.isFinite(h) && h >= LIMITS.floorHeightM.min && h <= LIMITS.floorHeightM.max;
}

function estIndex(relAltM: number | null, floors: Floor[]): number | null {
  if (relAltM === null || !Number.isFinite(relAltM)) return null;
  const index = classifyFloor(relAltM, floors)?.index ?? null;
  return index === 0 ? 0 : index; // buildUniformFloors(0, …) yields index -0
}

/**
 * Readings with the venue's floor height replaced by the override: floor
 * bands are uniform at height h over the venue's true floor indices (always
 * including the entrance floor 0), the true floor centre is index × h, and the
 * barometer and GPS floor estimates are re-classified against those bands.
 * Readings of venues without a valid override are returned unchanged (same
 * objects); with no valid override at all the input array itself is returned.
 */
export function applyFloorHeightOverrides(readings: Reading[], overrides: FloorHeightOverrides): Reading[] {
  const active = Object.entries(overrides).filter(([, h]) => isValidFloorHeight(h));
  if (active.length === 0) return readings;
  const heightOf = new Map(active);

  const range = new Map<string, { min: number; max: number }>();
  for (const r of readings) {
    if (!heightOf.has(r.venueId) || !Number.isFinite(r.trueFloorIndex)) continue;
    const cur = range.get(r.venueId);
    if (!cur) range.set(r.venueId, { min: r.trueFloorIndex, max: r.trueFloorIndex });
    else {
      cur.min = Math.min(cur.min, r.trueFloorIndex);
      cur.max = Math.max(cur.max, r.trueFloorIndex);
    }
  }
  const floorsOf = new Map<string, Floor[]>();
  for (const [venueId, { min, max }] of range) {
    floorsOf.set(venueId, buildUniformFloors(Math.max(0, -min), Math.max(0, max), heightOf.get(venueId)!));
  }

  return readings.map((r) => {
    const floors = floorsOf.get(r.venueId);
    if (!floors) return r;
    const h = heightOf.get(r.venueId)!;
    return {
      ...r,
      trueFloorCenterM: r.trueFloorIndex * h,
      trueFloorHeightM: h,
      estFloorIndexBaro: estIndex(r.baroRelAltM, floors),
      estFloorIndexGps: estIndex(r.gpsRelAltM, floors),
    };
  });
}

export interface VenueFloorHeightRow {
  id: string;
  name: string;
  readings: number;
  /** Distinct floor heights recorded on the phones, ascending (empty for older exports). */
  recordedM: number[];
}

/** Loaded venues with their recorded floor heights, sorted by name (for the override list). */
export function venueFloorHeights(readings: readonly Reading[]): VenueFloorHeightRow[] {
  const m = new Map<string, { name: string; n: number; heights: Set<number> }>();
  for (const r of readings) {
    let v = m.get(r.venueId);
    if (!v) m.set(r.venueId, (v = { name: r.venueName || r.venueId, n: 0, heights: new Set() }));
    v.n++;
    if (r.trueFloorHeightM !== null && Number.isFinite(r.trueFloorHeightM) && r.trueFloorHeightM > 0) {
      v.heights.add(r.trueFloorHeightM);
    }
  }
  return [...m.entries()]
    .map(([id, v]) => ({ id, name: v.name, readings: v.n, recordedM: [...v.heights].sort((a, b) => a - b) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
