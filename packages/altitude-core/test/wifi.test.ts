import { describe, expect, it } from 'vitest';
import {
  barometerAccuracyOn,
  cleanAccessPoints,
  csvToReadings,
  csvToWifiScans,
  evaluateWifiFloors,
  fingerprintDistance,
  generateSampleReadings,
  generateSampleWifiScans,
  isDeviceCheckCsv,
  isLocallyAdministered,
  isWifiScanCsv,
  normalizeBssid,
  readingsToCsv,
  wifiScansToCsv,
  type WifiScan,
} from '../src';

const ap = (bssid: string, rssiDbm: number, ageMs: number | null = 1000) => ({
  bssid,
  rssiDbm,
  frequencyMhz: 2437,
  rttResponder: null,
  ageMs,
});

describe('access point cleaning', () => {
  it('normalises MACs and rejects invalid ones', () => {
    expect(normalizeBssid('A4-5E-60-11-22-33')).toBe('a4:5e:60:11:22:33');
    expect(normalizeBssid('02:00:00:00:00:00')).toBeNull(); // Android's "no permission" placeholder
    expect(normalizeBssid('not-a-mac')).toBeNull();
  });

  it('detects locally administered (hotspot / randomised) MACs', () => {
    expect(isLocallyAdministered('a4:5e:60:11:22:33')).toBe(false);
    expect(isLocallyAdministered('da:a1:19:00:00:01')).toBe(true);
    expect(isLocallyAdministered('02:11:22:33:44:55')).toBe(true);
  });

  it('drops hotspots, invalid signals and duplicates, keeping the strongest', () => {
    const { aps, dropped } = cleanAccessPoints([
      ap('a4:5e:60:11:22:33', -70),
      ap('A4:5E:60:11:22:33', -60),
      ap('da:a1:19:00:00:01', -40),
      ap('a4:5e:60:11:22:34', 5),
      ap('a4:5e:60:11:22:35', -80),
    ]);
    expect(aps.map((a) => [a.bssid, a.rssiDbm])).toEqual([
      ['a4:5e:60:11:22:33', -60],
      ['a4:5e:60:11:22:35', -80],
    ]);
    expect(dropped).toBe(3);
  });
});

describe('Wi-Fi CSV', () => {
  const readings = generateSampleReadings(42, 6);
  const scans = generateSampleWifiScans(readings);

  it('round-trips scans, including scans with no access points', () => {
    const withEmpty: WifiScan[] = [
      ...scans,
      { ...scans[0]!, readingId: 'empty1', status: 'throttled', aps: [] },
    ];
    const back = csvToWifiScans(wifiScansToCsv(withEmpty));
    expect(back.errors).toEqual([]);
    expect(back.scans).toEqual(withEmpty);
  });

  it('is told apart from readings and device-check files', () => {
    const csv = wifiScansToCsv(scans);
    expect(isWifiScanCsv(csv)).toBe(true);
    expect(isDeviceCheckCsv(csv)).toBe(false);
    expect(isWifiScanCsv(readingsToCsv(readings))).toBe(false);
  });

  it('keeps readings round-tripping with the new optional Wi-Fi columns', () => {
    const back = csvToReadings(readingsToCsv(readings));
    expect(back.errors).toEqual([]);
    expect(back.readings).toEqual(readings);
  });

  it('reports bad rows', () => {
    const csv = wifiScansToCsv(scans.slice(0, 1)) + 'x,s,v,0,2026-01-01T00:00:00Z,bogus,,,,,\r\n';
    expect(csvToWifiScans(csv).errors[0]).toMatch(/unknown scan status/);
  });
});

describe('Wi-Fi floor classifier', () => {
  it('measures distance only when access points overlap', () => {
    const a = new Map([['x', -50], ['y', -70]]);
    expect(fingerprintDistance(a, a)).toBe(0);
    expect(fingerprintDistance(a, new Map([['z', -50]]))).toBe(Infinity);
  });

  it('identifies floors on synthetic data using session holdout', () => {
    const readings = generateSampleReadings(42, 12);
    const scans = generateSampleWifiScans(readings);
    const ev = evaluateWifiFloors(scans);
    expect(ev.evaluated).toBeGreaterThan(100);
    expect(ev.predictions.every((p) => p.holdout === 'session')).toBe(true);
    expect(ev.accuracy!).toBeGreaterThan(0.8);
    const baro = barometerAccuracyOn(readings, ev.predictions);
    expect(baro).not.toBeNull();
  });

  it('falls back to time holdout with one session and skips unusable scans', () => {
    const readings = generateSampleReadings(42, 12);
    const scans = generateSampleWifiScans(readings);
    const oneSession = scans.filter((s) => s.sessionId === scans[0]!.sessionId);
    const ev = evaluateWifiFloors([
      ...oneSession,
      { ...oneSession[0]!, readingId: 'thr', status: 'throttled', aps: [] },
      { ...oneSession[0]!, readingId: 'few', aps: oneSession[0]!.aps.slice(0, 2) },
    ]);
    expect(ev.predictions.every((p) => p.holdout === 'time')).toBe(true);
    expect(ev.skipped.notOk).toBe(1);
    expect(ev.skipped.tooFewAps).toBe(1);
  });

  it('ignores access point results older than the limit', () => {
    const fresh: WifiScan = {
      readingId: 'r1', sessionId: 's', venueId: 'v', trueFloorIndex: 0,
      scannedAt: '2026-10-27T10:00:00Z', status: 'stale',
      aps: [ap('a4:00:00:00:00:01', -50, 60_000), ap('a4:00:00:00:00:02', -55, 60_000), ap('a4:00:00:00:00:03', -60, 60_000)],
    };
    expect(evaluateWifiFloors([fresh]).skipped.tooFewAps).toBe(1);
  });
});
