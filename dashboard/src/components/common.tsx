import { useEffect, useId, useState, type ReactNode } from 'react';
import type { AccuracySummary } from '@locus/altitude-core';
import { fmtM, fmtPct } from '../lib/data';

export function Card({
  title,
  subtitle,
  actions,
  children,
  id,
  className = '',
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  const autoId = useId();
  const headingId = `${id ?? autoId}-title`;
  return (
    <section className={`card ${className}`} aria-labelledby={headingId} id={id}>
      <div className="card-head">
        <div>
          <h2 id={headingId}>{title}</h2>
          {subtitle ? <p className="card-sub">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Number input that keeps the typed text and only commits valid values. */
export function NumberField({
  label,
  value,
  onCommit,
  parse,
  hint,
  error,
  step,
  suffix,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  parse: (raw: string) => number | null;
  hint?: string;
  error: string;
  step?: number | 'any';
  suffix?: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => {
    // Sync when the value changes from outside (e.g. "Reset to defaults").
    setText((t) => (parse(t) === value ? t : String(value)));
  }, [value, parse]);
  const parsed = parse(text);
  const invalid = parsed === null;
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
        {suffix ? <span className="muted"> ({suffix})</span> : null}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step ?? 'any'}
        value={text}
        aria-invalid={invalid}
        aria-describedby={`${id}-desc`}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          if (n !== null) onCommit(n);
        }}
      />
      <span id={`${id}-desc`} className={invalid ? 'field-error' : 'field-hint'}>
        {invalid ? error : hint}
      </span>
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            let next = -1;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length;
            if (next >= 0) {
              e.preventDefault();
              onChange(options[next]!.value);
              const group = e.currentTarget.parentElement;
              requestAnimationFrame(() =>
                (group?.querySelectorAll('button')[next] as HTMLButtonElement | undefined)?.focus(),
              );
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Accuracy table shared by the source comparison and the breakdowns. */
export function SummaryTable({
  caption,
  groupLabel,
  rows,
  highlight,
  swatch,
}: {
  caption: string;
  groupLabel: string;
  rows: { group: string; summary: AccuracySummary }[];
  highlight?: string;
  swatch?: (group: string) => string | undefined;
}) {
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{groupLabel}</th>
            <th scope="col" className="num">
              Floor accuracy
            </th>
            <th scope="col" className="num">
              Median |error|
            </th>
            <th scope="col" className="num">
              p90 |error|
            </th>
            <th scope="col" className="num">
              Within ½ floor
            </th>
            <th scope="col" className="num">
              Mean error
            </th>
            <th scope="col" className="num">
              n
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ group, summary: s }) => {
            const color = swatch?.(group);
            return (
              <tr key={group} className={highlight === group ? 'row-highlight' : undefined}>
                <th scope="row">
                  {color ? <span className="swatch" style={{ background: color }} aria-hidden="true" /> : null}
                  {group}
                  {highlight === group ? <span className="muted small"> · gate source</span> : null}
                </th>
                <td className="num">{fmtPct(s.floorAccuracy)}</td>
                <td className="num">{fmtM(s.medianAbsErrorM)}</td>
                <td className="num">{fmtM(s.p90AbsErrorM)}</td>
                <td className="num">{fmtPct(s.withinHalfFloor)}</td>
                <td className="num">{fmtM(s.meanErrorM)}</td>
                <td className="num">{s.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TooltipBox({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{title}</div>
      {rows.map(([k, v]) => (
        <div className="chart-tooltip-row" key={k}>
          <span>{k}</span>
          <strong>{v}</strong>
        </div>
      ))}
    </div>
  );
}

export function IconCheck() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconCross() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  );
}
export function IconAlert() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M10 3l8 14H2L10 3z" strokeLinejoin="round" />
      <path d="M10 8v4M10 14.5v.5" strokeLinecap="round" />
    </svg>
  );
}
