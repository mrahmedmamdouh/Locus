import LocusWifi, { type NativeWifiScan } from '../../modules/locus-wifi/src/LocusWifiModule';

export type RawWifiResult = NativeWifiScan;

/** True when this build has the Android Wi-Fi scan module (false on iOS, web, Expo Go). */
export const wifiScanSupported = LocusWifi !== null;

/**
 * Run one Wi-Fi scan (Android only). Null when the native module is missing
 * (iOS/web), which maps to status 'unsupported'. Never throws: a native failure
 * becomes a result with `error` set.
 */
export async function scanWifi(timeoutMs: number): Promise<RawWifiResult | null> {
  if (!LocusWifi) return null;
  try {
    return await LocusWifi.scan(Math.round(timeoutMs));
  } catch (e) {
    return {
      started: false,
      updated: false,
      permission: 'granted',
      locationEnabled: true,
      wifiEnabled: true,
      elapsedMs: 0,
      results: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
