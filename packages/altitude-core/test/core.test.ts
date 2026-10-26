import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATE,
  buildUniformFloors,
  classifyFloor,
  csvToReadings,
  driftByMinutes,
  evaluateGate,
  generateSampleReadings,
  haversineM,
  isInsideGeofence3D,
  metersPerHpa,
  median,
  parseCsvRows,
  percentile,
  readingsToCsv,
  relativeAltitudeFromPressure,
  summarize,
  typicalFloorHeightM,
  updateDwell,
  validateFloors,
  type Reading,
} from '../src';

describe('pressure', () => {
  it('returns 0 m at the baseline pressure', () => {
    expect(relativeAltitudeFromPressure(1010, 1010)).toBe(0);
  });

  it('gives about 8.6 m per hPa near sea level at 24 °C', () => {
    expect(relativeAltitudeFromPressure(1009, 1010, 24)).toBeCloseTo(8.6, 1);
    expect(metersPerHpa(1010, 24)).toBeCloseTo(8.6, 1);
  });

  it('is positive going up (lower pressure) and negative going down', () => {
    expect(relativeAltitudeFromPressure(1009.5, 1010)).toBeGreaterThan(0);
    expect(relativeAltitudeFromPressure(1010.5, 1010)).toBeLessThan(0);
  });

  it('rejects invalid pressures', () => {
    expect(() => relativeAltitudeFromPressure(0, 1010)).toThrow(RangeError);
    expect(() => relativeAltitudeFromPressure(NaN, 1010)).toThrow(RangeError);
  });
});

describe('floors', () => {
  const floors = buildUniformFloors(1, 2, 5);

  it('builds labelled, centred bands', () => {
    expect(floors.map((f) => f.label)).toEqual(['B1', 'G', '1', '2']);
    expect(floors[1]).toMatchObject({ index: 0, zMinM: -2.5, zMaxM: 2.5 });
    expect(validateFloors(floors)).toEqual([]);
    expect(typicalFloorHeightM(floors)).toBe(5);
  });

  it('classifies altitudes to the containing band, or the nearest one', () => {
    expect(classifyFloor(0.4, floors)?.label).toBe('G');
    expect(classifyFloor(5.2, floors)?.label).toBe('1');
    expect(classifyFloor(-4.9, floors)?.label).toBe('B1');
    expect(classifyFloor(11, floors)?.label).toBe('2'); // just above the top band
    expect(classifyFloor(40, floors)).toBeNull(); // far beyond: drift, not "top floor"
    expect(classifyFloor(-100, floors)).toBeNull();
    expect(classifyFloor(NaN, floors)).toBeNull();
  });

  it('flags overlapping floors', () => {
    const bad = [
      { label: 'G', index: 0, zMinM: -2, zMaxM: 3 },
      { label: '1', index: 1, zMinM: 2, zMaxM: 7 },
    ];
    expect(validateFloors(bad).join(' ')).toMatch(/overlap/);
  });
});

describe('3D geofence', () => {
  const fence = { id: 'shop', lat: 23.588, lon: 58.383, radiusM: 30, zMinM: 4, zMaxM: 9 };

  it('measures known distances', () => {
    // 0.001° latitude ≈ 111 m
    expect(haversineM(23.588, 58.383, 23.589, 58.383)).toBeCloseTo(111.2, 0);
  });

  it('needs both the radius and the altitude band', () => {
    expect(isInsideGeofence3D({ lat: 23.588, lon: 58.3831, relAltM: 5 }, fence)).toBe(true);
    expect(isInsideGeofence3D({ lat: 23.588, lon: 58.3831, relAltM: 0 }, fence)).toBe(false);
    expect(isInsideGeofence3D({ lat: 23.59, lon: 58.383, relAltM: 5 }, fence)).toBe(false);
  });

  it('fires only after the dwell time', () => {
    let s = { fenceId: 'shop', enteredAtMs: null as number | null };
    let r = updateDwell(s, true, 0, 60_000);
    expect(r.fired).toBe(false);
    s = r.state;
    r = updateDwell(s, true, 30_000, 60_000);
    expect(r.fired).toBe(false);
    r = updateDwell(r.state, true, 60_000, 60_000);
    expect(r.fired).toBe(true);
    r = updateDwell(r.state, false, 61_000, 60_000);
    expect(r.state.enteredAtMs).toBeNull();
  });
});

describe('smoothing', () => {
  it('computes median and percentiles', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    expect(percentile([0, 10], 90)).toBe(9);
  });
});

