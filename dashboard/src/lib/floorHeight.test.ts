import { describe, expect, it } from 'vitest';
import { generateSampleReadings, summarize } from '@locus/altitude-core';
import type { Reading } from '@locus/altitude-core';
import { applyFloorHeightOverrides, venueFloorHeights } from './floorHeight';

const base = generateSampleReadings(3, 1)[0]!;
const reading = (over: Partial<Reading>): Reading => ({
  ...base,
  venueId: 'venue:avenues mall',
  venueName: 'Avenues Mall',
  trueFloorHeightM: 4.5,
  gpsRelAltM: null,
  notes: '',
  ...over,
});

// Recorded at 4.5 m: floor 1 at 7.1 m was classified as floor 2 on the phone.
const readings = [
  reading({ id: 'a', trueFloorIndex: -1, trueFloorCenterM: -4.5, baroRelAltM: -5.9, estFloorIndexBaro: -1 }),
  reading({ id: 'b', trueFloorIndex: 0, trueFloorCenterM: 0, baroRelAltM: 0.3, estFloorIndexBaro: 0 }),
  reading({ id: 'c', trueFloorIndex: 1, trueFloorCenterM: 4.5, baroRelAltM: 7.1, estFloorIndexBaro: 2, gpsRelAltM: 3 }),
  reading({ id: 'd', trueFloorIndex: 2, trueFloorCenterM: 9, baroRelAltM: 11.4, estFloorIndexBaro: 2 }),
  reading({ id: 'e', trueFloorIndex: 2, trueFloorCenterM: 9, baroRelAltM: null, estFloorIndexBaro: 2 }),
  reading({ id: 'x', venueId: 'venue:other', venueName: 'Other', trueFloorIndex: 1, trueFloorCenterM: 4.5, baroRelAltM: 7.1, estFloorIndexBaro: 2 }),
];

describe('applyFloorHeightOverrides', () => {
  it('returns the input untouched without a valid override', () => {
    expect(applyFloorHeightOverrides(readings, {})).toBe(readings);
    expect(applyFloorHeightOverrides(readings, { 'venue:avenues mall': Number.NaN })).toBe(readings);
    expect(applyFloorHeightOverrides(readings, { 'venue:avenues mall': 0.5 })).toBe(readings);
  });

  it('re-derives floor centre, height and floor estimates for the overridden venue only', () => {
    const out = applyFloorHeightOverrides(readings, { 'venue:avenues mall': 5.75 });
    const by = new Map(out.map((r) => [r.id, r]));
    expect(by.get('c')).toMatchObject({ trueFloorCenterM: 5.75, trueFloorHeightM: 5.75, estFloorIndexBaro: 1, estFloorIndexGps: 1 });
    expect(by.get('a')).toMatchObject({ trueFloorCenterM: -5.75, estFloorIndexBaro: -1, estFloorIndexGps: null });
    expect(by.get('d')).toMatchObject({ trueFloorCenterM: 11.5, estFloorIndexBaro: 2 });
    expect(by.get('e')!.estFloorIndexBaro).toBeNull();
    expect(by.get('x')).toBe(readings[5]); // other venue untouched
    expect(readings[2]!.estFloorIndexBaro).toBe(2); // input not mutated
    expect(summarize(out.slice(0, 4), 'baro', 4.5).floorAccuracy).toBe(1);
    expect(summarize(readings.slice(0, 4), 'baro', 4.5).floorAccuracy).toBe(0.75);
  });

  it('returns null beyond the venue floors and includes the entrance floor', () => {
    const upper = [
      reading({ id: 'u1', trueFloorIndex: 1, baroRelAltM: 0.4 }),
      reading({ id: 'u2', trueFloorIndex: 2, baroRelAltM: 30 }),
    ];
    const out = applyFloorHeightOverrides(upper, { 'venue:avenues mall': 5 });
    expect(out[0]!.estFloorIndexBaro).toBe(0);
    expect(out[1]!.estFloorIndexBaro).toBeNull();
  });
});

describe('venueFloorHeights', () => {
  it('lists venues with their recorded heights', () => {
    expect(venueFloorHeights([...readings, reading({ id: 'y', venueId: 'venue:other', venueName: 'Other', trueFloorHeightM: null })])).toEqual([
      { id: 'venue:avenues mall', name: 'Avenues Mall', readings: 5, recordedM: [4.5] },
      { id: 'venue:other', name: 'Other', readings: 2, recordedM: [4.5] },
    ]);
  });
});
