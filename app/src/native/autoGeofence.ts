import { AppState, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Barometer } from 'expo-sensors';
import type { Venue } from '@locus/altitude-core';
import { AUTO_BASELINE_CAPTURE_MS, computeAutoBaseline, entranceHeightM, type AutoBaseline } from '../logic/autoMode';
import { makeAutoEvent, type AutoEvent, type AutoEventContext } from '../logic/autoEvents';
import { makeId } from '../logic/ids';
import { appendAutoEvent, loadAll, loadAutoBaseline, saveAutoBaseline } from '../state/storage';

/**
 * Background geofencing for automatic mode.
 *
 * The task is defined at module scope (imported from index.ts before the app registers), so the OS
 * can wake the JS runtime for a boundary crossing while the app is in the background or killed.
 * On entry it tries to read ~3 s of barometer. Whether that works in the background is exactly
 * what we want to learn, so the outcome is logged either way; with no samples, the baseline is
 * stored as pending and taken from the first foreground barometer samples (see AutoModeProvider).
 */
export const GEOFENCE_TASK = 'locus-auto-geofence';

/** Region identifier = venue id. */
export function regionsFor(venues: Venue[]): Location.LocationRegion[] {
  return venues
    .filter((v) => v.boundary)
    .map((v) => ({
      identifier: v.id,
      latitude: v.boundary!.lat,
      longitude: v.boundary!.lon,
      radius: v.boundary!.radiusM,
      notifyOnEnter: true,
      notifyOnExit: true,
    }));
}

/** In-process listeners: the foreground provider reloads when the task changed the baseline. */
const listeners = new Set<() => void>();
export function onBackgroundAutoChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function logAutoEvent(
  partial: Omit<Partial<AutoEvent>, 'id' | 'context'> & { kind: AutoEvent['kind'] },
  context: AutoEventContext,
): Promise<void> {
  try {
    await appendAutoEvent(makeAutoEvent({ ...partial, id: makeId('ae'), context }, new Date()));
  } catch {
    // Logging must never break the flow.
  }
}

