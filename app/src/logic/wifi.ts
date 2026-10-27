import { cleanAccessPoints, type WifiAp, type WifiScan, type WifiScanStatus } from '@locus/altitude-core';
import type { NativeWifiScan } from '../../modules/locus-wifi/src/LocusWifiModule';

/** Wi-Fi scan timeout: a little longer than the 5 s barometer window. */
export const WIFI_SCAN_TIMEOUT_MS = 6_000;

export interface WifiScanMeta {
  readingId: string;
  sessionId: string;
  venueId: string;
  trueFloorIndex: number;
  scannedAt: string;
}

/** Status of a native scan result. `raw` null = no native module (iOS/web). */
export function wifiStatus(raw: NativeWifiScan | null): WifiScanStatus {
  if (!raw) return 'unsupported';
  if (raw.permission !== 'granted') return 'no-permission';
  if (!raw.locationEnabled) return 'location-off';
  const hasResults = raw.results.length > 0;
  if (raw.error && !hasResults) return 'error';
  if (raw.started && raw.updated) return 'ok';
  if (hasResults) return 'stale';
  if (!raw.wifiEnabled) return 'wifi-off';
  if (raw.error) return 'error';
  return 'throttled';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Map a native result to a library WifiScan: status, then hotspot/duplicate
 * filtering via `cleanAccessPoints`. Pass `skipped` when the tester turned scanning off.
 */
export function toWifiScan(raw: NativeWifiScan | null, meta: WifiScanMeta, skipped = false): WifiScan {
  if (skipped) return { ...meta, status: 'skipped', aps: [] };
  const status = wifiStatus(raw);
  if (!raw || (status !== 'ok' && status !== 'stale')) return { ...meta, status, aps: [] };
  const aps: WifiAp[] = [];
  for (const r of raw.results) {
    const rssi = num(r.rssiDbm);
    const freq = num(r.frequencyMhz);
    if (typeof r.bssid !== 'string' || rssi === null || freq === null) continue;
    const age = num(r.ageMs);
    aps.push({
      bssid: r.bssid,
      rssiDbm: rssi,
      frequencyMhz: freq,
      rttResponder: typeof r.rttResponder === 'boolean' ? r.rttResponder : null,
      ageMs: age === null ? null : Math.max(0, Math.round(age)),
    });
  }
  return { ...meta, status, aps: cleanAccessPoints(aps).aps };
}

/** Median access point age in ms, or null. */
export function medianApAgeMs(scan: WifiScan): number | null {
  const ages = scan.aps.map((a) => a.ageMs).filter((a): a is number => a !== null).sort((a, b) => a - b);
  if (ages.length === 0) return null;
  const mid = Math.floor(ages.length / 2);
  return ages.length % 2 ? ages[mid]! : (ages[mid - 1]! + ages[mid]!) / 2;
}

/** One-line summary for the result card, e.g. "23 access points (fresh)". */
export function describeWifiScan(scan: WifiScan): string {
  const n = scan.aps.length;
  const aps = `${n} access point${n === 1 ? '' : 's'}`;
  switch (scan.status) {
    case 'ok':
      return `${aps} (fresh)`;
    case 'stale': {
      const age = medianApAgeMs(scan);
      return age === null ? `${aps} (cached)` : `${aps} (cached, ${Math.round(age / 1000)} s old)`;
    }
    case 'throttled':
      return 'throttled (Android refused a new scan)';
    case 'no-permission':
      return 'no location permission';
    case 'location-off':
      return 'Location is off';
    case 'wifi-off':
      return 'Wi-Fi is off';
    case 'unsupported':
      return 'not supported on this phone';
    case 'skipped':
      return 'off in Settings';
    case 'error':
      return 'scan failed';
  }
}

/** Short label for the Data tab (from the Reading fields); null when there is nothing worth showing. */
export function wifiReadingLabel(status: string | null, apCount: number | null): string | null {
  if (status === null || status === 'unsupported') return null;
  if ((status === 'ok' || status === 'stale') && apCount !== null) return `Wi-Fi ${apCount} APs${status === 'stale' ? ' (cached)' : ''}`;
  return `Wi-Fi ${status}`;
}

/** True when the last two scans were refused by Android's scan throttling. */
export function shouldShowThrottleTip(recent: (WifiScanStatus | null)[]): boolean {
  const last2 = recent.slice(-2);
  return last2.length === 2 && last2.every((s) => s === 'stale' || s === 'throttled');
}

export const THROTTLE_TIP =
  'Android limits Wi-Fi scans to 4 every 2 minutes. On test phones, turn off Developer options → Networking → Wi-Fi scan throttling.';
