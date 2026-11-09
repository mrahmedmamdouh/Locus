import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import * as Location from 'expo-location';
import { createDriftTracker, median, relativeAltitudeFromPressure, type DriftTracker, type Venue } from '@locus/altitude-core';
import {
  AUTO_BASELINE_CAPTURE_MS,
  INITIAL_PRESENCE,
  baselineReady,
  buildAutoFields,
  computeAutoBaseline,
  entranceHeightM,
  shouldCaptureOnEnter,
  updatePresence,
  type AutoBaseline,
  type AutoFields,
  type PresenceState,
} from '../logic/autoMode';
import { autoEventsToCsv, autoEventsFileName } from '../logic/autoEvents';
import { shareCsv } from '../logic/export';
import type { GpsFix } from '../logic/types';
import {
  logAutoEvent,
  onBackgroundAutoChange,
  startGeofencing,
  stopGeofencing,
} from '../native/autoGeofence';
import { clearAutoEvents, loadAutoBaseline, loadAutoEvents, saveAutoBaseline } from './storage';
import { useAppState } from './AppState';
import { useSensors } from './SensorContext';
import { confirm } from '../ui/confirm';

/** 'always' = background geofencing possible; 'foreground-only' = only while the app is open. */
export type AutoPermission = 'unknown' | 'always' | 'foreground-only' | 'denied';

export interface AutoLive {
  /** Raw height vs the automatic baseline (m). */
  rawM: number;
  /** Drift-corrected height (m). */
  correctedM: number;
  floorIndex: number | null;
  offsetM: number;
  stationary: boolean;
}

export interface AutoModeValue {
  enabled: boolean;
  permission: AutoPermission;
  /** Last problem starting OS geofencing (null = running or not needed). */
  geofenceError: string | null;
  baseline: AutoBaseline | null;
  /** Venue ids the foreground detector considers "inside". */
  insideVenueIds: string[];
  live: AutoLive | null;
  capturing: boolean;
  /** Ask for permissions (with an explanation) and switch automatic mode on. */
  enable: () => Promise<void>;
  disable: () => void;
  /** Automatic-mode columns for a reading being saved now. */
  fieldsFor: (venueId: string, pressureHpa: number | null, now: Date) => AutoFields;
  /** Take an automatic baseline now (tester override, e.g. the boundary is wrong). Logged as foreground. */
  captureNow: (venue: Venue) => Promise<void>;
  exportEvents: () => Promise<number>;
  clearEvents: () => Promise<void>;
  eventCount: number;
}

const Ctx = createContext<AutoModeValue | null>(null);

const TICK_MS = 1000;
const PERSIST_OFFSET_MS = 30_000;

function fixFields(fix: GpsFix | null) {
  return fix ? { lat: fix.latitude, lon: fix.longitude, gpsAccuracyM: fix.accuracy } : {};
}

