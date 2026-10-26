import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DeviceCheck, Reading, Venue } from '@locus/altitude-core';
import type { Session } from '../logic/types';
import {
  DEFAULT_SETTINGS,
  loadAll,
  saveDeviceChecks,
  saveReadings,
  saveSessions,
  saveSettings,
  saveVenues,
  type Settings,
} from './storage';

export interface AppStateValue {
  ready: boolean;
  /** Last persistence error, shown as a banner. */
  storageError: string | null;
  venues: Venue[];
  sessions: Session[];
  readings: Reading[];
  settings: Settings;
  activeSession: Session | null;
  upsertVenue: (v: Venue) => void;
  deleteVenue: (id: string) => void;
  upsertSession: (s: Session) => void;
  setActiveSession: (id: string | null) => void;
  addReading: (r: Reading) => void;
  deleteReading: (id: string) => void;
  clearReadings: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  /** Device capability checks, oldest first. */
  deviceChecks: DeviceCheck[];
  addDeviceCheck: (c: DeviceCheck) => void;
  deleteDeviceCheck: (id: string) => void;
  /** True while a 5 s reading is being recorded; navigation is blocked meanwhile. */
  recordingInProgress: boolean;
  setRecordingInProgress: (on: boolean) => void;
}

const Ctx = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [deviceChecks, setDeviceChecks] = useState<DeviceCheck[]>([]);
  const [recordingInProgress, setRecordingInProgress] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadAll()
      .then((s) => {
        if (cancelled) return;
        setVenues(s.venues);
        setSessions(s.sessions);
        setReadings(s.readings);
        setSettings(s.settings);
        setDeviceChecks(s.deviceChecks);
      })
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        // Do not mark ready: persisting empty state now would overwrite the stored data.
        if (!cancelled) setStorageError('Could not load saved data. Restart the app; nothing was overwritten.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist each slice after it changes (skipped until the initial load finished).
  const persist = useCallback((p: Promise<void>) => {
    p.then(() => setStorageError(null)).catch(() => setStorageError('Saving to phone storage failed. Export your data soon.'));
  }, []);
  useEffect(() => {
    if (ready) persist(saveVenues(venues));
  }, [venues, ready, persist]);
  useEffect(() => {
    if (ready) persist(saveSessions(sessions));
  }, [sessions, ready, persist]);
  useEffect(() => {
    if (ready) persist(saveReadings(readings));
  }, [readings, ready, persist]);
  useEffect(() => {
    if (ready) persist(saveSettings(settings));
  }, [settings, ready, persist]);
  useEffect(() => {
    if (ready) persist(saveDeviceChecks(deviceChecks));
  }, [deviceChecks, ready, persist]);

  const upsert = <T extends { id: string }>(list: T[], item: T) => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i < 0) return [...list, item];
    const copy = list.slice();
    copy[i] = item;
    return copy;
  };

  const value = useMemo<AppStateValue>(() => {
    const activeSession = sessions.find((s) => s.id === settings.activeSessionId) ?? null;
    return {
      ready,
      storageError,
      venues,
      sessions,
      readings,
      settings,
      activeSession,
      upsertVenue: (v) => setVenues((list) => upsert(list, v)),
      deleteVenue: (id) => {
        setVenues((list) => list.filter((v) => v.id !== id));
        setSettings((s) => {
          const active = sessions.find((x) => x.id === s.activeSessionId);
          return active && active.venueId === id ? { ...s, activeSessionId: null } : s;
        });
      },
      upsertSession: (s) => setSessions((list) => upsert(list, s)),
      setActiveSession: (id) => setSettings((s) => ({ ...s, activeSessionId: id })),
      addReading: (r) => setReadings((list) => [...list, r]),
      deleteReading: (id) => setReadings((list) => list.filter((r) => r.id !== id)),
      clearReadings: () => setReadings([]),
      updateSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
      deviceChecks,
      addDeviceCheck: (c) => setDeviceChecks((list) => [...list, c]),
      deleteDeviceCheck: (id) => setDeviceChecks((list) => list.filter((c) => c.id !== id)),
      recordingInProgress,
      setRecordingInProgress,
    };
  }, [ready, storageError, venues, sessions, readings, settings, deviceChecks, recordingInProgress]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppStateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState must be used inside AppStateProvider');
  return v;
}
