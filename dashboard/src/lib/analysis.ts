/**
 * One pure entry point that turns readings + settings into everything the
 * dashboard renders. Components stay thin: they only display this result.
 */
import { driftByMinutes, evaluateGate, summarize, summarizeBy } from '@locus/altitude-core';
import type { AccuracySummary, AltitudeSource, GateResult, Reading } from '@locus/altitude-core';
import { countFallbackFloorHeight, isSyntheticRow, recalibrationAdvice, type DriftRow, type RecalibrationAdvice } from './data';
import type { Settings } from './settings';

export const SOURCES: readonly AltitudeSource[] = ['baro', 'gps', 'os'];

export type BreakdownKey = 'venue' | 'device' | 'platform' | 'floor';

export const BREAKDOWN_LABEL: Record<BreakdownKey, string> = {
  venue: 'Venue',
  device: 'Device model',
  platform: 'Platform',
  floor: 'True floor',
};

export interface BreakdownRow {
  group: string;
  summary: AccuracySummary;
}

export interface Analysis {
  total: number;
  venues: number;
  devices: number;
  syntheticRows: number;
  /** Readings without their own floor height, judged against the fallback floor height. */
  fallbackFloorRows: number;
  gate: GateResult;
  bySource: AccuracySummary[];
  breakdowns: Record<BreakdownKey, BreakdownRow[]>;
  drift: DriftRow[];
  driftBucketMinutes: number;
  advice: RecalibrationAdvice;
}

/** Floor breakdown label: "G (index 0)" and sort by index rather than alphabetically. */
function floorKey(r: Reading): string {
  return `${String(r.trueFloorIndex).padStart(4, ' ')}\u0000${r.trueFloorLabel || r.trueFloorIndex}`;
}

function floorDisplay(key: string): string {
  const [idx, label] = key.split('\u0000');
  return `${label} (index ${Number(idx)})`;
}

/** Pick a drift bucket width so a session of any length gets a readable number of buckets. */
export function driftBucketFor(readings: readonly Reading[]): number {
  let maxS = 0;
  for (const r of readings) if (r.secondsSinceCalibration > maxS) maxS = r.secondsSinceCalibration;
  const minutes = maxS / 60;
  if (minutes <= 30) return 2;
  if (minutes <= 90) return 5;
  if (minutes <= 240) return 15;
  return 30;
}

export function analyze(readings: Reading[], settings: Settings): Analysis {
  const { floorHeightM, source, gate: criteria } = settings;
  const breakdownSource = source;
  const venueName = new Map<string, string>();
  for (const r of readings) if (!venueName.has(r.venueId)) venueName.set(r.venueId, r.venueName || r.venueId);

  const floorRows = summarizeBy(readings, floorKey, breakdownSource, floorHeightM)
    .sort((a, b) => Number(a.group.split('\u0000')[0]) - Number(b.group.split('\u0000')[0]))
    .map((g) => ({ group: floorDisplay(g.group), summary: g.summary }));

  const driftBucketMinutes = driftBucketFor(readings);
  const drift = driftByMinutes(readings, 'baro', driftBucketMinutes);

  return {
    total: readings.length,
    venues: venueName.size,
    devices: new Set(readings.map((r) => r.deviceModel)).size,
    syntheticRows: readings.filter(isSyntheticRow).length,
    fallbackFloorRows: countFallbackFloorHeight(readings),
    gate: evaluateGate(readings, floorHeightM, source, criteria),
    bySource: SOURCES.map((s) => summarize(readings, s, floorHeightM)),
    breakdowns: {
      venue: summarizeBy(readings, (r) => r.venueId, breakdownSource, floorHeightM).map((g) => ({
        group: venueName.get(g.group) ?? g.group,
        summary: g.summary,
      })),
      device: summarizeBy(readings, (r) => r.deviceModel || '(unknown)', breakdownSource, floorHeightM),
      platform: summarizeBy(readings, (r) => r.platform || '(unknown)', breakdownSource, floorHeightM),
      floor: floorRows,
    },
    drift,
    driftBucketMinutes,
    advice: recalibrationAdvice(drift, floorHeightM),
  };
}
