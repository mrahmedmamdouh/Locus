import type { Floor } from './types';

/** Centre of a floor's altitude band (meters relative to entrance). */
export function floorCenterM(floor: Floor): number {
  return (floor.zMinM + floor.zMaxM) / 2;
}

/**
 * Build a floor table with uniform floor heights.
 *
 * The entrance floor (index 0) is centred on 0 m, so its band is
 * [-h/2, +h/2]; floor n is centred on n * h.
 *
 * @param floorsBelow number of basement levels (e.g. 2 → B2, B1)
 * @param floorsAbove number of levels above the entrance (e.g. 3 → 1, 2, 3)
 * @param floorHeightM typical slab-to-slab height; malls are often 4.5–6 m
 */
export function buildUniformFloors(
  floorsBelow: number,
  floorsAbove: number,
  floorHeightM: number,
  groundLabel = 'G',
): Floor[] {
  if (!(floorHeightM > 0)) throw new RangeError('floorHeightM must be > 0');
  if (floorsBelow < 0 || floorsAbove < 0) throw new RangeError('floor counts must be >= 0');
  const floors: Floor[] = [];
  for (let i = -floorsBelow; i <= floorsAbove; i++) {
    const label = i === 0 ? groundLabel : i < 0 ? `B${-i}` : String(i);
    floors.push({
      label,
      index: i,
      zMinM: i * floorHeightM - floorHeightM / 2,
      zMaxM: i * floorHeightM + floorHeightM / 2,
    });
  }
  return floors;
}

/** Validate a floor table: sorted, non-overlapping, positive heights. Returns problems found. */
export function validateFloors(floors: Floor[]): string[] {
  const problems: string[] = [];
  if (floors.length === 0) problems.push('Venue has no floors.');
  const sorted = [...floors].sort((a, b) => a.index - b.index);
  const seen = new Set<number>();
  for (const f of sorted) {
    if (seen.has(f.index)) problems.push(`Duplicate floor index ${f.index}.`);
    seen.add(f.index);
    if (!(f.zMaxM > f.zMinM)) problems.push(`Floor ${f.label}: zMaxM must be above zMinM.`);
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.zMinM < prev.zMaxM - 1e-9) {
      problems.push(`Floors ${prev.label} and ${cur.label} overlap.`);
    }
    if (floorCenterM(cur) <= floorCenterM(prev)) {
      problems.push(`Floor ${cur.label} is not above ${prev.label}.`);
    }
  }
  return problems;
}

/**
 * Estimate the floor for a relative altitude.
 * Returns the floor whose band contains the altitude; if it falls in a gap
 * between bands, the floor with the nearest centre. Returns null when the
 * altitude is more than half a floor beyond the lowest or highest band, so a
 * large drift is never counted as "on the top floor".
 */
export function classifyFloor(relAltM: number, floors: Floor[]): Floor | null {
  if (!Number.isFinite(relAltM) || floors.length === 0) return null;
  const inside = floors.find((f) => relAltM >= f.zMinM && relAltM < f.zMaxM);
  if (inside) return inside;
  let lowest = floors[0]!;
  let highest = floors[0]!;
  for (const f of floors) {
    if (f.zMinM < lowest.zMinM) lowest = f;
    if (f.zMaxM > highest.zMaxM) highest = f;
  }
  if (relAltM >= highest.zMaxM + (highest.zMaxM - highest.zMinM) / 2) return null;
  if (relAltM < lowest.zMinM - (lowest.zMaxM - lowest.zMinM) / 2) return null;
  let best: Floor | null = null;
  let bestDist = Infinity;
  for (const f of floors) {
    const d = Math.abs(relAltM - floorCenterM(f));
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best;
}

/** Median slab-to-slab height of a floor table (meters), or null if under 2 floors. */
export function typicalFloorHeightM(floors: Floor[]): number | null {
  const sorted = [...floors].sort((a, b) => a.index - b.index);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(floorCenterM(sorted[i]!) - floorCenterM(sorted[i - 1]!));
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}
