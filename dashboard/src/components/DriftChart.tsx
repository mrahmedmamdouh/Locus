import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtM, type DriftRow, type RecalibrationAdvice } from '../lib/data';
import { useChartPalette } from '../hooks/useChartPalette';
import { Card, TooltipBox } from './common';

function adviceText(a: RecalibrationAdvice, bucket: number): string {
  const t = a.thresholdM.toFixed(2);
  switch (a.kind) {
    case 'no-data':
      return 'Not enough barometer readings per time bucket to judge drift yet.';
    case 'stable':
      return `p90 error stays below half a floor (${t} m) across the session. No extra recalibration needed within the tested duration; keep calibrating at each mall entrance.`;
    case 'exceeds-from-start':
      return `p90 error is already at or above half a floor (${t} m) in the first ${bucket} minutes, so the problem is noise or calibration, not drift. Recalibrating more often will not fix it.`;
    case 'recalibrate':
      return `p90 error reaches half a floor (${t} m) from about minute ${a.minutes}. Recommendation: recalibrate at least every ${a.minutes} minutes (e.g. re-anchor at a known floor or entrance).`;
  }
}

export function DriftChart({
  drift,
  bucketMinutes,
  advice,
  floorHeightM,
}: {
  drift: DriftRow[];
  bucketMinutes: number;
  advice: RecalibrationAdvice;
  floorHeightM: number;
}) {
  const pal = useChartPalette();
  const half = floorHeightM / 2;
  const data = drift.map((d) => ({ ...d, label: `${d.minutesFrom}–${d.minutesFrom + bucketMinutes}` }));
  return (
    <Card
      title="Barometer drift since calibration"
      subtitle={`Absolute error in ${bucketMinutes}-minute buckets after the entrance calibration. Weather moves pressure slowly, so error can grow over time.`}
    >
      {data.length === 0 ? (
        <p className="muted small">No barometer readings to chart.</p>
      ) : (
        <>
          <ul className="legend" aria-hidden="true">
            <li>
              <span className="legend-line" style={{ borderColor: pal.series.baro }} />
              Median |error|
            </li>
            <li>
              <span className="legend-line dashed" style={{ borderColor: pal.series.baro }} />
              p90 |error|
            </li>
            <li>
              <span className="legend-line dashed" style={{ borderColor: pal.threshold }} />½ floor ({half.toFixed(2)} m)
            </li>
          </ul>
          <div className="chart" role="img" aria-label={`Line chart of barometer error versus minutes since calibration. ${adviceText(advice, bucketMinutes)}`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
                <CartesianGrid vertical={false} stroke={pal.grid} />
                <XAxis
                  dataKey="minutesFrom"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tick={{ fill: pal.tick, fontSize: 12 }}
                  stroke={pal.axis}
                  label={{ value: 'Minutes since calibration', position: 'insideBottom', offset: -12, fill: pal.tick, fontSize: 12 }}
                />
                <YAxis tick={{ fill: pal.tick, fontSize: 12 }} stroke={pal.axis} unit=" m" width={56} />
                <Tooltip
                  cursor={{ stroke: pal.axis }}
                  content={({ active, payload }) => {
                    const d = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
                    return d ? (
                      <TooltipBox
                        title={`Minutes ${d.label}`}
                        rows={[
                          ['Median |error|', fmtM(d.medianAbsErrorM)],
                          ['p90 |error|', fmtM(d.p90AbsErrorM)],
                          ['Readings', String(d.n)],
                        ]}
                      />
                    ) : null;
                  }}
                />
                <ReferenceLine y={half} stroke={pal.threshold} strokeDasharray="4 3" />
                <Line
                  type="monotone"
                  dataKey="medianAbsErrorM"
                  name="Median |error|"
                  stroke={pal.series.baro}
                  strokeWidth={2}
                  dot={{ r: 3, fill: pal.series.baro, strokeWidth: 0 }}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="p90AbsErrorM"
                  name="p90 |error|"
                  stroke={pal.series.baro}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  dot={{ r: 3, fill: pal.surface, stroke: pal.series.baro, strokeWidth: 2 }}
                  isAnimationActive={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      <p className="chart-note">
        <strong>Recalibration: </strong>
        {adviceText(advice, bucketMinutes)}
      </p>
      {data.length > 0 ? (
        <details className="data-table">
          <summary>Show drift data as a table</summary>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Barometer error by minutes since calibration</caption>
              <thead>
                <tr>
                  <th scope="col">Minutes</th>
                  <th scope="col" className="num">Median |error|</th>
                  <th scope="col" className="num">p90 |error|</th>
                  <th scope="col" className="num">n</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => (
                  <tr key={d.minutesFrom}>
                    <th scope="row">{d.label}</th>
                    <td className="num">{fmtM(d.medianAbsErrorM)}</td>
                    <td className="num">{fmtM(d.p90AbsErrorM)}</td>
                    <td className="num">{d.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}
