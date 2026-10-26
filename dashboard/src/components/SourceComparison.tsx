import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AccuracySummary, AltitudeSource } from '@locus/altitude-core';
import { SOURCE_LABEL, fmtFloors, fmtM, fmtPct } from '../lib/data';
import { useChartPalette } from '../hooks/useChartPalette';
import { Card, SummaryTable, TooltipBox } from './common';

export function SourceComparison({
  bySource,
  gateSource,
  floorHeightM,
}: {
  bySource: AccuracySummary[];
  gateSource: AltitudeSource;
  floorHeightM: number;
}) {
  const pal = useChartPalette();
  const half = floorHeightM / 2;
  const data = bySource
    .filter((s) => s.n > 0 && s.p90AbsErrorM !== null)
    .map((s) => ({ source: s.source, label: SOURCE_LABEL[s.source], p90: s.p90AbsErrorM!, s }));
  const rows = bySource.map((s) => ({ group: SOURCE_LABEL[s.source], summary: s }));
  const colorFor = (g: string) => {
    const src = (Object.keys(SOURCE_LABEL) as AltitudeSource[]).find((k) => SOURCE_LABEL[k] === g);
    return src ? pal.series[src] : undefined;
  };
  return (
    <Card
      title="Barometer vs GPS vs iOS OS altitude"
      subtitle="Same readings, three altitude sources. Lower error is better. Barometer and GPS floor accuracy uses the on-device floor estimate; iOS OS altitude counts as the correct floor when within half of that floor's height."
    >
      <SummaryTable
        caption="Accuracy by altitude source"
        groupLabel="Source"
        rows={rows}
        highlight={SOURCE_LABEL[gateSource]}
        swatch={colorFor}
      />
      <h3 style={{ marginTop: 18, marginBottom: 6 }}>90th-percentile |error| by source (m)</h3>
      {data.length === 0 ? (
        <p className="muted small">No altitude values in the included readings.</p>
      ) : (
        <div className="chart chart-sm" role="img" aria-label={`Bar chart of 90th-percentile absolute error: ${data.map((d) => `${d.label} ${d.p90.toFixed(2)} m`).join(', ')}. Half a floor is ${half.toFixed(2)} m.`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 8 }} barCategoryGap={10}>
              <CartesianGrid horizontal={false} stroke={pal.grid} />
              <XAxis type="number" tick={{ fill: pal.tick, fontSize: 12 }} stroke={pal.axis} unit=" m" />
              <YAxis type="category" dataKey="label" width={112} tick={{ fill: pal.tick, fontSize: 12 }} stroke={pal.axis} />
              <Tooltip
                cursor={{ fill: pal.grid, opacity: 0.4 }}
                content={({ active, payload }) => {
                  const d = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
                  return d ? (
                    <TooltipBox
                      title={d.label}
                      rows={[
                        ['p90 |error|', `${fmtM(d.p90)} (${fmtFloors(d.s.p90AbsErrorFloors)})`],
                        ['Median |error|', fmtM(d.s.medianAbsErrorM)],
                        ['Floor accuracy', fmtPct(d.s.floorAccuracy)],
                        ['n', String(d.s.n)],
                      ]}
                    />
                  ) : null;
                }}
              />
              <ReferenceLine
                x={half}
                stroke={pal.threshold}
                strokeDasharray="4 3"
                label={{ value: '½ floor', position: 'top', fill: pal.tick, fontSize: 11 }}
              />
              <Bar dataKey="p90" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {data.map((d) => (
                  <Cell key={d.source} fill={pal.series[d.source]} />
                ))}
                <LabelList
                  dataKey="p90"
                  position="right"
                  formatter={(v: unknown) => (typeof v === 'number' ? `${v.toFixed(2)} m` : '')}
                  style={{ fill: pal.reference, fontSize: 12 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="chart-note">
        Dashed line: half of the fallback floor height ({half.toFixed(2)} m). The gate judges each reading against
        its own floor&rsquo;s height; see p90 in floors in the table above.
      </p>
    </Card>
  );
}
