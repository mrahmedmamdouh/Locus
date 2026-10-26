import type { GpsFix } from './types';

/**
 * A fix older than this is never attached to a reading. Escalator rides take ~30 s,
 * so anything older may describe the previous floor.
 */
export const MAX_GPS_FIX_AGE_MS = 10_000;

/**
 * Pick the GPS fix for a recording window. Call AFTER the window with the latest fix.
 * The fix is used only if it was taken during the window (timestamp >= windowStartMs)
 * and is at most MAX_GPS_FIX_AGE_MS old; otherwise null (GPS columns stay empty).
 */
export function fixForWindow(
  fix: GpsFix | null,
  windowStartMs: number,
  nowMs: number,
  maxAgeMs = MAX_GPS_FIX_AGE_MS,
): GpsFix | null {
  if (!fix) return null;
  if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude) || !Number.isFinite(fix.timestamp)) return null;
  if (fix.timestamp < windowStartMs) return null;
  return nowMs - fix.timestamp <= maxAgeMs ? fix : null;
}
