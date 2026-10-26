import { trimmedMean } from '@locus/altitude-core';
import type { AppCalibration, BaroWindow, GpsFix } from './types';
import { roundOrNull } from './numbers';

export interface CalibrationResult {
  calibration: AppCalibration;
  /** iOS OS relative altitude at the entrance (see Session.osRelAltBaselineM). */
  osRelAltBaselineM: number | null;
  sensorEpoch: string | null;
  sampleCount: number;
}

/**
 * Build a calibration at the venue entrance from a window of barometer samples
 * (baseline = 10 % trimmed mean) and an optional GPS fix.
 * Throws if there is neither barometer data nor a GPS altitude: nothing to measure against.
 */
export function buildCalibration(args: {
  venueId: string;
  baro: BaroWindow;
  gps: GpsFix | null;
  temperatureC: number;
  now: Date;
}): CalibrationResult {
  const { venueId, baro, gps, temperatureC, now } = args;
  if (!Number.isFinite(temperatureC) || temperatureC < -40 || temperatureC > 60) {
    throw new RangeError('Temperature must be between -40 and 60 °C.');
  }
  const pressures = baro.pressures.filter((p) => Number.isFinite(p) && p > 0);
  const baseline = trimmedMean(pressures);
  const gpsAlt = gps && gps.altitude !== null && Number.isFinite(gps.altitude) ? gps.altitude : null;
  if (baseline === null && gpsAlt === null) {
    throw new Error('No barometer samples and no GPS altitude: cannot calibrate.');
  }
  const osBaseline = trimmedMean(baro.osRelAlts);
  return {
    calibration: {
      venueId,
      timestamp: now.toISOString(),
      baselinePressureHpa: roundOrNull(baseline, 4),
      baselineGpsAltM: roundOrNull(gpsAlt, 2),
      temperatureC,
    },
    osRelAltBaselineM: osBaseline,
    sensorEpoch: baro.epoch,
    sampleCount: pressures.length,
  };
}
