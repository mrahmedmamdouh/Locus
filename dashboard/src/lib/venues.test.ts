import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateGate, generateSampleReadings, type Reading, type WifiScan } from '@locus/altitude-core';
import {
  EMPTY_DATASET,
  addCsvText,
  addSource,
  addWifiScanSource,
  canonicalVenueId,
  isVenueNameTypo,
  levenshtein,
} from './data';

const fixture = (f: string) => readFileSync(join(__dirname, '__fixtures__', f), 'utf8');

describe('venues across phones', () => {
  it('keys venues by name, ignoring case and spacing', () => {
    expect(canonicalVenueId('Mall of Oman', 'v1')).toBe(canonicalVenueId('  Mall  Of OMAN ', 'v2'));
    expect(canonicalVenueId('', 'v3')).toBe('v3');
  });

  it('merges the same mall from an iPhone and an Android file (field test 2026-10-31)', () => {
    let ds = addCsvText(EMPTY_DATASET, 'iphone.csv', fixture('mall-iphone.csv'));
    ds = addCsvText(ds, 'android.csv', fixture('mall-android.csv'));
    expect(ds.readings).toHaveLength(6);
    expect(new Set(ds.readings.map((r) => r.venueId))).toEqual(new Set(['venue:mall of oman']));
    // The gate must see one venue, not two.
    expect(evaluateGate(ds.readings, 4.5, 'baro', { minFloorAccuracy: 0, maxP90FractionOfFloor: 1, minReadings: 1, minVenues: 1, minReadingsPerVenue: 1 }).venues).toBe(1);
  });

  it('re-keys Wi-Fi scans whether they are loaded before or after their readings', () => {
    const androidCsv = fixture('mall-android.csv');
    const phoneVenueId = androidCsv.split(/\r?\n/)[1]!.split(',')[2]!;
    const readingId = androidCsv.split(/\r?\n/)[1]!.split(',')[0]!;
    const scan: WifiScan = { readingId, sessionId: 's', venueId: phoneVenueId, trueFloorIndex: 0, scannedAt: '2026-10-31T16:47:38Z', status: 'ok', aps: [] };

    const before = addCsvText(addWifiScanSource(EMPTY_DATASET, 'wifi.csv', [scan], []), 'android.csv', androidCsv);
    expect(before.wifiScans[0]!.venueId).toBe('venue:mall of oman');

    const after = addWifiScanSource(addCsvText(EMPTY_DATASET, 'android.csv', androidCsv), 'wifi.csv', [scan], []);
    expect(after.wifiScans[0]!.venueId).toBe('venue:mall of oman');
  });
});

describe('venue name typos', () => {
  const base = generateSampleReadings(3, 1)[0]!;
  const reading = (id: string, venueId: string, venueName: string): Reading => ({ ...base, id, venueId, venueName, notes: '' });
  const iphone = [reading('i1', 'vIphone', 'Avenus Mall'), reading('i2', 'vIphone', 'Avenus Mall')];
  const android = [reading('a1', 'vAndroid', 'Avenues Mall'), reading('a2', 'vAndroid', 'Avenues Mall')];

  it('detects typos only for long names with the same digits', () => {
    expect(levenshtein('avenus mall', 'avenues mall')).toBe(1);
    expect(isVenueNameTypo('avenus mall', 'avenues mall')).toBe(true);
    expect(isVenueNameTypo('city centre qurum', 'city centre muscat')).toBe(false);
    expect(isVenueNameTypo('mall 1', 'mall 2')).toBe(false);
    expect(isVenueNameTypo('the mall 1', 'the mall 2')).toBe(false); // long enough, digits differ
    expect(isVenueNameTypo('the mall 12', 'the mall 12a')).toBe(true);
    expect(isVenueNameTypo('mall abc', 'mall abd')).toBe(true);
    expect(isVenueNameTypo('mall ab', 'mall ac')).toBe(false); // too short
  });

  it.each([
    ['iPhone first', iphone, android, 'Avenues Mall', 'Avenus Mall'],
    ['Android first', android, iphone, 'Avenus Mall', 'Avenues Mall'],
  ])('merges Avenus / Avenues Mall (%s)', (_, first, second, from, to) => {
    const ds = addSource(addSource(EMPTY_DATASET, 'first.csv', first, []), 'second.csv', second, []);
    expect(new Set(ds.readings.map((r) => r.venueId)).size).toBe(1);
    expect(ds.files[0]!.venueMerges).toBeUndefined();
    expect(ds.files[1]!.venueMerges).toEqual([{ from, to }]);
  });

  it('merges typos within a single file', () => {
    const ds = addSource(EMPTY_DATASET, 'both.csv', [...iphone, ...android], []);
    expect(new Set(ds.readings.map((r) => r.venueId))).toEqual(new Set(['venue:avenus mall']));
    expect(ds.files[0]!.venueMerges).toEqual([{ from: 'Avenues Mall', to: 'Avenus Mall' }]);
  });

  it('keeps different malls apart', () => {
    const ds = addSource(
      addSource(EMPTY_DATASET, 'a.csv', [reading('q', 'v1', 'City Centre Qurum'), reading('m1', 'v3', 'Mall 1')], []),
      'b.csv',
      [reading('m', 'v2', 'City Centre Muscat'), reading('m2', 'v4', 'Mall 2')],
      [],
    );
    expect(new Set(ds.readings.map((r) => r.venueId)).size).toBe(4);
    expect(ds.files[1]!.venueMerges).toBeUndefined();
  });

  it('records no merge when re-loading names already merged', () => {
    const ds = addSource(addSource(EMPTY_DATASET, 'a.csv', iphone, []), 'b.csv', [reading('z', 'v3', 'avenus  MALL')], []);
    expect(ds.readings.find((r) => r.id === 'z')!.venueId).toBe('venue:avenus mall');
    expect(ds.files[1]!.venueMerges).toBeUndefined();
  });

  it('Wi-Fi scans follow the merged venue whether loaded before or after the readings', () => {
    const scan: WifiScan = { readingId: 'a1', sessionId: 's', venueId: 'vAndroid', trueFloorIndex: 0, scannedAt: '2026-11-01T10:00:00Z', status: 'ok', aps: [] };

    const before = addSource(addWifiScanSource(addSource(EMPTY_DATASET, 'iphone.csv', iphone, []), 'wifi.csv', [scan], []), 'android.csv', android, []);
    expect(before.wifiScans[0]!.venueId).toBe('venue:avenus mall');

    const after = addWifiScanSource(addSource(addSource(EMPTY_DATASET, 'iphone.csv', iphone, []), 'android.csv', android, []), 'wifi.csv', [scan], []);
    expect(after.wifiScans[0]!.venueId).toBe('venue:avenus mall');

    const scanFirst = addSource(addSource(addWifiScanSource(EMPTY_DATASET, 'wifi.csv', [scan], []), 'iphone.csv', iphone, []), 'android.csv', android, []);
    expect(scanFirst.wifiScans[0]!.venueId).toBe('venue:avenus mall');
  });
});
