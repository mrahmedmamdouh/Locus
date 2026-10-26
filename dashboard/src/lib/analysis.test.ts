import { describe, expect, it } from 'vitest';
import { generateSampleReadings } from '@locus/altitude-core';
import { analyze, driftBucketFor } from './analysis';
import { DEFAULT_SETTINGS } from './settings';

describe('analyze', () => {
  const sample = generateSampleReadings();
  const a = analyze(sample, DEFAULT_SETTINGS);

  it('summarises every source and counts synthetic rows', () => {
    expect(a.bySource.map((s) => s.source)).toEqual(['baro', 'gps', 'os']);
    expect(a.syntheticRows).toBe(sample.length);
    expect(a.venues).toBe(2);
  });

  it('the synthetic sample passes the default gate with the barometer', () => {
    expect(a.gate.verdict).toBe('pass');
    expect(a.gate.summary.n).toBe(sample.length);
    expect(a.gate.summary.p90AbsErrorFloors).not.toBeNull();
    expect(a.gate.venues).toBe(2);
  });

  it('counts readings that use the fallback floor height', () => {
    expect(a.fallbackFloorRows).toBe(0);
    const old = sample.map((r) => ({ ...r, trueFloorHeightM: null }));
    expect(analyze(old, DEFAULT_SETTINGS).fallbackFloorRows).toBe(sample.length);
  });

  it('gives the iOS OS source a floor accuracy', () => {
    const os = a.bySource.find((s) => s.source === 'os')!;
    expect(os.n).toBeGreaterThan(0);
    expect(os.floorAccuracy).not.toBeNull();
  });

  it('only counts venues with enough readings per venue', () => {
    const strict = { ...DEFAULT_SETTINGS, gate: { ...DEFAULT_SETTINGS.gate, minReadingsPerVenue: 1_000_000 } };
    const g = analyze(sample, strict).gate;
    expect(g.venues).toBe(0);
    expect(g.verdict).toBe('insufficient-data');
  });

  it('orders the floor breakdown by floor index, not label', () => {
    const labels = a.breakdowns.floor.map((r) => r.group);
    expect(labels[0]).toMatch(/^B2 \(index -2\)$/);
    expect(labels.at(-1)).toMatch(/^3 \(index 3\)$/);
  });

  it('venue breakdown uses display names', () => {
    expect(a.breakdowns.venue.map((r) => r.group)).toContain('Demo Mall Cairo (synthetic)');
  });

  it('reports insufficient data under the reading minimum', () => {
    expect(analyze(sample.slice(0, 10), DEFAULT_SETTINGS).gate.verdict).toBe('insufficient-data');
  });

  it('picks a drift bucket by session length', () => {
    expect(driftBucketFor([])).toBe(2);
    expect(driftBucketFor([{ ...sample[0]!, secondsSinceCalibration: 3 * 3600 }])).toBe(15);
  });
});
