import { describe, expect, it } from 'vitest';
import {
  READING_COLUMNS,
  buildUniformFloors,
  csvToReadings,
  readingsToCsv,
  relativeAltitudeFromPressure,
  type Venue,
} from '@locus/altitude-core';
import { buildReading, readingOutcome, type BuildReadingInput } from '../src/logic/reading';
import { buildCalibration } from '../src/logic/calibration';
import type { BaroWindow, GpsFix, Session } from '../src/logic/types';

const venue: Venue = {
  id: 'v1',
  name: 'City Stars',
  city: 'Cairo',
  country: 'EG',
  floors: buildUniformFloors(1, 3, 4.5),
};
const floor = (index: number) => venue.floors.find((f) => f.index === index)!;

const CAL_TIME = new Date('2026-10-27T10:00:00.000Z');
const NOW = new Date('2026-10-27T10:05:30.000Z');
const BASE = 1010;
const T = 24;

/** Pressure at a given height above BASE (inverse hypsometric). */
const pressureAt = (h: number) => BASE * Math.exp((-h * 9.80665) / (287.053 * (T + 273.15)));

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    venueId: venue.id,
    venueName: venue.name,
    startedAt: CAL_TIME.toISOString(),
    calibration: {
      venueId: venue.id,
      timestamp: CAL_TIME.toISOString(),
      baselinePressureHpa: BASE,
      baselineGpsAltM: 70,
      temperatureC: T,
    },
    osRelAltBaselineM: 0.4,
    sensorEpoch: 'e1',
    demo: false,
    ...overrides,
  };
}

const fix = (altitude: number | null, ageMs = 2000): GpsFix => ({
  latitude: 30.07,
  longitude: 31.34,
  altitude,
  accuracy: 12.34,
  altitudeAccuracy: 9.87,
  timestamp: NOW.getTime() - ageMs,
});

function input(overrides: Partial<BuildReadingInput> = {}): BuildReadingInput {
  const h = 9; // floor 2 centre
  const baro: BaroWindow = {
    // A spike outlier that the trimmed mean must reject.
    pressures: [...Array.from({ length: 19 }, () => pressureAt(h)), pressureAt(h) - 5],
    osRelAlts: [9.4, 9.4, 9.4],
    epoch: 'e1',
  };
  return {
    id: 'r1',
    session: session(),
    venue,
    trueFloor: floor(2),
    baro,
    gps: fix(70 + 9 + 2), // GPS 2 m too high
    windowStart: new Date(NOW.getTime() - 5000),
    now: NOW,
    deviceModel: 'Pixel 8',
    platform: 'android',
    note: ' near escalator ',
    demo: false,
    ...overrides,
  };
}

