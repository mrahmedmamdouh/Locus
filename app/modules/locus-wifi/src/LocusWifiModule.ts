import { NativeModule, requireOptionalNativeModule } from 'expo';

/** Shape returned by the Android `scan` function (see LocusWifiModule.kt). Never contains SSIDs. */
export interface NativeWifiResult {
  bssid: string;
  rssiDbm: number;
  frequencyMhz: number;
  rttResponder: boolean | null;
  ageMs: number;
}

export interface NativeWifiScan {
  started: boolean;
  updated: boolean;
  permission: 'granted' | 'denied';
  locationEnabled: boolean;
  wifiEnabled: boolean;
  elapsedMs: number;
  results: NativeWifiResult[];
  error: string | null;
}

declare class LocusWifiModule extends NativeModule<{}> {
  scan(timeoutMs: number): Promise<NativeWifiScan>;
}

/** Android only; null on iOS and web (the module is not built there). */
export default requireOptionalNativeModule<LocusWifiModule>('LocusWifi');
