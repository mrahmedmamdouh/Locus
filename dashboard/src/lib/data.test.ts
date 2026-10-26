import { describe, expect, it } from 'vitest';
import { generateSampleReadings, readingsToCsv } from '@locus/altitude-core';
import type { Reading } from '@locus/altitude-core';
import {
  EMPTY_DATASET,
  addCsvText,
  addSource,
  applyExclusions,
  filterReadings,
  isCorrect,
  mergeReadings,
  paginate,
  recalibrationAdvice,
  scatterPoints,
  thin,
  venueOptions,
  DEFAULT_TABLE_FILTER,
  exportFileName,
} from './data';
import { parseBounded } from './settings';

const sample = generateSampleReadings(7, 3);
const base = sample[0]!;
const r = (over: Partial<Reading>): Reading => ({ ...base, ...over });

describe('mergeReadings', () => {
  it('de-duplicates by id, first occurrence wins', () => {
    const a = [r({ id: '1', notes: 'first' }), r({ id: '2' })];
    const b = [r({ id: '2', notes: 'second' }), r({ id: '3' })];
    const m = mergeReadings(a, b);
    expect(m.readings.map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(m.added).toBe(1);
    expect(m.duplicates).toBe(1);
    expect(m.readings[1]!.notes).toBe(base.notes);
  });

  it('removes duplicates within a single incoming batch', () => {
    const m = mergeReadings([], [r({ id: 'x' }), r({ id: 'x' })]);
    expect(m.readings).toHaveLength(1);
    expect(m.duplicates).toBe(1);
  });

  it('keeps rows with empty ids (cannot be de-duplicated)', () => {
    const m = mergeReadings([r({ id: '' })], [r({ id: '' })]);
    expect(m.readings).toHaveLength(2);
  });

  it('does not mutate the existing array', () => {
    const existing = [r({ id: 'a' })];
    mergeReadings(existing, [r({ id: 'b' })]);
    expect(existing).toHaveLength(1);
  });
});

describe('addCsvText / addSource', () => {
  it('loads a CSV and reports parse errors without failing the load', () => {
    const csv = readingsToCsv(sample.slice(0, 4));
    const broken = csv.trimEnd() + '\r\nbad,row\r\n';
    const ds = addCsvText(EMPTY_DATASET, 'a.csv', broken);
    expect(ds.readings).toHaveLength(4);
    expect(ds.files[0]!.errors.length).toBeGreaterThan(0);
    expect(ds.files[0]!.added).toBe(4);
  });

  it('re-uploading the same file adds nothing and records duplicates', () => {
    const csv = readingsToCsv(sample.slice(0, 5));
    let ds = addCsvText(EMPTY_DATASET, 'a.csv', csv);
    ds = addCsvText(ds, 'a-copy.csv', csv);
    expect(ds.readings).toHaveLength(5);
    expect(ds.files[1]!.duplicates).toBe(5);
    expect(ds.files[1]!.added).toBe(0);
  });

  it('reports a file with missing columns and keeps other files', () => {
    let ds = addCsvText(EMPTY_DATASET, 'good.csv', readingsToCsv(sample.slice(0, 2)));
    ds = addCsvText(ds, 'bad.csv', 'foo,bar\n1,2\n');
    expect(ds.readings).toHaveLength(2);
    expect(ds.files[1]!.errors[0]).toMatch(/Missing columns/);
  });

  it('marks synthetic sources', () => {
    const ds = addSource(EMPTY_DATASET, 'Synthetic sample', sample, [], true);
    expect(ds.files[0]!.synthetic).toBe(true);
  });
});

describe('applyExclusions', () => {
  const rows = [
    r({ id: '1', notes: 'DEMO run' }),
    r({ id: '2', notes: 'synthetic' }),
    r({ id: '3', notes: 'real reading' }),
    r({ id: '4', notes: 'demo lowercase is real' }),
    r({ id: '5', notes: 'not synthetic' }),
  ];
  it('default excludes DEMO-prefixed rows only', () => {
    expect(applyExclusions(rows, { excludeDemo: true, excludeSynthetic: false }).map((x) => x.id)).toEqual([
      '2',
      '3',
      '4',
      '5',
    ]);
  });
  it('can exclude synthetic rows (exact match)', () => {
    expect(applyExclusions(rows, { excludeDemo: true, excludeSynthetic: true }).map((x) => x.id)).toEqual([
      '3',
      '4',
      '5',
    ]);
  });
  it('can include everything', () => {
    expect(applyExclusions(rows, { excludeDemo: false, excludeSynthetic: false })).toHaveLength(5);
  });
});

describe('filterReadings', () => {
  const rows = [
    r({ id: 'a', venueId: 'v1', deviceModel: 'P', trueFloorIndex: 1, estFloorIndexBaro: 1, estFloorIndexGps: 0 }),
    r({ id: 'b', venueId: 'v1', deviceModel: 'Q', trueFloorIndex: 1, estFloorIndexBaro: 2, estFloorIndexGps: 1 }),
    r({ id: 'c', venueId: 'v2', deviceModel: 'P', trueFloorIndex: 0, estFloorIndexBaro: null, estFloorIndexGps: 0 }),
  ];
  const ids = (xs: Reading[]) => xs.map((x) => x.id);

  it('filters by venue and device', () => {
    expect(ids(filterReadings(rows, { ...DEFAULT_TABLE_FILTER, venue: 'v1' }, 'baro'))).toEqual(['a', 'b']);
    expect(ids(filterReadings(rows, { ...DEFAULT_TABLE_FILTER, device: 'P' }, 'baro'))).toEqual(['a', 'c']);
  });
  it('filters by correctness for the chosen estimate source', () => {
    expect(ids(filterReadings(rows, { ...DEFAULT_TABLE_FILTER, correctness: 'correct' }, 'baro'))).toEqual(['a']);
    expect(ids(filterReadings(rows, { ...DEFAULT_TABLE_FILTER, correctness: 'incorrect' }, 'baro'))).toEqual(['b']);
    expect(ids(filterReadings(rows, { ...DEFAULT_TABLE_FILTER, correctness: 'no-estimate' }, 'baro'))).toEqual(['c']);
    expect(ids(filterReadings(rows, { ...DEFAULT_TABLE_FILTER, correctness: 'correct' }, 'gps'))).toEqual(['b', 'c']);
  });
  it('isCorrect returns null without an estimate', () => {
    expect(isCorrect(rows[2]!, 'baro')).toBeNull();
  });
});

describe('paginate', () => {
  const xs = Array.from({ length: 23 }, (_, i) => i);
  it('slices pages and reports range', () => {
    const p = paginate(xs, 2, 10);
    expect(p.items).toEqual([20, 21, 22]);
    expect(p).toMatchObject({ page: 2, pageCount: 3, from: 21, to: 23, total: 23 });
  });
  it('clamps out-of-range pages', () => {
    expect(paginate(xs, 99, 10).page).toBe(2);
    expect(paginate(xs, -1, 10).page).toBe(0);
  });
  it('handles empty lists', () => {
    expect(paginate([], 0, 10)).toMatchObject({ items: [], pageCount: 1, from: 0, to: 0 });
  });
});

describe('charts helpers', () => {
  it('scatterPoints skips rows without a value for the source', () => {
    const rows = [r({ id: 'a', gpsRelAltM: 3 }), r({ id: 'b', gpsRelAltM: null })];
    expect(scatterPoints(rows, 'gps').map((p) => p.id)).toEqual(['a']);
  });
  it('thin caps length and keeps order', () => {
    const t = thin(Array.from({ length: 1000 }, (_, i) => i), 100);
    expect(t).toHaveLength(100);
    expect(t[0]).toBe(0);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });
  it('venueOptions is distinct and sorted by name', () => {
    expect(venueOptions(sample).map((v) => v.id)).toEqual(['demo-cairo', 'demo-muscat']);
  });
});

describe('recalibrationAdvice', () => {
  const row = (minutesFrom: number, p90: number | null, n = 10) => ({
    minutesFrom,
    n,
    medianAbsErrorM: p90,
    p90AbsErrorM: p90,
  });
  it('stable when p90 stays under half a floor', () => {
    expect(recalibrationAdvice([row(0, 0.5), row(5, 1)], 4.5).kind).toBe('stable');
  });
  it('recommends the first bucket that crosses half a floor', () => {
    expect(recalibrationAdvice([row(0, 0.5), row(5, 1), row(10, 2.3)], 4.5)).toMatchObject({
      kind: 'recalibrate',
      minutes: 10,
      thresholdM: 2.25,
    });
  });
  it('ignores sparse buckets', () => {
    expect(recalibrationAdvice([row(0, 0.5), row(5, 9, 2)], 4.5).kind).toBe('stable');
  });
  it('flags error above threshold from the start', () => {
    expect(recalibrationAdvice([row(0, 3)], 4.5).kind).toBe('exceeds-from-start');
  });
  it('no-data for empty input', () => {
    expect(recalibrationAdvice([], 4.5).kind).toBe('no-data');
  });
});

describe('misc', () => {
  it('parseBounded validates numbers', () => {
    expect(parseBounded('4.5', 2, 15)).toBe(4.5);
    expect(parseBounded('', 2, 15)).toBeNull();
    expect(parseBounded('abc', 2, 15)).toBeNull();
    expect(parseBounded('20', 2, 15)).toBeNull();
    expect(parseBounded('2.5', 1, 10, true)).toBeNull();
  });
  it('exportFileName is filesystem-safe', () => {
    expect(exportFileName(new Date(2026, 9, 27, 9, 5))).toBe('locus-readings-20261027-0905.csv');
  });
});
