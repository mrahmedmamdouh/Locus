import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DeviceCheck, Reading, Venue, WifiScan } from '@locus/altitude-core';
import type { Session } from '../logic/types';

/**
 * Tiny persistence layer over AsyncStorage. Everything stays on the phone;
 * the only way data leaves is the CSV export.
 *
 * Readings are stored one key per session (`locus.v2.readings:<sessionId>`) plus an
 * index key listing the session ids, so no single value grows past Android's ~2 MB
 * per-value limit and saving one reading rewrites only its own session's key.
 * Wi-Fi scans (Android) use the same layout under their own keys
 * (`locus.v1.wifiScans:<sessionId>` + index), joined to readings by reading id.
 */
export const KEYS = {
  venues: 'locus.v1.venues',
  sessions: 'locus.v1.sessions',
  /** Pre-v2 single value holding every reading; migrated once, then removed. */
  legacyReadings: 'locus.v1.readings',
  readingIndex: 'locus.v2.readingSessions',
  readingPrefix: 'locus.v2.readings:',
  settings: 'locus.v1.settings',
  /** Device capability checks (small list, one value). */
  deviceChecks: 'locus.v1.deviceChecks',
  wifiIndex: 'locus.v1.wifiScanSessions',
  wifiPrefix: 'locus.v1.wifiScans:',
} as const;

export const readingKey = (sessionId: string) => `${KEYS.readingPrefix}${sessionId}`;
export const wifiKey = (sessionId: string) => `${KEYS.wifiPrefix}${sessionId}`;
const CORRUPT_MARK = '.corrupt.';

/** The subset of AsyncStorage used here (lets tests pass an in-memory store). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

export interface Settings {
  demoMode: boolean;
  activeSessionId: string | null;
  defaultTemperatureC: number;
  /** The first-launch "run a device check" prompt was dismissed or acted on. */
  deviceCheckPromptDone: boolean;
  /** Record a Wi-Fi scan with each reading (Android only). */
  recordWifi: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  demoMode: false,
  activeSessionId: null,
  defaultTemperatureC: 24,
  deviceCheckPromptDone: false,
  recordWifi: true,
};

export interface PersistedState {
  venues: Venue[];
  sessions: Session[];
  readings: Reading[];
  settings: Settings;
  deviceChecks: DeviceCheck[];
  wifiScans: WifiScan[];
}

const isArray = <T,>(v: unknown): v is T[] => Array.isArray(v);
const isObject = (v: unknown): v is Partial<Settings> => typeof v === 'object' && v !== null;
const isDeviceCheckArray = (v: unknown): v is DeviceCheck[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && typeof (x as DeviceCheck).id === 'string');
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Readings saved before `trueFloorHeightM` / the Wi-Fi fields existed get null (not undefined). */
const normalizeReading = (r: Reading): Reading => ({
  ...r,
  trueFloorHeightM: r.trueFloorHeightM ?? null,
  wifiScanStatus: r.wifiScanStatus ?? null,
  wifiApCount: r.wifiApCount ?? null,
});
const normalizeWifiScan = (s: WifiScan): WifiScan => ({ ...s, aps: Array.isArray(s.aps) ? s.aps : [] });

export function groupBySession<T extends { sessionId: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of items) {
    const list = out.get(r.sessionId);
    if (list) list.push(r);
    else out.set(r.sessionId, [r]);
  }
  return out;
}

const sameList = <T,>(a: readonly T[] | undefined, b: readonly T[]) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