describe('CSV round trip', () => {
  it('serialises and parses readings without loss', () => {
    const readings = generateSampleReadings(1, 2);
    const parsed = csvToReadings(readingsToCsv(readings));
    expect(parsed.errors).toEqual([]);
    expect(parsed.readings).toEqual(readings);
  });

  it('handles quotes, commas, new lines and formula injection in notes', () => {
    const [r] = generateSampleReadings(2, 1) as [Reading];
    const tricky = { ...r, notes: 'Near "Zara", 2nd\nescalator', venueName: '=HYPERLINK("x")' };
    const csv = readingsToCsv([tricky]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const back = csvToReadings(csv).readings[0]!;
    expect(back.notes).toBe(tricky.notes);
    expect(back.venueName).toBe(tricky.venueName);
  });

  it('reports bad rows instead of throwing', () => {
    const csv = readingsToCsv(generateSampleReadings(3, 1)).replace(/\r\n([^,]*),/, '\r\n$1,') + 'only,one,row\r\n';
    const result = csvToReadings(csv);
    expect(result.errors.length).toBe(1);
    expect(result.readings.length).toBeGreaterThan(0);
  });

  it('rejects rows with the wrong number of cells', () => {
    const csv = readingsToCsv(generateSampleReadings(3, 1));
    const lines = csv.trimEnd().split('\r\n');
    lines[1] = lines[1]!.split(',').slice(0, -1).join(',');
    const result = csvToReadings(lines.join('\r\n'));
    expect(result.errors[0]).toMatch(/Row 2: has/);
  });

  it('round-trips text starting with a tab and keeps leading spaces', () => {
    const [r] = generateSampleReadings(5, 1) as [Reading];
    const odd = { ...r, notes: '\t=cmd', venueName: '  Mall' };
    const back = csvToReadings(readingsToCsv([odd])).readings[0]!;
    expect(back.notes).toBe('\t=cmd');
    expect(back.venueName).toBe('  Mall');
  });

  it('rejects hex and other non-decimal numbers', () => {
    const csv = readingsToCsv(generateSampleReadings(6, 1));
    const lines = csv.trimEnd().split('\r\n');
    const cells = lines[1]!.split(',');
    cells[7] = '0x1A'; // secondsSinceCalibration
    lines[1] = cells.join(',');
    expect(csvToReadings(lines.join('\r\n')).errors[0]).toMatch(/secondsSinceCalibration/);
  });

  it('still loads exports made before trueFloorHeightM existed', () => {
    const csv = readingsToCsv(generateSampleReadings(7, 1));
    const rows = csv.trimEnd().split('\r\n').map((l) => l.split(','));
    const col = rows[0]!.indexOf('trueFloorHeightM');
    const old = rows.map((r) => r.filter((_, i) => i !== col).join(',')).join('\r\n');
    const result = csvToReadings(old);
    expect(result.errors).toEqual([]);
    expect(result.readings[0]!.trueFloorHeightM).toBeNull();
  });

  it('reports missing columns', () => {
    expect(csvToReadings('a,b\r\n1,2').errors[0]).toMatch(/Missing columns/);
  });

  it('parses quoted CRLF rows', () => {
    expect(parseCsvRows('a,"b\r\nc"\r\n1,2\r\n')).toEqual([
      ['a', 'b\r\nc'],
      ['1', '2'],
    ]);
  });
});

describe('statistics and gate', () => {
  const readings = generateSampleReadings(42, 12);

  it('shows the barometer beating GPS on synthetic data', () => {
    const baro = summarize(readings, 'baro', 4.5);
    const gps = summarize(readings, 'gps', 4.5);
    expect(baro.n).toBe(readings.length);
    expect(baro.floorAccuracy!).toBeGreaterThan(0.85);
    expect(gps.floorAccuracy!).toBeLessThan(baro.floorAccuracy!);
    expect(baro.p90AbsErrorM!).toBeLessThan(gps.p90AbsErrorM!);
  });

  it('passes the gate with good synthetic barometer data and fails with GPS', () => {
    expect(evaluateGate(readings, 4.5, 'baro').verdict).toBe('pass');
    expect(evaluateGate(readings, 4.5, 'gps').verdict).toBe('fail');
  });

  it('handles very large datasets without stack overflow', () => {
    const big: Reading[] = [];
    while (big.length < 250_000) big.push(...readings);
    expect(summarize(big, 'baro', 4.5).maxAbsErrorM).toBeGreaterThan(0);
  });

  it('does not count a venue that has no readings for the evaluated source', () => {
    // Reviewer probe: many readings in one venue + one GPS-only row elsewhere must not pass.
    const cairo = readings.filter((r) => r.venueId === 'demo-cairo');
    const extra = { ...readings.find((r) => r.venueId === 'demo-muscat')!, baroRelAltM: null, id: 'x1' };
    const result = evaluateGate([...cairo, ...cairo.map((r) => ({ ...r, id: r.id + 'b' })), extra], 4.5, 'baro');
    expect(result.verdict).toBe('insufficient-data');
    expect(result.venues).toBe(1);
  });

  it('judges each reading against its own venue floor height', () => {
    // The same 2.4 m error is within half of a 5 m floor but not of a 4 m floor.
    const base = readings[0]!;
    const a = { ...base, id: 'a', baroRelAltM: base.trueFloorCenterM + 2.4, trueFloorHeightM: 5 };
    const b = { ...base, id: 'b', baroRelAltM: base.trueFloorCenterM + 2.4, trueFloorHeightM: 4 };
    expect(summarize([a], 'baro', 4.5).withinHalfFloor).toBe(1);
    expect(summarize([b], 'baro', 4.5).withinHalfFloor).toBe(0);
    // Without a stored height the fallback is used.
    expect(summarize([{ ...b, trueFloorHeightM: null }], 'baro', 6).withinHalfFloor).toBe(1);
  });

  it('gives the iOS altimeter a floor accuracy', () => {
    const ios = summarize(readings, 'os', 4.5);
    expect(ios.n).toBeGreaterThan(0);
    expect(ios.floorAccuracy).not.toBeNull();
  });

  it('refuses a verdict on too little data', () => {
    const result = evaluateGate(readings.slice(0, 10), 4.5, 'baro', DEFAULT_GATE);
    expect(result.verdict).toBe('insufficient-data');
  });

  it('buckets drift by minutes since calibration', () => {
    const drift = driftByMinutes(readings, 'baro', 5);
    expect(drift.length).toBeGreaterThan(1);
    expect(drift[0]!.minutesFrom).toBe(0);
  });
});
