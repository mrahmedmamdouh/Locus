import { useState } from 'react';
import type { Api } from '../api';
import { useLoad } from './useLoad';

export function Malls({ api }: { api: Api }) {
  const malls = useLoad(() => api.malls(), [api.baseUrl]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const stores = useLoad(() => (open ? api.stores(open, q) : Promise.resolve([])), [api.baseUrl, open, q]);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Malls</h2>
          <p className="muted">The places catalogue Locus maintains. Pilot malls have measured floor heights and receive offers; the others are listed for planning.</p>
        </div>
      </div>
      {malls.error && <p className="error">{malls.error}</p>}
      <div className="cards">
        {malls.data?.map((m) => (
          <article key={m.id} className={`card mall ${m.status}`}>
            <header>
              <strong>{m.name}</strong>
              <span className={`badge ${m.status === 'pilot' ? 'live' : 'draft'}`}>{m.status}</span>
            </header>
            <p className="muted small">
              {m.city} · {m.storeCount} stores · radius {Math.round(m.boundary.radiusM)} m
            </p>
            <ol className="floors" reversed>
              {[...m.floors].reverse().map((f) => (
                <li key={f.index} className={f.index === m.entranceFloorIndex ? 'entrance' : ''}>
                  {f.label}
                  {f.index === m.entranceFloorIndex && <span className="muted small"> · entrance</span>}
                </li>
              ))}
            </ol>
            {m.storeCount > 0 && (
              <button className="link" onClick={() => (setOpen(open === m.id ? null : m.id), setQ(''))}>
                {open === m.id ? 'Hide stores' : 'Browse stores'}
              </button>
            )}
            {open === m.id && (
              <div className="stores">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name" aria-label="Filter stores" />
                <ul>
                  {stores.data?.map((s) => (
                    <li key={s.id}>
                      {s.name}
                      <span className="muted small"> {s.floorIndex === null ? '· floor unknown' : `· ${m.floors.find((f) => f.index === s.floorIndex)?.label ?? s.floorIndex}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
