import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import * as Location from 'expo-location';
import { createSimulator } from '../logic/simulator';
import type { GpsFix } from '../logic/types';

export type LocationPermission = 'unknown' | 'granted' | 'denied' | 'undetermined';

export interface LocationApi {
  permission: LocationPermission;
  /** Whether the OS will ask again (false = must open Settings). */
  canAskAgain: boolean;
  requestPermission: () => Promise<LocationPermission>;
  /** Latest fix for rendering (state; may lag behind inside async callbacks). */
  latest: GpsFix | null;
  /** Latest fix right now, read from a ref (use this in async code such as after a recording window). */
  getLatest: () => GpsFix | null;
  error: string | null;
  /** Resolve with the first fix newer than `sinceMs`, or null after `timeoutMs`. */
  waitForFix: (sinceMs: number, timeoutMs: number) => Promise<GpsFix | null>;
}

function toFix(l: Location.LocationObject): GpsFix {
  return {
    latitude: l.coords.latitude,
    longitude: l.coords.longitude,
    altitude: l.coords.altitude,
    accuracy: l.coords.accuracy,
    altitudeAccuracy: l.coords.altitudeAccuracy,
    timestamp: l.timestamp,
  };
}

/** Watches high-accuracy GPS fixes while permission is granted (or simulates them in demo mode). */
export function useLocationFix(opts: { demo: boolean; simHeightRef: MutableRefObject<number> }): LocationApi {
  const { demo, simHeightRef } = opts;
  const [permission, setPermission] = useState<LocationPermission>('unknown');
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [latest, setLatest] = useState<GpsFix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRef = useRef<GpsFix | null>(null);
  const waitersRef = useRef(new Set<(f: GpsFix) => void>());

  const publish = useCallback((fix: GpsFix) => {
    latestRef.current = fix;
    setLatest(fix);
    for (const w of [...waitersRef.current]) w(fix);
  }, []);

  const applyPermission = useCallback((res: Location.LocationPermissionResponse): LocationPermission => {
    const p: LocationPermission = res.granted ? 'granted' : res.status === 'undetermined' ? 'undetermined' : 'denied';
    setPermission(p);
    setCanAskAgain(res.canAskAgain);
    return p;
  }, []);

  useEffect(() => {
    let cancelled = false;
    Location.getForegroundPermissionsAsync()
      .then((res) => {
        if (!cancelled) applyPermission(res);
      })
      .catch(() => {
        if (!cancelled) setPermission('undetermined');
      });
    return () => {
      cancelled = true;
    };
  }, [applyPermission]);

  const requestPermission = useCallback(async () => {
    try {
      return applyPermission(await Location.requestForegroundPermissionsAsync());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Location permission request failed.');
      setPermission('denied');
      return 'denied' as const;
    }
  }, [applyPermission]);

  useEffect(() => {
    latestRef.current = null;
    setLatest(null);
    if (demo) {
      const sim = createSimulator();
      const id = setInterval(() => publish(sim.gpsAt(simHeightRef.current, Date.now())), 1000);
      return () => clearInterval(id);
    }
    if (permission !== 'granted') return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    setError(null);
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
      (loc) => publish(toFix(loc)),
      (reason) => setError(reason),
    )
      .then((s) => {
        if (cancelled) s.remove();
        else sub = s;
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not start GPS.'));
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [demo, permission, publish, simHeightRef]);

  const waitForFix = useCallback((sinceMs: number, timeoutMs: number) => {
    const cur = latestRef.current;
    if (cur && cur.timestamp >= sinceMs) return Promise.resolve(cur);
    return new Promise<GpsFix | null>((resolve) => {
      const waiter = (f: GpsFix) => {
        if (f.timestamp < sinceMs) return;
        clearTimeout(timer);
        waitersRef.current.delete(waiter);
        resolve(f);
      };
      const timer = setTimeout(() => {
        waitersRef.current.delete(waiter);
        resolve(null);
      }, timeoutMs);
      waitersRef.current.add(waiter);
    });
  }, []);

  const getLatest = useCallback(() => latestRef.current, []);

  return { permission, canAskAgain, requestPermission, latest, getLatest, error, waitForFix };
}
