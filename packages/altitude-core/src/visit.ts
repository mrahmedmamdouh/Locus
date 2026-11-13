import { createDriftTracker, type DriftTracker } from './drift';
import { floorCenterM } from './floors';
import { G0, R_DRY_AIR, relativeAltitudeFromPressure } from './pressure';
import { median } from './smoothing';
import type { Floor, VenueBoundary } from './types';

/**
 * Visit engine: the floor logic of the Locus SDK, as one pure state machine.
 *
 * This TypeScript file is the REFERENCE. The Swift (iOS) and Kotlin (Android) SDKs port it line
 * by line and must produce the same outputs for the shared vectors in sdk/spec/vectors (generated
 * by scripts/gen-vectors.ts). Change the behaviour here first, regenerate the vectors, then port.
 *
 * Inputs are mall-boundary events from the OS (enter / exit) and barometer samples. Outputs are
 * what the bank app needs: arrived, left, and the floor (debounced).
 *
 * Rules learnt in the field (Muscat, November 2026):
 * 1. An "enter" while a visit to the same mall is open (no exit since) is ignored. On 13 Nov iOS
 *    reported an arrival at Mall of Oman 2.5 h into the visit; re-baselining there would have
 *    shifted every later floor.
 * 2. An "enter" whose location fix is worse than the boundary radius is ignored (that one came
 *    with a 2.8 km fix).
 * 3. Exit followed by enter within reentryWindowMs resumes the visit with the old baseline (the
 *    iPhone reported a false exit 2 minutes after arriving home on 12 Nov).
 * 4. Within suspectWindowMs a new baseline is taken only if the phone is at the entrance floor by
 *    the old baseline; otherwise the old baseline is kept.
 * 5. A baseline must start within maxPendingMs of the arrival. Later than that the phone may be
 *    upstairs, so the visit stays mall-level (no floors) rather than risk a wrong baseline.
 * 6. Floor changes are reported after the floor has been stable for floorDwellMs.
 * 7. A phone found already inside when monitoring starts (not a crossing) is mall-level only.
 */

export interface EngineVenue {
  id: string;
  floors: Floor[];
  /** Floor of the main entrances, where arrivals are assumed. Default 0. */
  entranceFloorIndex?: number;
  boundary: VenueBoundary;
}

export interface EngineConfig {
  /** Barometer capture for a new baseline, from the first sample after arrival (ms). */
  captureMs: number;
  /** Longest wait from arrival to the first barometer sample before giving up on floors (ms). */
  maxPendingMs: number;
  /** Exit + enter within this time resumes the visit unconditionally (ms). */
  reentryWindowMs: number;
  /** Exit + enter within this time takes a new baseline only if the phone is at the entrance floor (ms). */
  suspectWindowMs: number;
  /** A new floor is reported after it has been stable this long (ms). */
  floorDwellMs: number;
  /** Indoor air temperature for the pressure-to-height conversion (°C). */
  temperatureC: number;
  driftAlpha: number;
  driftWindowMs: number;
  driftMaxRangeM: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  captureMs: 3_000,
  maxPendingMs: 120_000,
  reentryWindowMs: 15 * 60_000,
  suspectWindowMs: 60 * 60_000,
  floorDwellMs: 10_000,
  temperatureC: 24,
  driftAlpha: 0.5,
  driftWindowMs: 8_000,
  driftMaxRangeM: 0.4,
};

export type EngineInput =
  /**
   * crossing: true (default) when the OS reported a boundary crossing; false when the phone was
   * found already inside, e.g. monitoring just started in the middle of the mall. A found-inside
   * visit is mall-level only: the phone may be upstairs, so no baseline is taken.
   */
  | { type: 'enter'; tMs: number; venueId: string; accuracyM: number | null; crossing?: boolean }
  | { type: 'exit'; tMs: number; venueId: string }
  | { type: 'pressure'; tMs: number; hPa: number }
  /** The app was killed and relaunched: the engine is rebuilt from its own snapshot(). */
  | { type: 'restart'; tMs: number };

/**
 * What the SDKs persist so a relaunched app (killed by the OS, then woken by a region event)
 * continues the same visit. iOS does not repeat "enter" for a region the phone is already in, so
 * without this a relaunch inside the mall would lose the baseline.
 */
