import { barometerWorks, median, type DeviceCheck, type PermissionState } from '@locus/altitude-core';
import { deviceModelLabel, type DeviceInfo } from './device';
import { roundOrNull } from './numbers';
import type { GpsFix } from './types';

/** How long the device check listens to the barometer. */
export const DEVICE_CHECK_BARO_MS = 5_000;
/** How long the device check waits for one GPS fix (runs alongside the barometer window). */
export const DEVICE_CHECK_GPS_TIMEOUT_MS = 8_000;

/** One barometer event as received during the check. `t` = arrival time (Date.now ms). */
export interface CheckBaroSample {
  t: number;
  pressure: number;
  relativeAltitude?: number | null;
}

/** Everything the device check collected on the phone; turned into a DeviceCheck by `buildDeviceCheck`. */
export interface CollectedDeviceCheck {
  id: string;
  timestamp: string;
  device: DeviceInfo & { osVersion: string | null };
  platform: string;
  appVersion: string;
  /** null = the availability call threw (unknown; recorded as false with a note). */
  hasBarometer: boolean | null;
  barometerPermission: PermissionState;
  samples: CheckBaroSample[];
  locationPermission: PermissionState;
  fix: GpsFix | null;
  /** Short reasons for anything that failed (sensor threw, timeout, …). */
  problems: string[];
  /** Free text typed by the tester. */
  userNotes?: string;
}

/** Map an expo permission response (or a thrown call = null) to the library's PermissionState. */
export function toPermissionState(
  res: { granted?: boolean; status?: string } | null | undefined,
  platform: string,
  kind: 'motion' | 'location',
): PermissionState {
  // Android (and web) need no permission for the barometer.
  if (kind === 'motion' && platform !== 'ios') return 'not-required';
  if (!res) return 'unknown';
  if (res.granted || res.status === 'granted') return 'granted';
  if (res.status === 'denied') return 'denied';
  if (res.status === 'undetermined') return 'undetermined';
  return 'unknown';
}

const validPressure = (p: number) => Number.isFinite(p) && p > 0;

/** Median of the valid pressures (hPa), or null when none arrived. */
export function medianPressureHpa(samples: CheckBaroSample[]): number | null {
  return median(samples.map((s) => s.pressure).filter(validPressure));
}

/**
 * Observed update rate in Hz: intervals between first and last sample over the time they span.
 * Needs at least two samples over a positive span.
 */
export function observedRateHz(samples: CheckBaroSample[]): number | null {
  const ts = samples
    .filter((s) => validPressure(s.pressure))
    .map((s) => s.t)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const spanS = (ts[ts.length - 1]! - ts[0]!) / 1000;
  if (spanS <= 0) return null;
  return (ts.length - 1) / spanS;
}

const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

export function buildDeviceCheck(c: CollectedDeviceCheck): DeviceCheck {
  const problems = [...c.problems];
  const hasBarometer = c.hasBarometer === true;
  if (c.hasBarometer === null) problems.push('barometer availability unknown (check failed)');
  const samples = hasBarometer ? c.samples : [];
  const hpa = medianPressureHpa(samples);
  if (hasBarometer && c.barometerPermission !== 'denied' && hpa === null) problems.push('barometer sent no data');

  const fix = c.fix && finite(c.fix.latitude) && finite(c.fix.longitude) ? c.fix : null;
  if (!fix && c.locationPermission === 'granted' && !problems.some((p) => p.startsWith('GPS'))) {
    problems.push('GPS: no fix in time');
  }
  const notes = [c.userNotes?.trim(), ...problems].filter((s): s is string => !!s).join('; ');

  return {
    id: c.id,
    timestamp: c.timestamp,
    deviceModel: deviceModelLabel(c.device),
    brand: c.device.brand?.trim() || 'unknown',
    platform: c.platform,
    osVersion: c.device.osVersion?.trim() || 'unknown',
    appVersion: c.appVersion,
    hasBarometer,
    barometerPermission: c.barometerPermission,
    barometerSampleHpa: roundOrNull(hpa, 2),
    barometerRateHz: roundOrNull(observedRateHz(samples), 1),
    osAltimeterAvailable: samples.some((s) => finite(s.relativeAltitude)),
    locationPermission: c.locationPermission,
    gpsFix: fix !== null,
    gpsAltitudeAvailable: fix !== null && finite(fix.altitude),
    gpsAccuracyM: roundOrNull(fix?.accuracy, 1),
    gpsAltAccuracyM: roundOrNull(fix?.altitudeAccuracy, 1),
    notes,
  };
}

export interface DeviceCheckVerdict {
  barometer: string;
  gps: string;
  conclusion: string;
  canRunBarometerTest: boolean;
}

export function deviceCheckVerdict(c: DeviceCheck): DeviceCheckVerdict {
  const works = barometerWorks(c);
  let barometer: string;
  if (works) {
    const rate = c.barometerRateHz === null ? '' : `, ${c.barometerRateHz.toFixed(0)} Hz`;
    barometer = `Barometer: works (${c.barometerSampleHpa!.toFixed(1)} hPa${rate})`;
  } else if (!c.hasBarometer) {
    barometer = 'No barometer';
  } else if (c.barometerPermission === 'denied') {
    barometer = 'Barometer present but blocked (permission)';
  } else {
    barometer = 'Barometer present but sent no usable data';
  }

  let gps: string;
  if (c.locationPermission === 'denied') gps = 'GPS altitude: unknown (location permission denied)';
  else if (!c.gpsFix) gps = 'GPS altitude: unknown (no fix)';
  else if (c.gpsAltitudeAvailable) {
    const acc = c.gpsAltAccuracyM !== null ? ` (±${c.gpsAltAccuracyM.toFixed(0)} m vertical)` : c.gpsAccuracyM !== null ? ` (±${c.gpsAccuracyM.toFixed(0)} m horizontal)` : '';
    gps = `GPS altitude: yes${acc}`;
  } else gps = 'GPS altitude: no (fix had no altitude)';

  return {
    barometer,
    gps,
    conclusion: works ? 'Can run the barometer test' : 'GPS-only: useful as a comparison phone',
    canRunBarometerTest: works,
  };
}
