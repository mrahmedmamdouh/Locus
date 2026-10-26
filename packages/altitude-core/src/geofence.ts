import type { GeoPoint3D, Geofence3D } from './types';

const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/lon points, in meters (haversine). */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** True when the point is within the fence radius AND inside its altitude band. */
export function isInsideGeofence3D(point: GeoPoint3D, fence: Geofence3D): boolean {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !Number.isFinite(point.relAltM)) {
    return false;
  }
  const horizontal = haversineM(point.lat, point.lon, fence.lat, fence.lon);
  return horizontal <= fence.radiusM && point.relAltM >= fence.zMinM && point.relAltM <= fence.zMaxM;
}

export interface DwellState {
  fenceId: string;
  enteredAtMs: number | null;
}

/**
 * Dwell tracker: a fence "fires" only after the user has stayed inside it for
 * `dwellMs` continuously. Pure function: returns the next state and whether
 * it fired on this update.
 */
export function updateDwell(
  state: DwellState,
  inside: boolean,
  nowMs: number,
  dwellMs = 60_000,
): { state: DwellState; fired: boolean } {
  if (!inside) return { state: { ...state, enteredAtMs: null }, fired: false };
  const enteredAtMs = state.enteredAtMs ?? nowMs;
  const fired = state.enteredAtMs !== null && nowMs - enteredAtMs >= dwellMs;
  return { state: { ...state, enteredAtMs }, fired };
}
