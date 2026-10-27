import { describe, expect, it } from 'vitest';
import type { WifiScanStatus } from '@locus/altitude-core';
import {
  describeWifiScan,
  medianApAgeMs,
  shouldShowThrottleTip,
  toWifiScan,
  wifiReadingLabel,
  wifiStatus,
} from '../src/logic/wifi';
import type { NativeWifiScan } from '../modules/locus-wifi/src/LocusWifiModule';

const meta = {
  readingId: 'r1',
  sessionId: 's1',
  venueId: 'v1',
  trueFloorIndex: 2,
  scannedAt: '2026-10-27T10:00:00.000Z',
};

const res = (bssid: string, rssiDbm: number, ageMs = 500, rttResponder: boolean | null = false) => ({
  bssid,
  rssiDbm,
  frequencyMhz: 5180,
  rttResponder,
  ageMs,
});

function raw(overrides: Partial<NativeWifiScan> = {}): NativeWifiScan {
  return {
    started: true,
    updated: true,
    permission: 'granted',
    locationEnabled: true,
    wifiEnabled: true,
    elapsedMs: 3200,
    results: [res('A0:B1:C2:D3:E4:01', -60), res('a0:b1:c2:d3:e4:02', -45)],
    error: null,
    ...overrides,
  };
}

describe('wifiStatus', () => {
  it('covers every native outcome', () => {
    expect(wifiStatus(null)).toBe('unsupported');
    expect(wifiStatus(raw({ permission: 'denied', results: [] }))).toBe('no-permission');
    expect(wifiStatus(raw({ locationEnabled: false, results: [] }))).toBe('location-off');
    expect(wifiStatus(raw())).toBe('ok');
    expect(wifiStatus(raw({ started: false, updated: false }))).toBe('stale');
    expect(wifiStatus(raw({ started: true, updated: false }))).toBe('stale'); // timed out / no new results
    expect(wifiStatus(raw({ started: false, updated: false, results: [] }))).toBe('throttled');
    expect(wifiStatus(raw({ started: false, updated: false, wifiEnabled: false, results: [] }))).toBe('wifi-off');
    expect(wifiStatus(raw({ started: false, error: 'SecurityException: x', results: [] }))).toBe('error');
  });

  it('wifi-off only when there are no results (scan-always mode still returns results)', () => {
    expect(wifiStatus(raw({ wifiEnabled: false }))).toBe('ok');
    expect(wifiStatus(raw({ wifiEnabled: false, started: false, updated: false }))).toBe('stale');
  });
});

describe('toWifiScan', () => {
  it('maps a fresh scan, normalises BSSIDs and sorts by signal', () => {
    const scan = toWifiScan(raw(), meta);
    expect(scan).toMatchObject({ ...meta, status: 'ok' });
    expect(scan.aps.map((a) => a.bssid)).toEqual(['a0:b1:c2:d3:e4:02', 'a0:b1:c2:d3:e4:01']);
    expect(scan.aps[0]).toEqual({ bssid: 'a0:b1:c2:d3:e4:02', rssiDbm: -45, frequencyMhz: 5180, rttResponder: false, ageMs: 500 });
  });

  it('drops hotspots / randomised MACs, invalid BSSIDs and duplicates via the library', () => {
    const scan = toWifiScan(
      raw({
        results: [
          res('a0:b1:c2:d3:e4:01', -60),
          res('a2:b1:c2:d3:e4:09', -30), // locally administered (phone hotspot)
          res('02:00:00:00:00:00', -40), // redacted placeholder
          res('not-a-mac', -40),
          res('A0-B1-C2-D3-E4-01', -55), // same AP, stronger
        ],
      }),
      meta,
    );
    expect(scan.aps).toHaveLength(1);
    expect(scan.aps[0]).toMatchObject({ bssid: 'a0:b1:c2:d3:e4:01', rssiDbm: -55 });
  });

  it('keeps cached results with their age when the scan was refused', () => {
    const scan = toWifiScan(raw({ started: false, updated: false, results: [res('a0:b1:c2:d3:e4:01', -60, 40_000)] }), meta);
    expect(scan.status).toBe('stale');
    expect(scan.aps[0]!.ageMs).toBe(40_000);
    expect(describeWifiScan(scan)).toBe('1 access point (cached, 40 s old)');
  });

  it('clamps negative ages and keeps unknown values null', () => {
    const scan = toWifiScan(
      raw({ results: [{ ...res('a0:b1:c2:d3:e4:01', -60, -5), rttResponder: null }, { ...res('a0:b1:c2:d3:e4:03', -70), ageMs: NaN }] }),
      meta,
    );
    expect(scan.aps.map((a) => a.ageMs)).toEqual([0, null]);
    expect(scan.aps[0]!.rttResponder).toBeNull();
    expect(medianApAgeMs(scan)).toBe(0);
  });

  it('stores no access points for non-scan statuses', () => {
    const cases: [NativeWifiScan | null, WifiScanStatus][] = [
      [null, 'unsupported'],
      [raw({ permission: 'denied' }), 'no-permission'],
      [raw({ locationEnabled: false }), 'location-off'],
      [raw({ started: false, updated: false, results: [] }), 'throttled'],
    ];
    for (const [r, status] of cases) expect(toWifiScan(r, meta)).toEqual({ ...meta, status, aps: [] });
  });

  it("returns 'skipped' when the tester turned scanning off", () => {
    expect(toWifiScan(raw(), meta, true)).toEqual({ ...meta, status: 'skipped', aps: [] });
  });
});

describe('wifi UI helpers', () => {
  it('describes scans for the result card', () => {
    expect(describeWifiScan(toWifiScan(raw(), meta))).toBe('2 access points (fresh)');
    expect(describeWifiScan(toWifiScan(raw({ started: false, updated: false, results: [] }), meta))).toMatch(/^throttled/);
  });

  it('shows the throttle tip after two refused scans in a row', () => {
    expect(shouldShowThrottleTip(['stale'])).toBe(false);
    expect(shouldShowThrottleTip(['stale', 'throttled'])).toBe(true);
    expect(shouldShowThrottleTip(['stale', 'ok'])).toBe(false);
    expect(shouldShowThrottleTip(['throttled', 'ok', 'stale', 'stale'])).toBe(true);
  });

  it('labels readings in the Data tab', () => {
    expect(wifiReadingLabel(null, null)).toBeNull();
    expect(wifiReadingLabel('unsupported', 0)).toBeNull();
    expect(wifiReadingLabel('ok', 23)).toBe('Wi-Fi 23 APs');
    expect(wifiReadingLabel('stale', 5)).toBe('Wi-Fi 5 APs (cached)');
    expect(wifiReadingLabel('throttled', 0)).toBe('Wi-Fi throttled');
  });
});
