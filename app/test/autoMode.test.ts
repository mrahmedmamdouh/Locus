import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUniformFloors,
  csvToReadings,
  floorCenterM,
  readingsToCsv,
  relativeAltitudeFromPressure,
  summarize,
  type Venue,
} from '@locus/altitude-core';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

import {
  DEFAULT_BOUNDARY_RADIUS_M,
  EXIT_FIXES,
  INITIAL_PRESENCE,
  NO_AUTO_FIELDS,
  baselineReady,
  buildAutoFields,
  computeAutoBaseline,
  entranceFloorIndex,
  entranceHeightM,
  exitMarginM,
  parseBoundary,
  shouldCaptureOnEnter,
  updatePresence,
  type AutoBaseline,
  type PresenceState,
} from '../src/logic/autoMode';
import {
  AUTO_EVENT_COLUMNS,
  autoEventsFileName,
  autoEventsToCsv,
  makeAutoEvent,
  parseAutoEvent,
  parseAutoEventLines,
  serializeAutoEvent,
} from '../src/logic/autoEvents';
import { buildReading, manualVsAutoLine, type BuildReadingInput } from '../src/logic/reading';
import { floorHeightMismatch, floorsToDrafts, rescaleDrafts } from '../src/logic/venueDraft';
import { parseDecimal } from '../src/logic/numbers';
import { KEYS, MAX_AUTO_EVENTS, createStorage, type KeyValueStore } from '../src/state/storage';
import type { Session } from '../src/logic/types';

const T = 24;
const SCALE = (287.053 * (T + 273.15)) / 9.80665;
/** Pressure at height h (m) above a reference pressure p0. */
const pAt = (p0: number, h: number) => p0 * Math.exp(-h / SCALE);

const venue: Venue = {
  id: 'v1',
  name: 'Avenues',
  city: 'Muscat',
  country: 'OM',
  floors: buildUniformFloors(1, 2, 6),
  boundary: { lat: 23.588, lon: 58.383, radiusM: 150 },
  entranceFloorIndex: 0,
};

const baseline = (over: Partial<AutoBaseline> = {}): AutoBaseline => ({
  venueId: 'v1',
  venueName: 'Avenues',
  source: 'geofence-foreground',
  enteredAt: '2026-11-01T16:00:00.000Z',
  calibratedAt: '2026-11-01T16:00:03.000Z',
  baselinePressureHpa: 1013,
  entrancePressureHpa: 1013,
  entranceHeightM: 0,
  sampleCount: 30,
  temperatureC: T,
  gpsAccuracyM: 12,
  driftOffsetM: 0,
  exitedAt: null,
  ...over,
});

describe('entrance floor and baseline', () => {
  it('defaults the entrance to floor 0 and uses its centre height', () => {
    expect(entranceFloorIndex(venue)).toBe(0);
    expect(entranceHeightM(venue)).toBe(0);
    const upper = { ...venue, entranceFloorIndex: 1 };
    expect(entranceFloorIndex(upper)).toBe(1);
    expect(entranceHeightM(upper)).toBe(6);
    // Not in the table: falls back to index × typical floor height / the lowest floor ≥ 0.
    expect(entranceHeightM({ ...venue, entranceFloorIndex: 3 })).toBe(18);
    expect(entranceFloorIndex({ ...venue, entranceFloorIndex: 7 })).toBe(0);
  });

  it('takes the median and refers it to height 0 of the floor table', () => {
    const p0 = 1012.5;
    // Entrances on floor 1 (6 m): the capture reads the pressure 6 m up, plus one outlier.
    const pressures = [pAt(p0, 6), pAt(p0, 6) + 0.001, pAt(p0, 6) - 0.001, 900];
    const res = computeAutoBaseline({ pressures, entranceHeightM: 6, temperatureC: T })!;
    expect(res.sampleCount).toBe(4);
    expect(res.baselinePressureHpa).toBeCloseTo(p0, 2);
    // Back at the entrance the height is the entrance floor's height.
    expect(relativeAltitudeFromPressure(pAt(p0, 6), res.baselinePressureHpa, T)).toBeCloseTo(6, 1);
  });

  it('returns null without valid samples', () => {
    expect(computeAutoBaseline({ pressures: [], entranceHeightM: 0, temperatureC: T })).toBeNull();
    expect(computeAutoBaseline({ pressures: [NaN, -1, 0], entranceHeightM: 0, temperatureC: T })).toBeNull();
  });

  it('re-baselines on entry only after an exit or for another venue', () => {
    expect(shouldCaptureOnEnter(null, 'v1')).toBe(true);
    expect(shouldCaptureOnEnter(baseline(), 'v1')).toBe(false);
    expect(shouldCaptureOnEnter(baseline({ exitedAt: '2026-11-01T17:00:00.000Z' }), 'v1')).toBe(true);
    expect(shouldCaptureOnEnter(baseline(), 'v2')).toBe(true);
    expect(baselineReady(baseline({ baselinePressureHpa: null }))).toBe(false);
  });
});

