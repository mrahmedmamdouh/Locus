import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Reading, Venue } from '@locus/altitude-core';
import type { Session } from '../logic/types';

/**
 * Tiny persistence layer over AsyncStorage. Everything stays on the phone;
 * the only way data leaves is the CSV export.
 *
 * Readings are stored one key per session (`locus.v2.readings:<sessionId>`) plus an
 * index key listing the session ids, so no single value grows past Android's ~2 MB
 * per-value limit and saving one reading rewrites only its own session's key.
 */
export const KEYS = {
  venues: 'locus.v1.venues',
  sessions: 'locus.v1.sessions',
  /** Pre-v2 single value holding every reading; migrated once, then removed. */
  legacyReadings: 'locus.v1.readings',
  readingIndex: 'locus.v2.readingSessions',
  readingPrefix: 'locus.v2.readings:',
  settings: 'locus.v1.settings',
} as const;

export const readingKey = (sessionId: string) => `${KEYS.readingPrefix}${sessionId}`;
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
}

export const DEFAULT_SETTINGS: Settings = {
  demoMode: false,
  activeSessionId: null,
  defaultTemperatureC: 24,
};

export interface PersistedState {
  venues: Venue[];
  sessions: Session[];
  readings: Reading[];
  settings: Settings;
}

const isArray = <T,>(v: unknown): v is T[] => Array.isArray(v);
const isObject = (v: unknown): v is Partial<Settings> => typeof v === 'object' && v !== null;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Readings saved before `trueFloorHeightM` existed get null (not undefined). */
const normalizeReading = (r: Reading): Reading => ({ ...r, trueFloorHeightM: r.trueFloorHeightM ?? null });

export function groupBySession(readings: Reading[]): Map<string, Reading[]> {
  const out = new Map<string, Reading[]>();
  for (const r of readings) {
    const list = out.get(r.sessionId);
    if (list) list.push(r);
    else out.set(r.sessionId, [r]);
  }
  return out;
}

const sameList = (a: readonly Reading[] | undefined, b: readonly Reading[]) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

export function createStorage(kv: KeyValueStore) {
  /** What is known to be on disk per session (updated only after a successful write). */
  let persisted = new Map<string, Reading[]>();
  let persistedIndex: string[] = [];
  /** Serialises reading writes so they land in order. */
  let queue: Promise<void> = Promise.resolve();

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

  async function loadReadings(): Promise<Reading[]> {
    const indexRaw = await kv.getItem(KEYS.readingIndex);
    let ids: string[];
    if (indexRaw === null) {
      ids = await migrateLegacy();
    } else {
      ids = await readJson<string[]>(KEYS.readingIndex, [], isStringArray);
      // A leftover legacy key after a completed migration: try to clean it up.
      if ((await kv.getItem(KEYS.legacyReadings)) !== null) {
        await kv.removeItem(KEYS.legacyReadings).catch(() => undefined);
      }
    }
    // Also pick up session keys missing from the index (interrupted write, corrupt index).
    const allKeys = await kv.getAllKeys();
    const extra = allKeys
      .filter((k) => k.startsWith(KEYS.readingPrefix) && !k.includes(CORRUPT_MARK))
      .map((k) => k.slice(KEYS.readingPrefix.length))
      .filter((id) => !ids.includes(id));
    ids = [...ids, ...extra];

    const map = new Map<string, Reading[]>();
    const all: Reading[] = [];
    for (const id of ids) {
      const list = (await readJson<Reading[]>(readingKey(id), [], isArray)).map(normalizeReading);
      if (list.length === 0) continue;
      map.set(id, list);
      all.push(...list);
    }
    persisted = map;
    persistedIndex = ids;
    return all;
  }

  async function writeReadings(next: Reading[]): Promise<void> {
    const groups = groupBySession(next);
    const nextIndex = [...groups.keys()];
    const indexChanged =
      nextIndex.length !== persistedIndex.length || nextIndex.some((id, i) => id !== persistedIndex[i]);
    const added = nextIndex.filter((id) => !persisted.has(id));
    const removed = [...persisted.keys()].filter((id) => !groups.has(id));

    // New sessions: list them in the index first; an index entry without a key loads as empty.
    if (indexChanged && added.length > 0) {
      const withAdded = [...new Set([...persistedIndex, ...nextIndex])];
      await kv.setItem(KEYS.readingIndex, JSON.stringify(withAdded));
      persistedIndex = withAdded;
    }
    for (const [id, list] of groups) {
      if (sameList(persisted.get(id), list)) continue;
      await kv.setItem(readingKey(id), JSON.stringify(list));
      persisted.set(id, list);
    }
    if (indexChanged) {
      await kv.setItem(KEYS.readingIndex, JSON.stringify(nextIndex));
      persistedIndex = nextIndex;
    }
    for (const id of removed) {
      await kv.removeItem(readingKey(id));
      persisted.delete(id);
    }
  }

  return {
    async loadAll(): Promise<PersistedState> {
      const [venues, sessions, readings, settings] = await Promise.all([
        readJson<Venue[]>(KEYS.venues, [], isArray),
        readJson<Session[]>(KEYS.sessions, [], isArray),
        loadReadings(),
        readJson<Partial<Settings>>(KEYS.settings, {}, isObject),
      ]);
      return { venues, sessions, readings, settings: { ...DEFAULT_SETTINGS, ...settings } };
    },
    saveVenues: (v: Venue[]) => kv.setItem(KEYS.venues, JSON.stringify(v)),
    saveSessions: (s: Session[]) => kv.setItem(KEYS.sessions, JSON.stringify(s)),
    /**
     * Persist the full reading list, writing only the sessions that changed since the last
     * successful save. Call only after loadAll() succeeded. A failed write is retried on the next save.
     */
    saveReadings(next: Reading[]): Promise<void> {
      const run = queue.then(() => writeReadings(next));
      queue = run.catch(() => undefined);
      return run;
    },
    saveSettings: (s: Settings) => kv.setItem(KEYS.settings, JSON.stringify(s)),
  };
}

const appStorage = createStorage(AsyncStorage);
export const { loadAll, saveVenues, saveSessions, saveReadings, saveSettings } = appStorage;
