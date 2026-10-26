import { describe, expect, it } from 'vitest';
import { MAX_GPS_FIX_AGE_MS, fixForWindow } from '../src/logic/gps';
import { deviceModelLabel } from '../src/logic/device';
import type { GpsFix } from '../src/logic/types';

const START = 1_000_000;
const END = START + 5000;
const at = (timestamp: number): GpsFix => ({
  latitude: 30,
  longitude: 31,
  altitude: 70,
  accuracy: 5,
  altitudeAccuracy: 3,
  timestamp,
});

describe('fixForWindow (GPS freshness)', () => {
  it('accepts a fix taken during the sampling window', () => {
    expect(fixForWindow(at(START), START, END)).not.toBeNull();
    expect(fixForWindow(at(END - 100), START, END)).not.toBeNull();
  });

  it('rejects a fix from before the window, even if only a second old', () => {
    expect(fixForWindow(at(START - 1), START, END)).toBeNull();
    // Typical escalator case: fix captured on the previous floor ~30 s earlier.
    expect(fixForWindow(at(END - 30_000), START, END)).toBeNull();
  });

  it('rejects fixes older than the max age and invalid fixes', () => {
    expect(MAX_GPS_FIX_AGE_MS).toBeLessThanOrEqual(10_000);
    expect(fixForWindow(at(START), START, START + MAX_GPS_FIX_AGE_MS + 1)).toBeNull();
    expect(fixForWindow(null, START, END)).toBeNull();
    expect(fixForWindow({ ...at(START + 1), latitude: NaN }, START, END)).toBeNull();
  });
});

describe('deviceModelLabel', () => {
  it('uses the model name, never the user-set device name', () => {
    const withName = { modelName: 'Pixel 8', brand: 'google', modelId: null, deviceName: "Ahmed's phone" };
    expect(deviceModelLabel(withName)).toBe('Pixel 8');
    expect(deviceModelLabel({ ...withName, modelName: null })).toBe('google');
    expect(deviceModelLabel({ ...withName, modelName: null })).not.toContain('Ahmed');
  });

  it('falls back to brand + model id, then unknown', () => {
    expect(deviceModelLabel({ modelName: null, brand: 'samsung', modelId: 'SM-S911B' })).toBe('samsung SM-S911B');
    expect(deviceModelLabel({ modelName: '  ', brand: null, modelId: 'iPhone16,1' })).toBe('iPhone16,1');
    expect(deviceModelLabel({ modelName: null, brand: null, modelId: null })).toBe('unknown');
  });
});
