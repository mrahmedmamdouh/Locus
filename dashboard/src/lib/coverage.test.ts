import { describe, expect, it } from 'vitest';
import { deviceChecksToCsv, generateSampleReadings, readingsToCsv, summarizeCoverage } from '@locus/altitude-core';
import type { DeviceCheck } from '@locus/altitude-core';
import { EMPTY_DATASET, addCsvText, addDeviceCheckSource, applyExclusions, detectFileKind, mergeDeviceChecks } from './data';
import { barometerState, coverage, crossCheck, generateSampleDeviceChecks, phoneRows } from './coverage';

const sample = generateSampleDeviceChecks();
const base = sample[0]!;
const dc = (over: Partial<DeviceCheck>): DeviceCheck => ({ ...base, ...over });
const readings = generateSampleReadings(7, 3);

describe('file-type routing', () => {
  it('detects device-check and readings CSVs', () => {
    expect(detectFileKind(deviceChecksToCsv(sample))).toBe('device-checks');
    expect(detectFileKind(readingsToCsv(readings.slice(0, 2)))).toBe('readings');
    expect(detectFileKind('foo,bar\n1,2\n')).toBe('readings');
  });

  it('routes each file to its own list and records its kind', () => {
    let ds = addCsvText(EMPTY_DATASET, 'r.csv', readingsToCsv(readings.slice(0, 3)));
    ds = addCsvText(ds, 'd.csv', deviceChecksToCsv(sample.slice(0, 4)));
    expect(ds.readings).toHaveLength(3);
    expect(ds.deviceChecks).toHaveLength(4);
    expect(ds.files.map((f) => f.kind)).toEqual(['readings', 'device-checks']);
    expect(ds.files[1]!.added).toBe(4);
  });

  it('reports device-check parse errors without failing the load', () => {
    const csv = deviceChecksToCsv(sample.slice(0, 2)).replace(/,true,/, ',maybe,');
    const ds = addCsvText(EMPTY_DATASET, 'd.csv', csv + 'short,row\r\n');
    expect(ds.files[0]!.kind).toBe('device-checks');
    expect(ds.deviceChecks).toHaveLength(1);
    expect(ds.files[0]!.errors).toHaveLength(2);
    expect(ds.files[0]!.errors.join(' ')).toMatch(/invalid value in hasBarometer/);
  });
});

describe('device-check merge / dedup', () => {
  it('de-duplicates by id across files, first occurrence wins', () => {
    const m = mergeDeviceChecks([dc({ id: 'a', notes: 'first' })], [dc({ id: 'a', notes: 'second' }), dc({ id: 'b' })]);
    expect(m.deviceChecks.map((c) => c.id)).toEqual(['a', 'b']);
    expect(m.deviceChecks[0]!.notes).toBe('first');
    expect(m).toMatchObject({ added: 1, duplicates: 1 });
  });

  it('re-uploading the same device-check file adds nothing', () => {
    const csv = deviceChecksToCsv(sample);
    let ds = addCsvText(EMPTY_DATASET, 'a.csv', csv);
    ds = addCsvText(ds, 'a-copy.csv', csv);
    expect(ds.deviceChecks).toHaveLength(sample.length);
    expect(ds.files[1]).toMatchObject({ added: 0, duplicates: sample.length, kind: 'device-checks' });
  });

  it('keeps readings untouched when device checks are added', () => {
    let ds = addCsvText(EMPTY_DATASET, 'r.csv', readingsToCsv(readings.slice(0, 2)));
    ds = addDeviceCheckSource(ds, 's', sample, [], true);
    expect(ds.readings).toHaveLength(2);
    expect(ds.files[1]!.synthetic).toBe(true);
  });

  it('the synthetic exclusion also applies to device checks', () => {
    expect(applyExclusions(sample, { excludeDemo: true, excludeSynthetic: true })).toHaveLength(0);
  });
});

describe('synthetic device-check sample', () => {
  it('is deterministic, labelled synthetic and round-trips through CSV', () => {
    expect(generateSampleDeviceChecks()).toEqual(sample);
    expect(sample.every((c) => c.notes === 'synthetic')).toBe(true);
    const ds = addCsvText(EMPTY_DATASET, 'x.csv', deviceChecksToCsv(sample));
    expect(ds.files[0]!.errors).toEqual([]);
    expect(ds.deviceChecks).toEqual(sample);
  });

  it('mixes barometer and no-barometer phones', () => {
    const cov = coverage(sample);
    expect(cov.overall.devices).toBe(11); // the Pixel 8 re-check counts once
    expect(cov.overall.withBarometer).toBe(4); // iPhone 11 is blocked by permission
    expect(cov.overall).toEqual(summarizeCoverage(sample).overall);
    expect(cov.byPlatform.map((r) => r.group)).toEqual(['Android', 'iOS']);
    expect(cov.byBrand.find((r) => r.group === 'Apple')).toMatchObject({ devices: 3, withBarometer: 2 });
  });

  it('per-phone rows keep the latest check and explain the barometer state', () => {
    const rows = phoneRows(sample);
    expect(rows).toHaveLength(11);
    const pixel = rows.find((r) => r.check.deviceModel === 'Pixel 8')!;
    expect(pixel.checks).toBe(2);
    expect(pixel.check.id).toBe('synthetic-dc-04');
    expect(rows.find((r) => r.check.deviceModel === 'iPhone 11')!.barometer).toBe('blocked');
    expect(rows.find((r) => r.check.deviceModel === 'Galaxy A15')!.barometer).toBe('none');
    expect(barometerState(dc({ hasBarometer: true, barometerSampleHpa: null }))).toBe('no-signal');
  });
});

describe('crossCheck', () => {
  it('lists models missing from either export (case-insensitive)', () => {
    // Sample readings use iPhone 15, Pixel 8, Galaxy A54.
    const checks = [dc({ deviceModel: 'iphone 15 ' }), dc({ deviceModel: 'Pixel 8' }), dc({ deviceModel: 'Redmi 13C' })];
    expect(crossCheck(readings, checks)).toEqual({
      readingsWithoutCheck: ['Galaxy A54'],
      checksWithoutReadings: ['Redmi 13C'],
    });
  });
  it('is empty-safe', () => {
    expect(crossCheck([], [])).toEqual({ readingsWithoutCheck: [], checksWithoutReadings: [] });
  });
});
