import { classifyFloor, floorCenterM } from './floors';
import type { Floor } from './types';

/**
 * Barometric drift correction by "floor snapping".
 *
 * Weather and air-conditioning move indoor pressure by several metres of
 * apparent height per hour, so a single entrance baseline slowly walks the
 * estimate off its floor. Shoppers spend most of their time standing or
 * strolling on one floor, so whenever the phone is STATIONARY we assume it
 * rests on the nearest floor and nudge an offset towards that floor's centre.
 *
 * Safety rules:
 * - The offset changes only while stationary (range of raw height over the
 *   window ≤ `stationaryMaxRangeM`), never during an escalator or lift ride.
 * - It snaps only when the corrected height is already within half of the
 *   nearest floor's height of its centre, so it never pulls across a floor.
 * - At most one update per stationary window, so the correction speed does not
 *   depend on the sensor sample rate (alpha is "per window", not "per sample").
 *
 * Pure and deterministic: the same samples always give the same output.
 */

export interface DriftTrackerOptions {
  /** Floor table (heights relative to the baseline). */
  floors: Floor[];
  /** Share of the residual removed per stationary window (0–1]. Default 0.5. */
  alpha?: number;
  /** How long the phone must be steady before the offset may update (ms). Default 8000. */
  stationaryWindowMs?: number;
  /** Max spread (max − min) of raw height within the window to count as steady (m). Default 0.4. */
  stationaryMaxRangeM?: number;
  /** Start from a known offset (e.g. restored after an app restart). reset() still goes back to 0. Default 0. */
  initialOffsetM?: number;
}

export interface DriftSample {
  /** Sample time, ms (any monotonic clock; Date.now() is fine). */
  tMs: number;
  /** Raw height relative to the baseline, metres (no correction applied). */
  relAltM: number;
}

export interface DriftUpdate {
  /** relAltM − offsetM: the drift-corrected height (m). */
  correctedM: number;
  /** Floor of the corrected height (classifyFloor), or null when off the table. */
  floorIndex: number | null;
  /** Current drift estimate (m) that is subtracted from the raw height. */
  offsetM: number;
  /** Whether the phone counted as stationary at this sample. */
  stationary: boolean;
}

export interface DriftTracker {
  update(sample: DriftSample): DriftUpdate;
  /** Forget the offset and the sample window (e.g. after a new baseline). */
  reset(): void;
  /** Current offset without feeding a sample. */
  readonly offsetM: number;
}

export function createDriftTracker(opts: DriftTrackerOptions): DriftTracker {
  const floors = opts.floors;
  const alpha = opts.alpha ?? 0.5;
  const windowMs = opts.stationaryWindowMs ?? 8000;
  const maxRange = opts.stationaryMaxRangeM ?? 0.4;
  if (!(alpha > 0 && alpha <= 1)) throw new RangeError('alpha must be in (0, 1]');
  if (!(windowMs > 0)) throw new RangeError('stationaryWindowMs must be > 0');
  if (!(maxRange >= 0)) throw new RangeError('stationaryMaxRangeM must be >= 0');

  let offset = Number.isFinite(opts.initialOffsetM) ? opts.initialOffsetM! : 0;
  let buf: DriftSample[] = [];
  let lastUpdateMs: number | null = null;

  const nearestFloor = (z: number): Floor | null => {
    let best: Floor | null = null;
    let bestD = Infinity;
    for (const f of floors) {
      const d = Math.abs(z - floorCenterM(f));
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  };

  const result = (rawM: number, stationary: boolean): DriftUpdate => {
    const correctedM = rawM - offset;
    const f = classifyFloor(correctedM, floors);
    return { correctedM, floorIndex: f ? f.index : null, offsetM: offset, stationary };
  };

  return {
    get offsetM() {
      return offset;
    },
    reset() {
      offset = 0;
      buf = [];
      lastUpdateMs = null;
    },
    update(sample) {
      const { tMs, relAltM } = sample;
      if (!Number.isFinite(tMs) || !Number.isFinite(relAltM)) {
        return { ...result(Number.NaN, false), floorIndex: null };
      }
      const prev = buf[buf.length - 1];
      // Time went backwards or a data gap longer than the window: nothing is known about the gap.
      if (prev && (tMs < prev.tMs || tMs - prev.tMs > windowMs)) buf = [];
      buf.push({ tMs, relAltM });
      // Keep at most one sample at or before the window start, so a full window is covered.
      const cutoff = tMs - windowMs;
      while (buf.length >= 2 && buf[1]!.tMs <= cutoff) buf.shift();

      const covered = buf[0]!.tMs <= cutoff;
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      for (const s of buf) {
        if (s.relAltM < lo) lo = s.relAltM;
        if (s.relAltM > hi) hi = s.relAltM;
        sum += s.relAltM;
      }
      const stationary = covered && hi - lo <= maxRange;

      if (stationary && (lastUpdateMs === null || tMs - lastUpdateMs >= windowMs)) {
        const corrected = sum / buf.length - offset;
        const f = nearestFloor(corrected);
        if (f) {
          const residual = corrected - floorCenterM(f);
          if (Math.abs(residual) < (f.zMaxM - f.zMinM) / 2) {
            offset += alpha * residual;
            lastUpdateMs = tMs;
          }
        }
      }
      return result(relAltM, stationary);
    },
  };
}