export interface VisitSnapshot {
  venueId: string;
  phase: 'capturing' | 'active' | 'no-baseline';
  enteredAtMs: number;
  exitedAtMs: number | null;
  baselineHpa: number | null;
  driftOffsetM: number;
  emittedFloor: number | null;
}

export type IgnoreReason = 'unknown-venue' | 'poor-accuracy' | 'already-inside';
export type BaselineStatus = 'new' | 'kept' | 'unavailable';

export type EngineOutput =
  | { type: 'arrived'; tMs: number; venueId: string; resumed: boolean }
  | { type: 'ignored'; tMs: number; venueId: string; reason: IgnoreReason }
  | { type: 'baseline'; tMs: number; venueId: string; status: BaselineStatus; baselinePressureHpa: number | null; sampleCount: number }
  | { type: 'floor'; tMs: number; venueId: string; floorIndex: number }
  | { type: 'left'; tMs: number; venueId: string };

type Phase = 'capturing' | 'active' | 'no-baseline';

interface Visit {
  venue: EngineVenue;
  phase: Phase;
  enteredAtMs: number;
  exitedAtMs: number | null;
  captureStartMs: number | null;
  samples: number[];
  baselineHpa: number | null;
  tracker: DriftTracker | null;
  lastCorrectedM: number | null;
  emittedFloor: number | null;
  candidate: number | null;
  candidateSinceMs: number;
  /** The previous visit to the same mall, while deciding between keeping it and a new baseline (rule 4). */
  previous: Visit | null;
}

/** Floor index of the main entrances: the configured one if it is in the table, else the lowest floor ≥ 0. */
export function engineEntranceFloor(venue: Pick<EngineVenue, 'floors' | 'entranceFloorIndex'>): Floor | null {
  const want = venue.entranceFloorIndex ?? 0;
  const exact = venue.floors.find((f) => f.index === want);
  if (exact) return exact;
  const sorted = [...venue.floors].sort((a, b) => a.index - b.index);
  return sorted.find((f) => f.index >= 0) ?? sorted[0] ?? null;
}

/** Pressure at height 0 of the floor table, from the median pressure measured at height `heightM`. */
export function pressureAtTableZero(entrancePressureHpa: number, heightM: number, temperatureC: number): number {
  const scale = (R_DRY_AIR * (temperatureC + 273.15)) / G0;
  return entrancePressureHpa * Math.exp(heightM / scale);
}

export class VisitEngine {
  private readonly venues = new Map<string, EngineVenue>();
  private readonly cfg: EngineConfig;
  private visit: Visit | null = null;

