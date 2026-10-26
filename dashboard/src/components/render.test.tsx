import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { generateSampleReadings } from '@locus/altitude-core';
import { App } from '../App';
import { analyze } from '../lib/analysis';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { VerdictCard } from './VerdictCard';
import { ReadingsTable } from './ReadingsTable';
import { DataLoader } from './DataLoader';
import { SettingsPanel } from './SettingsPanel';
import { SourceComparison } from './SourceComparison';

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
        files={[{ name: 'a.csv', parsed: 1, added: 1, duplicates: 0, errors: ['Row 2: bad'], synthetic: false }]}
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
});