describe('buildReading', () => {
  it('fills every Reading field from samples', () => {
    const r = buildReading(input());
    expect(Object.keys(r).sort()).toEqual([...READING_COLUMNS].sort());
    expect(r).toMatchObject({
      id: 'r1',
      sessionId: 's1',
      venueId: 'v1',
      venueName: 'City Stars',
      deviceModel: 'Pixel 8',
      platform: 'android',
      timestamp: NOW.toISOString(),
      secondsSinceCalibration: 330,
      trueFloorLabel: '2',
      trueFloorIndex: 2,
      trueFloorCenterM: 9,
      trueFloorHeightM: 4.5,
      baselinePressureHpa: BASE,
      temperatureC: T,
      gpsLat: 30.07,
      gpsLon: 31.34,
      gpsAltM: 81,
      gpsAccuracyM: 12.3,
      gpsAltAccuracyM: 9.9,
      gpsRelAltM: 11,
      estFloorIndexBaro: 2,
      estFloorIndexGps: 2,
      sampleCount: 20,
      notes: 'near escalator',
    });
  });

  it('uses the trimmed-mean pressure and the library hypsometric formula', () => {
    const r = buildReading(input());
    expect(r.baroRelAltM).toBeCloseTo(9, 2);
    expect(r.baroRelAltM).toBeCloseTo(relativeAltitudeFromPressure(r.pressureHpa!, BASE, T), 2);
  });

  it('computes iOS OS relative altitude against the calibration baseline of the same stream', () => {
    expect(buildReading(input()).osRelAltM).toBeCloseTo(9, 6);
    const otherStream = buildReading(input({ baro: { ...input().baro, epoch: 'e2' } }));
    expect(otherStream.osRelAltM).toBeNull();
  });

  it('classifies a wrong floor when the barometer is off by more than half a floor', () => {
    const r = buildReading(input({ trueFloor: floor(1) }));
    expect(r.estFloorIndexBaro).toBe(2);
    const o = readingOutcome(r, venue.floors);
    expect(o.baro.correct).toBe(false);
    expect(o.baro.estFloorLabel).toBe('2');
    expect(o.baro.errorM).toBeCloseTo(4.5, 2);
  });

  it('records the true floor band height', () => {
    const custom: Venue = {
      ...venue,
      floors: [
        { label: 'G', index: 0, zMinM: -3, zMaxM: 3 },
        { label: 'M', index: 1, zMinM: 3, zMaxM: 6.5 },
      ],
    };
    expect(buildReading(input({ venue: custom, trueFloor: custom.floors[1]! })).trueFloorHeightM).toBe(3.5);
  });

  it('gives a null floor estimate when the height is off the floor table', () => {
    // Floors span -6.75..15.75 m; 30 m is more than half a floor above the top band.
    const r = buildReading(input({ baro: { pressures: [pressureAt(30)], osRelAlts: [], epoch: 'e1' }, gps: fix(70 - 40) }));
    expect(r.baroRelAltM).toBeCloseTo(30, 1);
    expect(r.estFloorIndexBaro).toBeNull();
    expect(r.estFloorIndexGps).toBeNull();
    const o = readingOutcome(r, venue.floors);
    expect(o.baro).toMatchObject({ estFloorLabel: null, offTable: true, correct: false });
    expect(o.gps).toMatchObject({ estFloorLabel: null, offTable: true, correct: false });
    expect(o.os.offTable).toBe(false);
  });

  it('keeps baro fields null on a phone without a barometer (GPS-only)', () => {
    const r = buildReading(
      input({
        baro: { pressures: [], osRelAlts: [], epoch: null },
        session: session({ calibration: { ...session().calibration, baselinePressureHpa: null } }),
      }),
    );
    expect(r.pressureHpa).toBeNull();
    expect(r.baselinePressureHpa).toBeNull();
    expect(r.baroRelAltM).toBeNull();
    expect(r.estFloorIndexBaro).toBeNull();
    expect(r.osRelAltM).toBeNull();
    expect(r.sampleCount).toBe(0);
    expect(r.estFloorIndexGps).toBe(2);
    expect(readingOutcome(r, venue.floors).baro.correct).toBeNull();
  });

  it('drops GPS when there is no fix, no altitude, a stale fix, or no GPS baseline', () => {
    expect(buildReading(input({ gps: null })).gpsRelAltM).toBeNull();
    const noAlt = buildReading(input({ gps: fix(null) }));
    expect(noAlt.gpsAltM).toBeNull();
    expect(noAlt.gpsRelAltM).toBeNull();
    expect(noAlt.gpsLat).toBe(30.07);
    const stale = buildReading(input({ gps: fix(80, 5 * 60_000) }));
    expect(stale.gpsLat).toBeNull();
    expect(stale.estFloorIndexGps).toBeNull();
    // 6 s old: recent, but from before the 5 s window (could be the previous floor).
    const beforeWindow = buildReading(input({ gps: fix(80, 6000) }));
    expect(beforeWindow.gpsLat).toBeNull();
    expect(beforeWindow.gpsRelAltM).toBeNull();
    const noBase = buildReading(
      input({ session: session({ calibration: { ...session().calibration, baselineGpsAltM: null } }) }),
    );
    expect(noBase.gpsAltM).toBe(81);
    expect(noBase.gpsRelAltM).toBeNull();
    expect(noBase.estFloorIndexGps).toBeNull();
  });

  it('ignores invalid pressure samples', () => {
    const r = buildReading(input({ baro: { pressures: [NaN, 0, -1, pressureAt(0)], osRelAlts: [], epoch: 'e1' } }));
    expect(r.sampleCount).toBe(1);
    expect(r.baroRelAltM).toBeCloseTo(0, 3);
    expect(r.estFloorIndexBaro).toBe(0);
  });

  it('prefixes DEMO in demo mode', () => {
    expect(buildReading(input({ demo: true })).notes).toBe('DEMO near escalator');
    expect(buildReading(input({ demo: true, note: '' })).notes).toBe('DEMO');
  });

  it('rejects a true floor that is not in the venue', () => {
    expect(() => buildReading(input({ trueFloor: { label: '9', index: 9, zMinM: 38, zMaxM: 43 } }))).toThrow();
  });

  it('round-trips through the shared CSV schema', () => {
    const rows = [buildReading(input()), buildReading(input({ id: 'r2', gps: null, demo: true }))];
    const parsed = csvToReadings(readingsToCsv(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.readings).toEqual(rows);
  });
});

describe('buildCalibration', () => {
  it('uses the trimmed mean of pressure and the GPS altitude', () => {
    const res = buildCalibration({
      venueId: 'v1',
      baro: { pressures: [1010, 1010, 1010, 1010, 1010, 1010, 1010, 1010, 1010, 1020], osRelAlts: [0.2, 0.4], epoch: 'e1' },
      gps: fix(70.456),
      temperatureC: 24,
      now: CAL_TIME,
    });
    expect(res.calibration).toEqual({
      venueId: 'v1',
      timestamp: CAL_TIME.toISOString(),
      baselinePressureHpa: 1010,
      baselineGpsAltM: 70.46,
      temperatureC: 24,
    });
    expect(res.osRelAltBaselineM).toBeCloseTo(0.3);
    expect(res.sampleCount).toBe(10);
  });

  it('allows GPS-only or baro-only, but not neither', () => {
    const empty: BaroWindow = { pressures: [], osRelAlts: [], epoch: null };
    expect(buildCalibration({ venueId: 'v1', baro: empty, gps: fix(70), temperatureC: 24, now: CAL_TIME }).calibration.baselinePressureHpa).toBeNull();
    expect(buildCalibration({ venueId: 'v1', baro: { ...empty, pressures: [1000] }, gps: null, temperatureC: 24, now: CAL_TIME }).calibration.baselineGpsAltM).toBeNull();
    expect(() => buildCalibration({ venueId: 'v1', baro: empty, gps: null, temperatureC: 24, now: CAL_TIME })).toThrow();
    expect(() => buildCalibration({ venueId: 'v1', baro: { ...empty, pressures: [1000] }, gps: null, temperatureC: 400, now: CAL_TIME })).toThrow();
  });
});
