/** Local wall-clock helpers in a client's IANA time zone (works on Node and Cloudflare Workers). */
export interface LocalClock {
  /** Minutes since local midnight. */
  minutes: number;
  /** Local midnight that started today, as UTC ISO. */
  dayStartIso: string;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localClock(now: Date, timeZone: string): LocalClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour);
  const mi = Number(parts.minute);
  const s = Number(parts.second);
  // Offset of local time from UTC at `now` (whole seconds).
  const offsetMs = Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(now.getTime() / 1000) * 1000;
  return { minutes: h * 60 + mi, dayStartIso: new Date(Date.UTC(y, mo - 1, d) - offsetMs).toISOString() };
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether `minutes` falls in [start, end), wrapping past midnight when start > end. */
export function inQuietHours(minutes: number, start: string | null, end: string | null): boolean {
  if (!start || !end || !HHMM.test(start) || !HHMM.test(end)) return false;
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}
