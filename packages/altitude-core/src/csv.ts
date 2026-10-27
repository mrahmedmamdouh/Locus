import type { Reading } from './types';

/**
 * CSV schema for field-test readings. Column order is the export order;
 * the dashboard and any analysis notebook rely on these names.
 */
export const READING_COLUMNS = [
  'id',
  'sessionId',
  'venueId',
  'venueName',
  'deviceModel',
  'platform',
  'timestamp',
  'secondsSinceCalibration',
  'trueFloorLabel',
  'trueFloorIndex',
  'trueFloorCenterM',
  'trueFloorHeightM',
  'pressureHpa',
  'baselinePressureHpa',
  'temperatureC',
  'baroRelAltM',
  'osRelAltM',
  'gpsLat',
  'gpsLon',
  'gpsAltM',
  'gpsAccuracyM',
  'gpsAltAccuracyM',
  'gpsRelAltM',
  'estFloorIndexBaro',
  'estFloorIndexGps',
  'sampleCount',
  'wifiScanStatus',
  'wifiApCount',
  'notes',
] as const satisfies readonly (keyof Reading)[];

const NUMERIC: ReadonlySet<keyof Reading> = new Set<keyof Reading>([
  'secondsSinceCalibration',
  'trueFloorIndex',
  'trueFloorCenterM',
  'trueFloorHeightM',
  'pressureHpa',
  'baselinePressureHpa',
  'temperatureC',
  'baroRelAltM',
  'osRelAltM',
  'gpsLat',
  'gpsLon',
  'gpsAltM',
  'gpsAccuracyM',
  'gpsAltAccuracyM',
  'gpsRelAltM',
  'estFloorIndexBaro',
  'estFloorIndexGps',
  'sampleCount',
  'wifiApCount',
]);

/** Columns added after v0.1; files without them still load (value = null). */
const OPTIONAL_COLUMNS: ReadonlySet<keyof Reading> = new Set<keyof Reading>([
  'trueFloorHeightM',
  'wifiScanStatus',
  'wifiApCount',
]);

/** Characters that make a spreadsheet treat a text cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Columns that must hold a number (never empty). */
const REQUIRED_NUMERIC: ReadonlySet<keyof Reading> = new Set<keyof Reading>([
  'secondsSinceCalibration',
  'trueFloorIndex',
  'trueFloorCenterM',
  'temperatureC',
  'sampleCount',
]);

/** Undo the formula-escaping quote added by `escapeCsvCell` to a text cell. */
export function unescapeCsvText(cell: string): string {
  return cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell;
}

/** Escape one CSV cell (RFC 4180) and neutralise spreadsheet formula injection. */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  // Neutralise spreadsheet formula injection (CSV opened in Excel/Sheets).
  if (FORMULA_START.test(s) && typeof value !== 'number') s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise readings to RFC 4180 CSV with a header row. */
export function readingsToCsv(readings: Reading[]): string {
  const lines = [READING_COLUMNS.join(',')];
  for (const r of readings) {
    lines.push(READING_COLUMNS.map((c) => escapeCsvCell(r[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Parse RFC 4180 CSV into rows of strings. Handles quotes, escaped quotes and CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export interface ParseResult {
  readings: Reading[];
  /** Human-readable problems, one per skipped row or missing column. */
  errors: string[];
}

/** Parse an exported CSV back into readings. Bad rows are skipped and reported, never thrown. */
export function csvToReadings(text: string): ParseResult {
  const rows = parseCsvRows(text);
  const errors: string[] = [];
  if (rows.length === 0) return { readings: [], errors: ['File is empty.'] };
  const header = rows[0]!.map((h) => h.trim());
  const missing = READING_COLUMNS.filter((c) => !header.includes(c) && !OPTIONAL_COLUMNS.has(c));
  if (missing.length > 0) {
    return { readings: [], errors: [`Missing columns: ${missing.join(', ')}`] };
  }
  const idx = new Map(header.map((h, i) => [h, i] as const));
  const readings: Reading[] = [];
  rows.slice(1).forEach((cells, n) => {
    const line = n + 2;
    if (cells.length !== header.length) {
      errors.push(`Row ${line}: has ${cells.length} cells, expected ${header.length}`);
      return;
    }
    const out: Record<string, unknown> = {};
    for (const col of READING_COLUMNS) {
      const at = idx.get(col);
      const cell = at === undefined ? '' : (cells[at] ?? '');
      if (NUMERIC.has(col)) {
        const raw = cell.trim();
        if (raw === '') {
          out[col] = null;
        } else {
          // Plain decimal numbers only (rejects hex like 0x1, Infinity, etc.).
          const num = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw) ? Number(raw) : NaN;
          out[col] = Number.isFinite(num) ? num : NaN;
        }
      } else {
        // Text is kept as written (no trimming); undo the formula-escaping quote.
        // Optional text columns: empty means "not recorded" (null), as when exported.
        out[col] = OPTIONAL_COLUMNS.has(col) && cell === '' ? null : unescapeCsvText(cell);
      }
    }
    const bad = READING_COLUMNS.filter(
      (c) => (NUMERIC.has(c) && Number.isNaN(out[c] as number)) || (REQUIRED_NUMERIC.has(c) && out[c] === null),
    );
    if (bad.length > 0) {
      errors.push(`Row ${line}: invalid or missing number in ${bad.join(', ')}`);
      return;
    }
    readings.push(out as unknown as Reading);
  });
  return { readings, errors };
}