/** Read the barometer for `ms`; resolves with whatever arrived (maybe nothing). Never throws. */
export async function sampleBarometer(ms: number): Promise<{ pressures: number[]; error: string | null }> {
  try {
    if (Platform.OS === 'web' || !(await Barometer.isAvailableAsync())) return { pressures: [], error: 'barometer not available' };
  } catch (e) {
    return { pressures: [], error: e instanceof Error ? e.message : String(e) };
  }
  return new Promise((resolve) => {
    const pressures: number[] = [];
    let sub: { remove: () => void } | null = null;
    try {
      sub = Barometer.addListener((m) => {
        if (Number.isFinite(m.pressure) && m.pressure > 0) pressures.push(m.pressure);
      });
    } catch (e) {
      resolve({ pressures, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    setTimeout(() => {
      sub?.remove();
      resolve({ pressures, error: null });
    }, ms);
  });
}

interface GeofenceData {
  eventType: Location.LocationGeofencingEventType;
  region: Location.LocationRegion;
}

async function handleGeofenceEvent(body: TaskManager.TaskManagerTaskBody<GeofenceData>): Promise<void> {
  // iOS reports the app state; on Android ask React Native (a headless run is never 'active').
  const appState = body.executionInfo?.appState ?? AppState.currentState;
  const context: AutoEventContext = appState === 'active' ? 'foreground' : 'background';
  await logAutoEvent({ kind: 'wake', message: `geofence task woke (appState=${appState ?? 'unknown'}, platform=${Platform.OS})` }, context);
  if (body.error) {
    await logAutoEvent({ kind: 'error', message: `geofence task error: ${body.error.message}` }, context);
    return;
  }
  const { eventType, region } = body.data ?? ({} as GeofenceData);
  const { venues, settings } = await loadAll().catch(() => ({ venues: [] as Venue[], settings: { autoMode: false, defaultTemperatureC: 24 } }));
  const venue = venues.find((v) => v.id === region?.identifier) ?? null;
  const base = { venueId: venue?.id ?? region?.identifier ?? null, venueName: venue?.name ?? null };
  if (eventType === Location.LocationGeofencingEventType.Exit) {
    await logAutoEvent({ ...base, kind: 'geofence-exit', message: 'OS geofence exit' }, context);
    const current = await loadAutoBaseline().catch(() => null);
    if (current && current.venueId === base.venueId && current.exitedAt === null) {
      await saveAutoBaseline({ ...current, exitedAt: new Date().toISOString() }).catch(() => undefined);
      listeners.forEach((l) => l());
    }
    return;
  }
  if (eventType !== Location.LocationGeofencingEventType.Enter) return;
  await logAutoEvent({ ...base, kind: 'geofence-enter', message: 'OS geofence enter' }, context);
  if (!settings.autoMode || !venue) {
    await logAutoEvent({ ...base, kind: 'info', message: !venue ? 'unknown region; ignored' : 'auto mode is off; ignored' }, context);
    return;
  }
  if (context === 'foreground') {
    // The app is open: the foreground provider handles entries from its own GPS watcher.
    await logAutoEvent({ ...base, kind: 'info', message: 'app active: baseline left to the foreground detector' }, context);
    listeners.forEach((l) => l());
    return;
  }
  let gpsAccuracyM: number | null = null;
  let lat: number | null = null;
  let lon: number | null = null;
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last) {
      gpsAccuracyM = last.coords.accuracy;
      lat = last.coords.latitude;
      lon = last.coords.longitude;
    }
  } catch {
    // optional
  }
  const { pressures, error } = await sampleBarometer(AUTO_BASELINE_CAPTURE_MS);
  const temperatureC = settings.defaultTemperatureC ?? 24;
  const res = computeAutoBaseline({ pressures, entranceHeightM: entranceHeightM(venue), temperatureC });
  const now = new Date().toISOString();
  const baseline: AutoBaseline = {
    venueId: venue.id,
    venueName: venue.name,
    source: 'geofence-background',
    enteredAt: now,
    calibratedAt: res ? now : null,
    baselinePressureHpa: res?.baselinePressureHpa ?? null,
    entrancePressureHpa: res?.entrancePressureHpa ?? null,
    entranceHeightM: entranceHeightM(venue),
    sampleCount: res?.sampleCount ?? 0,
    temperatureC,
    gpsAccuracyM,
    driftOffsetM: 0,
    exitedAt: null,
  };
  await saveAutoBaseline(baseline).catch(() => undefined);
  if (res) {
    await logAutoEvent(
      {
        ...base,
        kind: 'baseline',
        lat,
        lon,
        gpsAccuracyM,
        pressureHpa: res.entrancePressureHpa,
        baselinePressureHpa: res.baselinePressureHpa,
        sampleCount: res.sampleCount,
        message: `background barometer worked: ${res.sampleCount} samples in ${AUTO_BASELINE_CAPTURE_MS} ms`,
      },
      context,
    );
  } else {
    await logAutoEvent(
      {
        ...base,
        kind: 'baseline-pending',
        lat,
        lon,
        gpsAccuracyM,
        sampleCount: 0,
        message: `no barometer samples in the background${error ? ` (${error})` : ''}; baseline will be taken at the first foreground barometer sample`,
      },
      context,
    );
  }
  listeners.forEach((l) => l());
}

// Must run at import time (module scope), before the app component registers.
if (Platform.OS !== 'web') {
  try {
    TaskManager.defineTask<GeofenceData>(GEOFENCE_TASK, (body) => handleGeofenceEvent(body));
  } catch {
    // Expo Go or a build without the task manager: foreground detection still works.
  }
}

/** Start (or update) OS geofencing for the venues with a boundary. Returns an error message or null. */
export async function startGeofencing(venues: Venue[]): Promise<string | null> {
  if (Platform.OS === 'web') return 'Geofencing is not available on web.';
  const regions = regionsFor(venues);
  try {
    if (!(await TaskManager.isAvailableAsync())) return 'Background tasks are not available in this build (Expo Go?).';
    if (regions.length === 0) {
      await stopGeofencing();
      return 'No venue has a mall boundary yet.';
    }
    await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function stopGeofencing(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  } catch {
    // not started
  }
}

export { loadAutoBaseline, saveAutoBaseline };
