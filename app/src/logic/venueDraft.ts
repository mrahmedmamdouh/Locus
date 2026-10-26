import { buildUniformFloors, validateFloors, type Floor } from '@locus/altitude-core';
import { parseCount, parseDecimal } from './numbers';

/** Editable floor row: numbers kept as text while the tester types. */
export interface FloorDraft {
  index: number;
  label: string;
  zMin: string;
  zMax: string;
}

export const DEFAULT_FLOOR_HEIGHT_M = 4.5;

export function floorsToDrafts(floors: Floor[]): FloorDraft[] {
  return [...floors]
    .sort((a, b) => b.index - a.index)
    .map((f) => ({ index: f.index, label: f.label, zMin: String(f.zMinM), zMax: String(f.zMaxM) }));
}

/** Quick builder: validate the inputs, then delegate to buildUniformFloors. */
export function buildDrafts(
  basementsText: string,
  aboveText: string,
  heightText: string,
): { drafts: FloorDraft[] | null; error: string | null } {
  const below = parseCount(basementsText);
  const above = parseCount(aboveText);
  const h = parseDecimal(heightText);
  if (below === null || below > 10) return { drafts: null, error: 'Basements must be a whole number 0–10.' };
  if (above === null || above > 30) return { drafts: null, error: 'Floors above must be a whole number 0–30.' };
  if (h === null || h < 2 || h > 15) return { drafts: null, error: 'Floor height must be between 2 and 15 m.' };
  return { drafts: floorsToDrafts(buildUniformFloors(below, above, h)), error: null };
}

/** Parse and validate drafts. Returns floors only when there are no problems. */
export function parseDrafts(drafts: FloorDraft[]): { floors: Floor[] | null; problems: string[] } {
  const problems: string[] = [];
  const floors: Floor[] = [];
  const labels = new Set<string>();
  for (const d of drafts) {
    const label = d.label.trim();
    const name = label || `index ${d.index}`;
    if (!label) problems.push(`Floor at index ${d.index} needs a label.`);
    else if (labels.has(label.toLowerCase())) problems.push(`Label "${label}" is used twice.`);
    labels.add(label.toLowerCase());
    const zMin = parseDecimal(d.zMin);
    const zMax = parseDecimal(d.zMax);
    if (zMin === null) problems.push(`Floor ${name}: bottom (zMin) is not a number.`);
    if (zMax === null) problems.push(`Floor ${name}: top (zMax) is not a number.`);
    if (zMin !== null && zMax !== null) floors.push({ label, index: d.index, zMinM: zMin, zMaxM: zMax });
  }
  if (problems.length === 0) problems.push(...validateFloors(floors));
  return problems.length ? { floors: null, problems } : { floors: [...floors].sort((a, b) => a.index - b.index), problems };
}

export interface VenueDraft {
  name: string;
  city: string;
  country: string;
  floors: FloorDraft[];
}

export function venueProblems(d: VenueDraft): { floors: Floor[] | null; problems: string[] } {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push('Venue name is required.');
  if (!d.city.trim()) problems.push('City is required.');
  if (!d.country.trim()) problems.push('Country is required.');
  const parsed = parseDrafts(d.floors);
  return { floors: parsed.floors, problems: [...problems, ...parsed.problems] };
}
