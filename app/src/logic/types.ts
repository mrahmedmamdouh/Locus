import type { Calibration } from '@locus/altitude-core';

/** One GPS fix, normalised from expo-location. Timestamp in epoch ms. */
export interface GpsFix {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  altitudeAccuracy: number | null;
  timestamp: number;
}

/**
 * Calibration as stored by the app. Same as the library `Calibration`, except
 * the baseline pressure may be null on phones without a barometer (GPS-only).
 */
export type AppCalibration = Omit<Calibration, 'baselinePressureHpa'> & {
  baselinePressureHpa: number | null;
};

/** A test session: one tester, one venue, one calibration at the entrance. */
export interface Session {
  id: string;
  venueId: string;
  venueName: string;
  startedAt: string; // ISO 8601
  /** One session = one calibration; recalibrating starts a new session at the same venue. */
  calibration: AppCalibration;
  /**
   * iOS only: OS relative altitude (CoreMotion) at calibration time. The OS value is relative
   * to when the sensor stream started, so we subtract this to get "relative to entrance".
   */
  osRelAltBaselineM: number | null;
  /** Identifies the sensor stream the OS baseline belongs to; a restarted stream invalidates it. */
  sensorEpoch: string | null;
  demo: boolean;
}

/** Barometer samples collected over a window. */
export interface BaroWindow {
  pressures: number[];
  /** iOS CoreMotion relative altitude samples (empty on Android/web). */
  osRelAlts: number[];
  /** Sensor stream id the samples came from. */
  epoch: string | null;
}
