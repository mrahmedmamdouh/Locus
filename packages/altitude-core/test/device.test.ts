import { describe, expect, it } from 'vitest';
import {
  barometerWorks,
  csvToDeviceChecks,
  deviceChecksToCsv,
  isDeviceCheckCsv,
  readingsToCsv,
  generateSampleReadings,
  summarizeCoverage,
  type DeviceCheck,
} from '../src';

const base: DeviceCheck = {
  id: 'd1',
  timestamp: '2026-10-27T10:00:00.000Z',
  deviceModel: 'Pixel 8',
  brand: 'google',
  platform: 'android',
  osVersion: '16',
  appVersion: '0.1.0',
  hasBarometer: true,
  barometerPermission: 'not-required',
  barometerSampleHpa: 1009.42,
  barometerRateHz: 25,
  osAltimeterAvailable: false,
  locationPermission: 'granted',
  gpsFix: true,
  gpsAltitudeAvailable: true,
  gpsAccuracyM: 12.5,
  gpsAltAccuracyM: 9,
  notes: '',
};

const noBaro: DeviceCheck = {
  ...base,
  id: 'd2',
  deviceModel: 'Galaxy A15',
  brand: 'samsung',
  hasBarometer: false,
  barometerSampleHpa: null,
  barometerRateHz: null,
};

describe('device checks', () => {
  it('round-trips through CSV, including nulls and booleans', () => {
    const checks = [base, noBaro, { ...base, id: 'd3', notes: '=SUM(1), "quoted"' }];
    const csv = deviceChecksToCsv(checks);
    const back = csvToDeviceChecks(csv);
    expect(back.errors).toEqual([]);
    expect(back.checks).toEqual(checks);
  });

  it('tells device-check files from readings files', () => {
    expect(isDeviceCheckCsv(deviceChecksToCsv([base]))).toBe(true);
    expect(isDeviceCheckCsv(readingsToCsv(generateSampleReadings(1, 1)))).toBe(false);
  });

  it('reports bad booleans instead of guessing', () => {
    const csv = deviceChecksToCsv([base]).replace(',true,not-required,', ',yes,not-required,');
    expect(csvToDeviceChecks(csv).errors[0]).toMatch(/hasBarometer/);
  });

  it('only counts a barometer that is present, permitted and reporting', () => {
    expect(barometerWorks(base)).toBe(true);
    expect(barometerWorks(noBaro)).toBe(false);
    expect(barometerWorks({ ...base, barometerPermission: 'denied' })).toBe(false);
    expect(barometerWorks({ ...base, barometerSampleHpa: null })).toBe(false);
    expect(barometerWorks({ ...base, barometerSampleHpa: 0 })).toBe(false);
  });

  it('summarises coverage, counting each phone once (latest check wins)', () => {
    const older = { ...noBaro, id: 'd4', timestamp: '2026-10-27T09:00:00.000Z', hasBarometer: true };
    const { overall, groups } = summarizeCoverage([base, noBaro, older]);
    expect(overall.devices).toBe(2);
    expect(overall.withBarometer).toBe(1);
    expect(overall.barometerShare).toBe(0.5);
    expect(groups.map((g) => g.group)).toEqual(['Galaxy A15', 'Pixel 8']);
  });
});
