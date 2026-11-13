import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVectorsJson, VECTORS_PATH } from '../scripts/vectors';
import { runVisitEngine, VisitEngine, type EngineOutput } from '../src/visit';
import { buildVisitScenarios, type VisitScenario } from './visitScenarios';

const csv = readFileSync(fileURLToPath(new URL('./fixtures/moo-2026-11-13-iphone.csv', import.meta.url)), 'utf8');
const scenarios = new Map(buildVisitScenarios(csv).map((s) => [s.name, s]));
const run = (name: string): EngineOutput[] => {
  const s = scenarios.get(name)!;
  return runVisitEngine(s.venues, s.inputs);
};
const kinds = (out: EngineOutput[]) =>
  out.map((o) =>
    o.type === 'floor' ? `floor:${o.floorIndex}` : o.type === 'baseline' ? `baseline:${o.status}` : o.type === 'ignored' ? `ignored:${o.reason}` : o.type === 'arrived' ? (o.resumed ? 'resumed' : 'arrived') : o.type,
  );

describe('visit engine', () => {
  it('arrives, takes a baseline and reports floors after the dwell time', () => {
    expect(kinds(run('arrive-and-go-up'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'floor:1', 'floor:2', 'left']);
    const floors = run('arrive-and-go-up').filter((o) => o.type === 'floor');
    // Floor 1 starts at +60 s and is reported 10 s later.
    const t0 = scenarios.get('arrive-and-go-up')!.inputs[0]!.tMs;
    expect(floors[1]!.tMs - t0).toBe(70_000);
  });

  it('refers heights to table zero when the entrance is not floor 0', () => {
    expect(kinds(run('arrive-on-lower-entrance'))).toEqual(['arrived', 'baseline:new', 'floor:-1', 'floor:0']);
  });

  it('ignores an arrival during an open visit and keeps the floor', () => {
    expect(kinds(run('enter-while-inside-is-ignored'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'floor:2', 'ignored:already-inside']);
  });

  it('ignores an arrival with a fix worse than the radius', () => {
    expect(kinds(run('poor-accuracy-enter-is-ignored'))).toEqual(['ignored:poor-accuracy', 'arrived', 'baseline:new', 'floor:0']);
    expect(kinds(run('unknown-venue-is-ignored'))).toEqual(['ignored:unknown-venue']);
  });

  it('resumes after a quick false exit without a new baseline', () => {
    expect(kinds(run('quick-reentry-resumes'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'floor:2', 'left', 'resumed']);
  });

  it('keeps the old baseline on a suspect re-entry upstairs, and takes a new one at the entrance', () => {
    expect(kinds(run('suspect-reentry-upstairs-keeps-baseline'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'floor:2', 'left', 'arrived', 'baseline:kept']);
    expect(kinds(run('suspect-reentry-at-entrance-takes-new-baseline'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'left', 'arrived', 'baseline:new', 'floor:0', 'floor:1']);
    expect(kinds(run('late-reentry-takes-new-baseline'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'left', 'arrived', 'baseline:new', 'floor:0']);
  });

  it('keeps a phone found already inside at mall level', () => {
    expect(kinds(run('found-inside-is-mall-level'))).toEqual(['arrived', 'baseline:unavailable', 'left', 'arrived', 'baseline:new', 'floor:0']);
  });

  it('stays mall-level when no barometer sample arrives in time', () => {
    expect(kinds(run('no-barometer-stays-mall-level'))).toEqual(['arrived', 'baseline:unavailable', 'left']);
  });

  it('does not flicker on an escalator ride shorter than the dwell time', () => {
    expect(kinds(run('escalator-ride-does-not-flicker'))).toEqual(['arrived', 'baseline:new', 'floor:0']);
  });

  it('closes the first visit when arriving at another mall', () => {
    expect(kinds(run('switch-malls-without-exit'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'left', 'arrived', 'baseline:new', 'floor:0']);
  });

  it('continues the visit after an app restart', () => {
    expect(kinds(run('app-restart-inside-keeps-baseline'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'floor:2', 'ignored:already-inside', 'floor:1']);
    expect(kinds(run('app-restart-during-capture-recaptures'))).toEqual(['arrived', 'baseline:new', 'floor:0']);
  });

  it('round-trips a snapshot', () => {
    const s = scenarios.get('drift-is-corrected-while-standing')!;
    const a = new VisitEngine(s.venues);
    for (const i of s.inputs) a.handle(i);
    const b = new VisitEngine(s.venues);
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.currentFloorIndex).toBe(1);
    expect(a.snapshot()!.driftOffsetM).toBeGreaterThan(1);
  });

  it('corrects slow drift while standing on a floor', () => {
    expect(kinds(run('drift-is-corrected-while-standing'))).toEqual(['arrived', 'baseline:new', 'floor:0', 'floor:1']);
  });

  it('gets every Mall of Oman reading right except the tester label slip', () => {
    const s = scenarios.get('mall-of-oman-2026-11-13-iphone') as VisitScenario;
    const engine = new VisitEngine(s.venues);
    const out: EngineOutput[] = [];
    let ti = 0;
    const misses: string[] = [];
    for (const input of s.inputs) {
      while (ti < s.truth!.length && input.tMs > s.truth![ti]!.tMs) {
        const t = s.truth![ti]!;
        if (engine.currentFloorIndex !== t.floorIndex) misses.push(`${new Date(t.tMs).toISOString()} truth ${t.floorIndex} got ${engine.currentFloorIndex} ${t.note}`);
        ti++;
      }
      out.push(...engine.handle(input));
    }
    expect(misses).toEqual([expect.stringContaining('label slip')]);
    expect(out.filter((o) => o.type === 'baseline').length).toBe(1);
    expect(out.some((o) => o.type === 'ignored' && o.reason === 'poor-accuracy')).toBe(true);
    expect(out[out.length - 1]!.type).toBe('left');
  });

  it('has up-to-date shared vectors for the Swift and Kotlin SDKs (run npm run vectors)', () => {
    expect(existsSync(VECTORS_PATH)).toBe(true);
    expect(readFileSync(VECTORS_PATH, 'utf8')).toBe(buildVectorsJson());
  });
});
