import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reading, WifiScan } from '@locus/altitude-core';

// The real module needs React Native; the app singleton is never used in these tests.
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

import { KEYS, createStorage, readingKey, wifiKey, type KeyValueStore } from '../src/state/storage';

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  writes: string[] = [];
  failSet: (key: string) => boolean = () => false;
  async getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  async setItem(key: string, value: string) {
    if (this.failSet(key)) throw new Error(`write failed: ${key}`);
    this.writes.push(key);
    this.data.set(key, value);
  }
  async removeItem(key: string) {
    this.data.delete(key);
  }
  async getAllKeys() {
    return [...this.data.keys()];
  }
}

let n = 0;
const reading = (sessionId: string, extra: Partial<Reading> = {}): Reading =>
  ({ id: `r${++n}`, sessionId, trueFloorHeightM: 4.5, notes: '', ...extra }) as Reading;

let kv: MemoryStore;
beforeEach(() => {
  kv = new MemoryStore();
  n = 0;
});

describe('storage: migration from the single legacy key', () => {
  it('splits legacy readings into per-session keys and removes the legacy key', async () => {
    const legacy = [reading('s1'), reading('s2'), reading('s1', { trueFloorHeightM: undefined as unknown as null })];
    kv.data.set(KEYS.legacyReadings, JSON.stringify(legacy));
    const state = await createStorage(kv).loadAll();
    expect(state.readings.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(state.readings.find((r) => r.id === 'r3')!.trueFloorHeightM).toBeNull();
    expect(JSON.parse(kv.data.get(KEYS.readingIndex)!)).toEqual(['s1', 's2']);
    expect(JSON.parse(kv.data.get(readingKey('s1'))!).map((r: Reading) => r.id)).toEqual(['r1', 'r3']);
    expect(kv.data.has(KEYS.legacyReadings)).toBe(false);
    // Second launch reads the new layout.
    expect((await createStorage(kv).loadAll()).readings).toHaveLength(3);
  });

  it('keeps the legacy key and fails the load if a migration write fails', async () => {
    const legacy = JSON.stringify([reading('s1'), reading('s2')]);
    kv.data.set(KEYS.legacyReadings, legacy);
    kv.failSet = (k) => k === readingKey('s2');
    await expect(createStorage(kv).loadAll()).rejects.toThrow();
    expect(kv.data.get(KEYS.legacyReadings)).toBe(legacy);
    expect(kv.data.has(KEYS.readingIndex)).toBe(false);
    // Retry after the fault clears completes the migration.
    kv.failSet = () => false;
    expect((await createStorage(kv).loadAll()).readings).toHaveLength(2);
    expect(kv.data.has(KEYS.legacyReadings)).toBe(false);
  });

  it('backs up a corrupt legacy value instead of losing it', async () => {
    kv.data.set(KEYS.legacyReadings, '{not json');
    const state = await createStorage(kv).loadAll();
    expect(state.readings).toEqual([]);
    const backup = [...kv.data.keys()].find((k) => k.startsWith(`${KEYS.legacyReadings}.corrupt.`));
    expect(backup && kv.data.get(backup)).toBe('{not json');
  });

  it('fails the load (so nothing is overwritten) if a corrupt value cannot be backed up', async () => {
    kv.data.set(readingKey('s1'), 'garbage');
    kv.data.set(KEYS.readingIndex, JSON.stringify(['s1']));
    kv.failSet = (k) => k.includes('.corrupt.');
    await expect(createStorage(kv).loadAll()).rejects.toThrow();
    expect(kv.data.get(readingKey('s1'))).toBe('garbage');
  });
});

describe('storage: per-session writes', () => {
  it('appending a reading rewrites only that session key', async () => {
    const store = createStorage(kv);
    const a = reading('s1');
    const b = reading('s2');
    await store.loadAll();
    await store.saveReadings([a, b]);
    kv.writes = [];
    const c = reading('s2');
    await store.saveReadings([a, b, c]);
    expect(kv.writes).toEqual([readingKey('s2')]);
    expect(JSON.parse(kv.data.get(readingKey('s2'))!).map((r: Reading) => r.id)).toEqual([b.id, c.id]);
    // Saving an unchanged list writes nothing.
    kv.writes = [];
    await store.saveReadings([a, b, c]);
    expect(kv.writes).toEqual([]);
  });

  it('a new session writes its key and the index', async () => {
    const store = createStorage(kv);
    await store.loadAll();
    await store.saveReadings([reading('s1')]);
    expect(JSON.parse(kv.data.get(KEYS.readingIndex)!)).toEqual(['s1']);
    expect(kv.data.has(readingKey('s1'))).toBe(true);
  });

  it('deleting a reading rewrites its session; deleting the last one removes the key', async () => {
    const store = createStorage(kv);
    const [a, b, c] = [reading('s1'), reading('s1'), reading('s2')];
    await store.loadAll();
    await store.saveReadings([a, b, c]);
    kv.writes = [];
    await store.saveReadings([a, c]);
    expect(kv.writes).toEqual([readingKey('s1')]);
    await store.saveReadings([a]);
    expect(kv.data.has(readingKey('s2'))).toBe(false);
    expect(JSON.parse(kv.data.get(KEYS.readingIndex)!)).toEqual(['s1']);
    expect((await createStorage(kv).loadAll()).readings.map((r) => r.id)).toEqual([a.id]);
  });

  it('clearing removes every session key', async () => {
    const store = createStorage(kv);
    await store.loadAll();
    await store.saveReadings([reading('s1'), reading('s2')]);
    await store.saveReadings([]);
    expect([...kv.data.keys()].filter((k) => k.startsWith(KEYS.readingPrefix))).toEqual([]);
    expect(JSON.parse(kv.data.get(KEYS.readingIndex)!)).toEqual([]);
    expect((await createStorage(kv).loadAll()).readings).toEqual([]);
  });

  it('a failed write is retried on the next save', async () => {
    const store = createStorage(kv);
    await store.loadAll();
    const a = reading('s1');
    kv.failSet = (k) => k === readingKey('s1');
    await expect(store.saveReadings([a])).rejects.toThrow();
    kv.failSet = () => false;
    const b = reading('s1');
    await store.saveReadings([a, b]);
    expect((await createStorage(kv).loadAll()).readings.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('loads session keys missing from the index', async () => {
    kv.data.set(KEYS.readingIndex, JSON.stringify([]));
    kv.data.set(readingKey('s9'), JSON.stringify([reading('s9')]));
    expect((await createStorage(kv).loadAll()).readings).toHaveLength(1);
  });

  it('stores thousands of readings without any single value above 2 MB', async () => {
    const store = createStorage(kv);
    await store.loadAll();
    const pad = 'x'.repeat(550);
    const all: Reading[] = [];
    for (let s = 0; s < 10; s++) for (let i = 0; i < 500; i++) all.push(reading(`s${s}`, { notes: pad }));
    await store.saveReadings(all);
    const biggest = Math.max(...[...kv.data.values()].map((v) => v.length));
    expect(biggest).toBeLessThan(2 * 1024 * 1024);
    expect((await createStorage(kv).loadAll()).readings).toHaveLength(5000);
  });
});

describe('storage: Wi-Fi scans', () => {
  const scan = (readingId: string, sessionId: string): WifiScan => ({
    readingId,
    sessionId,
    venueId: 'v1',
    trueFloorIndex: 1,
    scannedAt: '2026-10-27T10:00:00.000Z',
    status: 'ok',
    aps: [{ bssid: 'a0:b1:c2:d3:e4:01', rssiDbm: -50, frequencyMhz: 2412, rttResponder: null, ageMs: 10 }],
  });

  it('stores scans per session under their own keys and loads them back', async () => {
    const store = createStorage(kv);
    expect((await store.loadAll()).wifiScans).toEqual([]);
    const [a, b] = [scan('r1', 's1'), scan('r2', 's2')];
    await store.saveWifiScans([a, b]);
    expect(JSON.parse(kv.data.get(KEYS.wifiIndex)!)).toEqual(['s1', 's2']);
    expect(kv.data.has(wifiKey('s1'))).toBe(true);
    expect(kv.data.has(readingKey('s1'))).toBe(false);
    kv.writes = [];
    await store.saveWifiScans([a, b, scan('r3', 's2')]);
    expect(kv.writes).toEqual([wifiKey('s2')]);
    expect((await createStorage(kv).loadAll()).wifiScans.map((s) => s.readingId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('deleting and clearing remove scan keys', async () => {
    const store = createStorage(kv);
    await store.loadAll();
    await store.saveWifiScans([scan('r1', 's1'), scan('r2', 's2')]);
    await store.saveWifiScans([scan('r1', 's1')]);
    expect(kv.data.has(wifiKey('s2'))).toBe(false);
    await store.saveWifiScans([]);
    expect([...kv.data.keys()].filter((k) => k.startsWith(KEYS.wifiPrefix))).toEqual([]);
  });

  it('a corrupt scan key is backed up, not lost, and readings still load', async () => {
    kv.data.set(KEYS.wifiIndex, JSON.stringify(['s1']));
    kv.data.set(wifiKey('s1'), '{broken');
    kv.data.set(readingKey('s1'), JSON.stringify([reading('s1')]));
    const state = await createStorage(kv).loadAll();
    expect(state.wifiScans).toEqual([]);
    expect(state.readings).toHaveLength(1);
    const backup = [...kv.data.keys()].find((k) => k.startsWith(`${wifiKey('s1')}.corrupt.`));
    expect(backup && kv.data.get(backup)).toBe('{broken');
  });

  it('fails the load (nothing overwritten) if a corrupt scan key cannot be backed up', async () => {
    kv.data.set(wifiKey('s1'), 'garbage');
    kv.failSet = (k) => k.includes('.corrupt.');
    await expect(createStorage(kv).loadAll()).rejects.toThrow();
    expect(kv.data.get(wifiKey('s1'))).toBe('garbage');
  });

  it('old readings without Wi-Fi fields load with nulls; settings default to recording Wi-Fi', async () => {
    kv.data.set(KEYS.readingIndex, JSON.stringify(['s1']));
    kv.data.set(readingKey('s1'), JSON.stringify([{ id: 'old', sessionId: 's1', notes: '' }]));
    const state = await createStorage(kv).loadAll();
    expect(state.readings[0]).toMatchObject({ wifiScanStatus: null, wifiApCount: null, trueFloorHeightM: null });
    expect(state.settings.recordWifi).toBe(true);
  });
});
