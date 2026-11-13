/** Small input checks; each returns the clean value or throws a 400 ApiError. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (message: string, code = 'invalid_request') => new ApiError(400, code, message);

export function obj(v: unknown, what = 'body'): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${what} must be a JSON object.`);
  return v as Record<string, unknown>;
}

export function str(v: unknown, name: string, opts: { min?: number; max: number; pattern?: RegExp }): string {
  if (typeof v !== 'string') throw bad(`${name} must be a string.`);
  const s = v.trim();
  if (s.length < (opts.min ?? 1) || s.length > opts.max) throw bad(`${name} must be ${opts.min ?? 1}–${opts.max} characters.`);
  if (opts.pattern && !opts.pattern.test(s)) throw bad(`${name} has an invalid format.`);
  return s;
}

export function optStr(v: unknown, name: string, opts: { max: number; pattern?: RegExp }): string | null {
  if (v === undefined || v === null || v === '') return null;
  return str(v, name, { ...opts, min: 1 });
}

export function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`);
  return v;
}

export function optInt(v: unknown, name: string, min: number, max: number): number | null {
  if (v === undefined || v === null) return null;
  return int(v, name, min, max);
}

export function num(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${name} must be a number from ${min} to ${max}.`);
  return v;
}

export function oneOf<T extends string>(v: unknown, name: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw bad(`${name} must be one of: ${values.join(', ')}.`);
  return v as T;
}

/** ISO 8601 date-time with a time zone; returned normalised to UTC (…Z). */
export function isoTime(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    throw bad(`${name} must be an ISO 8601 date-time with a time zone, e.g. 2026-12-01T00:00:00+04:00.`);
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw bad(`${name} is not a valid date.`);
  return new Date(t).toISOString();
}

export function httpsUrl(v: unknown, name: string): string | null {
  const s = optStr(v, name, { max: 500 });
  if (s === null) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${name} must be a URL.`);
  }
  if (u.protocol !== 'https:') throw bad(`${name} must start with https://.`);
  return u.toString();
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
