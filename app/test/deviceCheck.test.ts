import { describe, expect, it, vi } from 'vitest';
import { DEVICE_CHECK_COLUMNS, barometerWorks, csvToDeviceChecks, deviceChecksToCsv } from '@locus/altitude-core';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

import {
  buildDeviceCheck,
  deviceCheckVerdict,
  medianPressureHpa,
  observedRateHz,
  toPermissionState,
  type CheckBaroSample,
  type CollectedDeviceCheck,
} from '../src/logic/deviceCheck';
import { deviceChecksFileName } from '../src/logic/exportName';
import { KEYS, createStorage, type KeyValueStore } from '../src/state/storage';
import type { GpsFix } from '../src/logic/types';

const fix = (extra: Partial<GpsFix> = {}): GpsFix => ({
  latitude: 30.05,
  longitude: 31.23,
  altitude: 72.4,
  accuracy: 6.04,
  altitudeAccuracy: 3.96,
  timestamp: 1,
  ...extra,
});

/** n samples at `hz`, pressure around 1009.4. */
const samples = (n: number, hz: number, extra: Partial<CheckBaroSample> = {}): CheckBaroSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: 1000 + (i * 1000) / hz, pressure: 1009.4 + (i % 2 ? 0.02 : -0.02), ...extra }));

const base = (extra: Partial<CollectedDeviceCheck> = {}): CollectedDeviceCheck => ({
  id: 'd1',
  timestamp: '2026-10-27T10:00:00.000Z',
  device: { modelName: 'Galaxy A05', brand: 'samsung', modelId: 'SM-A055F', osVersion: '14' },
  platform: 'android',
  appVersion: '0.1.0',
  hasBarometer: true,
  barometerPermission: 'not-required',
  samples: samples(126, 25),
  locationPermission: 'granted',
  fix: fix(),
  problems: [],
  ...extra,
});

describe('median / rate math', () => {
  it('median ignores invalid pressures', () => {
    expect(medianPressureHpa([{ t: 0, pressure: 1000 }, { t: 1, pressure: 1002 }, { t: 2, pressure: NaN }, { t: 3, pressure: 1001 }])).toBe(1001);
    expect(medianPressureHpa([{ t: 0, pressure: 1000 }, { t: 1, pressure: 1003 }])).toBe(1001.5);
    expect(medianPressureHpa([])).toBeNull();
  });

  it('rate = intervals / span', () => {
    expect(observedRateHz(samples(126, 25))).toBeCloseTo(25, 6);
    expect(observedRateHz(samples(6, 1))).toBeCloseTo(1, 6);
    // Order does not matter.
    expect(observedRateHz(samples(11, 10).reverse())).toBeCloseTo(10, 6);
  });

  it('rate needs two samples over a positive span', () => {
    expect(observedRateHz([])).toBeNull();
    expect(observedRateHz([{ t: 5, pressure: 1000 }])).toBeNull();
    expect(observedRateHz([{ t: 5, pressure: 1000 }, { t: 5, pressure: 1000 }])).toBeNull();
  });
});

describe('toPermissionState', () => {
  it('maps responses; Android motion is not-required', () => {
    expect(toPermissionState({ granted: true, status: 'granted' }, 'ios', 'motion')).toBe('granted');
    expect(toPermissionState({ granted: false, status: 'denied' }, 'ios', 'motion')).toBe('denied');
    expect(toPermissionState({ granted: false, status: 'undetermined' }, 'ios', 'location')).toBe('undetermined');
    expect(toPermissionState(null, 'ios', 'location')).toBe('unknown');
    expect(toPermissionState({ granted: false, status: 'denied' }, 'android', 'motion')).toBe('not-required');
    expect(toPermissionState({ granted: false, status: 'denied' }, 'android', 'location')).toBe('denied');
  });
});

