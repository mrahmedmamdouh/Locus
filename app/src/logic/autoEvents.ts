import { escapeCsvCell } from '@locus/altitude-core';
import { localDateStamp } from './time';

/**
 * Automatic-mode event log. We need to learn what iOS and Android actually allow (background
 * geofence wake-ups, barometer access in the background, delays), so every step is logged.
 * Stored as one JSON line per event; exported as CSV.
 */
export type AutoEventKind =
  | 'geofence-enter'
  | 'geofence-exit'
  | 'wake'
  | 'baseline'
  | 'baseline-pending'
  | 'geofencing-started'
  | 'geofencing-stopped'
  | 'permission'
  | 'error'
  | 'info';

/** Where the event happened. */
export type AutoEventContext = 'foreground' | 'background';

export interface AutoEvent {
  id: string;
  /** ISO 8601 time the event was logged. */
  t: string;
  kind: AutoEventKind;
  context: AutoEventContext;
  venueId: string | null;
  venueName: string | null;
  lat: number | null;
  lon: number | null;
  gpsAccuracyM: number | null;
  /** Pressure measured at the event (e.g. entrance median), hPa. */
  pressureHpa: number | null;
  /** Baseline referred to height 0 of the floor table, hPa. */
  baselinePressureHpa: number | null;
  sampleCount: number | null;
  message: string;
}

export const AUTO_EVENT_COLUMNS = [
  'id',
  't',
  'kind',
  'context',
  'venueId',
  'venueName',
  'lat',
  'lon',
  'gpsAccuracyM',
  'pressureHpa',
  'baselinePressureHpa',
  'sampleCount',
  'message',
] as const satisfies readonly (keyof AutoEvent)[];

export function makeAutoEvent(
  partial: Partial<AutoEvent> & Pick<AutoEvent, 'id' | 'kind' | 'context'>,
  now: Date,
): AutoEvent {
  return {
    t: now.toISOString(),
    venueId: null,
    venueName: null,
    lat: null,
    lon: null,
    gpsAccuracyM: null,
    pressureHpa: null,
    baselinePressureHpa: null,
    sampleCount: null,
    message: '',
    ...partial,
  };
}

export function serializeAutoEvent(e: AutoEvent): string {
  // JSON.stringify never emits raw new lines, so one event = one line.
  return JSON.stringify(e);
}

const KINDS: ReadonlySet<string> = new Set<AutoEventKind>([
  'geofence-enter',
  'geofence-exit',
  'wake',
  'baseline',
  'baseline-pending',
  'geofencing-started',
  'geofencing-stopped',
  'permission',
  'error',
  'info',
]);

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Parse one JSON line; returns null for anything that is not a valid event. */
export function parseAutoEvent(line: string): AutoEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.t !== 'string' || typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  return {
    id: o.id,
    t: o.t,
    kind: o.kind as AutoEventKind,
    context: o.context === 'background' ? 'background' : 'foreground',
    venueId: strOrNull(o.venueId),
    venueName: strOrNull(o.venueName),
    lat: numOrNull(o.lat),
    lon: numOrNull(o.lon),
    gpsAccuracyM: numOrNull(o.gpsAccuracyM),
    pressureHpa: numOrNull(o.pressureHpa),
    baselinePressureHpa: numOrNull(o.baselinePressureHpa),
    sampleCount: numOrNull(o.sampleCount),
    message: typeof o.message === 'string' ? o.message : '',
  };
}

/** Parse JSON lines (or a list of single lines), skipping bad ones, sorted by time. */
export function parseAutoEventLines(lines: readonly string[]): AutoEvent[] {
  const out: AutoEvent[] = [];
  for (const chunk of lines) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      const e = parseAutoEvent(line);
      if (e) out.push(e);
    }
  }
  return out.sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id));
}

export function autoEventsToCsv(events: readonly AutoEvent[]): string {
  const lines = [AUTO_EVENT_COLUMNS.join(',')];
  for (const e of events) lines.push(AUTO_EVENT_COLUMNS.map((c) => escapeCsvCell(e[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** locus-auto-events-<YYYY-MM-DD>.csv */
export function autoEventsFileName(date: Date): string {
  return `locus-auto-events-${localDateStamp(date)}.csv`;
}
