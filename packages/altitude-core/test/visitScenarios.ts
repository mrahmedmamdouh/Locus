/**
 * Scenarios for the visit engine. They are run by visit.test.ts and written by
 * scripts/gen-vectors.ts to sdk/spec/vectors/visit-engine.json, which the Swift and Kotlin SDK
 * tests replay. Every input is spelled out, so the ports never depend on this file.
 */
import { buildUniformFloors } from '../src/floors';
import { G0, R_DRY_AIR } from '../src/pressure';
import type { EngineInput, EngineVenue } from '../src/visit';

export interface VisitScenario {
  name: string;
  description: string;
  venues: EngineVenue[];
  inputs: EngineInput[];
  /** For replay checks: the floor the tester was on at the end of each reading burst. */
  truth?: { tMs: number; floorIndex: number; note: string }[];
}

const T0 = Date.UTC(2026, 10, 13, 16, 0, 0);
const SCALE = (R_DRY_AIR * (24 + 273.15)) / G0;
const P0 = 1014.0;
/** Pressure at height h above table zero, rounded like a phone reports it (4 decimals). */
const p = (h: number, base = P0) => Math.round(base * Math.exp(-h / SCALE) * 1e4) / 1e4;

const mall: EngineVenue = {
  id: 'test-mall',
  floors: buildUniformFloors(1, 2, 5.75),
  entranceFloorIndex: 0,
  boundary: { lat: 23.5712, lon: 58.4045, radiusM: 300 },
};

const other: EngineVenue = {
  id: 'other-mall',
  floors: buildUniformFloors(0, 1, 6),
  boundary: { lat: 23.59, lon: 58.41, radiusM: 250 },
};

/** One pressure sample a second at height h, from t (inclusive) for n samples. */
function stand(t: number, h: number, n: number, base = P0): EngineInput[] {
  return Array.from({ length: n }, (_, i) => ({ type: 'pressure' as const, tMs: t + i * 1000, hPa: p(h, base) }));
}

const enter = (tMs: number, venueId = mall.id, accuracyM: number | null = 15): EngineInput => ({ type: 'enter', tMs, venueId, accuracyM });
const exit = (tMs: number, venueId = mall.id): EngineInput => ({ type: 'exit', tMs, venueId });
const MIN = 60_000;

function synthetic(): VisitScenario[] {
  return [
    {
      name: 'arrive-and-go-up',
      description: 'Arrival at the entrance, baseline, floor 0, then 20 s on floor 1 and floor 2 (each reported after 10 s).',
      venues: [mall],
      inputs: [enter(T0), ...stand(T0 + 500, 0, 15), ...stand(T0 + 60_000, 5.75, 20), ...stand(T0 + 120_000, 11.5, 20), exit(T0 + 10 * MIN)],
    },
    {
      name: 'arrive-on-lower-entrance',
      description: 'Entrance floor is B1 (-1); heights are referred to table zero, so the first floor reported is -1 and G is 0.',
      venues: [{ ...mall, entranceFloorIndex: -1 }],
      inputs: [enter(T0), ...stand(T0 + 500, -5.75, 15), ...stand(T0 + 60_000, 0, 20)],
    },
    {
      name: 'enter-while-inside-is-ignored',
      description: 'A second OS arrival during the visit (13 Nov, iOS) is ignored; floors keep using the first baseline.',
      venues: [mall],
      inputs: [enter(T0), ...stand(T0 + 500, 0, 10), ...stand(T0 + 60_000, 11.5, 15), enter(T0 + 5 * MIN), ...stand(T0 + 5 * MIN + 500, 11.5, 15)],
    },
    {
      name: 'poor-accuracy-enter-is-ignored',
      description: 'An arrival whose fix is worse than the radius (2.8 km on 13 Nov) is ignored; a good one is accepted.',
      venues: [mall],
      inputs: [enter(T0, mall.id, 2809), ...stand(T0 + 500, 0, 5), enter(T0 + 10_000, mall.id, 40), ...stand(T0 + 10_500, 0, 10)],
    },
    {
      name: 'unknown-venue-is-ignored',
      description: 'An arrival at a region the engine does not know is ignored.',
      venues: [mall],
      inputs: [enter(T0, 'nowhere'), ...stand(T0 + 500, 0, 5)],
    },
    {
      name: 'quick-reentry-resumes',
      description: 'False exit 2 minutes after arrival and enter 6 minutes later (home, 12 Nov): the visit resumes, no new baseline, even upstairs.',
      venues: [mall],
      inputs: [
        enter(T0),
        ...stand(T0 + 500, 0, 10),
        ...stand(T0 + MIN, 11.5, 15),
        exit(T0 + 2 * MIN),
        enter(T0 + 8 * MIN),
        ...stand(T0 + 8 * MIN + 500, 11.5, 15),
      ],
    },
    {
      name: 'suspect-reentry-upstairs-keeps-baseline',
      description: 'Exit and enter 30 minutes later while on floor 2: the new capture is not at the entrance by the old baseline, so the old one is kept.',
      venues: [mall],
      inputs: [
        enter(T0),
        ...stand(T0 + 500, 0, 10),
        ...stand(T0 + MIN, 11.5, 15),
        exit(T0 + 2 * MIN),
        enter(T0 + 32 * MIN),
        ...stand(T0 + 32 * MIN + 500, 11.5, 15),
      ],
    },
    {
      name: 'suspect-reentry-at-entrance-takes-new-baseline',
      description: 'Exit and enter 30 minutes later at the entrance (weather moved pressure by 0.3 hPa): a new baseline is taken.',
      venues: [mall],
      inputs: [
        enter(T0),
        ...stand(T0 + 500, 0, 10),
        exit(T0 + 2 * MIN),
        enter(T0 + 32 * MIN),
        ...stand(T0 + 32 * MIN + 500, 0, 10, P0 - 0.3),
        ...stand(T0 + 33 * MIN, 5.75, 15, P0 - 0.3),
      ],
    },
    {
      name: 'late-reentry-takes-new-baseline',
      description: 'Exit and enter 3 hours later: a new visit with a new baseline, even if the phone is upstairs (no way to tell).',
      venues: [mall],
      inputs: [enter(T0), ...stand(T0 + 500, 0, 10), exit(T0 + 2 * MIN), enter(T0 + 180 * MIN), ...stand(T0 + 180 * MIN + 500, 5.75, 10)],
    },
    {
      name: 'no-barometer-stays-mall-level',
      description: 'No pressure samples within 2 minutes of arrival (Android headless start, or no barometer): mall-level only, later samples are not used.',
      venues: [mall],
      inputs: [enter(T0), ...stand(T0 + 3 * MIN, 5.75, 10), exit(T0 + 10 * MIN)],
    },
    {
      name: 'escalator-ride-does-not-flicker',
      description: 'Riding up through a floor boundary for 6 s and back down does not report a floor change (dwell 10 s).',
      venues: [mall],
      inputs: [
        enter(T0),
        ...stand(T0 + 500, 0, 10),
        ...[1, 2, 3, 4, 5, 6].map((i) => ({ type: 'pressure' as const, tMs: T0 + 20_000 + i * 1000, hPa: p(4) })),
        ...stand(T0 + 27_000, 0, 15),
      ],
    },
    {
      name: 'switch-malls-without-exit',
      description: 'Arrival at another mall while a visit is open closes the first visit (left) and starts the second.',
      venues: [mall, other],
      inputs: [enter(T0), ...stand(T0 + 500, 0, 5), enter(T0 + 30 * MIN, other.id), ...stand(T0 + 30 * MIN + 500, 0, 5, P0 + 1)],
    },
    {
      name: 'app-restart-inside-keeps-baseline',
      description: 'The app is killed on floor 2 and relaunched; the OS reports "inside" again (ignored) and floors continue from the saved baseline and drift offset.',
      venues: [mall],
      inputs: [
        enter(T0),
        ...stand(T0 + 500, 0, 10),
        ...stand(T0 + MIN, 11.5, 15),
        { type: 'restart', tMs: T0 + 10 * MIN },
        enter(T0 + 10 * MIN + 100),
        ...stand(T0 + 10 * MIN + 500, 11.5, 5),
        ...stand(T0 + 11 * MIN, 5.75, 15),
      ],
    },
    {
      name: 'app-restart-during-capture-recaptures',
      description: 'Killed during the 3 s capture: the relaunched engine captures again (still within 2 minutes of arrival).',
      venues: [mall],
      inputs: [enter(T0), ...stand(T0 + 500, 0, 2), { type: 'restart', tMs: T0 + 2600 }, ...stand(T0 + 30_000, 0, 6)],
    },
    {
      name: 'drift-is-corrected-while-standing',
      description: 'Pressure falls 0.25 hPa (about 2 m) over 40 minutes while the phone stays on floor 1; floor snapping keeps it on floor 1.',
      venues: [mall],
      inputs: [
        enter(T0),
        ...stand(T0 + 500, 0, 10),
        ...Array.from({ length: 40 }, (_, k) => stand(T0 + (k + 1) * MIN, 5.75, 12, P0 - (0.25 * (k + 1)) / 40)).flat(),
      ],
    },
  ];
}

