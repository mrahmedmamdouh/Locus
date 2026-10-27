/**
 * Shared types for the Locus altitude field test.
 *
 * Heights are in meters RELATIVE TO THE VENUE ENTRANCE where the tester
 * calibrated (entrance = 0 m). This keeps every reading independent of
 * weather-driven changes in absolute sea-level pressure.
 */

/** One floor of a venue, as a vertical band relative to the calibration entrance. */
export interface Floor {
  /** Display label, e.g. "G", "1", "B1", "Food court". */
  label: string;
  /** Ordinal: 0 = entrance level, 1 = one up, -1 = one down. */
  index: number;
  /** Bottom of the band in meters relative to the entrance. */
  zMinM: number;
  /** Top of the band in meters relative to the entrance. */
  zMaxM: number;
}

export interface Venue {
  id: string;
  name: string;
  city: string;
  country: 'EG' | 'OM' | string;
  /** Optional known elevation of the entrance above sea level (meters). */
  entranceAltitudeM?: number;
  floors: Floor[];
}

/** A merchant location as a 3D geofence: a vertical cylinder. */
export interface Geofence3D {
  id: string;
  lat: number;
  lon: number;
  radiusM: number;
  /** Altitude band relative to the venue entrance (meters). */
  zMinM: number;
  zMaxM: number;
}

export interface GeoPoint3D {
  lat: number;
  lon: number;
  /** Altitude relative to the venue entrance (meters). */
  relAltM: number;
}

/** Calibration taken at the venue entrance (ground truth z = 0). */
export interface Calibration {
  venueId: string;
  timestamp: string; // ISO 8601
  baselinePressureHpa: number;
  /** GPS altitude at the entrance, if a fix was available. */
  baselineGpsAltM: number | null;
  /** Assumed indoor air temperature used for the pressure-to-height conversion. */
  temperatureC: number;
}

/**
 * One field-test reading: the tester stands on a KNOWN floor (ground truth)
 * and the phone records barometer + GPS. One row of the exported CSV.
 */
export interface Reading {
  id: string;
  sessionId: string;
  venueId: string;
  venueName: string;
  deviceModel: string;
  platform: 'ios' | 'android' | 'web' | string;
  timestamp: string; // ISO 8601
  secondsSinceCalibration: number;

  /** Ground truth entered by the tester. */
  trueFloorLabel: string;
  trueFloorIndex: number;
  /** Centre of the true floor's band, meters relative to entrance. */
  trueFloorCenterM: number;
  /**
   * Height of the true floor's band (zMaxM − zMinM) at capture time, so each
   * reading is judged against its own venue's floors. Null in older exports.
   */
  trueFloorHeightM: number | null;

  /** Barometer. */
  pressureHpa: number | null;
  baselinePressureHpa: number | null;
  temperatureC: number;
  /** Relative altitude computed from pressure (meters). */
  baroRelAltM: number | null;
  /** iOS-only: CoreMotion relative altitude reported by the OS (meters). */
  osRelAltM: number | null;

  /** GPS. */
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAltM: number | null;
  gpsAccuracyM: number | null;
  gpsAltAccuracyM: number | null;
  /** GPS altitude minus the entrance GPS altitude (meters). */
  gpsRelAltM: number | null;

  /** Floor estimates at capture time. */
  estFloorIndexBaro: number | null;
  estFloorIndexGps: number | null;

  /** Number of raw sensor samples averaged into this reading. */
  sampleCount: number;

  /**
   * Wi-Fi scan taken with this reading (Android only); details are in the
   * separate Wi-Fi CSV, joined by reading id. Null in older exports.
   */
  wifiScanStatus: string | null;
  /** Access points kept after cleaning (hotspots dropped). */
  wifiApCount: number | null;
  notes: string;
}

/** Which altitude source to evaluate. */
export type AltitudeSource = 'baro' | 'gps' | 'os';
