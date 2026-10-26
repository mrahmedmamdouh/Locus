import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CoverageRow, DeviceCheck, Reading } from '@locus/altitude-core';
import {
  BAROMETER_STATE_LABEL,
  coverage,
  crossCheck,
  platformLabel,
  type BarometerState,
} from '../lib/coverage';
import { fmtM, fmtPct } from '../lib/data';
import { useChartPalette } from '../hooks/useChartPalette';
import { Card, TooltipBox } from './common';

function StatusCell({ ok, label }: { ok: boolean | null; label: string }) {
  const cls = ok === null ? 'status-na' : ok ? 'status-ok' : 'status-bad';
  const mark = ok === null ? '!' : ok ? '✓' : '✗';
  return (
    <span className={`status-dot ${cls}`}>
      <span aria-hidden="true">{mark}</span> {label}
    </span>
  );
}

function BarometerCell({ state }: { state: BarometerState }) {
  const ok = state === 'works' ? true : state === 'none' ? false : null;
  return <StatusCell ok={ok} label={BAROMETER_STATE_LABEL[state]} />;
}

function CoverageTable({ caption, groupLabel, rows }: { caption: string; groupLabel: string; rows: CoverageRow[] }) {
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{groupLabel}</th>
            <th scope="col" className="num">
              Phones
            </th>
            <th scope="col" className="num">
              Working barometer
            </th>
            <th scope="col" className="num">
              Share
            </th>
            <th scope="col" className="num">
              GPS altitude
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group}>
              <th scope="row">{r.group}</th>
              <td className="num">{r.devices}</td>
              <td className="num">{r.withBarometer}</td>
              <td className="num">{fmtPct(r.barometerShare, 0)}</td>
              <td className="num">{r.withGpsAltitude}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso || '—' : d.toISOString().slice(0, 10);
}

function BrandChart({ rows }: { rows: CoverageRow[] }) {
  const pal = useChartPalette();
  const data = rows.map((r) => ({ label: r.group, pct: r.barometerShare * 100, r }));
  const height = Math.max(120, data.length * 30 + 40);
  return (
    <div
      className="chart"
      style={{ height }}
      role="img"
      aria-label={`Bar chart of phones with a working barometer by brand: ${rows
        .map((r) => `${r.group} ${fmtPct(r.barometerShare, 0)} (${r.withBarometer} of ${r.devices})`)
        .join(', ')}.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 8 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke={pal.grid} />
          <XAxis type="number" domain={[0, 100]} tick={{ fill: pal.tick, fontSize: 12 }} stroke={pal.axis} unit="%" />
          <YAxis type="category" dataKey="label" width={96} tick={{ fill: pal.tick, fontSize: 12 }} stroke={pal.axis} />
          <Tooltip
            cursor={{ fill: pal.grid, opacity: 0.4 }}
            content={({ active, payload }) => {
              const d = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
              return d ? (
                <TooltipBox
                  title={d.label}
                  rows={[
                    ['Working barometer', `${d.r.withBarometer} of ${d.r.devices}`],
                    ['Share', fmtPct(d.r.barometerShare, 0)],
                  ]}
                />
              ) : null;
            }}
          />
          <Bar dataKey="pct" fill={pal.series.baro} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList
              dataKey="pct"
              position="right"
              formatter={(v: unknown) => (typeof v === 'number' ? `${v.toFixed(0)}%` : '')}
              style={{ fill: pal.reference, fontSize: 12 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ModelList({ title, models, empty }: { title: string; models: string[]; empty: string }) {
  return (
    <div>
      <h3>{title}</h3>
      {models.length === 0 ? (
        <p className="small muted">{empty}</p>
      ) : (
        <ul className="model-list small">
          {models.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SensorCoverage({
  checks,
  readings,
  synthetic = false,
}: {
  checks: DeviceCheck[];
  readings: Reading[];
  synthetic?: boolean;
}) {
  if (checks.length === 0) {
    return (
      <Card title="Sensor coverage" subtitle="Which tested phones can run the barometer test at all.">
        <p className="muted">Export device checks from the app to see sensor coverage.</p>
      </Card>
    );
  }
  const cov = coverage(checks);
  const o = cov.overall;
  const cross = readings.length > 0 ? crossCheck(readings, checks) : null;
  return (
    <Card
      title="Sensor coverage"
      subtitle="Which tested phones can run the barometer test at all. A barometer counts only if the phone has one, it is permitted, and it reported a plausible pressure."
    >
      {synthetic ? (
        <p className="small">
          <span className="tag tag-synthetic">Synthetic</span> Includes generated device checks, not real phones.
        </p>
      ) : null}
      <p className="coverage-headline">
        <strong>{`${o.withBarometer} of ${o.devices} phones (${fmtPct(o.barometerShare, 0)})`}</strong> have a working
        barometer.
      </p>
      <p className="small muted">
        Phones are counted once per model and OS version; when a phone was checked more than once, the latest check
        wins. {o.withGpsAltitude} of {o.devices} reported a GPS altitude.
      </p>

      <div className="grid-2 coverage-grid">
        <div>
          <h3>By platform</h3>
          <CoverageTable caption="Sensor coverage by platform" groupLabel="Platform" rows={cov.byPlatform} />
        </div>
        <div>
          <h3>By brand</h3>
          <CoverageTable caption="Sensor coverage by brand" groupLabel="Brand" rows={cov.byBrand} />
        </div>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Share of phones with a working barometer, by brand</h3>
      <BrandChart rows={cov.byBrand} />

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Phones checked</h3>
      <div className="table-wrap" role="region" aria-label="Phones checked" tabIndex={0}>
        <table>
          <caption className="sr-only">Phones checked, latest check per model and OS version</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Brand</th>
              <th scope="col">Platform</th>
              <th scope="col">Barometer</th>
              <th scope="col">GPS altitude</th>
              <th scope="col" className="num">
                GPS alt. accuracy
              </th>
              <th scope="col">Last checked</th>
            </tr>
          </thead>
          <tbody>
            {cov.phones.map((p) => (
              <tr key={p.key}>
                <th scope="row">
                  {p.check.deviceModel || 'Unknown'}
                  {p.checks > 1 ? <span className="muted small cell-sub">{p.checks} checks</span> : null}
                </th>
                <td>{p.check.brand || '—'}</td>
                <td>
                  {platformLabel(p.check.platform)} {p.check.osVersion}
                </td>
                <td>
                  <BarometerCell state={p.barometer} />
                </td>
                <td>
                  <StatusCell ok={p.check.gpsAltitudeAvailable} label={p.check.gpsAltitudeAvailable ? 'Yes' : 'No'} />
                </td>
                <td className="num">{fmtM(p.check.gpsAltAccuracyM, 1)}</td>
                <td>{fmtDate(p.check.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cross ? (
        <>
          <h3 style={{ marginTop: 18, marginBottom: 6 }}>Cross-check with readings</h3>
          <div className="grid-2 coverage-grid">
            <ModelList
              title="In readings, no device check"
              models={cross.readingsWithoutCheck}
              empty="Every model in the readings has a device check."
            />
            <ModelList
              title="Device check, no readings"
              models={cross.checksWithoutReadings}
              empty="Every checked model has readings."
            />
          </div>
        </>
      ) : null}
    </Card>
  );
}
