import {
  classifyFloor,
  floorCenterM,
  relativeAltitudeFromPressure,
  trimmedMean,
  type Floor,
  type Reading,
  type Venue,
} from '@locus/altitude-core';
import { freshFix } from './gps';
import { round, roundOrNull } from './numbers';
import { secondsBetween } from './time';
import type { BaroWindow, GpsFix, Session } from './types';

export const DEMO_NOTE_PREFIX = 'DEMO';

export interface BuildReadingInput {
  id: string;
  session: Session;
  venue: Venue;
  trueFloor: Floor;
  baro: BaroWindow;
  /** Latest GPS fix from the watcher; dropped if older than MAX_GPS_FIX_AGE_MS. */
  gps: GpsFix | null;
  now: Date;
  deviceModel: string;
  platform: string;
  note: string;
  demo: boolean;
}

export function demoNote(note: string, demo: boolean): string {
  const n = note.trim();
  if (!demo) return n;
  return n ? `${DEMO_NOTE_PREFIX} ${n}` : DEMO_NOTE_PREFIX;
}

/**
 * Build one field-test reading from sensor samples. Pure: no sensors, no storage.
 * Every sensor-derived field is null when its input is missing; it never throws on
 * missing sensor data (only on an invalid true floor).
 */
export function buildReading(input: BuildReadingInput): Reading {
  const { session, venue, trueFloor, baro, now } = input;
  if (!venue.floors.some((f) => f.index === trueFloor.index)) {
    throw new Error(`Floor ${trueFloor.label} is not part of ${venue.name}.`);
  }
  const cal = session.calibration;

  // Barometer: robust average over the window, then height relative to the entrance.
  const pressures = baro.pressures.filter((p) => Number.isFinite(p) && p > 0);
  const pressure = trimmedMean(pressures);
  const baseline = cal.baselinePressureHpa;
  const baroRelAltM =
    pressure !== null && baseline !== null
      ? relativeAltitudeFromPressure(pressure, baseline, cal.temperatureC)
      : null;

  // iOS CoreMotion relative altitude: only valid if the sensor stream is the one we calibrated on.
  const osNow = trimmedMean(baro.osRelAlts);
  const osRelAltM =
    osNow !== null &&
    session.osRelAltBaselineM !== null &&
    session.sensorEpoch !== null &&
    baro.epoch === session.sensorEpoch
      ? osNow - session.osRelAltBaselineM
      : null;

  // GPS: latest fresh fix, altitude relative to the entrance fix.
  const fix = freshFix(input.gps, now.getTime());
  const gpsAlt = fix && fix.altitude !== null && Number.isFinite(fix.altitude) ? fix.altitude : null;
  const gpsRelAltM =
    gpsAlt !== null && cal.baselineGpsAltM !== null ? gpsAlt - cal.baselineGpsAltM : null;

  const estBaro = baroRelAltM !== null ? classifyFloor(baroRelAltM, venue.floors) : null;
  const estGps = gpsRelAltM !== null ? classifyFloor(gpsRelAltM, venue.floors) : null;

  return {
    id: input.id,
    sessionId: session.id,
    venueId: venue.id,
    venueName: venue.name,
    deviceModel: input.deviceModel || 'unknown',
    platform: input.platform,
    timestamp: now.toISOString(),
    secondsSinceCalibration: round(secondsBetween(cal.timestamp, now.getTime()), 1),
    trueFloorLabel: trueFloor.label,
    trueFloorIndex: trueFloor.index,
    trueFloorCenterM: floorCenterM(trueFloor),
    pressureHpa: roundOrNull(pressure, 4),
    baselinePressureHpa: baseline,
    temperatureC: cal.temperatureC,
    baroRelAltM: roundOrNull(baroRelAltM, 3),
    osRelAltM: roundOrNull(osRelAltM, 3),
    gpsLat: fix ? fix.latitude : null,
    gpsLon: fix ? fix.longitude : null,
    gpsAltM: roundOrNull(gpsAlt, 2),
    gpsAccuracyM: roundOrNull(fix?.accuracy, 1),
    gpsAltAccuracyM: roundOrNull(fix?.altitudeAccuracy, 1),
    gpsRelAltM: roundOrNull(gpsRelAltM, 2),
    estFloorIndexBaro: estBaro ? estBaro.index : null,
    estFloorIndexGps: estGps ? estGps.index : null,
    sampleCount: pressures.length,
    notes: demoNote(input.note, input.demo),
  };
}

export interface SourceOutcome {
  estFloorLabel: string | null;
  errorM: number | null;
  correct: boolean | null;
}

export interface ReadingOutcome {
  baro: SourceOutcome;
  gps: SourceOutcome;
  os: SourceOutcome;
}

function outcome(
  relAlt: number | null,
  estIndex: number | null,
  r: Reading,
  floors: Floor[],
): SourceOutcome {
  if (relAlt === null) return { estFloorLabel: null, errorM: null, correct: null };
  const idx = estIndex ?? classifyFloor(relAlt, floors)?.index ?? null;
  const label = idx === null ? null : (floors.find((f) => f.index === idx)?.label ?? String(idx));
  return {
    estFloorLabel: label,
    errorM: relAlt - r.trueFloorCenterM,
    correct: idx === null ? null : idx === r.trueFloorIndex,
  };
}

/** Estimated vs true floor and height error per source, for the result card. */
export function readingOutcome(r: Reading, floors: Floor[]): ReadingOutcome {
  return {
    baro: outcome(r.baroRelAltM, r.estFloorIndexBaro, r, floors),
    gps: outcome(r.gpsRelAltM, r.estFloorIndexGps, r, floors),
    os: outcome(r.osRelAltM, null, r, floors),
  };
}
