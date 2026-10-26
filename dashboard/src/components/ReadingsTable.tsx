import { useEffect, useId, useMemo, useState } from 'react';
import { altitudeFor, readingsToCsv } from '@locus/altitude-core';
import type { AltitudeSource, Reading } from '@locus/altitude-core';
import {
  DEFAULT_TABLE_FILTER,
  SOURCE_LABEL,
  distinctSorted,
  estFloor,
  estimateSourceFor,
  exportFileName,
  filterReadings,
  fmtNum,
  isCorrect,
  paginate,
  venueOptions,
  type Correctness,
  type TableFilter,
} from '../lib/data';
import { Card } from './common';

const PAGE_SIZE = 25;

function download(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CorrectCell({ value }: { value: boolean | null }) {
  if (value === null) return <span className="status-dot status-na">No estimate</span>;
  return value ? (
    <span className="status-dot status-ok">
      <span aria-hidden="true">✓</span> Correct
    </span>
  ) : (
    <span className="status-dot status-bad">
      <span aria-hidden="true">✗</span> Wrong
    </span>
  );
}

export function ReadingsTable({ readings, source }: { readings: Reading[]; source: AltitudeSource }) {
  const ids = { venue: useId(), device: useId(), correct: useId() };
  const [filter, setFilter] = useState<TableFilter>(DEFAULT_TABLE_FILTER);
  const [page, setPage] = useState(0);
  const estSource = estimateSourceFor(source);

  const venues = useMemo(() => venueOptions(readings), [readings]);
  const devices = useMemo(() => distinctSorted(readings, (r) => r.deviceModel), [readings]);
  const filtered = useMemo(() => filterReadings(readings, filter, estSource), [readings, filter, estSource]);
  const pg = paginate(filtered, page, PAGE_SIZE);

  useEffect(() => setPage(0), [filter, readings]);

  // Drop a filter value that no longer exists after data changes.
  useEffect(() => {
    if (filter.venue && !venues.some((v) => v.id === filter.venue)) setFilter((f) => ({ ...f, venue: '' }));
    if (filter.device && !devices.includes(filter.device)) setFilter((f) => ({ ...f, device: '' }));
  }, [venues, devices, filter.venue, filter.device]);

  return (
    <Card
      title="Readings"
      subtitle={`Correct / wrong uses the on-device ${SOURCE_LABEL[estSource].toLowerCase()} floor estimate${source === 'os' ? ' (no OS floor estimate exists)' : ''}.`}
    >
      <div className="toolbar">
        <div className="field">
          <label htmlFor={ids.venue} className="field-label">
            Venue
          </label>
          <select id={ids.venue} value={filter.venue} onChange={(e) => setFilter({ ...filter, venue: e.target.value })}>
            <option value="">All venues</option>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.device} className="field-label">
            Device
          </label>
          <select id={ids.device} value={filter.device} onChange={(e) => setFilter({ ...filter, device: e.target.value })}>
            <option value="">All devices</option>
            {devices.map((d) => (
              <option key={d} value={d}>
                {d || '(unknown)'}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.correct} className="field-label">
            Floor estimate
          </label>
          <select
            id={ids.correct}
            value={filter.correctness}
            onChange={(e) => setFilter({ ...filter, correctness: e.target.value as Correctness })}
          >
            <option value="all">All</option>
            <option value="correct">Correct floor</option>
            <option value="incorrect">Wrong floor</option>
            <option value="no-estimate">No estimate</option>
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={filtered.length === 0}
          onClick={() => download(readingsToCsv(filtered), exportFileName())}
        >
          Export {filtered.length.toLocaleString()} as CSV
        </button>
      </div>

      <div className="table-wrap" role="region" aria-label="Readings" tabIndex={0}>
        <table>
          <caption className="sr-only">
            Readings {pg.from}–{pg.to} of {pg.total}
          </caption>
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Venue</th>
              <th scope="col">Device</th>
              <th scope="col">True floor</th>
              <th scope="col" className="num">True centre (m)</th>
              <th scope="col" className="num">{SOURCE_LABEL[source]} (m)</th>
              <th scope="col" className="num">Error (m)</th>
              <th scope="col" className="num">Est. floor</th>
              <th scope="col">Result</th>
              <th scope="col" className="num">Min since cal.</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {pg.items.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  No readings match these filters.
                </td>
              </tr>
            ) : (
              pg.items.map((r, i) => {
                const alt = altitudeFor(r, source);
                return (
                  <tr key={`${r.id}-${i}`}>
                    <td>{r.id}</td>
                    <td>{r.venueName || r.venueId}</td>
                    <td>{r.deviceModel}</td>
                    <td>{r.trueFloorLabel}</td>
                    <td className="num">{fmtNum(r.trueFloorCenterM, 1)}</td>
                    <td className="num">{fmtNum(alt)}</td>
                    <td className="num">{alt === null ? '—' : fmtNum(alt - r.trueFloorCenterM)}</td>
                    <td className="num">{estFloor(r, estSource) ?? '—'}</td>
                    <td>
                      <CorrectCell value={isCorrect(r, estSource)} />
                    </td>
                    <td className="num">{fmtNum(r.secondsSinceCalibration / 60, 1)}</td>
                    <td title={r.notes} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.notes}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <nav className="pager" aria-label="Readings pages">
        <span aria-live="polite">
          {pg.total === 0
            ? '0 readings'
            : `${pg.from.toLocaleString()}–${pg.to.toLocaleString()} of ${pg.total.toLocaleString()} · page ${pg.page + 1} of ${pg.pageCount}`}
        </span>
        <div className="pager-buttons">
          <button type="button" className="btn" onClick={() => setPage(0)} disabled={pg.page === 0} aria-label="First page">
            «
          </button>
          <button type="button" className="btn" onClick={() => setPage(pg.page - 1)} disabled={pg.page === 0}>
            Previous
          </button>
          <button type="button" className="btn" onClick={() => setPage(pg.page + 1)} disabled={pg.page >= pg.pageCount - 1}>
            Next
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setPage(pg.pageCount - 1)}
            disabled={pg.page >= pg.pageCount - 1}
            aria-label="Last page"
          >
            »
          </button>
        </div>
      </nav>
    </Card>
  );
}
