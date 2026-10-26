import { G0, R_DRY_AIR } from '@locus/altitude-core';
import type { GpsFix } from './types';

/**
 * Demo-mode sensor simulator for web and simulators without a barometer.
 * Produces pressure for a target height (inverse hypsometric equation) plus
 * white noise (~0.5 m) and a slow weather drift, and a much noisier GPS fix.
 */
export interface Simulator {
  pressureAt(heightM: number, nowMs: number): number;
  gpsAt(heightM: number, nowMs: number): GpsFix;
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function createSimulator(opts?: {
  basePressureHpa?: number;
  temperatureC?: number;
  noiseM?: number;
  driftHpaPerMin?: number;
  gpsNoiseM?: number;
  rand?: () => number;
  startMs?: number;
}): Simulator {
  const p0 = opts?.basePressureHpa ?? 1009.5;
  const tK = (opts?.temperatureC ?? 24) + 273.15;
  const noiseM = opts?.noiseM ?? 0.5;
  const drift = opts?.driftHpaPerMin ?? 0.002;
  const gpsNoise = opts?.gpsNoiseM ?? 10;
  const rand = opts?.rand ?? Math.random;
  const start = opts?.startMs ?? Date.now();
  const scale = (R_DRY_AIR * tK) / G0;
  return {
    pressureAt(heightM, nowMs) {
      const h = heightM + gauss(rand) * noiseM;
      const minutes = (nowMs - start) / 60_000;
      return p0 * Math.exp(-h / scale) + minutes * drift;
    },
    gpsAt(heightM, nowMs) {
      return {
        latitude: 30.0285 + (rand() - 0.5) * 0.0002,
        longitude: 31.4086 + (rand() - 0.5) * 0.0002,
        altitude: 75 + heightM + gauss(rand) * gpsNoise,
        accuracy: 8 + rand() * 20,
        altitudeAccuracy: 6 + rand() * 15,
        timestamp: nowMs,
      };
    },
  };
}
