import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FINGERPRINT_OPTIONS,
  deviceChecksToCsv,
  generateSampleReadings,
  generateSampleWifiScans,
  readingsToCsv,
  wifiScansToCsv,
} from '@locus/altitude-core';
import type { WifiPrediction, WifiScan } from '@locus/altitude-core';
import { generateSampleDeviceChecks } from './coverage';
import { EMPTY_DATASET, addCsvText, applyScanExclusions, detectFileKind, mergeWifiScans } from './data';
import {
  DEFAULT_WIFI_SETTINGS,
  WIFI_PARSE,
  analyzeWifi,
  confidenceFilter,
  confusionMatrix,
  scanHealth,
  toFingerprintOptions,
} from './wifi';

const readings = generateSampleReadings();
const scans = generateSampleWifiScans(readings);

const pred = (over: Partial<WifiPrediction>): WifiPrediction => ({
  readingId: 'x',
  venueId: 'v',
  trueFloorIndex: 0,
  predictedFloorIndex: 0,
  confidence: 1,
  holdout: 'session',
  ...over,
});

describe('file routing', () => {
  const rCsv = readingsToCsv(readings.slice(0, 3));
  const dCsv = deviceChecksToCsv(generateSampleDeviceChecks().slice(0, 2));
  const wCsv = wifiScansToCsv(scans.slice(0, 4));

  it('detects the three kinds', () => {
    expect(detectFileKind(rCsv)).toBe('readings');
    expect(detectFileKind(dCsv)).toBe('device-checks');
    expect(detectFileKind(wCsv)).toBe('wifi-scans');
  });

  it('routes each file to its own list with a kind tag', () => {
    let ds = addCsvText(EMPTY_DATASET, 'r.csv', rCsv);
    ds = addCsvText(ds, 'd.csv', dCsv);
    ds = addCsvText(ds, 'w.csv', wCsv);
    expect(ds.readings).toHaveLength(3);
    expect(ds.deviceChecks).toHaveLength(2);
    expect(ds.wifiScans).toHaveLength(4);
    expect(ds.files.map((f) => f.kind)).toEqual(['readings', 'device-checks', 'wifi-scans']);
    expect(ds.wifiScans[0]!.aps.length).toBe(scans[0]!.aps.length);
  });

  it('reports Wi-Fi parse errors per file without failing the load', () => {
    const broken = wCsv.trimEnd() + '\r\nonly,three,cells\r\n';
    const ds = addCsvText(EMPTY_DATASET, 'w.csv', broken);
    expect(ds.wifiScans).toHaveLength(4);
    expect(ds.files[0]!.errors.length).toBe(1);
  });
});

describe('mergeWifiScans', () => {
  it('de-duplicates by readingId across files, first wins', () => {
    const a = scans.slice(0, 3);
    const b = [{ ...scans[2]!, status: 'error' as const }, scans[3]!];
    const m = mergeWifiScans(a, b);
    expect(m.wifiScans.map((s) => s.readingId)).toEqual(scans.slice(0, 4).map((s) => s.readingId));
    expect(m.added).toBe(1);
    expect(m.duplicates).toBe(1);
    expect(m.wifiScans[2]!.status).toBe('ok');
  });

  it('re-uploading the same Wi-Fi file adds nothing', () => {
    const csv = wifiScansToCsv(scans.slice(0, 5));
    const ds = addCsvText(addCsvText(EMPTY_DATASET, 'a.csv', csv), 'a.csv', csv);
    expect(ds.wifiScans).toHaveLength(5);
    expect(ds.files[1]!.duplicates).toBe(5);
  });
});

describe('applyScanExclusions', () => {
  const rs = [
    { ...readings[0]!, id: 'a', notes: 'DEMO run' },
    { ...readings[0]!, id: 'b', notes: 'synthetic' },
    { ...readings[0]!, id: 'c', notes: '' },
  ];
  const ss: WifiScan[] = ['a', 'b', 'c', 'orphan'].map((readingId) => ({ ...scans[0]!, readingId }));
  const ids = (xs: WifiScan[]) => xs.map((s) => s.readingId);

  it('drops scans whose reading is excluded, keeps orphans', () => {
    expect(ids(applyScanExclusions(ss, rs, { excludeDemo: true, excludeSynthetic: false }))).toEqual(['b', 'c', 'orphan']);
    expect(ids(applyScanExclusions(ss, rs, { excludeDemo: true, excludeSynthetic: true }))).toEqual(['c', 'orphan']);
    expect(applyScanExclusions(ss, rs, { excludeDemo: false, excludeSynthetic: false })).toHaveLength(4);
  });
});

