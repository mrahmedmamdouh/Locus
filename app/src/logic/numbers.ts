export function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

export function roundOrNull(x: number | null | undefined, dp: number): number | null {
  return x === null || x === undefined || !Number.isFinite(x) ? null : round(x, dp);
}

/** Parse a user-typed decimal ("4,5" and "4.5" both work). Returns null when not a finite number. */
export function parseDecimal(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse a non-negative integer, or null. */
export function parseCount(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

export function fmt(x: number | null | undefined, dp = 1, unit = ''): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const s = x.toFixed(dp);
  return unit ? `${s} ${unit}` : s;
}

export function fmtSigned(x: number | null | undefined, dp = 1, unit = ''): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const s = (x > 0 ? '+' : '') + x.toFixed(dp);
  return unit ? `${s} ${unit}` : s;
}

export function fmtPct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${Math.round(x * 100)}%`;
}
