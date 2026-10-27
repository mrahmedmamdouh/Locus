import { escapeCsvCell, parseCsvRows, unescapeCsvText } from './csv';
import type { Reading } from './types';

/**
 * Wi-Fi scans captured with field-test readings (Android only: iOS does not
 * let apps scan Wi-Fi). Used to measure how well Wi-Fi fingerprints alone can
 * tell floors apart on phones without a barometer (ADR 0002).
 *
 * Privacy: network names (SSIDs) are never stored. Access points with a
 * locally administered MAC (phone hotspots, randomised addresses) are dropped,
 * because they are personal devices, not mall infrastructure.
 */

export type WifiScanStatus =
  | 'ok' // fresh scan results
  | 'stale' // OS refused a new scan (throttled); cached results returned with their age
  | 'throttled' // OS refused a new scan and no usable cached results
  | 'no-permission'
  | 'location-off'
  | 'wifi-off'
  | 'unsupported' // iOS, web, or no Wi-Fi hardware
  | 'error'
  | 'skipped'; // scanning disabled by the tester

export interface WifiAp {
  /** Access point MAC address, lower case, colon separated. */
  bssid: string;
  rssiDbm: number;
  frequencyMhz: number;
  /** Supports Wi-Fi RTT (802.11mc responder); null if the OS did not say. */
  rttResponder: boolean | null;
  /** Age of this result when the reading was taken (ms); null if unknown. */
  ageMs: number | null;
}