/** Replay of the iPhone at Mall of Oman on 13 Nov 2026 (fixture: test/fixtures/moo-2026-11-13-iphone.csv). */
function mallOfOmanReplay(csvText: string): VisitScenario {
  const venue: EngineVenue = {
    id: 'mall-of-oman',
    floors: buildUniformFloors(0, 2, 5.75),
    entranceFloorIndex: 0,
    boundary: { lat: 23.5712, lon: 58.4045, radiusM: 400 },
  };
  const rows = csvText
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','))
    .map(([ts, fl, pr, note]) => ({ tMs: Date.parse(ts!), floor: Number(fl), hPa: Number(pr), note: note ?? '' }));
  const tEnter = Date.parse('2026-11-13T15:54:56.086Z');
  const inputs: EngineInput[] = [enter(tEnter, venue.id, 20)];
  // The real background capture: 2 samples of 1014.3752 hPa in 3 s.
  for (let i = 0; i < 4; i++) inputs.push({ type: 'pressure', tMs: tEnter + 500 + i * 1000, hPa: 1014.3752 });
  const truth: NonNullable<VisitScenario['truth']> = [];
  for (const r of rows) {
    if (r.note === 'car park') {
      // 18:20: iOS reported an arrival with a 2.8 km fix while the phone was still inside.
      inputs.push(enter(Date.parse('2026-11-13T18:20:06.335Z'), venue.id, 2809));
    }
    // The tester stood still ~12 s for each reading: one sample a second around the reading time.
    for (let i = -6; i <= 5; i++) inputs.push({ type: 'pressure', tMs: r.tMs + i * 1000, hPa: r.hPa });
    truth.push({ tMs: r.tMs + 5000, floorIndex: r.floor, note: r.note });
  }
  inputs.push(exit(Date.parse('2026-11-13T18:23:49.105Z'), venue.id));
  return {
    name: 'mall-of-oman-2026-11-13-iphone',
    description: 'Real visit: 38 readings over 2.5 h with an iPhone 15 Pro; includes the 18:20 bogus arrival and the exit.',
    venues: [venue],
    inputs,
    truth,
  };
}

export function buildVisitScenarios(mooCsvText: string): VisitScenario[] {
  return [...synthetic(), mallOfOmanReplay(mooCsvText)];
}
