import { describe, expect, it } from 'vitest';
import { relativeAltitudeFromPressure } from '@locus/altitude-core';
import { buildDrafts, parseDrafts, venueProblems } from '../src/logic/venueDraft';
import { csvFileName, slugify } from '../src/logic/exportName';
import { formatElapsed } from '../src/logic/time';
import { parseDecimal } from '../src/logic/numbers';
import { createSimulator } from '../src/logic/simulator';

describe('venue drafts', () => {
  it('builds uniform floors, top floor first', () => {
    const { drafts, error } = buildDrafts('1', '2', '4,5');
    expect(error).toBeNull();
    expect(drafts!.map((d) => d.label)).toEqual(['2', '1', 'G', 'B1']);
    expect(parseDrafts(drafts!).floors!.map((f) => f.index)).toEqual([-1, 0, 1, 2]);
  });

  it('rejects bad builder input', () => {
    expect(buildDrafts('x', '2', '4.5').error).toMatch(/Basements/);
    expect(buildDrafts('0', '2', '0').error).toMatch(/height/);
  });

  it('reports overlaps, bad numbers and duplicate labels', () => {
    const { drafts } = buildDrafts('0', '1', '4');
    const overlap = drafts!.map((d) => (d.index === 1 ? { ...d, zMin: '1' } : d));
    expect(parseDrafts(overlap).problems.join(' ')).toMatch(/overlap/);
    const nan = drafts!.map((d) => (d.index === 1 ? { ...d, zMax: 'abc' } : d));
    expect(parseDrafts(nan).problems.join(' ')).toMatch(/not a number/);
    const dup = drafts!.map((d) => ({ ...d, label: 'X' }));
    expect(parseDrafts(dup).floors).toBeNull();
    expect(venueProblems({ name: '', city: 'Muscat', country: 'OM', floors: drafts! }).problems).toContain('Venue name is required.');
  });
});

describe('helpers', () => {
  it('names export files', () => {
    expect(slugify('Mall of Arabia — Ç')).toBe('mall-of-arabia-c');
    expect(csvFileName('City Stars', new Date(2026, 9, 27))).toBe('locus-readings-city-stars-2026-10-27.csv');
  });
  it('formats elapsed time and decimals', () => {
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(3725)).toBe('1:02:05');
    expect(parseDecimal('4,5')).toBe(4.5);
    expect(parseDecimal('')).toBeNull();
  });
  it('simulates pressure that maps back to the requested height', () => {
    const sim = createSimulator({ noiseM: 0, driftHpaPerMin: 0, startMs: 0, basePressureHpa: 1000 });
    expect(relativeAltitudeFromPressure(sim.pressureAt(9, 0), 1000, 24)).toBeCloseTo(9, 6);
  });
});
