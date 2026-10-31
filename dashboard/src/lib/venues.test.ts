import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateGate, type WifiScan } from '@locus/altitude-core';
import { EMPTY_DATASET, addCsvText, addWifiScanSource, canonicalVenueId } from './data';

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