export function createStorage(kv: KeyValueStore) {
  /**
   * Read and parse a JSON value. Missing → fallback. Unparseable/invalid → copy the raw
   * value to a backup key first (throws if that fails, so nothing is ever lost), then fallback.
   */
  async function readJson<T>(key: string, fallback: T, isValid: (v: unknown) => v is T): Promise<T> {
    const raw = await kv.getItem(key);
    if (raw === null) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (isValid(parsed)) return parsed;
    // Keep the unreadable value so it is not lost when the app saves over the key.
    // If the backup fails this throws, so the load fails and nothing gets overwritten.
    await kv.setItem(`${key}${CORRUPT_MARK}${Date.now()}`, raw);
    // Backed up: drop the original so it is not backed up again on every launch.
    await kv.removeItem(key).catch(() => undefined);
    return fallback;
  }

  /**
   * A list stored one key per session plus an index key of session ids. Writes only the
   * sessions that changed since the last successful save, serialised so they land in order.
   */
  function perSessionStore<T extends { sessionId: string }>(cfg: {
    indexKey: string;
    prefix: string;
    normalize: (x: T) => T;
    /** Called when the index key is missing (first launch or pre-index data); returns the session ids. */
    migrate?: () => Promise<string[]>;
    /** Called after a successful index read (e.g. legacy clean-up). */
    afterIndexRead?: () => Promise<void>;
  }) {
    const keyOf = (sessionId: string) => `${cfg.prefix}${sessionId}`;
    /** What is known to be on disk per session (updated only after a successful write). */
    let persisted = new Map<string, T[]>();
    let persistedIndex: string[] = [];
    let queue: Promise<void> = Promise.resolve();

    async function load(): Promise<T[]> {
      const indexRaw = await kv.getItem(cfg.indexKey);
      let ids: string[];
      if (indexRaw === null) {
        ids = cfg.migrate ? await cfg.migrate() : [];
      } else {
        ids = await readJson<string[]>(cfg.indexKey, [], isStringArray);
        await cfg.afterIndexRead?.();
      }
      // Also pick up session keys missing from the index (interrupted write, corrupt index).
      const allKeys = await kv.getAllKeys();
      const extra = allKeys
        .filter((k) => k.startsWith(cfg.prefix) && !k.includes(CORRUPT_MARK))
        .map((k) => k.slice(cfg.prefix.length))
        .filter((id) => !ids.includes(id));
      ids = [...ids, ...extra];

      const map = new Map<string, T[]>();
      const all: T[] = [];
      for (const id of ids) {
        const list = (await readJson<T[]>(keyOf(id), [], isArray)).map(cfg.normalize);
        if (list.length === 0) continue;
        map.set(id, list);
        all.push(...list);
      }
      persisted = map;
      persistedIndex = ids;
      return all;
    }

    async function write(next: T[]): Promise<void> {
      const groups = groupBySession(next);
      const nextIndex = [...groups.keys()];
      const indexChanged =
        nextIndex.length !== persistedIndex.length || nextIndex.some((id, i) => id !== persistedIndex[i]);
      const added = nextIndex.filter((id) => !persisted.has(id));
      const removed = [...persisted.keys()].filter((id) => !groups.has(id));

      // New sessions: list them in the index first; an index entry without a key loads as empty.
      if (indexChanged && added.length > 0) {
        const withAdded = [...new Set([...persistedIndex, ...nextIndex])];
        await kv.setItem(cfg.indexKey, JSON.stringify(withAdded));
        persistedIndex = withAdded;
      }
      for (const [id, list] of groups) {
        if (sameList(persisted.get(id), list)) continue;
        await kv.setItem(keyOf(id), JSON.stringify(list));
        persisted.set(id, list);
      }
      if (indexChanged) {
        await kv.setItem(cfg.indexKey, JSON.stringify(nextIndex));
        persistedIndex = nextIndex;
      }
      for (const id of removed) {
        await kv.removeItem(keyOf(id));
        persisted.delete(id);
      }
    }

    return {
      load,
      /** Call only after load() succeeded. A failed write is retried on the next save. */
      save(next: T[]): Promise<void> {
        const run = queue.then(() => write(next));
        queue = run.catch(() => undefined);
        return run;
      },
    };
  }

  /** One-time move from the single legacy key to per-session keys. Legacy key stays until all writes succeed. */
  async function migrateLegacy(): Promise<string[]> {
    const raw = await kv.getItem(KEYS.legacyReadings);
    if (raw === null) return [];
    const legacy = await readJson<Reading[]>(KEYS.legacyReadings, [], isArray);
    const groups = groupBySession(legacy);
    for (const [sessionId, list] of groups) {
      await kv.setItem(readingKey(sessionId), JSON.stringify(list));
    }
    const ids = [...groups.keys()];
    await kv.setItem(KEYS.readingIndex, JSON.stringify(ids));
    // Migration is complete; failing to delete the old key is harmless (the index now wins).
    await kv.removeItem(KEYS.legacyReadings).catch(() => undefined);
    return ids;
  }

  const readingStore = perSessionStore<Reading>({
    indexKey: KEYS.readingIndex,
    prefix: KEYS.readingPrefix,
    normalize: normalizeReading,
    migrate: migrateLegacy,
    afterIndexRead: async () => {
      // A leftover legacy key after a completed migration: try to clean it up.
      if ((await kv.getItem(KEYS.legacyReadings)) !== null) {
        await kv.removeItem(KEYS.legacyReadings).catch(() => undefined);
      }
    },
  });
  const wifiStore = perSessionStore<WifiScan>({
    indexKey: KEYS.wifiIndex,
    prefix: KEYS.wifiPrefix,
    normalize: normalizeWifiScan,
  });

  return {
    async loadAll(): Promise<PersistedState> {
      const [venues, sessions, readings, settings, deviceChecks, wifiScans] = await Promise.all([
        readJson<Venue[]>(KEYS.venues, [], isArray),
        readJson<Session[]>(KEYS.sessions, [], isArray),
        readingStore.load(),
        readJson<Partial<Settings>>(KEYS.settings, {}, isObject),
        readJson<DeviceCheck[]>(KEYS.deviceChecks, [], isDeviceCheckArray),
        wifiStore.load(),
      ]);
      return { venues, sessions, readings, settings: { ...DEFAULT_SETTINGS, ...settings }, deviceChecks, wifiScans };
    },
    saveVenues: (v: Venue[]) => kv.setItem(KEYS.venues, JSON.stringify(v)),
    saveSessions: (s: Session[]) => kv.setItem(KEYS.sessions, JSON.stringify(s)),
    /**
     * Persist the full reading list, writing only the sessions that changed since the last
     * successful save. Call only after loadAll() succeeded. A failed write is retried on the next save.
     */
    saveReadings: (next: Reading[]) => readingStore.save(next),
    /** Persist the full Wi-Fi scan list (same per-session layout as readings). Call only after loadAll() succeeded. */
    saveWifiScans: (next: WifiScan[]) => wifiStore.save(next),
    saveSettings: (s: Settings) => kv.setItem(KEYS.settings, JSON.stringify(s)),
    /** Persist the full device-check list. Call only after loadAll() succeeded. */
    saveDeviceChecks: (c: DeviceCheck[]) => kv.setItem(KEYS.deviceChecks, JSON.stringify(c)),
  };
}

const appStorage = createStorage(AsyncStorage);
export const { loadAll, saveVenues, saveSessions, saveReadings, saveWifiScans, saveSettings, saveDeviceChecks } = appStorage;
