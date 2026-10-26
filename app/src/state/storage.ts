import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Reading, Venue } from '@locus/altitude-core';
import type { Session } from '../logic/types';

/**
 * Tiny persistence layer over AsyncStorage. Everything stays on the phone;
 * the only way data leaves is the CSV export.
 */
const KEYS = {
  venues: 'locus.v1.venues',
  sessions: 'locus.v1.sessions',
  readings: 'locus.v1.readings',
  settings: 'locus.v1.settings',
} as const;

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

async function readJson<T>(key: string, fallback: T, isValid: (v: unknown) => v is T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (isValid(parsed)) return parsed;
  // Keep the unreadable value so it is not lost when the app saves over the key.
  await AsyncStorage.setItem(`${key}.corrupt.${Date.now()}`, raw).catch(() => undefined);
  return fallback;
}

const isArray = <T,>(v: unknown): v is T[] => Array.isArray(v);
const isObject = (v: unknown): v is Partial<Settings> => typeof v === 'object' && v !== null;

export async function loadAll(): Promise<PersistedState> {
  const [venues, sessions, readings, settings] = await Promise.all([
    readJson<Venue[]>(KEYS.venues, [], isArray),
    readJson<Session[]>(KEYS.sessions, [], isArray),
    readJson<Reading[]>(KEYS.readings, [], isArray),
    readJson<Partial<Settings>>(KEYS.settings, {}, isObject),
  ]);
  return { venues, sessions, readings, settings: { ...DEFAULT_SETTINGS, ...settings } };
}

export const saveVenues = (v: Venue[]) => AsyncStorage.setItem(KEYS.venues, JSON.stringify(v));
export const saveSessions = (s: Session[]) => AsyncStorage.setItem(KEYS.sessions, JSON.stringify(s));
export const saveReadings = (r: Reading[]) => AsyncStorage.setItem(KEYS.readings, JSON.stringify(r));
export const saveSettings = (s: Settings) => AsyncStorage.setItem(KEYS.settings, JSON.stringify(s));
