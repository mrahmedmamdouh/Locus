import { useId, useMemo, useState } from 'react';
import type { Reading, WifiScan } from '@locus/altitude-core';
import { fmtNum, fmtPct, venueOptions } from '../lib/data';
import {
  CONFIDENCE_THRESHOLD,
  DEFAULT_WIFI_SETTINGS,
  SCAN_STATUS_LABEL,
  WIFI_PARSE,
  analyzeWifi,
  confidenceFilter,
  confusionMatrix,
  floorLabels,
  scanHealth,
  type WifiSettings,
} from '../lib/wifi';
import { Card, IconAlert, NumberField } from './common';

const TITLE = 'Wi-Fi floor test';
const SUBTITLE = 'Can Wi-Fi fingerprints alone identify the floor, especially on phones without a barometer?';

const pctOf = (k: number, n: number) => (n ? fmtPct(k / n, 0) : '—');

function Headline({ label, acc, n, other }: { label: string; acc: number | null; n: number; other?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{fmtPct(acc, 1)}</span>
      <span className="kpi-sub">
        {n ? `Wi-Fi alone picked the right floor in ${fmtPct(acc, 1)} of ${n.toLocaleString()} readings` : 'No readings evaluated'}
      </span>
      {other ? <span className="kpi-sub">{other}</span> : null}
    </div>
  );
}

