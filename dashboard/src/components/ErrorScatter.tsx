import { useMemo, useState } from 'react';
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { AltitudeSource, Reading } from '@locus/altitude-core';
import { SOURCE_LABEL, fmtM, scatterPoints, thin, type ScatterPoint } from '../lib/data';
import { useChartPalette } from '../hooks/useChartPalette';
import { Card, TooltipBox } from './common';

const MAX_POINTS_PER_SERIES = 1500;
const SERIES: AltitudeSource[] = ['baro', 'gps'];

export function ErrorScatter({ readings }: { readings: Reading[] }) {
  const pal = useChartPalette();
  const [visible, setVisible] = useState<Record<AltitudeSource, boolean>>({ baro: true, gps: true, os: false });

  const series = useMemo(
    () =>
      SERIES.map((source) => {
        const all = scatterPoints(readings, source);
        return { source, all: all.length, points: thin(all, MAX_POINTS_PER_SERIES) };
      }),
    [readings],
  );

  const shown = series.filter((s) => visible[s.source] && s.points.length > 0);
  const extent = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const s of shown)
      for (const p of s.points) {
        lo = Math.min(lo, p.x, p.y);
        hi = Math.max(hi, p.x, p.y);
      }
    const pad = Math.max(1, (hi - lo) * 0.05);
    return [Math.floor(lo - pad), Math.ceil(hi + pad)] as [number, number];
  }, [shown]);

  const thinned = series.some((s) => s.all > s.points.length);

  return (
    <Card
      title="Estimated vs true altitude"
      subtitle="Each dot is one reading: estimated height above the entrance against the centre of the floor the tester was standing on. Perfect estimates sit on the y = x line."
      actions={
        <fieldset className="segmented" style={{ border: '1px solid var(--border-strong)', padding: 0, margin: 0 }}>
          <legend className="sr-only">Series shown</legend>
          {SERIES.map((s) => (
            <label key={s} className="check" style={{ padding: '6px 12px', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={visible[s]}
                onChange={(e) => setVisible({ ...visible, [s]: e.target.checked })}
                style={{ marginTop: 0 }}
              />
              <span className="legend-dot" style={{ background: pal.series[s] }} aria-hidden="true" />
              {SOURCE_LABEL[s]}
            </label>
          ))}
        </fieldset>
      }
    >
      {shown.length === 0 ? (
        <p className="muted small">No readings with a value for the selected series.</p>
      ) : (
        <div className="chart" style={{ height: 360 }} role="img" aria-label="Scatter plot of estimated relative altitude versus true floor centre for barometer and GPS. Barometer points cluster tightly on the y equals x line; points far from the line are errors.">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 16, bottom: 22, left: 0 }}>
              <CartesianGrid stroke={pal.grid} />
              <XAxis
                type="number"
                dataKey="x"
                domain={extent}
                allowDataOverflow
                tick={{ fill: pal.tick, fontSize: 12 }}
                stroke={pal.axis}
                unit=" m"
                label={{ value: 'True floor centre (m above entrance)', position: 'insideBottom', offset: -14, fill: pal.tick, fontSize: 12 }}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={extent}
                allowDataOverflow
                tick={{ fill: pal.tick, fontSize: 12 }}
                stroke={pal.axis}
                unit=" m"
                width={56}
              />
              <ReferenceLine
                segment={[
                  { x: extent[0], y: extent[0] },
                  { x: extent[1], y: extent[1] },
                ]}
                stroke={pal.reference}
                strokeDasharray="4 3"
                ifOverflow="hidden"
                label={{ value: 'y = x', position: 'insideTopRight', fill: pal.tick, fontSize: 11 }}
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3', stroke: pal.axis }}
                content={({ active, payload }) => {
                  const item = active ? payload?.[0] : undefined;
                  const p = item?.payload as ScatterPoint | undefined;
                  if (!p) return null;
                  return (
                    <TooltipBox
                      title={`${String(item?.name ?? '')} · reading ${p.id}`}
                      rows={[
                        ['Venue', p.venue],
                        ['Device', p.device],
                        ['True floor', `${p.floor} (${fmtM(p.x, 1)})`],
                        ['Estimate', fmtM(p.y)],
                        ['Error', fmtM(p.y - p.x)],
                      ]}
                    />
                  );
                }}
              />
              {shown.map((s) => (
                <Scatter
                  key={s.source}
                  name={SOURCE_LABEL[s.source]}
                  data={s.points}
                  fill={pal.series[s.source]}
                  fillOpacity={s.source === 'gps' ? 0.45 : 0.7}
                  isAnimationActive={false}
                  shape="circle"
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="chart-note">
        Barometer points should form tight columns on the y = x line; GPS altitude is usually spread over many
        floors indoors.
        {thinned ? ` Large dataset: up to ${MAX_POINTS_PER_SERIES.toLocaleString()} evenly sampled points per series are drawn; all readings count in the statistics.` : ''}
      </p>
    </Card>
  );
}
