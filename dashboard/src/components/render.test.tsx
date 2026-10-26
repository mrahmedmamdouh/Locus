import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { generateSampleReadings } from '@locus/altitude-core';
import { App } from '../App';
import { analyze } from '../lib/analysis';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { VerdictCard } from './VerdictCard';
import { ReadingsTable } from './ReadingsTable';
import { DataLoader } from './DataLoader';

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
  });

  it('escapes untrusted CSV text', () => {
    const evil = [{ ...readings[0]!, notes: '<img src=x onerror=alert(1)>' }];
    const html = renderToString(<ReadingsTable readings={evil} source="baro" />);
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