function Confusion({ predictions, readings }: { predictions: Parameters<typeof confusionMatrix>[0]; readings: Reading[] }) {
  const id = useId();
  const venues = useMemo(() => {
    const ids = new Set(predictions.map((p) => p.venueId));
    const named = venueOptions(readings).filter((v) => ids.has(v.id));
    const known = new Set(named.map((v) => v.id));
    return [...named, ...[...ids].filter((v) => !known.has(v)).sort().map((v) => ({ id: v, name: v }))];
  }, [predictions, readings]);
  const [venue, setVenue] = useState(() => venues[0]?.id ?? '');
  const sel = venues.some((v) => v.id === venue) ? venue : (venues[0]?.id ?? '');
  const m = confusionMatrix(predictions, sel);
  const labels = floorLabels(readings, sel);
  const label = (f: number) => labels.get(f) ?? `Floor ${f}`;
  const caption = `Wi-Fi confusion matrix, ${venues.find((v) => v.id === sel)?.name ?? 'all venues'}: rows are the true floor, columns the predicted floor`;
  return (
    <>
      <div className="toolbar">
        <div className="field">
          <label htmlFor={id} className="field-label">
            Venue
          </label>
          <select id={id} value={sel} onChange={(e) => setVenue(e.target.value)}>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {m.total === 0 ? (
        <p className="small muted">No predictions for this venue.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
          <table className="confusion">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">True ↓ / Predicted →</th>
                {m.floors.map((f) => (
                  <th scope="col" className="num" key={f}>
                    {label(f)}
                  </th>
                ))}
                <th scope="col" className="num">
                  Correct
                </th>
              </tr>
            </thead>
            <tbody>
              {m.floors.map((tf, i) => (
                <tr key={tf}>
                  <th scope="row">{label(tf)}</th>
                  {m.floors.map((pf, j) => {
                    const c = m.counts[i]![j]!;
                    return (
                      <td key={pf} className={`num${i === j ? ' cell-diag' : c ? ' cell-off' : ''}`}>
                        {c}
                      </td>
                    );
                  })}
                  <td className="num">{pctOf(m.counts[i]![i]!, m.rowTotals[i]!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function WifiFloorTest({
  scans,
  readings,
  synthetic = false,
}: {
  /** Included Wi-Fi scans (already filtered by the DEMO / synthetic exclusion). */
  scans: WifiScan[];
  /** Included readings (for barometer comparison, venue names and floor labels). */
  readings: Reading[];
  synthetic?: boolean;
}) {
  const [settings, setSettings] = useState<WifiSettings>(DEFAULT_WIFI_SETTINGS);
  const analysis = useMemo(() => (scans.length ? analyzeWifi(scans, readings, settings) : null), [scans, readings, settings]);
  const health = useMemo(() => scanHealth(scans), [scans]);

  if (!analysis) {
    return (
      <Card title={TITLE} subtitle={SUBTITLE}>
        <p className="muted">Android builds of the app export Wi-Fi scans; load that CSV to test Wi-Fi floor detection.</p>
      </Card>
    );
  }
  const { evaluation: ev, overall, noBarometer, holdout, byVenue } = analysis;
  const conf = confidenceFilter(ev.predictions, CONFIDENCE_THRESHOLD);
  const isDefault =
    settings.k === DEFAULT_WIFI_SETTINGS.k &&
    settings.maxApAgeS === DEFAULT_WIFI_SETTINGS.maxApAgeS &&
    settings.minAps === DEFAULT_WIFI_SETTINGS.minAps;

  return (
    <Card
      title={TITLE}
      subtitle={SUBTITLE}
      actions={
        <button type="button" className="btn btn-ghost" onClick={() => setSettings(DEFAULT_WIFI_SETTINGS)} disabled={isDefault}>
          Reset Wi-Fi settings
        </button>
      }
    >
      {synthetic ? (
        <p className="small">
          <span className="tag tag-synthetic">Synthetic</span> Includes generated Wi-Fi scans, not measured in a mall.
        </p>
      ) : null}

      <p className="coverage-headline" aria-live="polite">
        <strong>
          Wi-Fi alone picked the right floor in {fmtPct(overall.wifiAccuracy, 1)} of {overall.n.toLocaleString()} readings
        </strong>
        <span className="muted"> · Barometer on the same readings: {fmtPct(overall.baroAccuracy, 1)}</span>
      </p>

      <div className="kpis">
        <Headline
          label="All evaluated readings"
          acc={overall.wifiAccuracy}
          n={overall.n}
          other={`Barometer on the same readings: ${fmtPct(overall.baroAccuracy, 1)}`}
        />
        <Headline
          label="Phones without a barometer"
          acc={noBarometer.wifiAccuracy}
          n={noBarometer.n}
          other="Barometer on the same readings: none (no barometer)"
        />
        <div className="kpi">
          <span className="kpi-label">Only when confident (≥ {CONFIDENCE_THRESHOLD})</span>
          <span className="kpi-value">{fmtPct(conf.accuracy, 1)}</span>
          <span className="kpi-sub">
            right floor, keeping {fmtPct(conf.keptShare, 1)} of readings ({conf.kept.toLocaleString()} of{' '}
            {conf.total.toLocaleString()})
          </span>
          <span className="kpi-sub">Mirrors &ldquo;only push offers when confident&rdquo;.</span>
        </div>
      </div>

      <p className="small" style={{ marginTop: 12 }}>
        Each reading is predicted from OTHER sessions in the same venue (or, with one session, from readings taken more
        than 2 minutes apart), so the score reflects a new visitor.{' '}
        <span className="muted">
          {holdout.session.toLocaleString()} predictions used other sessions; {holdout.time.toLocaleString()} used the
          time-gap holdout.
        </span>
      </p>

      <fieldset className="exclusions wifi-settings">
        <legend>Fingerprint settings</legend>
        <div className="wifi-settings-grid">
          <NumberField
            label="k neighbours"
            value={settings.k}
            parse={WIFI_PARSE.k}
            onCommit={(k) => setSettings((s) => ({ ...s, k }))}
            step={1}
            hint="Nearest fingerprints that vote on the floor."
            error="Whole number from 1 to 50."
          />
          <NumberField
            label="Max access-point age"
            suffix="s"
            value={settings.maxApAgeS}
            parse={WIFI_PARSE.maxApAgeS}
            onCommit={(maxApAgeS) => setSettings((s) => ({ ...s, maxApAgeS }))}
            hint="Older cached results are ignored."
            error="Number from 0 to 3600."
          />
          <NumberField
            label="Min access points per scan"
            value={settings.minAps}
            parse={WIFI_PARSE.minAps}
            onCommit={(minAps) => setSettings((s) => ({ ...s, minAps }))}
            step={1}
            hint="Scans with fewer are not used."
            error="Whole number from 1 to 100."
          />
        </div>
      </fieldset>

      <div className="grid-2 coverage-grid">
        <div>
          <h3>By venue</h3>
          <div className="table-wrap" role="region" aria-label="Wi-Fi floor accuracy by venue" tabIndex={0}>
            <table>
              <caption className="sr-only">Wi-Fi floor accuracy by venue, with barometer accuracy on the same readings</caption>
              <thead>
                <tr>
                  <th scope="col">Venue</th>
                  <th scope="col" className="num">
                    Evaluated
                  </th>
                  <th scope="col" className="num">
                    Wi-Fi accuracy
                  </th>
                  <th scope="col" className="num">
                    Barometer (same readings)
                  </th>
                </tr>
              </thead>
              <tbody>
                {byVenue.map((v) => (
                  <tr key={v.venueId}>
                    <th scope="row">{v.venueName}</th>
                    <td className="num">{v.evaluated.toLocaleString()}</td>
                    <td className="num">{fmtPct(v.wifiAccuracy)}</td>
                    <td className="num">{fmtPct(v.baroAccuracy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3>Confusion matrix (Wi-Fi)</h3>
          <Confusion predictions={ev.predictions} readings={readings} />
        </div>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Scan health</h3>
      {health.showThrottleTip ? (
        <div className="banner banner-warn" role="note">
          <IconAlert />
          <p>
            <strong>{fmtPct(health.throttledShare, 0)} of scans were throttled or stale.</strong> On test phones, turn off
            &ldquo;Wi-Fi scan throttling&rdquo; in Developer options so every reading gets a fresh scan.
          </p>
        </div>
      ) : null}
      <div className="grid-2 coverage-grid">
        <div className="table-wrap" role="region" aria-label="Wi-Fi scan status" tabIndex={0}>
          <table>
            <caption className="sr-only">Wi-Fi scans by status</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Scans
                </th>
                <th scope="col" className="num">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {health.byStatus.map((s) => (
                <tr key={s.status}>
                  <th scope="row">{SCAN_STATUS_LABEL[s.status]}</th>
                  <td className="num">{s.count.toLocaleString()}</td>
                  <td className="num">{fmtPct(s.share, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <dl className="stat-list small">
            <div>
              <dt>Scans loaded</dt>
              <dd>{health.scans.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Median access points per scan</dt>
              <dd>{fmtNum(health.medianAps, 0)}</dd>
            </div>
            <div>
              <dt>Access points that are RTT responders</dt>
              <dd>{fmtPct(health.rttShare, 0)}</dd>
            </div>
            <div>
              <dt>Median access-point age</dt>
              <dd>{health.medianApAgeS === null ? '—' : `${fmtNum(health.medianApAgeS, 1)} s`}</dd>
            </div>
            <div>
              <dt>Skipped: scan not OK</dt>
              <dd>{ev.skipped.notOk.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Skipped: too few access points</dt>
              <dd>{ev.skipped.tooFewAps.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Skipped: no training data</dt>
              <dd>{ev.skipped.noTrainingData.toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Card>
  );
}