  constructor(venues: EngineVenue[], config: Partial<EngineConfig> = {}) {
    for (const v of venues) this.venues.set(v.id, v);
    this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...config };
  }

  /** Current mall, or null when not inside one. */
  get currentVenueId(): string | null {
    return this.visit && this.visit.exitedAtMs === null ? this.visit.venue.id : null;
  }

  /** Last reported floor, or null (no baseline yet, mall-level only, or not inside). */
  get currentFloorIndex(): number | null {
    return this.visit && this.visit.exitedAtMs === null ? this.visit.emittedFloor : null;
  }

  handle(input: EngineInput): EngineOutput[] {
    const out: EngineOutput[] = [];
    if (!Number.isFinite(input.tMs)) return out;
    if (input.type === 'enter') this.onEnter(input, out);
    else if (input.type === 'exit') this.onExit(input, out);
    else if (input.type === 'pressure') this.onPressure(input, out);
    else this.restore(this.snapshot());
    return out;
  }

  /** State to persist after every handle() call that produced output (and on app background). */
  snapshot(): VisitSnapshot | null {
    const v = this.visit;
    if (!v) return null;
    return {
      venueId: v.venue.id,
      phase: v.phase,
      enteredAtMs: v.enteredAtMs,
      exitedAtMs: v.exitedAtMs,
      baselineHpa: v.baselineHpa,
      driftOffsetM: v.tracker ? v.tracker.offsetM : 0,
      emittedFloor: v.emittedFloor,
    };
  }

  /**
   * Continue from a persisted snapshot. A capture in progress starts again (its samples are lost);
   * the drift offset is kept; the floor dwell starts again from the last reported floor. A snapshot
   * for a mall that is no longer configured is dropped.
   */
  restore(s: VisitSnapshot | null): void {
    const venue = s ? this.venues.get(s.venueId) : undefined;
    if (!s || !venue) {
      this.visit = null;
      return;
    }
    const active = s.phase === 'active' && s.baselineHpa !== null;
    this.visit = {
      venue,
      phase: active ? 'active' : s.phase === 'no-baseline' ? 'no-baseline' : 'capturing',
      enteredAtMs: s.enteredAtMs,
      exitedAtMs: s.exitedAtMs,
      captureStartMs: null,
      samples: [],
      baselineHpa: active ? s.baselineHpa : null,
      tracker: active
        ? createDriftTracker({
            floors: venue.floors,
            alpha: this.cfg.driftAlpha,
            stationaryWindowMs: this.cfg.driftWindowMs,
            stationaryMaxRangeM: this.cfg.driftMaxRangeM,
            initialOffsetM: s.driftOffsetM,
          })
        : null,
      lastCorrectedM: null,
      emittedFloor: active ? s.emittedFloor : null,
      candidate: active ? s.emittedFloor : null,
      candidateSinceMs: s.enteredAtMs,
      previous: null,
    };
  }

  private onEnter(e: Extract<EngineInput, { type: 'enter' }>, out: EngineOutput[]): void {
    const venue = this.venues.get(e.venueId);
    const ignore = (reason: IgnoreReason) => out.push({ type: 'ignored', tMs: e.tMs, venueId: e.venueId, reason });
    if (!venue) return void ignore('unknown-venue');
    if (e.accuracyM !== null && Number.isFinite(e.accuracyM) && e.accuracyM > venue.boundary.radiusM) return void ignore('poor-accuracy');
    const v = this.visit;
    if (v && v.venue.id === venue.id && v.exitedAtMs === null) return void ignore('already-inside');

    let previous: Visit | null = null;
    if (v && v.venue.id === venue.id && v.exitedAtMs !== null) {
      const gap = e.tMs - v.exitedAtMs;
      if (gap >= 0 && gap <= this.cfg.reentryWindowMs) {
        v.exitedAtMs = null;
        out.push({ type: 'arrived', tMs: e.tMs, venueId: venue.id, resumed: true });
        return;
      }
      if (gap >= 0 && gap <= this.cfg.suspectWindowMs && v.phase === 'active') previous = v;
    }
    if (v && v.venue.id !== venue.id && v.exitedAtMs === null) {
      out.push({ type: 'left', tMs: e.tMs, venueId: v.venue.id });
    }
    const crossing = e.crossing !== false;
    this.visit = {
      venue,
      phase: crossing ? 'capturing' : 'no-baseline',
      enteredAtMs: e.tMs,
      exitedAtMs: null,
      captureStartMs: null,
      samples: [],
      baselineHpa: null,
      tracker: null,
      lastCorrectedM: null,
      emittedFloor: null,
      candidate: null,
      candidateSinceMs: 0,
      previous,
    };
    out.push({ type: 'arrived', tMs: e.tMs, venueId: venue.id, resumed: false });
    if (!crossing) out.push({ type: 'baseline', tMs: e.tMs, venueId: venue.id, status: 'unavailable', baselinePressureHpa: null, sampleCount: 0 });
  }

  private onExit(e: Extract<EngineInput, { type: 'exit' }>, out: EngineOutput[]): void {
    const v = this.visit;
    if (!v || v.venue.id !== e.venueId || v.exitedAtMs !== null) return;
    v.exitedAtMs = e.tMs;
    out.push({ type: 'left', tMs: e.tMs, venueId: v.venue.id });
  }

  private onPressure(e: Extract<EngineInput, { type: 'pressure' }>, out: EngineOutput[]): void {
    const v = this.visit;
    if (!v || v.exitedAtMs !== null || !Number.isFinite(e.hPa) || e.hPa <= 0) return;
    if (v.phase === 'no-baseline') return;
    if (v.phase === 'capturing') {
      if (v.captureStartMs === null) {
        if (e.tMs - v.enteredAtMs > this.cfg.maxPendingMs) {
          this.giveUpBaseline(v, e.tMs, out);
          return;
        }
        v.captureStartMs = e.tMs;
      }
      const elapsed = e.tMs - v.captureStartMs;
      if (elapsed <= this.cfg.captureMs) v.samples.push(e.hPa);
      if (elapsed < this.cfg.captureMs) return;
      if (!this.finishCapture(v, e.tMs, out)) return;
    }
    this.track(this.visit!, e.tMs, e.hPa, out);
  }

  /** No barometer sample in time: keep the previous baseline if there is one, else go mall-level. */
  private giveUpBaseline(v: Visit, tMs: number, out: EngineOutput[]): void {
    if (v.previous) {
      this.restorePrevious(v, tMs, out);
      return;
    }
    v.phase = 'no-baseline';
    out.push({ type: 'baseline', tMs, venueId: v.venue.id, status: 'unavailable', baselinePressureHpa: null, sampleCount: 0 });
  }

  private restorePrevious(v: Visit, tMs: number, out: EngineOutput[]): void {
    const prev = v.previous!;
    prev.exitedAtMs = null;
    prev.previous = null;
    this.visit = prev;
    out.push({ type: 'baseline', tMs, venueId: prev.venue.id, status: 'kept', baselinePressureHpa: prev.baselineHpa, sampleCount: 0 });
  }

  /** Returns true when the visit is active afterwards (the sample should be tracked). */
  private finishCapture(v: Visit, tMs: number, out: EngineOutput[]): boolean {
    const med = median(v.samples);
    const entrance = engineEntranceFloor(v.venue);
    if (med === null || !entrance) {
      this.giveUpBaseline(v, tMs, out);
      return this.visit !== v && this.visit!.phase === 'active';
    }
    const entranceM = floorCenterM(entrance);
    const prev = v.previous;
    if (prev && prev.baselineHpa !== null && prev.tracker) {
      const hByPrev = relativeAltitudeFromPressure(med, prev.baselineHpa, this.cfg.temperatureC) - prev.tracker.offsetM;
      if (Math.abs(hByPrev - entranceM) > (entrance.zMaxM - entrance.zMinM) / 2) {
        this.restorePrevious(v, tMs, out);
        return true;
      }
    }
    v.previous = null;
    v.baselineHpa = pressureAtTableZero(med, entranceM, this.cfg.temperatureC);
    v.tracker = createDriftTracker({
      floors: v.venue.floors,
      alpha: this.cfg.driftAlpha,
      stationaryWindowMs: this.cfg.driftWindowMs,
      stationaryMaxRangeM: this.cfg.driftMaxRangeM,
    });
    v.phase = 'active';
    v.emittedFloor = null;
    out.push({ type: 'baseline', tMs, venueId: v.venue.id, status: 'new', baselinePressureHpa: v.baselineHpa, sampleCount: v.samples.length });
    return true;
  }

  private track(v: Visit, tMs: number, hPa: number, out: EngineOutput[]): void {
    if (v.phase !== 'active' || v.baselineHpa === null || !v.tracker) return;
    const raw = relativeAltitudeFromPressure(hPa, v.baselineHpa, this.cfg.temperatureC);
    const upd = v.tracker.update({ tMs, relAltM: raw });
    v.lastCorrectedM = upd.correctedM;
    const fi = upd.floorIndex;
    if (v.emittedFloor === null) {
      if (fi === null) return;
      v.emittedFloor = fi;
      v.candidate = fi;
      v.candidateSinceMs = tMs;
      out.push({ type: 'floor', tMs, venueId: v.venue.id, floorIndex: fi });
      return;
    }
    if (fi !== v.candidate) {
      v.candidate = fi;
      v.candidateSinceMs = tMs;
    }
    if (v.candidate !== null && v.candidate !== v.emittedFloor && tMs - v.candidateSinceMs >= this.cfg.floorDwellMs) {
      v.emittedFloor = v.candidate;
      out.push({ type: 'floor', tMs, venueId: v.venue.id, floorIndex: v.candidate });
    }
  }
}

/** Run a whole input sequence; used by the shared vectors. */
export function runVisitEngine(venues: EngineVenue[], inputs: EngineInput[], config: Partial<EngineConfig> = {}): EngineOutput[] {
  const engine = new VisitEngine(venues, config);
  return inputs.flatMap((i) => engine.handle(i));
}
