import { useState } from 'react';
import type { Api } from '../api';
import { useLoad } from './useLoad';

const day = (d: Date) => d.toISOString().slice(0, 10);

export function Reports({ api }: { api: Api }) {
  const [from, setFrom] = useState(day(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(day(new Date()));
  const r = useLoad(() => api.summary(new Date(`${from}T00:00:00`).toISOString(), new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString()), [api.baseUrl, from, to]);
  const s = r.data;
  const maxFloor = Math.max(1, ...(s?.byFloor.map((f) => f.visits) ?? [1]));

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Reports</h2>
          <p className="muted">Counts from the SDK in your app. Locus stores results (arrived, floor, offer shown or opened), never where people were.</p>
        </div>
        <div className="row">
          <label>
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </div>
      {r.error && <p className="error">{r.error}</p>}
      {s && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="muted small">Mall visits</span>
              <strong>{s.arrivals.toLocaleString()}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Customers (app installs)</span>
              <strong>{s.uniqueInstalls.toLocaleString()}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Offers shown</span>
              <strong>{s.offers.reduce((a, o) => a + o.delivered, 0).toLocaleString()}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Offers opened</span>
              <strong>{s.offers.reduce((a, o) => a + o.opened, 0).toLocaleString()}</strong>
            </div>
          </div>

          <div className="grid2">
            <div className="card">
              <h3>By mall</h3>
              {s.byMall.length === 0 ? (
                <p className="muted">No visits in this period.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Mall</th>
                      <th className="num">Visits</th>
                      <th className="num">Customers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byMall.map((m) => (
                      <tr key={m.mallId}>
                        <td>{m.name ?? m.mallId}</td>
                        <td className="num">{m.arrivals}</td>
                        <td className="num">{m.uniqueInstalls}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="card">
              <h3>By floor</h3>
              {s.byFloor.length === 0 ? (
                <p className="muted">No floor data in this period.</p>
              ) : (
                <ul className="bars">
                  {s.byFloor.map((f) => (
                    <li key={`${f.mallId}:${f.floorIndex}`}>
                      <span className="bar-label">
                        {s.byMall.find((m) => m.mallId === f.mallId)?.name ?? f.mallId} · {f.floorLabel ?? f.floorIndex}
                      </span>
                      <span className="bar" style={{ width: `${(f.visits / maxFloor) * 100}%` }} />
                      <span className="num">{f.visits}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="card">
            <h3>Offers</h3>
            {s.offers.length === 0 ? (
              <p className="muted">No offers shown in this period.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Offer</th>
                    <th className="num">Shown</th>
                    <th className="num">Opened</th>
                    <th className="num">Dismissed</th>
                    <th className="num">Open rate</th>
                  </tr>
                </thead>
                <tbody>
                  {s.offers.map((o) => (
                    <tr key={o.offerId}>
                      <td>{o.title ?? <span className="muted">deleted offer</span>}</td>
                      <td className="num">{o.delivered}</td>
                      <td className="num">{o.opened}</td>
                      <td className="num">{o.dismissed}</td>
                      <td className="num">{o.openRate === null ? '—' : `${Math.round(o.openRate * 100)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}