describe('buildDeviceCheck', () => {
  it('working barometer phone', () => {
    const c = buildDeviceCheck(base());
    expect(c).toMatchObject({
      deviceModel: 'Galaxy A05',
      brand: 'samsung',
      osVersion: '14',
      hasBarometer: true,
      barometerSampleHpa: 1009.4,
      barometerRateHz: 25,
      osAltimeterAvailable: false,
      gpsFix: true,
      gpsAltitudeAvailable: true,
      gpsAccuracyM: 6,
      gpsAltAccuracyM: 4,
      notes: '',
    });
    expect(barometerWorks(c)).toBe(true);
    const v = deviceCheckVerdict(c);
    expect(v.barometer).toBe('Barometer: works (1009.4 hPa, 25 Hz)');
    expect(v.gps).toBe('GPS altitude: yes (±4 m vertical)');
    expect(v.conclusion).toBe('Can run the barometer test');
  });

  it('never uses the user-set device name', () => {
    const device = { modelName: null, brand: 'xiaomi', modelId: '23106RN0DA', osVersion: '13', deviceName: "Ahmed's phone" };
    const c = buildDeviceCheck(base({ device }));
    expect(c.deviceModel).toBe('xiaomi 23106RN0DA');
    expect(JSON.stringify(c)).not.toContain('Ahmed');
  });

  it('iOS altimeter detected from relativeAltitude', () => {
    const c = buildDeviceCheck(base({ platform: 'ios', barometerPermission: 'granted', samples: samples(6, 1, { relativeAltitude: 0.1 }) }));
    expect(c.osAltimeterAvailable).toBe(true);
    expect(c.barometerRateHz).toBe(1);
  });

  it('no-barometer phone: GPS-only', () => {
    const c = buildDeviceCheck(base({ hasBarometer: false, samples: [] }));
    expect(c.hasBarometer).toBe(false);
    expect(c.barometerSampleHpa).toBeNull();
    expect(c.barometerRateHz).toBeNull();
    expect(c.notes).toBe('');
    const v = deviceCheckVerdict(c);
    expect(v.barometer).toBe('No barometer');
    expect(v.conclusion).toBe('GPS-only: useful as a comparison phone');
    expect(v.canRunBarometerTest).toBe(false);
  });

  it('iOS motion permission denied: present but blocked', () => {
    const c = buildDeviceCheck(base({ platform: 'ios', barometerPermission: 'denied', samples: [] }));
    expect(c.hasBarometer).toBe(true);
    expect(barometerWorks(c)).toBe(false);
    expect(deviceCheckVerdict(c).barometer).toBe('Barometer present but blocked (permission)');
  });

  it('location permission denied', () => {
    const c = buildDeviceCheck(base({ locationPermission: 'denied', fix: null }));
    expect(c).toMatchObject({ gpsFix: false, gpsAltitudeAvailable: false, gpsAccuracyM: null, gpsAltAccuracyM: null });
    expect(deviceCheckVerdict(c).gps).toContain('permission denied');
  });

  it('sensor availability call threw: recorded as no barometer with a reason', () => {
    const c = buildDeviceCheck(base({ hasBarometer: null, samples: samples(10, 10), problems: ['barometer check threw: boom'] }));
    expect(c.hasBarometer).toBe(false);
    expect(c.barometerSampleHpa).toBeNull();
    expect(c.notes).toContain('boom');
    expect(c.notes).toContain('availability unknown');
  });

  it('barometer present but silent gets a note and is not counted as working', () => {
    const c = buildDeviceCheck(base({ samples: [] }));
    expect(barometerWorks(c)).toBe(false);
    expect(c.notes).toContain('no data');
    expect(deviceCheckVerdict(c).barometer).toContain('no usable data');
  });

  it('GPS fix without altitude', () => {
    const c = buildDeviceCheck(base({ fix: fix({ altitude: null, altitudeAccuracy: null }) }));
    expect(c.gpsFix).toBe(true);
    expect(c.gpsAltitudeAvailable).toBe(false);
    expect(c.gpsAltAccuracyM).toBeNull();
    expect(deviceCheckVerdict(c).gps).toBe('GPS altitude: no (fix had no altitude)');
    expect(buildDeviceCheck(base({ fix: fix({ altitude: NaN }) })).gpsAltitudeAvailable).toBe(false);
  });

  it('no GPS fix in time is noted', () => {
    const c = buildDeviceCheck(base({ fix: null }));
    expect(c.gpsFix).toBe(false);
    expect(c.notes).toContain('GPS');
  });

  it('user notes come first, missing device info becomes unknown', () => {
    const c = buildDeviceCheck(base({ userNotes: ' borrowed ', device: { modelName: null, brand: null, modelId: null, osVersion: null }, problems: ['x'] }));
    expect(c.notes).toBe('borrowed; x');
    expect(c).toMatchObject({ deviceModel: 'unknown', brand: 'unknown', osVersion: 'unknown' });
  });

  it('round-trips through the library CSV', () => {
    const checks = [buildDeviceCheck(base()), buildDeviceCheck(base({ id: 'd2', hasBarometer: false, samples: [], fix: null }))];
    const csv = deviceChecksToCsv(checks);
    expect(csv.split('\r\n')[0]).toBe(DEVICE_CHECK_COLUMNS.join(','));
    const back = csvToDeviceChecks(csv);
    expect(back.errors).toEqual([]);
    expect(back.checks).toEqual(checks);
  });
});

describe('device-check export name and storage', () => {
  it('file name', () => {
    expect(deviceChecksFileName(new Date(2026, 9, 27))).toBe('locus-device-checks-2026-10-27.csv');
  });

  class Mem implements KeyValueStore {
    data = new Map<string, string>();
    failSet: (k: string) => boolean = () => false;
    async getItem(k: string) {
      return this.data.get(k) ?? null;
    }
    async setItem(k: string, v: string) {
      if (this.failSet(k)) throw new Error('fail');
      this.data.set(k, v);
    }
    async removeItem(k: string) {
      this.data.delete(k);
    }
    async getAllKeys() {
      return [...this.data.keys()];
    }
  }

  it('persists under its own key and reloads', async () => {
    const kv = new Mem();
    const store = createStorage(kv);
    expect((await store.loadAll()).deviceChecks).toEqual([]);
    const c = buildDeviceCheck(base());
    await store.saveDeviceChecks([c]);
    expect(kv.data.has(KEYS.deviceChecks)).toBe(true);
    expect((await createStorage(kv).loadAll()).deviceChecks).toEqual([c]);
  });

  it('a corrupt value is backed up; if backup fails the load fails and nothing is overwritten', async () => {
    const kv = new Mem();
    kv.data.set(KEYS.deviceChecks, '{bad');
    kv.failSet = (k) => k.includes('.corrupt.');
    await expect(createStorage(kv).loadAll()).rejects.toThrow();
    expect(kv.data.get(KEYS.deviceChecks)).toBe('{bad');
    kv.failSet = () => false;
    expect((await createStorage(kv).loadAll()).deviceChecks).toEqual([]);
    expect([...kv.data.keys()].some((k) => k.startsWith(`${KEYS.deviceChecks}.corrupt.`))).toBe(true);
  });
});
