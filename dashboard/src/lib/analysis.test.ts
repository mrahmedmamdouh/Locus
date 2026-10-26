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

  it('gives a verdict on the synthetic sample with the default gate', () => {
    expect(['pass', 'fail']).toContain(a.gate.verdict);
    expect(a.gate.summary.n).toBe(sample.length);
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
