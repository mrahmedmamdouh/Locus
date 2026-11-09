import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildUniformFloors,
  classifyFloor,
  createDriftTracker,
  parseCsvRows,
  relativeAltitudeFromPressure,
  type Floor,
} from '../src';

const FLOOR_M = 5.75;
const WINDOW_MS = 8000;

interface ReplayRow {
  sessionId: string;
  venueName: string;
  tMs: number;
  trueFloorIndex: number;
  pressureHpa: number;
  baselinePressureHpa: number;
  temperatureC: number;
}

/** iPhone 15 Pro field readings from 3 Muscat malls (no location columns). */
function loadReplay(): ReplayRow[] {
  const text = readFileSync(fileURLToPath(new URL('./fixtures/iphone-baro-replay.csv', import.meta.url)), 'utf8');
  const [header, ...rows] = parseCsvRows(text);
  const col = (name: string) => {
    const i = header!.indexOf(name);
    if (i < 0) throw new Error(`fixture lacks ${name}`);
    return i;
  };
  const c = {
    sessionId: col('sessionId'),
    venueName: col('venueName'),
    timestamp: col('timestamp'),
    trueFloorIndex: col('trueFloorIndex'),
    pressureHpa: col('pressureHpa'),
    baselinePressureHpa: col('baselinePressureHpa'),
    temperatureC: col('temperatureC'),
  };
  return rows
    .map((r) => ({
      sessionId: r[c.sessionId]!,
      venueName: r[c.venueName]!,
      tMs: Date.parse(r[c.timestamp]!),
      trueFloorIndex: Number(r[c.trueFloorIndex]),
      pressureHpa: Number(r[c.pressureHpa]),
      baselinePressureHpa: Number(r[c.baselinePressureHpa]),
      temperatureC: Number(r[c.temperatureC]),
    }))
    .sort((a, b) => a.tMs - b.tMs);
}

/** Replay one venue with ONLY its first session's baseline: { right, total } with and without the tracker. */
function replayVenue(all: ReplayRow[], venue: string) {
  const rows = all.filter((r) => r.venueName === venue);
  const first = rows[0]!;
  const baseline = first.baselinePressureHpa;
  const indices = rows.map((r) => r.trueFloorIndex);
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  const floors: Floor[] = buildUniformFloors(Math.max(0, -lo), Math.max(0, hi), FLOOR_M);
  const tracker = createDriftTracker({ floors });
  let withTracker = 0;
  let without = 0;
  for (const r of rows) {
    const relAlt = relativeAltitudeFromPressure(r.pressureHpa, baseline, r.temperatureC);
    if (classifyFloor(relAlt, floors)?.index === r.trueFloorIndex) without++;
    // Each reading is a 5 s stationary recording: feed it as a steady sample spanning the window.
    let out = tracker.update({ tMs: r.tMs, relAltM: relAlt });
    out = tracker.update({ tMs: r.tMs + WINDOW_MS / 2, relAltM: relAlt });
    out = tracker.update({ tMs: r.tMs + WINDOW_MS, relAltM: relAlt });
    if (out.floorIndex === r.trueFloorIndex) withTracker++;
  }
  return { total: rows.length, withTracker, without };
}

describe('drift tracker: field replay (iPhone 15 Pro, Muscat, first calibration only)', () => {
  const replay = loadReplay();

  it('documents the drift: one evening at Avenus Mall goes wrong without correction', () => {
    const r = replayVenue(replay, 'Avenus Mall');
    expect(r.total).toBe(90);
    expect(r.without).toBeLessThanOrEqual(65);
  });

  it('recovers Avenus Mall with floor snapping', () => {
    const r = replayVenue(replay, 'Avenus Mall');
    expect(r.withTracker).toBeGreaterThanOrEqual(87);
  });

  it('keeps Mall Of Oman perfect', () => {
    const r = replayVenue(replay, 'Mall Of Oman');
    expect(r.total).toBe(73);
    expect(r.withTracker).toBe(73);
  });

  it('does not hurt City Center Seeb', () => {
    const r = replayVenue(replay, 'City Center Seeb');
    expect(r.withTracker).toBeGreaterThanOrEqual(r.without);
  });
});

describe('drift tracker: rules', () => {
  const floors = buildUniformFloors(1, 2, 6);
  const feedSteady = (t: ReturnType<typeof createDriftTracker>, z: number, fromMs: number, seconds: number) => {
    let out = t.update({ tMs: fromMs, relAltM: z });
    for (let s = 1; s <= seconds; s++) out = t.update({ tMs: fromMs + s * 1000, relAltM: z });
    return out;
  };

  it('is not stationary until a full window of steady samples', () => {
    const t = createDriftTracker({ floors });
    expect(t.update({ tMs: 0, relAltM: 1 }).stationary).toBe(false);
    expect(t.update({ tMs: 7000, relAltM: 1 }).stationary).toBe(false);
    const out = t.update({ tMs: 8000, relAltM: 1 });
    expect(out.stationary).toBe(true);
    expect(out.offsetM).toBeCloseTo(0.5); // alpha 0.5 of the 1 m residual
  });

  it('snaps towards the nearest floor centre while stationary, at most once per window', () => {
    const t = createDriftTracker({ floors });
    const a = feedSteady(t, 2, 0, 8);
    expect(a.offsetM).toBeCloseTo(1);
    const b = feedSteady(t, 2, 9000, 7); // up to 16 s: second window complete
    expect(b.offsetM).toBeCloseTo(1.5);
    expect(b.correctedM).toBeCloseTo(0.5);
    expect(b.floorIndex).toBe(0);
  });

  it('does not update while moving (escalator ride)', () => {
    const t = createDriftTracker({ floors });
    let out = t.update({ tMs: 0, relAltM: 0 });
    for (let s = 1; s <= 30; s++) out = t.update({ tMs: s * 1000, relAltM: s * 0.2 });
    expect(out.stationary).toBe(false);
    expect(out.offsetM).toBe(0);
    expect(out.correctedM).toBeCloseTo(6);
    expect(out.floorIndex).toBe(1);
  });

  it('never snaps across a floor (residual of half a floor or more)', () => {
    const t = createDriftTracker({ floors });
    // Exactly between floors 0 and 1 (3 m): the nearest centre is 3 m away = half a floor.
    const out = feedSteady(t, 3, 0, 20);
    expect(out.stationary).toBe(true);
    expect(out.offsetM).toBe(0);
  });

  it('treats a data gap longer than the window as unknown, and reset() clears the offset', () => {
    const t = createDriftTracker({ floors });
    feedSteady(t, 1, 0, 8);
    expect(t.offsetM).toBeCloseTo(0.5);
    expect(t.update({ tMs: 60_000, relAltM: 1 }).stationary).toBe(false);
    t.reset();
    expect(t.offsetM).toBe(0);
  });

  it('can start from a restored offset', () => {
    const t = createDriftTracker({ floors, initialOffsetM: 1.2 });
    expect(t.update({ tMs: 0, relAltM: 1.2 }).correctedM).toBeCloseTo(0);
    t.reset();
    expect(t.offsetM).toBe(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const t = createDriftTracker({ floors, alpha: 0.3 });
      const outs = [];
      for (let s = 0; s < 40; s++) outs.push(t.update({ tMs: s * 1000, relAltM: 0.8 + (s % 3) * 0.1 }));
      return outs;
    };
    expect(run()).toEqual(run());
  });

  it('rejects bad options', () => {
    expect(() => createDriftTracker({ floors, alpha: 0 })).toThrow(RangeError);
    expect(() => createDriftTracker({ floors, stationaryWindowMs: 0 })).toThrow(RangeError);
  });
});
