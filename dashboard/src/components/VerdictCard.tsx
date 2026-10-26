import type { GateCriteria, GateResult } from '@locus/altitude-core';
import { SOURCE_LABEL, fmtM, fmtPct } from '../lib/data';
import type { Settings } from '../lib/settings';
import { IconAlert, IconCheck, IconCross } from './common';

const VERDICT_TEXT: Record<GateResult['verdict'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  'insufficient-data': 'INSUFFICIENT DATA',
};

const VERDICT_HEADLINE: Record<GateResult['verdict'], string> = {
  pass: 'Floors are separable with this source.',
  fail: 'Floors are not reliably separable yet.',
  'insufficient-data': 'Not enough data for a verdict.',
};

function Target({ ok, text }: { ok: boolean | null; text: string }) {
  return (
    <span className="kpi-target">
      {ok === null ? null : ok ? (
        <span className="kpi-ok">Meets</span>
      ) : (
        <span className="kpi-miss">Misses</span>
      )}
      <span>{text}</span>
    </span>
  );
}

export function VerdictCard({
  gate,
  settings,
  synthetic,
}: {
  gate: GateResult;
  settings: Settings;
  synthetic: boolean;
}) {
  const { summary: s, verdict, venues } = gate;
  const c: GateCriteria = settings.gate;
  const limitM = c.maxP90FractionOfFloor * settings.floorHeightM;
  const Icon = verdict === 'pass' ? IconCheck : verdict === 'fail' ? IconCross : IconAlert;
  return (
    <section className={`card verdict verdict-${verdict}`} aria-labelledby="verdict-title" aria-live="polite">
      <div className="verdict-top">
        <div className="verdict-badge">
          <Icon />
          <span>{VERDICT_TEXT[verdict]}</span>
        </div>
        <div className="verdict-text">
          <h2 id="verdict-title">
            Gate 1 · Floors separable — {VERDICT_HEADLINE[verdict]}
            <span className="sr-only"> Verdict: {VERDICT_TEXT[verdict]}.</span>
          </h2>
          <p className="card-sub">
            Source: {SOURCE_LABEL[settings.source]} · floor height {settings.floorHeightM} m
            {synthetic ? ' · includes SYNTHETIC demo data' : ''}
          </p>
          <ul className="verdict-reasons">
            {gate.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Floor accuracy</span>
          <span className="kpi-value">{fmtPct(s.floorAccuracy)}</span>
          <Target
            ok={s.floorAccuracy === null ? false : s.floorAccuracy >= c.minFloorAccuracy}
            text={`target ≥ ${fmtPct(c.minFloorAccuracy, 0)}`}
          />
        </div>
        <div className="kpi">
          <span className="kpi-label">p90 |error|</span>
          <span className="kpi-value">{fmtM(s.p90AbsErrorM)}</span>
          <Target
            ok={s.p90AbsErrorM === null ? false : s.p90AbsErrorM < limitM}
            text={`target < ${limitM.toFixed(2)} m`}
          />
        </div>
        <div className="kpi">
          <span className="kpi-label">Readings</span>
          <span className="kpi-value">{s.n.toLocaleString()}</span>
          <Target ok={s.n >= c.minReadings} text={`need ≥ ${c.minReadings.toLocaleString()}`} />
        </div>
        <div className="kpi">
          <span className="kpi-label">Venues</span>
          <span className="kpi-value">{venues}</span>
          <Target ok={venues >= c.minVenues} text={`need ≥ ${c.minVenues}`} />
        </div>
        <div className="kpi">
          <span className="kpi-label">Median |error|</span>
          <span className="kpi-value">{fmtM(s.medianAbsErrorM)}</span>
          <Target ok={null} text={`within ½ floor: ${fmtPct(s.withinHalfFloor)}`} />
        </div>
      </div>
    </section>
  );
}