export interface WifiScan {
  readingId: string;
  sessionId: string;
  venueId: string;
  trueFloorIndex: number;
  scannedAt: string; // ISO 8601
  status: WifiScanStatus;
  aps: WifiAp[];
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** Normalise a BSSID to lower-case colon form, or null if it is not a MAC address. */
export function normalizeBssid(bssid: string): string | null {
  const s = bssid.trim().toLowerCase().replace(/-/g, ':');
  return MAC.test(s) && s !== '00:00:00:00:00:00' && s !== '02:00:00:00:00:00' ? s : null;
}

/** True for locally administered MACs (bit 1 of the first octet): hotspots and randomised addresses. */
export function isLocallyAdministered(bssid: string): boolean {
  const first = parseInt(bssid.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}

/**
 * Clean raw scan results: normalise BSSIDs, drop invalid entries, personal
 * hotspots and duplicates (keeping the strongest), and sort by signal.
 */
export function cleanAccessPoints(raw: WifiAp[]): { aps: WifiAp[]; dropped: number } {
  const best = new Map<string, WifiAp>();
  let dropped = 0;
  for (const ap of raw) {
    const bssid = normalizeBssid(ap.bssid);
    if (!bssid || isLocallyAdministered(bssid) || !Number.isFinite(ap.rssiDbm) || ap.rssiDbm > 0 || ap.rssiDbm < -127) {
      dropped++;
      continue;
    }
    const prev = best.get(bssid);
    if (prev && prev.rssiDbm >= ap.rssiDbm) {
      dropped++;
      continue;
    }
    if (prev) dropped++;
    best.set(bssid, { ...ap, bssid });
  }
  return { aps: [...best.values()].sort((a, b) => b.rssiDbm - a.rssiDbm), dropped };
}

// ---------------------------------------------------------------- CSV (long format: one row per access point)

export const WIFI_COLUMNS = [
  'readingId',
  'sessionId',
  'venueId',
  'trueFloorIndex',
  'scannedAt',
  'scanStatus',
  'bssid',
  'rssiDbm',
  'frequencyMhz',
  'rttResponder',
  'apAgeMs',
] as const;

/** True when a CSV is a Wi-Fi scan export. */
export function isWifiScanCsv(text: string): boolean {
  const header = parseCsvRows(text.slice(0, 4096))[0] ?? [];
  return header.includes('bssid') && header.includes('scanStatus');
}

/** One row per access point; a scan with no access points still gets one row so its status is kept. */
export function wifiScansToCsv(scans: WifiScan[]): string {
  const lines: string[] = [WIFI_COLUMNS.join(',')];
  for (const s of scans) {
    const head = [s.readingId, s.sessionId, s.venueId, s.trueFloorIndex, s.scannedAt, s.status];
    const rows = s.aps.length
      ? s.aps.map((ap) => [...head, ap.bssid, ap.rssiDbm, ap.frequencyMhz, ap.rttResponder, ap.ageMs])
      : [[...head, '', '', '', '', '']];
    for (const r of rows) lines.push(r.map(escapeCsvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const STATUSES: ReadonlySet<string> = new Set([
  'ok', 'stale', 'throttled', 'no-permission', 'location-off', 'wifi-off', 'unsupported', 'error', 'skipped',
]);
const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Parse a Wi-Fi scan CSV back into scans (grouped by readingId, in file order). */
export function csvToWifiScans(text: string): { scans: WifiScan[]; errors: string[] } {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { scans: [], errors: ['File is empty.'] };
  const header = rows[0]!.map((h) => h.trim());
  const missing = WIFI_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { scans: [], errors: [`Missing columns: ${missing.join(', ')}`] };
  const at = (cells: string[], c: (typeof WIFI_COLUMNS)[number]) => cells[header.indexOf(c)] ?? '';
  const byReading = new Map<string, WifiScan>();
  const errors: string[] = [];
  rows.slice(1).forEach((cells, n) => {
    const line = n + 2;
    if (cells.length !== header.length) {
      errors.push(`Row ${line}: has ${cells.length} cells, expected ${header.length}`);
      return;
    }
    const readingId = unescapeCsvText(at(cells, 'readingId'));
    const status = at(cells, 'scanStatus').trim();
    const floor = at(cells, 'trueFloorIndex').trim();
    if (!readingId || !STATUSES.has(status) || !DECIMAL.test(floor)) {
      errors.push(`Row ${line}: missing reading id, unknown scan status or bad floor index`);
      return;
    }
    let scan = byReading.get(readingId);
    if (!scan) {
      scan = {
        readingId,
        sessionId: unescapeCsvText(at(cells, 'sessionId')),
        venueId: unescapeCsvText(at(cells, 'venueId')),
        trueFloorIndex: Number(floor),
        scannedAt: at(cells, 'scannedAt').trim(),
        status: status as WifiScanStatus,
        aps: [],
      };
      byReading.set(readingId, scan);
    }
    const bssidRaw = at(cells, 'bssid').trim();
    if (bssidRaw === '') return; // status-only row
    const bssid = normalizeBssid(bssidRaw);
    const rssi = at(cells, 'rssiDbm').trim();
    const freq = at(cells, 'frequencyMhz').trim();
    const age = at(cells, 'apAgeMs').trim();
    const rtt = at(cells, 'rttResponder').trim().toLowerCase();
    if (!bssid || !DECIMAL.test(rssi) || !DECIMAL.test(freq) || (age !== '' && !DECIMAL.test(age))) {
      errors.push(`Row ${line}: invalid access point values`);
      return;
    }
    scan.aps.push({
      bssid,
      rssiDbm: Number(rssi),
      frequencyMhz: Number(freq),
      rttResponder: rtt === 'true' ? true : rtt === 'false' ? false : null,
      ageMs: age === '' ? null : Number(age),
    });
  });
  return { scans: [...byReading.values()], errors };
}

// ---------------------------------------------------------------- Fingerprint floor classifier

export interface FingerprintOptions {
  /** Ignore access point results older than this when the reading was taken. */
  maxApAgeMs: number;
  /** Fingerprints with fewer access points are not used. */
  minAps: number;
  /** Neighbours that vote on the floor. */
  k: number;
  /** Value used for an access point that one fingerprint sees and the other does not. */
  missingRssiDbm: number;
  /**
   * When a venue has a single session, readings taken within this many seconds
   * of the test reading are excluded from training (same spot, near-duplicate).
   */
  sameSpotSeconds: number;
}

export const DEFAULT_FINGERPRINT_OPTIONS: FingerprintOptions = {
  maxApAgeMs: 15_000,
  minAps: 3,
  k: 3,
  missingRssiDbm: -100,
  sameSpotSeconds: 120,
};

interface Fingerprint {
  readingId: string;
  sessionId: string;
  venueId: string;
  trueFloorIndex: number;
  timeMs: number;
  rssi: Map<string, number>;
}

function toFingerprint(scan: WifiScan, opts: FingerprintOptions): Fingerprint | null {
  if (scan.status !== 'ok' && scan.status !== 'stale') return null;
  const rssi = new Map<string, number>();
  for (const ap of scan.aps) {
    if (ap.ageMs !== null && ap.ageMs > opts.maxApAgeMs) continue;
    rssi.set(ap.bssid, ap.rssiDbm);
  }
  if (rssi.size < opts.minAps) return null;
  return {
    readingId: scan.readingId,
    sessionId: scan.sessionId,
    venueId: scan.venueId,
    trueFloorIndex: scan.trueFloorIndex,
    timeMs: Date.parse(scan.scannedAt),
    rssi,
  };
}

/** Root-mean-square signal difference over the union of access points; Infinity if none are shared. */
export function fingerprintDistance(a: Map<string, number>, b: Map<string, number>, missingRssiDbm = -100): number {
  let shared = 0;
  let sum = 0;
  let n = 0;
  for (const [bssid, ra] of a) {
    const rb = b.get(bssid);
    if (rb !== undefined) shared++;
    sum += (ra - (rb ?? missingRssiDbm)) ** 2;
    n++;
  }
  for (const [bssid, rb] of b) {
    if (a.has(bssid)) continue;
    sum += (rb - missingRssiDbm) ** 2;
    n++;
  }
  return shared === 0 || n === 0 ? Infinity : Math.sqrt(sum / n);
}

export interface WifiPrediction {
  readingId: string;
  venueId: string;
  trueFloorIndex: number;
  predictedFloorIndex: number | null;
  /** Share of the neighbour vote won by the predicted floor (0–1). */
  confidence: number | null;
  /** 'session' = trained on other sessions; 'time' = same session, other spots. */
  holdout: 'session' | 'time';
}

export interface WifiEvaluation {
  predictions: WifiPrediction[];
  /** Scans that could not be evaluated, by reason. */
  skipped: { notOk: number; tooFewAps: number; noTrainingData: number };
  evaluated: number;
  accuracy: number | null;
  byVenue: { venueId: string; evaluated: number; accuracy: number | null }[];
}

/**
 * Leave-out evaluation of a k-nearest-neighbour Wi-Fi floor classifier, per venue.
 * If a venue has two or more sessions, each reading is predicted from the OTHER
 * sessions only (closest to real use: a new visitor). With one session, readings
 * within `sameSpotSeconds` of the test reading are excluded instead.
 */
export function evaluateWifiFloors(
  scans: WifiScan[],
  options: Partial<FingerprintOptions> = {},
): WifiEvaluation {
  const opts = { ...DEFAULT_FINGERPRINT_OPTIONS, ...options };
  const skipped = { notOk: 0, tooFewAps: 0, noTrainingData: 0 };
  const fps: Fingerprint[] = [];
  for (const s of scans) {
    if (s.status !== 'ok' && s.status !== 'stale') {
      skipped.notOk++;
      continue;
    }
    const fp = toFingerprint(s, opts);
    if (fp) fps.push(fp);
    else skipped.tooFewAps++;
  }
  const byVenue = new Map<string, Fingerprint[]>();
  for (const fp of fps) byVenue.set(fp.venueId, [...(byVenue.get(fp.venueId) ?? []), fp]);

  const predictions: WifiPrediction[] = [];
  for (const [, venueFps] of byVenue) {
    const multiSession = new Set(venueFps.map((f) => f.sessionId)).size >= 2;
    for (const test of venueFps) {
      const train = venueFps.filter((f) =>
        f === test
          ? false
          : multiSession
            ? f.sessionId !== test.sessionId
            : !(Number.isFinite(f.timeMs) && Number.isFinite(test.timeMs)) ||
              Math.abs(f.timeMs - test.timeMs) > opts.sameSpotSeconds * 1000,
      );
      const neighbours = train
        .map((f) => ({ f, d: fingerprintDistance(test.rssi, f.rssi, opts.missingRssiDbm) }))
        .filter((x) => Number.isFinite(x.d))
        .sort((a, b) => a.d - b.d)
        .slice(0, opts.k);
      if (neighbours.length === 0) {
        skipped.noTrainingData++;
        continue;
      }
      const votes = new Map<number, number>();
      let total = 0;
      for (const { f, d } of neighbours) {
        const w = 1 / (d + 1e-6);
        votes.set(f.trueFloorIndex, (votes.get(f.trueFloorIndex) ?? 0) + w);
        total += w;
      }
      let bestFloor: number | null = null;
      let bestVote = -1;
      for (const [floor, v] of votes) {
        if (v > bestVote) {
          bestVote = v;
          bestFloor = floor;
        }
      }
      predictions.push({
        readingId: test.readingId,
        venueId: test.venueId,
        trueFloorIndex: test.trueFloorIndex,
        predictedFloorIndex: bestFloor,
        confidence: total > 0 ? bestVote / total : null,
        holdout: multiSession ? 'session' : 'time',
      });
    }
  }
  const acc = (ps: WifiPrediction[]) =>
    ps.length ? ps.filter((p) => p.predictedFloorIndex === p.trueFloorIndex).length / ps.length : null;
  const venues = [...new Set(predictions.map((p) => p.venueId))].sort();
  return {
    predictions,
    skipped,
    evaluated: predictions.length,
    accuracy: acc(predictions),
    byVenue: venues.map((venueId) => {
      const ps = predictions.filter((p) => p.venueId === venueId);
      return { venueId, evaluated: ps.length, accuracy: acc(ps) };
    }),
  };
}

/**
 * Barometer floor accuracy on exactly the readings Wi-Fi could be evaluated on,
 * so the two numbers compare like with like.
 */
export function barometerAccuracyOn(readings: Reading[], predictions: WifiPrediction[]): number | null {
  const ids = new Set(predictions.map((p) => p.readingId));
  const same = readings.filter((r) => ids.has(r.id) && r.estFloorIndexBaro !== null);
  return same.length ? same.filter((r) => r.estFloorIndexBaro === r.trueFloorIndex).length / same.length : null;
}