describe('auto fields of a reading', () => {
  const now = new Date('2026-11-01T16:30:03.000Z');
  const args = {
    enabled: true,
    baseline: baseline(),
    venueId: 'v1',
    floors: venue.floors,
    pressureHpa: pAt(1013, 7.5),
    driftOffsetM: 1.2,
    now,
  };

  it('fills height, offset, corrected floor and minutes', () => {
    const f = buildAutoFields(args);
    expect(f.autoCalibrationSource).toBe('geofence-foreground');
    expect(f.autoCalibratedAt).toBe('2026-11-01T16:00:03.000Z');
    expect(f.autoBaselinePressureHpa).toBe(1013);
    expect(f.minutesSinceAutoCalibration).toBe(30);
    expect(f.autoRelAltM).toBeCloseTo(7.5, 2);
    expect(f.autoDriftOffsetM).toBe(1.2);
    expect(f.autoEstFloorIndex).toBe(1); // 7.5 − 1.2 = 6.3 m → floor 1
  });

  it('is all null when auto mode is off, and source "none" without a baseline', () => {
    expect(buildAutoFields({ ...args, enabled: false })).toEqual(NO_AUTO_FIELDS);
    expect(buildAutoFields({ ...args, baseline: null })).toEqual({ ...NO_AUTO_FIELDS, autoCalibrationSource: 'none' });
    expect(buildAutoFields({ ...args, baseline: baseline({ venueId: 'v2' }) }).autoCalibrationSource).toBe('none');
    // Background entry whose barometer read failed: still pending.
    const pending = baseline({ source: 'geofence-background', baselinePressureHpa: null, calibratedAt: null });
    expect(buildAutoFields({ ...args, baseline: pending })).toEqual({ ...NO_AUTO_FIELDS, autoCalibrationSource: 'none' });
  });

  it('keeps the baseline fields but no height when the reading has no pressure', () => {
    const f = buildAutoFields({ ...args, pressureHpa: null });
    expect(f.autoCalibrationSource).toBe('geofence-foreground');
    expect(f.autoRelAltM).toBeNull();
    expect(f.autoDriftOffsetM).toBeNull();
    expect(f.autoEstFloorIndex).toBeNull();
  });

  it('goes into the Reading, survives the CSV, and is evaluated as source "auto"', () => {
    const session: Session = {
      id: 's1',
      venueId: 'v1',
      venueName: 'Avenues',
      startedAt: '2026-11-01T16:05:00.000Z',
      calibration: { venueId: 'v1', timestamp: '2026-11-01T16:05:00.000Z', baselinePressureHpa: 1013.05, baselineGpsAltM: null, temperatureC: T },
      osRelAltBaselineM: null,
      sensorEpoch: 'e',
      demo: false,
      autoMode: true,
    };
    const p = pAt(1013, 7.5);
    const input: BuildReadingInput = {
      id: 'r1',
      session,
      venue,
      trueFloor: venue.floors.find((f) => f.index === 1)!,
      baro: { pressures: [p, p, p], osRelAlts: [], epoch: 'e' },
      gps: null,
      windowStart: new Date(now.getTime() - 5000),
      now,
      deviceModel: 'iPhone 15 Pro',
      platform: 'ios',
      note: '',
      demo: false,
      wifi: null,
      auto: buildAutoFields({ ...args, pressureHpa: p }),
    };
    const r = buildReading(input);
    expect(r.autoEstFloorIndex).toBe(1);
    const back = csvToReadings(readingsToCsv([r]));
    expect(back.errors).toEqual([]);
    expect(back.readings[0]).toEqual(r);
    const s = summarize([r], 'auto', 6);
    expect(s.floorAccuracy).toBe(1);
    expect(s.meanErrorM).toBeCloseTo(7.5 - 1.2 - floorCenterM(venue.floors.find((f) => f.index === 1)!), 2);
    // Without auto fields the reading has nulls (old behaviour).
    const plain = buildReading({ ...input, auto: undefined });
    expect(plain.autoCalibrationSource).toBeNull();
    expect(manualVsAutoLine(plain, venue.floors)).toBeNull();
  });

  it('formats the manual vs auto comparison line', () => {
    const base = buildReading({
      id: 'r2',
      session: {
        id: 's',
        venueId: 'v1',
        venueName: 'Avenues',
        startedAt: now.toISOString(),
        calibration: { venueId: 'v1', timestamp: now.toISOString(), baselinePressureHpa: 1013, baselineGpsAltM: null, temperatureC: T },
        osRelAltBaselineM: null,
        sensorEpoch: null,
        demo: false,
      },
      venue,
      trueFloor: venue.floors.find((f) => f.index === 1)!,
      baro: { pressures: [pAt(1013, 6.2)], osRelAlts: [], epoch: null },
      gps: null,
      windowStart: now,
      now,
      deviceModel: 'x',
      platform: 'ios',
      note: '',
      demo: false,
      wifi: null,
      auto: buildAutoFields({ ...args, pressureHpa: pAt(1013, 5.6), driftOffsetM: -0.4 }),
    });
    expect(manualVsAutoLine(base, venue.floors)).toBe('Manual: floor 1 ✓ · Auto: floor 1 ✓ (drift −0.4 m)');
    const none = { ...base, ...NO_AUTO_FIELDS, autoCalibrationSource: 'none' };
    expect(manualVsAutoLine(none, venue.floors)).toBe('Manual: floor 1 ✓ · Auto: no automatic baseline yet');
    const wrong = { ...base, autoEstFloorIndex: 0, autoRelAltM: 0.1, autoDriftOffsetM: 0 };
    expect(manualVsAutoLine(wrong, venue.floors)).toBe('Manual: floor 1 ✓ · Auto: floor G ✗ (drift 0.0 m)');
  });
});

