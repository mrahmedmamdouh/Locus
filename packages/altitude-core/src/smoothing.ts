/** Simple robust aggregations for noisy sensor samples. */

export function mean(values: number[]): number | null {
  const v = values.filter(Number.isFinite);
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

export function median(values: number[]): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Linear-interpolated percentile, p in [0, 100]. */
export function percentile(values: number[], p: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (p <= 0) return v[0]!;
  if (p >= 100) return v[v.length - 1]!;
  const rank = (p / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo]! + (v[hi]! - v[lo]!) * (rank - lo);
}

export function stdDev(values: number[]): number | null {
  const m = mean(values);
  const v = values.filter(Number.isFinite);
  if (m === null || v.length < 2) return null;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/** Mean after dropping the lowest and highest `trimFraction` of samples. */
export function trimmedMean(values: number[], trimFraction = 0.1): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const k = Math.floor(v.length * Math.min(Math.max(trimFraction, 0), 0.49));
  return mean(v.slice(k, v.length - k));
}

/** Exponential moving average helper. Returns the new average. */
export function ema(previous: number | null, sample: number, alpha = 0.2): number {
  if (previous === null || !Number.isFinite(previous)) return sample;
  return previous + alpha * (sample - previous);
}