export function AutoModeProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings, venues } = useAppState();
  const { baro, location } = useSensors();
  const enabled = settings.autoMode;

  const [permission, setPermission] = useState<AutoPermission>('unknown');
  const [geofenceError, setGeofenceError] = useState<string | null>(null);
  const [baseline, setBaselineState] = useState<AutoBaseline | null>(null);
  const baselineRef = useRef<AutoBaseline | null>(null);
  const [live, setLive] = useState<AutoLive | null>(null);
  const [capturing, setCapturing] = useState(false);
  const capturingRef = useRef(false);
  const [insideVenueIds, setInsideVenueIds] = useState<string[]>([]);
  const presenceRef = useRef(new Map<string, PresenceState>());
  const trackerRef = useRef<{ key: string; tracker: DriftTracker } | null>(null);
  const lastPersistRef = useRef(0);
  const [eventCount, setEventCount] = useState(0);

  const venuesRef = useRef(venues);
  venuesRef.current = venues;
  const baroRef = useRef(baro);
  baroRef.current = baro;

  const refreshEventCount = useCallback(() => {
    loadAutoEvents()
      .then((e) => setEventCount(e.length))
      .catch(() => undefined);
  }, []);

  const setBaseline = useCallback((b: AutoBaseline | null, persist = true) => {
    baselineRef.current = b;
    setBaselineState(b);
    if (persist) void saveAutoBaseline(b).catch(() => undefined);
  }, []);

  const reloadBaseline = useCallback(() => {
    loadAutoBaseline()
      .then((b) => {
        baselineRef.current = b;
        setBaselineState(b);
        // A baseline for a venue with no exit since means we are (probably) still inside.
        if (b && b.exitedAt === null) presenceRef.current.set(b.venueId, { inside: true, outsideCount: 0 });
      })
      .catch(() => undefined);
    refreshEventCount();
  }, [refreshEventCount]);

  // Load on start, when returning to the foreground, and when the background task changed it.
  useEffect(() => {
    reloadBaseline();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        reloadBaseline();
        if (settings.autoMode) void logAutoEvent({ kind: 'wake', message: 'app came to the foreground' }, 'foreground');
      }
    });
    const off = onBackgroundAutoChange(reloadBaseline);
    return () => {
      sub.remove();
      off();
    };
  }, [reloadBaseline, settings.autoMode]);

  // Permission state (no prompts here).
  const refreshPermission = useCallback(async (): Promise<AutoPermission> => {
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      if (!fg.granted) {
        setPermission('denied');
        return 'denied';
      }
      const bg = Platform.OS === 'web' ? null : await Location.getBackgroundPermissionsAsync();
      const p: AutoPermission = bg?.granted ? 'always' : 'foreground-only';
      setPermission(p);
      return p;
    } catch {
      setPermission('foreground-only');
      return 'foreground-only';
    }
  }, []);
  useEffect(() => {
    void refreshPermission();
  }, [refreshPermission, location.permission]);

  // OS geofencing follows the setting, the permission and the venue boundaries.
  const regionKey = venues
    .filter((v) => v.boundary)
    .map((v) => `${v.id}:${v.boundary!.lat},${v.boundary!.lon},${v.boundary!.radiusM}`)
    .join('|');
  const geofencingOnRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (enabled && permission === 'always') {
        const err = await startGeofencing(venuesRef.current);
        if (cancelled) return;
        setGeofenceError(err);
        await logAutoEvent(
          err
            ? { kind: 'error', message: `could not start OS geofencing: ${err}` }
            : { kind: 'geofencing-started', message: `OS geofencing on for ${regionKey.split('|').filter(Boolean).length} venue(s)` },
          'foreground',
        );
        geofencingOnRef.current = !err;
      } else if (geofencingOnRef.current || !enabled) {
        await stopGeofencing();
        if (geofencingOnRef.current) await logAutoEvent({ kind: 'geofencing-stopped', message: enabled ? 'no background permission' : 'auto mode off' }, 'foreground');
        geofencingOnRef.current = false;
        if (!cancelled) setGeofenceError(null);
      }
      if (!cancelled) refreshEventCount();
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, permission, regionKey, refreshEventCount]);

  /** Take a baseline from `ms` of foreground barometer samples. */
  const captureBaseline = useCallback(
    async (venue: Venue, source: AutoBaseline['source'], fix: GpsFix | null, enteredAt: string, why: string) => {
      if (capturingRef.current) return;
      const b = baroRef.current;
      if (b.status !== 'available' && b.status !== 'simulated') {
        // No barometer right now: keep it pending, it is retried when samples arrive.
        setBaseline({
          venueId: venue.id,
          venueName: venue.name,
          source,
          enteredAt,
          calibratedAt: null,
          baselinePressureHpa: null,
          entrancePressureHpa: null,
          entranceHeightM: entranceHeightM(venue),
          sampleCount: 0,
          temperatureC: settings.defaultTemperatureC,
          gpsAccuracyM: fix?.accuracy ?? null,
          driftOffsetM: 0,
          exitedAt: null,
        });
        await logAutoEvent(
          { kind: 'baseline-pending', venueId: venue.id, venueName: venue.name, ...fixFields(fix), message: `barometer ${b.status}; waiting for samples` },
          'foreground',
        );
        return;
      }
      capturingRef.current = true;
      setCapturing(true);
      try {
        const window = await b.collect(AUTO_BASELINE_CAPTURE_MS);
        const res = computeAutoBaseline({
          pressures: window.pressures,
          entranceHeightM: entranceHeightM(venue),
          temperatureC: settings.defaultTemperatureC,
        });
        if (!res) {
          await logAutoEvent({ kind: 'error', venueId: venue.id, venueName: venue.name, message: 'no barometer samples during capture' }, 'foreground');
          return;
        }
        const now = new Date().toISOString();
        setBaseline({
          venueId: venue.id,
          venueName: venue.name,
          source,
          enteredAt,
          calibratedAt: now,
          baselinePressureHpa: res.baselinePressureHpa,
          entrancePressureHpa: res.entrancePressureHpa,
          entranceHeightM: res.entranceHeightM,
          sampleCount: res.sampleCount,
          temperatureC: settings.defaultTemperatureC,
          gpsAccuracyM: fix?.accuracy ?? null,
          driftOffsetM: 0,
          exitedAt: null,
        });
        trackerRef.current = null;
        await logAutoEvent(
          {
            kind: 'baseline',
            venueId: venue.id,
            venueName: venue.name,
            ...fixFields(fix),
            pressureHpa: res.entrancePressureHpa,
            baselinePressureHpa: res.baselinePressureHpa,
            sampleCount: res.sampleCount,
            message: why,
          },
          'foreground',
        );
      } catch (e) {
        await logAutoEvent({ kind: 'error', venueId: venue.id, message: `baseline failed: ${e instanceof Error ? e.message : String(e)}` }, 'foreground');
      } finally {
        capturingRef.current = false;
        setCapturing(false);
        refreshEventCount();
      }
    },
    [setBaseline, settings.defaultTemperatureC, refreshEventCount],
  );

  // Foreground entry/exit detection from GPS fixes.
  const latestFix = location.latest;
  useEffect(() => {
    if (!enabled || !latestFix) return;
    let changed = false;
    for (const v of venuesRef.current) {
      if (!v.boundary) continue;
      const prev = presenceRef.current.get(v.id) ?? INITIAL_PRESENCE;
      const { state, event } = updatePresence(prev, latestFix, v.boundary);
      if (state !== prev) presenceRef.current.set(v.id, state);
      if (state.inside !== prev.inside) changed = true;
      if (event === 'enter') {
        void (async () => {
          await logAutoEvent(
            { kind: 'geofence-enter', venueId: v.id, venueName: v.name, ...fixFields(latestFix), message: 'foreground GPS entry' },
            'foreground',
          );
          if (shouldCaptureOnEnter(baselineRef.current, v.id)) {
            await captureBaseline(v, 'geofence-foreground', latestFix, new Date().toISOString(), 'foreground entry baseline');
          } else {
            await logAutoEvent({ kind: 'info', venueId: v.id, venueName: v.name, message: 'already inside (no exit since baseline); kept it' }, 'foreground');
            refreshEventCount();
          }
        })();
      } else if (event === 'exit') {
        void logAutoEvent({ kind: 'geofence-exit', venueId: v.id, venueName: v.name, ...fixFields(latestFix), message: 'foreground GPS exit' }, 'foreground');
        const cur = baselineRef.current;
        if (cur && cur.venueId === v.id && cur.exitedAt === null) setBaseline({ ...cur, exitedAt: new Date().toISOString() });
        refreshEventCount();
      }
    }
    if (changed) {
      setInsideVenueIds([...presenceRef.current.entries()].filter(([, s]) => s.inside).map(([id]) => id));
    }
  }, [enabled, latestFix, captureBaseline, setBaseline, refreshEventCount]);

  // A pending (background) baseline is completed from the first foreground barometer samples.
  const baroReady = baro.status === 'available' || baro.status === 'simulated';
  const hasSample = baro.latest !== null;
  useEffect(() => {
    const b = baselineRef.current;
    if (!enabled || !b || baselineReady(b) || !baroReady || !hasSample || capturingRef.current) return;
    const venue = venuesRef.current.find((v) => v.id === b.venueId);
    if (!venue) return;
    const minutes = (Date.now() - Date.parse(b.enteredAt)) / 60_000;
    void captureBaseline(
      venue,
      b.source,
      null,
      b.enteredAt,
      `pending ${b.source} baseline taken from the first foreground barometer samples, ${minutes.toFixed(1)} min after entry`,
    );
  }, [enabled, baseline, baroReady, hasSample, captureBaseline]);

  // ~1 Hz: feed the drift tracker while the app is open.
  useEffect(() => {
    if (!enabled) {
      setLive(null);
      return;
    }
    const id = setInterval(() => {
      const b = baselineRef.current;
      const venue = b ? venuesRef.current.find((v) => v.id === b.venueId) : undefined;
      if (!b || !baselineReady(b) || !venue) {
        setLive(null);
        return;
      }
      const key = `${b.venueId}|${b.calibratedAt}|${JSON.stringify(venue.floors)}`;
      if (!trackerRef.current || trackerRef.current.key !== key) {
        trackerRef.current = { key, tracker: createDriftTracker({ floors: venue.floors, initialOffsetM: b.driftOffsetM }) };
      }
      const p = median(baroRef.current.recent(TICK_MS).map((s) => s.pressure));
      if (p === null) return;
      const raw = relativeAltitudeFromPressure(p, b.baselinePressureHpa, b.temperatureC);
      const now = Date.now();
      const out = trackerRef.current.tracker.update({ tMs: now, relAltM: raw });
      setLive({ rawM: raw, correctedM: out.correctedM, floorIndex: out.floorIndex, offsetM: out.offsetM, stationary: out.stationary });
      if (now - lastPersistRef.current > PERSIST_OFFSET_MS && Math.abs(out.offsetM - b.driftOffsetM) > 0.01) {
        lastPersistRef.current = now;
        setBaseline({ ...b, driftOffsetM: Math.round(out.offsetM * 1000) / 1000 });
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [enabled, setBaseline]);

  const enable = useCallback(async () => {
    const ok = await confirm(
      'Turn on Auto mode?',
      'Auto mode tests what a customer would get: when you walk into a mall boundary, the app takes its own entrance baseline, with no tap from you.\n\n' +
        'To notice the entry while the app is in the background, Locus needs location access "Always" (Android: "Allow all the time"). Location stays on this phone and is only used to detect the mall boundaries you set.\n\n' +
        'If you do not allow it, Auto mode still works while the app is open.',
      'Continue',
    );
    if (!ok) return;
    try {
      let fg = await Location.getForegroundPermissionsAsync();
      if (!fg.granted) fg = await Location.requestForegroundPermissionsAsync();
      let bgGranted = false;
      if (fg.granted && Platform.OS !== 'web') {
        const bg = await Location.requestBackgroundPermissionsAsync();
        bgGranted = bg.granted;
      }
      const p: AutoPermission = !fg.granted ? 'denied' : bgGranted ? 'always' : 'foreground-only';
      setPermission(p);
      await logAutoEvent({ kind: 'permission', message: `auto mode on; location permission: ${p} (${Platform.OS})` }, 'foreground');
    } catch (e) {
      await logAutoEvent({ kind: 'error', message: `permission request failed: ${e instanceof Error ? e.message : String(e)}` }, 'foreground');
      await refreshPermission();
    }
    updateSettings({ autoMode: true });
    refreshEventCount();
  }, [updateSettings, refreshPermission, refreshEventCount]);

  const disable = useCallback(() => {
    updateSettings({ autoMode: false });
    presenceRef.current.clear();
    setInsideVenueIds([]);
  }, [updateSettings]);

  const fieldsFor = useCallback(
    (venueId: string, pressureHpa: number | null, now: Date): AutoFields => {
      const b = baselineRef.current;
      const venue = venuesRef.current.find((v) => v.id === venueId);
      const offset = trackerRef.current && b && trackerRef.current.key.startsWith(`${b.venueId}|${b.calibratedAt}|`) ? trackerRef.current.tracker.offsetM : (b?.driftOffsetM ?? 0);
      return buildAutoFields({ enabled, baseline: b, venueId, floors: venue?.floors ?? [], pressureHpa, driftOffsetM: offset, now });
    },
    [enabled],
  );

  const captureNow = useCallback(
    async (venue: Venue) => {
      const fix = location.getLatest();
      const now = new Date().toISOString();
      await logAutoEvent({ kind: 'info', venueId: venue.id, venueName: venue.name, ...fixFields(fix), message: 'tester forced an automatic baseline' }, 'foreground');
      await captureBaseline(venue, 'geofence-foreground', fix, now, 'forced by tester (not a real geofence entry)');
    },
    [captureBaseline, location],
  );

  const exportEvents = useCallback(async () => {
    const events = await loadAutoEvents();
    if (events.length > 0) await shareCsv(autoEventsToCsv(events), autoEventsFileName(new Date()), 'Export Locus auto-mode events');
    return events.length;
  }, []);

  const clearEvents = useCallback(async () => {
    await clearAutoEvents();
    refreshEventCount();
  }, [refreshEventCount]);

  const value = useMemo<AutoModeValue>(
    () => ({
      enabled,
      permission,
      geofenceError,
      baseline,
      insideVenueIds,
      live,
      capturing,
      enable,
      disable,
      fieldsFor,
      captureNow,
      exportEvents,
      clearEvents,
      eventCount,
    }),
    [enabled, permission, geofenceError, baseline, insideVenueIds, live, capturing, enable, disable, fieldsFor, captureNow, exportEvents, clearEvents, eventCount],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAutoMode(): AutoModeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAutoMode must be used inside AutoModeProvider');
  return v;
}