describe('entry detection from location fixes', () => {
  const b = venue.boundary!;
  /** A point `m` metres north of the boundary centre. */
  const north = (m: number, accuracy: number | null = 10) => ({ latitude: b.lat + m / 111_195, longitude: b.lon, accuracy });

  it('enters inside the radius only with accuracy ≤ radius / 2', () => {
    expect(updatePresence(INITIAL_PRESENCE, north(100, 90), b).event).toBeNull(); // too vague
    expect(updatePresence(INITIAL_PRESENCE, north(200, 10), b).event).toBeNull(); // outside
    expect(updatePresence(INITIAL_PRESENCE, north(100, null), b).event).toBeNull(); // no accuracy
    const r = updatePresence(INITIAL_PRESENCE, north(100, 75), b);
    expect(r.event).toBe('enter');
    expect(r.state.inside).toBe(true);
  });

  it('exits only after several fixes beyond radius + margin (hysteresis)', () => {
    let s: PresenceState = { inside: true, outsideCount: 0 };
    // Just outside the radius but inside the margin: still inside.
    let r = updatePresence(s, north(b.radiusM + exitMarginM(b.radiusM) - 5), b);
    expect(r.event).toBeNull();
    expect(r.state.inside).toBe(true);
    // A single far jump (indoor GPS) does not end the visit if the next fix is back inside.
    r = updatePresence(s, north(400), b);
    expect(r.state.outsideCount).toBe(1);
    r = updatePresence(r.state, north(50), b);
    expect(r.state).toEqual({ inside: true, outsideCount: 0 });
    // Far fixes with poor accuracy are ignored for exit.
    r = updatePresence(r.state, north(400, 400), b);
    expect(r.state.outsideCount).toBe(0);
    // EXIT_FIXES good fixes in a row outside: exit.
    s = r.state;
    let ev: string | null = null;
    for (let i = 0; i < EXIT_FIXES; i++) {
      const out = updatePresence(s, north(400), b);
      s = out.state;
      ev = out.event;
    }
    expect(ev).toBe('exit');
    expect(s.inside).toBe(false);
  });
});

describe('boundary input and floor height', () => {
  it('parses the boundary, with the default radius', () => {
    expect(parseBoundary('', '', '150', parseDecimal)).toEqual({ boundary: null, problems: [] });
    expect(parseBoundary('23.5', '58,4', '', parseDecimal).boundary).toEqual({ lat: 23.5, lon: 58.4, radiusM: DEFAULT_BOUNDARY_RADIUS_M });
    expect(parseBoundary('99', '58', '150', parseDecimal).problems[0]).toMatch(/latitude/);
    expect(parseBoundary('23', 'x', '150', parseDecimal).problems[0]).toMatch(/longitude/);
    expect(parseBoundary('23', '58', '5', parseDecimal).problems[0]).toMatch(/radius/);
  });

  it('applies a new floor height keeping labels, and flags a table that does not match', () => {
    const drafts = floorsToDrafts(buildUniformFloors(1, 2, 4.5)).map((d) => (d.index === 0 ? { ...d, label: 'Ground' } : d));
    expect(floorHeightMismatch(drafts, '5.75')).toBe(true);
    const res = rescaleDrafts(drafts, '5.75');
    expect(res.error).toBeNull();
    const g = res.drafts!.find((d) => d.index === 0)!;
    expect(g).toEqual({ index: 0, label: 'Ground', zMin: '-2.875', zMax: '2.875' });
    expect(res.drafts!.find((d) => d.index === 2)!.zMax).toBe('14.375');
    expect(floorHeightMismatch(res.drafts!, '5.75')).toBe(false);
    expect(rescaleDrafts(drafts, '1').error).toMatch(/between/);
  });
});

