import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Platform } from 'react-native';
import { Barometer, type BarometerMeasurement } from 'expo-sensors';
import { createSimulator } from '../logic/simulator';
import { makeId } from '../logic/ids';
import type { BaroWindow } from '../logic/types';

export interface BaroSample {
  /** Wall-clock ms (Date.now) when the sample arrived. */
  t: number;
  pressure: number;
  /** iOS CoreMotion relative altitude since the stream started; null elsewhere. */
  osRelAlt: number | null;
  epoch: string;
}

export type BaroStatus = 'checking' | 'available' | 'unavailable' | 'simulated';

export interface BarometerApi {
  status: BaroStatus;
  /** Whether the real hardware has a barometer (independent of demo mode). */
  hardwareAvailable: boolean | null;
  /** Latest sample, refreshed for rendering at about 4 Hz. */
  latest: BaroSample | null;
  /** Samples from the last `ms` milliseconds of the current stream. */
  recent: (ms: number) => BaroSample[];
  /** Id of the current sensor stream (changes when the stream restarts). */
  epoch: string | null;
  /** Wait `ms` and return the samples that arrived meanwhile. `onTick` gets the count so far. */
  collect: (ms: number, onTick?: (count: number, latest: BaroSample | null) => void) => Promise<BaroWindow>;
}

const UPDATE_INTERVAL_MS = 100;
const BUFFER_MS = 30_000;
const RENDER_INTERVAL_MS = 250;

/**
 * One long-lived barometer stream (real or simulated) with a 30 s ring buffer.
 * Mount once near the root so the iOS relative-altitude origin stays stable.
 */
export function useBarometer(opts: { demo: boolean; simHeightRef: MutableRefObject<number> }): BarometerApi {
  const { demo, simHeightRef } = opts;
  const [hardwareAvailable, setHardwareAvailable] = useState<boolean | null>(null);
  const [latest, setLatest] = useState<BaroSample | null>(null);
  const [epoch, setEpoch] = useState<string | null>(null);
  const bufferRef = useRef<BaroSample[]>([]);
  const epochRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ok = Platform.OS === 'web' ? false : await Barometer.isAvailableAsync();
        if (ok && Platform.OS === 'ios') {
          // CoreMotion altimeter needs Motion & Fitness permission (NSMotionUsageDescription).
          try {
            const perm = await Barometer.getPermissionsAsync();
            if (!perm.granted && perm.canAskAgain) await Barometer.requestPermissionsAsync();
          } catch {
            // Older OS versions do not gate the altimeter; carry on.
          }
        }
        if (!cancelled) setHardwareAvailable(ok);
      } catch {
        if (!cancelled) setHardwareAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const useSim = demo;
    const useReal = !demo && hardwareAvailable === true;
    bufferRef.current = [];
    setLatest(null);
    if (!useSim && !useReal) {
      epochRef.current = null;
      setEpoch(null);
      return;
    }
    const streamEpoch = makeId('e');
    epochRef.current = streamEpoch;
    setEpoch(streamEpoch);

    const push = (pressure: number, osRelAlt: number | null) => {
      if (!Number.isFinite(pressure) || pressure <= 0) return;
      const now = Date.now();
      const buf = bufferRef.current;
      buf.push({ t: now, pressure, osRelAlt: osRelAlt !== null && Number.isFinite(osRelAlt) ? osRelAlt : null, epoch: streamEpoch });
      while (buf.length > 0 && now - buf[0]!.t > BUFFER_MS) buf.shift();
    };

    let cleanup: () => void;
    if (useSim) {
      const sim = createSimulator();
      const id = setInterval(() => push(sim.pressureAt(simHeightRef.current, Date.now()), null), UPDATE_INTERVAL_MS);
      cleanup = () => clearInterval(id);
    } else {
      let sub: { remove: () => void } | null = null;
      try {
        Barometer.setUpdateInterval(UPDATE_INTERVAL_MS);
        sub = Barometer.addListener((m: BarometerMeasurement) => {
          push(m.pressure, typeof m.relativeAltitude === 'number' ? m.relativeAltitude : null);
        });
      } catch {
        sub = null;
      }
      cleanup = () => sub?.remove();
    }
    const renderId = setInterval(() => {
      const buf = bufferRef.current;
      setLatest(buf.length ? buf[buf.length - 1]! : null);
    }, RENDER_INTERVAL_MS);
    return () => {
      cleanup();
      clearInterval(renderId);
    };
  }, [demo, hardwareAvailable, simHeightRef]);

  const recent = useCallback((ms: number) => {
    const now = Date.now();
    const e = epochRef.current;
    return bufferRef.current.filter((s) => now - s.t <= ms && s.epoch === e);
  }, []);

  const collect = useCallback<BarometerApi['collect']>((ms, onTick) => {
    const start = Date.now();
    return new Promise<BaroWindow>((resolve) => {
      const tick = setInterval(() => {
        const buf = bufferRef.current;
        const n = buf.filter((s) => s.t >= start && s.epoch === epochRef.current).length;
        onTick?.(n, buf.length ? buf[buf.length - 1]! : null);
      }, RENDER_INTERVAL_MS);
      setTimeout(() => {
        clearInterval(tick);
        const e = epochRef.current;
        const samples = bufferRef.current.filter((s) => s.t >= start && s.epoch === e);
        resolve({
          pressures: samples.map((s) => s.pressure),
          osRelAlts: samples.map((s) => s.osRelAlt).filter((v): v is number => v !== null),
          epoch: e,
        });
      }, ms);
    });
  }, []);

  const status: BaroStatus = demo
    ? 'simulated'
    : hardwareAvailable === null
      ? 'checking'
      : hardwareAvailable
        ? 'available'
        : 'unavailable';

  return { status, hardwareAvailable, latest, recent, epoch, collect };
}
