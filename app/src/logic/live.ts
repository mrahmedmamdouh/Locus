import { classifyFloor, median, relativeAltitudeFromPressure, type Floor } from '@locus/altitude-core';
import type { GpsFix, Session } from './types';

export interface LiveEstimate {
  baroRelAltM: number | null;
  baroFloor: Floor | null;
  osRelAltM: number | null;
  gpsRelAltM: number | null;
  gpsFloor: Floor | null;
}

/**
 * Live (display-only) estimate: 2 s median of pressure → height relative to the entrance.
 * Recorded readings use the 5 s trimmed mean in buildReading instead.
 */
export function liveEstimate(args: {
  session: Session;
  floors: Floor[];
  pressures: number[];
  latestOsRelAlt: number | null;
  epoch: string | null;
  gps: GpsFix | null;
}): LiveEstimate {
  const { session, floors, pressures, latestOsRelAlt, epoch, gps } = args;
  const base = session.calibration.baselinePressureHpa;
  const p = median(pressures.filter((x) => Number.isFinite(x) && x > 0));
  const baroRelAltM = p !== null && base !== null ? relativeAltitudeFromPressure(p, base, session.calibration.temperatureC) : null;
  const osRelAltM =
    latestOsRelAlt !== null && session.osRelAltBaselineM !== null && epoch !== null && epoch === session.sensorEpoch
      ? latestOsRelAlt - session.osRelAltBaselineM
      : null;
  const gpsAlt = gps?.altitude ?? null;
  const baseGps = session.calibration.baselineGpsAltM;
  const gpsRelAltM = gpsAlt !== null && Number.isFinite(gpsAlt) && baseGps !== null ? gpsAlt - baseGps : null;
  return {
    baroRelAltM,
    baroFloor: baroRelAltM !== null ? classifyFloor(baroRelAltM, floors) : null,
    osRelAltM,
    gpsRelAltM,
    gpsFloor: gpsRelAltM !== null ? classifyFloor(gpsRelAltM, floors) : null,
  };
}