describe('event log', () => {
  const t = new Date('2026-11-01T16:00:00.000Z');

  it('serialises one event per line and parses it back', () => {
    const e = makeAutoEvent(
      { id: 'a1', kind: 'baseline-pending', context: 'background', venueId: 'v1', venueName: 'Avenues', message: 'no samples,\n"bg"' },
      t,
    );
    const line = serializeAutoEvent(e);
    expect(line).not.toContain('\n');
    expect(parseAutoEvent(line)).toEqual(e);
  });

  it('skips bad lines and sorts by time', () => {
    const a = serializeAutoEvent(makeAutoEvent({ id: 'b', kind: 'wake', context: 'background' }, new Date(t.getTime() + 1000)));
    const b = serializeAutoEvent(makeAutoEvent({ id: 'a', kind: 'geofence-enter', context: 'foreground' }, t));
    const events = parseAutoEventLines([a, 'not json', '{"id":"x","t":"y","kind":"nope"}', `${b}\n`]);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('exports CSV with a header and escaped cells', () => {
    const e = makeAutoEvent({ id: 'a1', kind: 'error', context: 'foreground', message: '=bad, "x"', pressureHpa: 1013.2 }, t);
    const csv = autoEventsToCsv([e]);
    const [header, row] = csv.trimEnd().split('\r\n');
    expect(header).toBe(AUTO_EVENT_COLUMNS.join(','));
    expect(row).toContain(`"'=bad, ""x"""`);
    expect(row).toContain('1013.2');
    expect(autoEventsFileName(new Date(2026, 10, 1))).toBe('locus-auto-events-2026-11-01.csv');
  });
});

describe('storage: auto events and baseline', () => {
  class MemoryStore implements KeyValueStore {
    data = new Map<string, string>();
    async getItem(k: string) {
      return this.data.get(k) ?? null;
    }
    async setItem(k: string, v: string) {
      this.data.set(k, v);
    }
    async removeItem(k: string) {
      this.data.delete(k);
    }
    async getAllKeys() {
      return [...this.data.keys()];
    }
  }
  let kv: MemoryStore;
  beforeEach(() => {
    kv = new MemoryStore();
  });

  it('appends events under their own keys and loads them in order', async () => {
    const s = createStorage(kv);
    await s.appendAutoEvent(makeAutoEvent({ id: 'e2', kind: 'wake', context: 'background' }, new Date(2000)));
    await s.appendAutoEvent(makeAutoEvent({ id: 'e1', kind: 'geofence-enter', context: 'background' }, new Date(1000)));
    expect([...kv.data.keys()].filter((k) => k.startsWith(KEYS.autoEventPrefix))).toHaveLength(2);
    expect((await s.loadAutoEvents()).map((e) => e.id)).toEqual(['e1', 'e2']);
    await s.clearAutoEvents();
    expect(await s.loadAutoEvents()).toEqual([]);
  });

  it('drops the oldest events beyond the cap', async () => {
    const s = createStorage(kv);
    for (let i = 0; i < MAX_AUTO_EVENTS + 3; i++) {
      await s.appendAutoEvent(makeAutoEvent({ id: `e${String(i).padStart(5, '0')}`, kind: 'info', context: 'foreground' }, new Date(i * 1000)));
    }
    const events = await s.loadAutoEvents();
    expect(events).toHaveLength(MAX_AUTO_EVENTS);
    expect(events[0]!.id).toBe('e00003');
    expect(kv.data.size).toBe(MAX_AUTO_EVENTS);
  });

  it('saves, loads and clears the baseline; ignores garbage', async () => {
    const s = createStorage(kv);
    expect(await s.loadAutoBaseline()).toBeNull();
    await s.saveAutoBaseline(baseline());
    expect(await s.loadAutoBaseline()).toEqual(baseline());
    await s.saveAutoBaseline(null);
    expect(await s.loadAutoBaseline()).toBeNull();
    kv.data.set(KEYS.autoBaseline, '{oops');
    expect(await s.loadAutoBaseline()).toBeNull();
  });

  it('gives older stored readings null auto fields and keeps autoMode off by default', async () => {
    const s = createStorage(kv);
    kv.data.set('locus.v2.readingSessions', JSON.stringify(['s1']));
    kv.data.set('locus.v2.readings:s1', JSON.stringify([{ id: 'r', sessionId: 's1' }]));
    const all = await s.loadAll();
    expect(all.readings[0]!.autoEstFloorIndex).toBeNull();
    expect(all.readings[0]!.autoCalibrationSource).toBeNull();
    expect(all.settings.autoMode).toBe(false);
  });
});
