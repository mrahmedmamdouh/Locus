import { useCallback, useMemo, useState } from 'react';
import { generateSampleReadings } from '@locus/altitude-core';
import { analyze, type Analysis } from './lib/analysis';
import {
  DEFAULT_EXCLUSION,
  EMPTY_DATASET,
  addCsvText,
  addSource,
  applyExclusions,
  type Dataset,
  type ExclusionOptions,
} from './lib/data';
import { DEFAULT_SETTINGS, type Settings } from './lib/settings';
import { DataLoader, type LoadedFile } from './components/DataLoader';
import { SettingsPanel } from './components/SettingsPanel';
import { VerdictCard } from './components/VerdictCard';
import { SourceComparison } from './components/SourceComparison';
import { Breakdowns } from './components/Breakdowns';
import { DriftChart } from './components/DriftChart';
import { ErrorScatter } from './components/ErrorScatter';
import { ReadingsTable } from './components/ReadingsTable';
import { IconAlert } from './components/common';

const PROTOCOL_URL = 'https://github.com/mrahmedmamdouh/Locus/blob/main/docs/field-test-protocol.md';
const SAMPLE_NAME = 'Synthetic sample (generated, not field data)';

function ExplainPanel() {
  return (
    <section className="card explain" aria-labelledby="explain-title">
      <h2 id="explain-title">What this test decides</h2>
      <p>
        Locus wants to target offers to the shop a customer is actually in, which in a multi-storey mall means
        knowing the floor. Testers stand on a known floor, the phone records barometer, GPS and (on iPhone) the
        OS altitude, and we compare each estimate with the true floor height relative to the entrance where the
        phone was calibrated.
      </p>
      <p>
        With the default criteria, the &ldquo;floors separable&rdquo; gate passes only when, across at least 200
        readings in at least two malls, the chosen source puts the phone on the right floor at least 85% of the
        time and 9 in 10 readings are within half a floor of the truth. Fail means floor-level targeting is not yet reliable; insufficient data
        means collect more before deciding.
      </p>
      <p>
        <a href={PROTOCOL_URL} target="_blank" rel="noopener noreferrer">
          Read the field-test protocol
        </a>
      </p>
    </section>
  );
}

function EmptyState({ onSample }: { onSample: () => void }) {
  return (
    <section className="card empty" aria-label="No data loaded">
      <h2>No readings loaded</h2>
      <p>Upload one or more CSV exports from the Locus app, or explore with synthetic demo data.</p>
      <button type="button" className="btn btn-primary" onClick={onSample}>
        Load synthetic sample data
      </button>
    </section>
  );
}

function safeAnalyze(readings: Parameters<typeof analyze>[0], settings: Settings): Analysis | Error {
  try {
    return analyze(readings, settings);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

export function App() {
  const [dataset, setDataset] = useState<Dataset>(EMPTY_DATASET);
  const [exclusion, setExclusion] = useState<ExclusionOptions>(DEFAULT_EXCLUSION);
  const [settings, setSettings] = useState<Settings>(() => structuredClone(DEFAULT_SETTINGS));

  const included = useMemo(() => applyExclusions(dataset.readings, exclusion), [dataset.readings, exclusion]);
  const result = useMemo(() => (included.length ? safeAnalyze(included, settings) : null), [included, settings]);

  const onFiles = useCallback((files: LoadedFile[]) => {
    setDataset((ds) =>
      files.reduce(
        (acc, f) => (f.text === null ? addSource(acc, f.name, [], [f.error ?? 'Could not read file.']) : addCsvText(acc, f.name, f.text)),
        ds,
      ),
    );
  }, []);
  const onSample = useCallback(() => {
    setDataset((ds) => (ds.files.some((f) => f.synthetic) ? ds : addSource(ds, SAMPLE_NAME, generateSampleReadings(), [], true)));
    // Make sure the sample is actually visible.
    setExclusion((e) => ({ ...e, excludeSynthetic: false }));
  }, []);
  const onClear = useCallback(() => setDataset(EMPTY_DATASET), []);

  const analysis = result instanceof Error ? null : result;
  const showsSynthetic = !!analysis && analysis.syntheticRows > 0;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to results
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="var(--accent)" />
              <rect x="8" y="20" width="16" height="4" rx="1" fill="var(--accent-ink)" />
              <rect x="8" y="14" width="16" height="4" rx="1" fill="var(--accent-ink)" opacity=".7" />
              <rect x="8" y="8" width="16" height="4" rx="1" fill="var(--accent-ink)" opacity=".4" />
            </svg>
            <div>
              <h1>Locus · Floor detection field test</h1>
              <p className="brand-sub">Can phone altitude tell which mall floor a shopper is on? Egypt + Oman MVP</p>
            </div>
          </div>
          <span className="privacy-pill">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="4" y="9" width="12" height="8" rx="1.5" />
              <path d="M7 9V6.5a3 3 0 016 0V9" />
            </svg>
            Runs in your browser · no data leaves this device
          </span>
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        {showsSynthetic ? (
          <div className="banner banner-warn" role="note">
            <IconAlert />
            <p>
              <strong>Synthetic demo data in view.</strong> {analysis.syntheticRows.toLocaleString()} of{' '}
              {analysis.total.toLocaleString()} included readings are generated by a simulator, not measured in a
              mall. Do not quote these numbers as field results.
            </p>
          </div>
        ) : null}

        {result instanceof Error ? (
          <div className="banner banner-warn" role="alert">
            <IconAlert />
            <p>
              <strong>Analysis failed.</strong> {result.message}. Try loading fewer files at once.
            </p>
          </div>
        ) : null}

        {analysis ? <VerdictCard gate={analysis.gate} settings={settings} synthetic={showsSynthetic} /> : null}

        <div className="grid-2">
          <DataLoader
            files={dataset.files}
            total={dataset.readings.length}
            included={included.length}
            exclusion={exclusion}
            onFiles={onFiles}
            onSample={onSample}
            onClear={onClear}
            onExclusion={setExclusion}
          />
          <SettingsPanel settings={settings} onChange={setSettings} />
        </div>

        {analysis ? (
          <>
            <SourceComparison bySource={analysis.bySource} gateSource={settings.source} floorHeightM={settings.floorHeightM} />
            <Breakdowns breakdowns={analysis.breakdowns} source={settings.source} />
            <div className="grid-2">
              <DriftChart
                drift={analysis.drift}
                bucketMinutes={analysis.driftBucketMinutes}
                advice={analysis.advice}
                floorHeightM={settings.floorHeightM}
              />
              <ErrorScatter readings={included} />
            </div>
            <ReadingsTable readings={included} source={settings.source} />
          </>
        ) : dataset.readings.length > 0 ? (
          <section className="card empty" aria-label="All readings excluded">
            <h2>All loaded readings are excluded</h2>
            <p>Untick an exclusion under &ldquo;Load data&rdquo; to include them.</p>
          </section>
        ) : (
          <EmptyState onSample={onSample} />
        )}

        <ExplainPanel />
      </main>
      <footer className="footer">
        Locus MVP · Static page, no tracking, no server. CSV files are parsed in this browser tab only.
      </footer>
    </>
  );
}
