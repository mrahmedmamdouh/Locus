import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { Barometer, type BarometerMeasurement } from 'expo-sensors';
import type { DeviceCheck, PermissionState } from '@locus/altitude-core';
import {
  DEVICE_CHECK_BARO_MS,
  DEVICE_CHECK_GPS_TIMEOUT_MS,
  buildDeviceCheck,
  toPermissionState,
  type CheckBaroSample,
} from '../logic/deviceCheck';
import { makeId } from '../logic/ids';
import type { GpsFix } from '../logic/types';

export interface DeviceCheckProgress {
  /** 0–1 over the whole check. */
  fraction: number;
  step: string;
  baroSamples: number;
  gps: 'waiting' | 'fix' | 'no fix' | 'skipped';
}

const TOTAL_MS = Math.max(DEVICE_CHECK_BARO_MS, DEVICE_CHECK_GPS_TIMEOUT_MS);

const reason = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e)).slice(0, 80);

export function appVersion(): string {
  return Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? 'unknown';
}

/**
 * Runs the ~8 s device capability check against the real hardware (ignores demo mode).
 * Every sensor/permission call is guarded: failures become notes, never crashes.
 */
export function useDeviceCheck(onDone: (c: DeviceCheck) => void) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DeviceCheckProgress | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (userNotes?: string) => {
      if (running) return;
      setRunning(true);
      const problems: string[] = [];
      const started = Date.now();
      const update = (p: Partial<DeviceCheckProgress>) => {
        if (!mounted.current) return;
        setProgress((prev) => ({
          fraction: Math.min(1, (Date.now() - started) / TOTAL_MS),
          step: 'Starting…',
          baroSamples: 0,
          gps: 'waiting',
          ...prev,
          ...p,
        }));
      };
      setProgress({ fraction: 0, step: 'Checking sensors…', baroSamples: 0, gps: 'waiting' });
      const platform = Platform.OS;

      // --- Barometer availability + iOS Motion permission ---
      let hasBarometer: boolean | null = null;
      try {
        hasBarometer = platform === 'web' ? false : await Barometer.isAvailableAsync();
      } catch (e) {
        problems.push(`barometer check threw: ${reason(e)}`);
      }
      let barometerPermission: PermissionState = toPermissionState(null, platform, 'motion');
      if (platform === 'ios' && hasBarometer) {
        try {
          let perm = await Barometer.getPermissionsAsync();
          if (!perm.granted && perm.canAskAgain && perm.status === 'undetermined') perm = await Barometer.requestPermissionsAsync();
          barometerPermission = toPermissionState(perm, platform, 'motion');
        } catch (e) {
          problems.push(`motion permission check threw: ${reason(e)}`);
        }
      }

      // --- Location permission ---
      let locationPermission: PermissionState = 'unknown';
      try {
        let res = await Location.getForegroundPermissionsAsync();
        if (!res.granted && res.status === 'undetermined' && res.canAskAgain) res = await Location.requestForegroundPermissionsAsync();
        locationPermission = toPermissionState(res, platform, 'location');
      } catch (e) {
        problems.push(`location permission check threw: ${reason(e)}`);
      }

      // --- GPS fix (in parallel with the barometer window) ---
      const gpsPromise: Promise<GpsFix | null> = (async () => {
        if (locationPermission !== 'granted') {
          update({ gps: 'skipped' });
          return null;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), DEVICE_CHECK_GPS_TIMEOUT_MS);
          });
          const loc = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), timeout]);
          if (!loc) {
            problems.push('GPS: no fix within 8 s');
            update({ gps: 'no fix' });
            return null;
          }
          update({ gps: 'fix' });
          return {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            altitude: loc.coords.altitude,
            accuracy: loc.coords.accuracy,
            altitudeAccuracy: loc.coords.altitudeAccuracy,
            timestamp: loc.timestamp,
          };
        } catch (e) {
          problems.push(`GPS failed: ${reason(e)}`);
          update({ gps: 'no fix' });
          return null;
        } finally {
          clearTimeout(timer);
        }
      })();

      // --- Barometer samples ---
      const samples: CheckBaroSample[] = [];
      const baroPromise = (async () => {
        if (!hasBarometer || barometerPermission === 'denied') return;
        let sub: { remove: () => void } | null = null;
        try {
          try {
            Barometer.setUpdateInterval(100);
          } catch {
            // Keep the default interval.
          }
          sub = Barometer.addListener((m: BarometerMeasurement) => {
            samples.push({
              t: Date.now(),
              pressure: m.pressure,
              relativeAltitude: typeof m.relativeAltitude === 'number' ? m.relativeAltitude : null,
            });
          });
        } catch (e) {
          problems.push(`barometer listener threw: ${reason(e)}`);
          return;
        }
        await new Promise((r) => setTimeout(r, DEVICE_CHECK_BARO_MS));
        try {
          sub?.remove();
        } catch {
          // ignore
        }
      })();

      const tick = setInterval(() => {
        const elapsed = Date.now() - started;
        update({
          fraction: Math.min(1, elapsed / TOTAL_MS),
          baroSamples: samples.length,
          step: elapsed < DEVICE_CHECK_BARO_MS && hasBarometer ? 'Listening to the barometer…' : 'Waiting for a GPS fix…',
        });
      }, 250);

      const [fix] = await Promise.all([gpsPromise, baroPromise]);
      clearInterval(tick);

      let osVersion: string | null = null;
      let device = { modelName: null as string | null, brand: null as string | null, modelId: null as string | null };
      try {
        // Never Device.deviceName: it is user-set and often the owner's name.
        device = { modelName: Device.modelName, brand: Device.brand, modelId: Device.modelId };
        osVersion = Device.osVersion;
      } catch (e) {
        problems.push(`device info failed: ${reason(e)}`);
      }

      const check = buildDeviceCheck({
        id: makeId('d'),
        timestamp: new Date().toISOString(),
        device: { ...device, osVersion },
        platform,
        appVersion: appVersion(),
        hasBarometer,
        barometerPermission,
        samples,
        locationPermission,
        fix,
        problems,
        userNotes,
      });
      if (mounted.current) {
        setProgress(null);
        setRunning(false);
      }
      onDone(check);
      return check;
    },
    [running, onDone],
  );

  return { run, running, progress };
}
