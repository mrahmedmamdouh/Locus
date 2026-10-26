import type { GpsFix } from './types';

/** A fix older than this is not attached to a reading (the tester may have changed floors). */
export const MAX_GPS_FIX_AGE_MS = 60_000;

/** Return the fix if it is recent enough to describe "now", else null. */
export function freshFix(fix: GpsFix | null, nowMs: number, maxAgeMs = MAX_GPS_FIX_AGE_MS): GpsFix | null {
  if (!fix) return null;
  if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return null;
  const age = nowMs - fix.timestamp;
  return age <= maxAgeMs ? fix : null;
}
