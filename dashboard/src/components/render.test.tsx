import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { generateSampleReadings, generateSampleWifiScans } from '@locus/altitude-core';
import { App } from '../App';
import { analyze } from '../lib/analysis';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { VerdictCard } from './VerdictCard';
import { ReadingsTable } from './ReadingsTable';
import { DataLoader } from './DataLoader';
import { SettingsPanel } from './SettingsPanel';
import { SourceComparison } from './SourceComparison';
import { SensorCoverage } from './SensorCoverage';
import { generateSampleDeviceChecks } from '../lib/coverage';
import { WifiFloorTest } from './WifiFloorTest';

// Smoke tests: components render with real analysis output (no DOM needed).
describe('render smoke tests', () => {
  const readings = generateSampleReadings();
  const a = analyze(readings, DEFAULT_SETTINGS);

  it('renders the empty app with the explain panel', () => {
    const html = renderToString(<App />);
    expect(html).toContain('No readings loaded');
    expect(html).toContain('field-test-protocol.md');
  });

  it('verdict card shows the verdict as text, not only colour', () => {
    const html = renderToString(<VerdictCard gate={a.gate} settings={DEFAULT_SETTINGS} synthetic />);
    expect(html).toMatch(/PASS|FAIL|INSUFFICIENT DATA/);
    expect(html).toContain('SYNTHETIC');
    expect(html).toMatch(/\d\.\d\d floors/);
  });

  it('settings show the fallback label, fallback count and per-venue minimum', () => {
    const html = renderToString(
      <SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} loadedReadings={120} fallbackReadings={40} />,
    );
    expect(html).toContain('Fallback floor height (m) — used only for files without per-floor heights');
    expect(html).toContain('40 of 120 loaded readings use the fallback.');
    expect(html).toContain('Min readings per venue');
    expect(html).not.toContain('cannot pass');
  });

  it('source comparison shows p90 in floors', () => {
    const html = renderToString(<SourceComparison bySource={a.bySource} gateSource="baro" floorHeightM={4.5} />);
    expect(html).toMatch(/\d\.\d\d floors/);
  });

  it('readings table marks iOS OS rows correct or wrong, not "No estimate"', () => {
    const ios = readings.filter((x) => x.osRelAltM !== null).slice(0, 5);
    const html = renderToString(<ReadingsTable readings={ios} source="os" floorHeightM={4.5} />);
    expect(html).toMatch(/Correct|Wrong/);
    expect(html).not.toContain('status-na');
  });

  it('escapes untrusted CSV text', () => {
    const evil = [{ ...readings[0]!, notes: '<img src=x onerror=alert(1)>' }];
    const html = renderToString(<ReadingsTable readings={evil} source="baro" floorHeightM={4.5} />);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('lists per-file parse errors', () => {
    const html = renderToString(
      <DataLoader
        files={[{ name: 'a.csv', kind: 'readings', parsed: 1, added: 1, duplicates: 0, errors: ['Row 2: bad'], synthetic: false }]}
        total={1}
        included={1}
        exclusion={{ excludeDemo: true, excludeSynthetic: false }}
        onFiles={() => {}}
        onSample={() => {}}
        onClear={() => {}}
        onExclusion={() => {}}
      />,
    );
    expect(html).toContain('Row 2: bad');
  });

  it('lists the detected kind of each file', () => {
    const html = renderToString(
      <DataLoader
        files={[{ name: 'd.csv', kind: 'device-checks', parsed: 2, added: 2, duplicates: 0, errors: [], synthetic: false }]}
        total={0}
        included={0}
        totalChecks={2}
        includedChecks={2}
        exclusion={{ excludeDemo: true, excludeSynthetic: false }}
        onFiles={() => {}}
        onSample={() => {}}
        onClear={() => {}}
        onExclusion={() => {}}
      />,
    );
    expect(html).toContain('Device checks');
    expect(html).toMatch(/2<\/strong> of 2 device checks/);
  });

  it('sensor coverage shows a hint without device checks', () => {
    const html = renderToString(<SensorCoverage checks={[]} readings={readings} />);
    expect(html).toContain('Export device checks from the app to see sensor coverage');
    expect(html).toContain('Export device checks');
    expect(renderToString(<App />)).toContain('Export device checks from the app to see sensor coverage');
  });

  it('sensor coverage renders headline, tables, status text and cross-check', () => {
    const checks = generateSampleDeviceChecks();
    const html = renderToString(<SensorCoverage checks={checks} readings={readings} synthetic />);
    expect(html).toMatch(/4 of 11 phones \(36%\)/);
    expect(html).toContain('latest check');
    expect(html).toContain('tag-synthetic');
    expect(html).toContain('By platform');
    expect(html).toContain('By brand');
    expect(html).toContain('Blocked by permission');
    expect(html).toMatch(/status-bad[^>]*>.*?No</);
    expect(html).toContain('Galaxy A54'); // in readings, no device check
    expect(html).toContain('Tecno Spark 20'); // device check, no readings
    expect(html).toContain('2026-10-13');
  });

  it('sensor coverage escapes untrusted CSV text', () => {
    const [c] = generateSampleDeviceChecks();
    const html = renderToString(
      <SensorCoverage checks={[{ ...c!, deviceModel: '<img src=x onerror=alert(1)>' }]} readings={[]} />,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('Wi-Fi floor test shows a hint without scans', () => {
    expect(renderToString(<WifiFloorTest scans={[]} readings={readings} />)).toContain('Android builds of the app export Wi-Fi scans');
    expect(renderToString(<App />)).toContain('Android builds of the app export Wi-Fi scans');
  });

  it('Wi-Fi floor test renders headline, holdout, tables and confidence view', () => {
    const rs = generateSampleReadings();
    const scans = generateSampleWifiScans(rs);
    const html = renderToString(<WifiFloorTest scans={scans} readings={rs} synthetic />).replace(/<!-- -->/g, '');
    expect(html).toContain('Wi-Fi alone picked the right floor in 99.6% of 240 readings');
    expect(html).toContain('Barometer on the same readings: 98.3%');
    expect(html).toContain('Phones without a barometer');
    expect(html).toContain('so the score reflects a new visitor');
    expect(html).toContain('240 predictions used other sessions; 0 used the time-gap holdout');
    expect(html).toContain('tag-synthetic');
    expect(html).toContain('Demo Mall Cairo (synthetic)');
    expect(html).toContain('True ↓ / Predicted →');
    expect(html).toContain('Stale (cached results)');
    expect(html).toContain('Skipped: too few access points');
    expect(html).toMatch(/keeping 98.3% of readings \(236 of 240\)/);
    expect(html).toContain('k neighbours');
    expect(html).not.toContain('Wi-Fi scan throttling');
  });

  it('Wi-Fi floor test shows the throttling tip and escapes venue ids', () => {
    const rs = generateSampleReadings();
    const scans = generateSampleWifiScans(rs).map((s, i) => ({
      ...s,
      venueId: '<img src=x onerror=alert(1)>',
      status: i % 3 === 0 ? ('throttled' as const) : s.status,
    }));
    const html = renderToString(<WifiFloorTest scans={scans} readings={[]} />);
    expect(html).toContain('Wi-Fi scan throttling');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
