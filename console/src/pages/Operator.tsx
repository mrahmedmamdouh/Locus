import { useState, type FormEvent } from 'react';
import { importCatalogue, PlatformApi, type Tenant } from '../operator';
import { useLoad } from './useLoad';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Locus operator screens: clients and their keys, and the places catalogue. */
export function Operator({ api, tab }: { api: PlatformApi; tab: 'clients' | 'catalogue' }) {
  return tab === 'clients' ? <Clients api={api} /> : <Catalogue api={api} />;
}

function Clients({ api }: { api: PlatformApi }) {
  const list = useLoad(() => api.tenants(), [api.baseUrl]);
  const [name, setName] = useState('Demo Bank');
  const [id, setId] = useState('demo-bank');
  const [country, setCountry] = useState('OM');
  const [shown, setShown] = useState<{ title: string; lines: [string, string][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState<string | null>(null);

  const fillDemo = async (t: Tenant) => {
    if (!window.confirm(`Replace everything in ${t.name} with demo data? Its merchants, offers, visits and purchases are deleted first.`)) return;
    setError(null);
    try {
      const r = await api.loadDemoData(t.id, (done, total) => setDemo(`Loading demo data into ${t.name}: ${Math.round((done / total) * 100)}%`));
      setDemo(`${t.name}: ${r.merchants} merchants (${r.branches} branches matched), ${r.offers} offers and four weeks of activity from ${r.customers} customers. Open it as the bank to see the reports.`);
    } catch (err) {
      setDemo(null);
      setError(errText(err));
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.createTenant({ id: id.trim(), name: name.trim(), country });
      setShown({
        title: `${r.tenant.name}: keys (shown once — copy them now)`,
        lines: [
          ['Publishable key (apps, demo app)', r.keys.publishable],
          ['Secret key (console sign-in, bank servers)', r.keys.secret],
        ],
      });
      void list.reload();
    } catch (err) {
      setError(errText(err));
    }
  };

  const issue = async (t: Tenant, kind: 'publishable' | 'secret') => {
    if (!window.confirm(`Create a new ${kind} key for ${t.name}? Old keys keep working until you revoke them.`)) return;
    try {
      const r = await api.newKey(t.id, kind);
      setShown({ title: `${t.name}: new ${kind} key (shown once)`, lines: [[kind === 'secret' ? 'Secret key' : 'Publishable key', r.key.key]] });
      void list.reload();
    } catch (err) {
      setError(errText(err));
    }
  };

  const revoke = async (t: Tenant, keyId: string, prefix: string) => {
    if (!window.confirm(`Revoke ${prefix}… of ${t.name}? Apps or staff using it stop working at once.`)) return;
    try {
      await api.revokeKey(keyId);
      void list.reload();
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Clients</h2>
          <p className="muted">Banks and fintechs using Locus. Each gets a publishable key for its app and a secret key for its staff and servers.</p>
        </div>
      </div>
      {shown && (
        <div className="card keys">
          <h3>{shown.title}</h3>
          {shown.lines.map(([label, value]) => (
            <div key={value} className="key-row">
              <span className="muted small">{label}</span>
              <code>{value}</code>
              <button className="link" onClick={() => void navigator.clipboard?.writeText(value)}>
                Copy
              </button>
            </div>
          ))}
          <p className="muted small">Locus stores only a fingerprint of each key; it cannot show them again. Keep them in a password manager.</p>
          <button className="secondary" onClick={() => setShown(null)}>
            I saved them
          </button>
        </div>
      )}
      <form className="card row wrap" onSubmit={create}>
        <label className="grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <label>
          Id
          <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} required pattern="[a-z0-9][a-z0-9\-]{1,63}" />
        </label>
        <label>
          Country
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="OM">Oman</option>
            <option value="EG">Egypt</option>
          </select>
        </label>
        <button className="primary align-end">Create client</button>
      </form>
      {error && <p className="error">{error}</p>}
      {demo && <p className="note">{demo}</p>}
      {list.error && <p className="error">{list.error}</p>}
      {list.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Keys</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.name}</strong>
                    <div className="muted small">
                      {t.id} · {t.country}
                    </div>
                  </td>
                  <td className="small">
                    {t.keys.map((k) => (
                      <div key={k.id}>
                        <code>{k.prefix}…</code> {k.kind}
                        {k.revokedAt ? (
                          <span className="muted"> · revoked</span>
                        ) : (
                          <button className="link danger-text" onClick={() => revoke(t, k.id, k.prefix)}>
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                  </td>
                  <td className="actions">
                    <button className="link" onClick={() => issue(t, 'publishable')}>
                      New app key
                    </button>
                    <button className="link" onClick={() => issue(t, 'secret')}>
                      New secret key
                    </button>
                    {t.id.startsWith('demo') && (
                      <button className="link" onClick={() => fillDemo(t)} title="Sample merchants, offers and four weeks of visits and purchases">
                        Fill with demo data
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Catalogue({ api }: { api: PlatformApi }) {
  const [malls, setMalls] = useState<File | null>(null);
  const [stores, setStores] = useState<File | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (!malls || !stores) return;
    setBusy(true);
    setError(null);
    try {
      const r = await importCatalogue(api, await malls.text(), await stores.text(), (done, total, mall) => setProgress(done < total ? `Loading ${mall} (${done + 1} of ${total})…` : 'Finishing…'));
      setProgress(`Done: ${r.malls} malls and ${r.stores} stores loaded.`);
    } catch (err) {
      setError(errText(err));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Places catalogue</h2>
          <p className="muted">
            Load or refresh the malls and stores (the Locus catalogue files <code>malls.csv</code> and <code>stores.csv</code>). The three pilot malls keep their measured floors; the
            others are listed with standard 5.5 m floors. Safe to run again: stores are updated, not duplicated.
          </p>
        </div>
      </div>
      <form className="card form" onSubmit={run}>
        <div className="grid2">
          <label>
            malls.csv
            <input type="file" accept=".csv,text/csv" onChange={(e) => setMalls(e.target.files?.[0] ?? null)} required />
          </label>
          <label>
            stores.csv
            <input type="file" accept=".csv,text/csv" onChange={(e) => setStores(e.target.files?.[0] ?? null)} required />
          </label>
        </div>
        {progress && <p className={progress.startsWith('Done') ? 'ok-text' : 'muted'}>{progress}</p>}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="primary" disabled={busy || !malls || !stores}>
            {busy ? 'Loading…' : 'Load catalogue'}
          </button>
        </div>
      </form>
    </section>
  );
}