describe('analyzeWifi on synthetic data', () => {
  it('sample generation fills wifiApCount on the same readings', () => {
    const android = readings.filter((r) => r.platform === 'android');
    expect(android.every((r) => (r.wifiApCount ?? 0) > 0)).toBe(true);
    expect(scans).toHaveLength(android.length);
  });

  it('settings default to the library options', () => {
    expect(toFingerprintOptions(DEFAULT_WIFI_SETTINGS)).toEqual({
      k: DEFAULT_FINGERPRINT_OPTIONS.k,
      maxApAgeMs: DEFAULT_FINGERPRINT_OPTIONS.maxApAgeMs,
      minAps: DEFAULT_FINGERPRINT_OPTIONS.minAps,
    });
    expect(WIFI_PARSE.k('2.5')).toBeNull();
    expect(WIFI_PARSE.k('5')).toBe(5);
  });

  it('headline numbers', () => {
    const a = analyzeWifi(scans, readings, DEFAULT_WIFI_SETTINGS);
    expect(a.overall.n).toBe(240);
    expect(a.overall.wifiAccuracy).toBeCloseTo(239 / 240, 6);
    expect(a.overall.baroAccuracy).toBeCloseTo(236 / 240, 6);
    expect(a.noBarometer).toEqual({ n: 0, wifiAccuracy: null });
    expect(a.holdout).toEqual({ session: 240, time: 0 });
    expect(a.byVenue.map((v) => [v.venueId, v.evaluated])).toEqual([
      ['demo-cairo', 144],
      ['demo-muscat', 96],
    ]);
    expect(a.byVenue[0]!.venueName).toBe('Demo Mall Cairo (synthetic)');
  });

  it('counts phones without a barometer (baroRelAltM null), Wi-Fi only', () => {
    const noBaro = readings.map((r) => (r.deviceModel === 'Galaxy A54' ? { ...r, baroRelAltM: null, estFloorIndexBaro: null } : r));
    const a = analyzeWifi(scans, noBaro, DEFAULT_WIFI_SETTINGS);
    expect(a.noBarometer.n).toBe(120);
    expect(a.noBarometer.wifiAccuracy).not.toBeNull();
  });

  it('re-runs with different settings', () => {
    const strict = analyzeWifi(scans, readings, { ...DEFAULT_WIFI_SETTINGS, minAps: 100 });
    expect(strict.overall.n).toBe(0);
    expect(strict.evaluation.skipped.tooFewAps).toBe(240);
    const aged = analyzeWifi(scans, readings, { ...DEFAULT_WIFI_SETTINGS, maxApAgeS: 0 });
    expect(aged.overall.n).toBeLessThan(240);
  });
});

describe('confusionMatrix', () => {
  const ps = [
    pred({ trueFloorIndex: 0, predictedFloorIndex: 0 }),
    pred({ trueFloorIndex: 0, predictedFloorIndex: 1 }),
    pred({ trueFloorIndex: 1, predictedFloorIndex: 1 }),
    pred({ trueFloorIndex: 2, predictedFloorIndex: 1, venueId: 'w' }),
    pred({ trueFloorIndex: 1, predictedFloorIndex: null }),
  ];
  it('counts true × predicted per venue', () => {
    const m = confusionMatrix(ps, 'v');
    expect(m.floors).toEqual([0, 1]);
    expect(m.counts).toEqual([
      [1, 1],
      [0, 1],
    ]);
    expect(m.rowTotals).toEqual([2, 1]);
    expect(m.total).toBe(3);
  });
  it('all venues uses the union of floors', () => {
    const m = confusionMatrix(ps);
    expect(m.floors).toEqual([0, 1, 2]);
    expect(m.counts[2]).toEqual([0, 1, 0]);
  });
  it('synthetic diagonal holds almost all readings', () => {
    const a = analyzeWifi(scans, readings, DEFAULT_WIFI_SETTINGS);
    const m = confusionMatrix(a.evaluation.predictions, 'demo-muscat');
    const diag = m.floors.reduce((s, _, i) => s + m.counts[i]![i]!, 0);
    expect(m.total).toBe(96);
    expect(diag).toBe(95);
  });
});

describe('confidenceFilter', () => {
  it('keeps predictions with confidence ≥ threshold', () => {
    const ps = [
      pred({ confidence: 0.9 }),
      pred({ confidence: 0.7, predictedFloorIndex: 1 }),
      pred({ confidence: 0.69 }),
      pred({ confidence: null }),
    ];
    const c = confidenceFilter(ps, 0.7);
    expect(c.kept).toBe(2);
    expect(c.keptShare).toBe(0.5);
    expect(c.accuracy).toBe(0.5);
  });
  it('empty input', () => {
    expect(confidenceFilter([])).toMatchObject({ kept: 0, keptShare: null, accuracy: null });
  });
  it('synthetic: confident predictions are all right', () => {
    const a = analyzeWifi(scans, readings, DEFAULT_WIFI_SETTINGS);
    const c = confidenceFilter(a.evaluation.predictions);
    expect(c.kept).toBe(236);
    expect(c.accuracy).toBe(1);
  });
});

describe('scanHealth', () => {
  it('summarises statuses, APs, RTT and age', () => {
    const h = scanHealth(scans);
    expect(h.scans).toBe(240);
    expect(h.byStatus.find((s) => s.status === 'ok')!.share).toBe(1);
    expect(h.rttShare).toBe(0);
    expect(h.medianAps).toBeGreaterThan(3);
    expect(h.medianApAgeS).toBeGreaterThan(0);
    expect(h.showThrottleTip).toBe(false);
  });
  it('shows the throttling tip above 20% throttled or stale', () => {
    const mix: WifiScan[] = [
      ...scans.slice(0, 7),
      { ...scans[7]!, status: 'stale' },
      { ...scans[8]!, status: 'throttled', aps: [] },
      { ...scans[9]!, status: 'throttled', aps: [] },
    ];
    const h = scanHealth(mix);
    expect(h.throttledShare).toBeCloseTo(0.3);
    expect(h.showThrottleTip).toBe(true);
    expect(scanHealth(mix.slice(0, 9)).showThrottleTip).toBe(true); // 2/9 = 22%
    expect(scanHealth(mix.slice(0, 8)).showThrottleTip).toBe(false); // 1/8
  });
});
