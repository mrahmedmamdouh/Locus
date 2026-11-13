import { useState, type FormEvent } from 'react';
import { merchantsFromCsv, type Api, type Branch, type ImportResult, type Mall, type Merchant, type MerchantFull, type MerchantInput, type Store } from '../api';
import { useLoad } from './useLoad';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const splitMids = (s: string) => [...new Set(s.split(/[,;\s]+/).filter(Boolean))];

export function Merchants({ api }: { api: Api }) {
  const list = useLoad(() => api.merchants(), [api.baseUrl]);
  const [open, setOpen] = useState<string | 'new' | 'import' | null>(null);

  if (open === 'import') return <ImportFlow api={api} onDone={() => (setOpen(null), void list.reload())} />;
  if (open) return <MerchantDetail api={api} id={open === 'new' ? null : open} onDone={() => (setOpen(null), void list.reload())} />;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Merchants</h2>
          <p className="muted">Your merchant partners, where their branches are, and the merchant IDs on their card transactions. Other clients never see them.</p>
        </div>
        <div className="row">
          <button onClick={() => setOpen('import')} className="secondary">
            Import file
          </button>
          <button className="primary" onClick={() => setOpen('new')}>
            Add merchant
          </button>
        </div>
      </div>
      {list.error && <p className="error">{list.error}</p>}
      {list.data && list.data.length === 0 && <p className="muted">No merchants yet. Add one, or import your merchant list.</p>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Category</th>
                <th className="num">Branches</th>
                <th className="num">Merchant IDs</th>
                <th className="num">Offers</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m: Merchant) => (
                <tr key={m.id} className="clickable" onClick={() => setOpen(m.id)}>
                  <td>
                    <strong>{m.name}</strong>
                    {m.nameAr && (
                      <div className="muted small" dir="rtl" lang="ar">
                        {m.nameAr}
                      </div>
                    )}
                  </td>
                  <td>{m.category ?? <span className="muted">—</span>}</td>
                  <td className="num">{m.branchCount === 0 ? <span className="warn-text">0</span> : m.branchCount}</td>
                  <td className="num">{m.midCount}</td>
                  <td className="num">{m.offerCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MerchantDetail({ api, id, onDone }: { api: Api; id: string | null; onDone: () => void }) {
  const loaded = useLoad(() => (id ? api.merchant(id) : Promise.resolve(null)), [api.baseUrl, id]);
  const malls = useLoad(() => api.malls(), [api.baseUrl]);
  const [m, setM] = useState<MerchantFull | null>(null);
  const cur = m ?? loaded.data;
  const [form, setForm] = useState<{ name: string; nameAr: string; category: string; mcc: string; mids: string } | null>(null);
  const f = form ?? { name: cur?.name ?? '', nameAr: cur?.nameAr ?? '', category: cur?.category ?? '', mcc: cur?.mcc ?? '', mids: cur?.mids.join(', ') ?? '' };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggest, setSuggest] = useState<Branch[] | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const input = { name: f.name.trim(), nameAr: f.nameAr.trim() || null, category: f.category.trim() || null, mcc: f.mcc.trim() || null, mids: splitMids(f.mids) };
      const saved = cur ? await api.updateMerchant(cur.id, input) : await api.createMerchant(input);
      setM(saved);
      setForm(null);
      setError(null);
      if (!cur) setSuggest(await api.suggestions(saved.id));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const setBranches = async (storeIds: string[]) => {
    if (!cur) return;
    try {
      setM(await api.setBranches(cur.id, storeIds));
      if (suggest) setSuggest(suggest.filter((s) => !storeIds.includes(s.storeId)));
    } catch (err) {
      window.alert(errText(err));
    }
  };

  const remove = async () => {
    if (!cur || !window.confirm(`Delete ${cur.name}, its branches and offers?`)) return;
    try {
      await api.deleteMerchant(cur.id);
      onDone();
    } catch (err) {
      window.alert(errText(err));
    }
  };

  if (id && loaded.loading && !cur) return <p className="muted">Loading…</p>;
  const have = new Set(cur?.branches.map((b) => b.storeId));

  return (
    <section>
      <div className="section-head">
        <h2>{cur ? cur.name : 'New merchant'}</h2>
        <button className="link" onClick={onDone}>
          Back to merchants
        </button>
      </div>
      <form className="card form" onSubmit={save}>
        <div className="grid2">
          <label>
            Name
            <input value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} required maxLength={80} />
          </label>
          <label>
            Name in Arabic <span className="muted">(optional)</span>
            <input value={f.nameAr} onChange={(e) => setForm({ ...f, nameAr: e.target.value })} maxLength={80} dir="rtl" lang="ar" />
          </label>
          <label>
            Category
            <input value={f.category} onChange={(e) => setForm({ ...f, category: e.target.value })} maxLength={40} placeholder="Cafe" />
          </label>
          <label>
            MCC <span className="muted">(4 digits, optional)</span>
            <input value={f.mcc} onChange={(e) => setForm({ ...f, mcc: e.target.value })} maxLength={4} inputMode="numeric" placeholder="5814" />
          </label>
        </div>
        <label>
          Merchant IDs (MIDs) <span className="muted">— as on card transactions, separated by commas; used to measure purchases after an offer</span>
          <input value={f.mids} onChange={(e) => setForm({ ...f, mids: e.target.value })} placeholder="100001, 100002" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : cur ? 'Save' : 'Create merchant'}
          </button>
          {cur && (
            <button type="button" className="danger" onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </form>

      {cur && (
        <div className="card">
          <div className="section-head tight">
            <div>
              <h3>Branches</h3>
              <p className="muted small">Stores in the Locus mall catalogue. “All branches” offers are shown on each branch’s floor.</p>
            </div>
            <button className="secondary" onClick={async () => setSuggest(await api.suggestions(cur.id))}>
              Find in catalogue
            </button>
          </div>
          {cur.branches.length === 0 ? (
            <p className="muted">No branches yet.</p>
          ) : (
            <ul className="branch-list">
              {cur.branches.map((b) => (
                <li key={b.storeId}>
                  <span>
                    <strong>{b.mallName}</strong> · {b.floorLabel ?? 'floor unknown'} · {b.storeName}
                    {b.source === 'auto' && <span className="badge scheduled">matched</span>}
                  </span>
                  <button className="link danger-text" onClick={() => setBranches(cur.branches.filter((x) => x.storeId !== b.storeId).map((x) => x.storeId))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {suggest && (
            <div className="suggestions">
              <h4>Possible branches</h4>
              {suggest.filter((s) => !have.has(s.storeId)).length === 0 ? (
                <p className="muted small">No similar store names found. Search a mall below.</p>
              ) : (
                <ul className="branch-list">
                  {suggest
                    .filter((s) => !have.has(s.storeId))
                    .map((s) => (
                      <li key={s.storeId}>
                        <span>
                          <strong>{s.mallName}</strong> · {s.floorLabel ?? 'floor unknown'} · {s.storeName} <span className="muted small">{Math.round((s.score ?? 0) * 100)}% match</span>
                        </span>
                        <button className="link" onClick={() => setBranches([...have, s.storeId])}>
                          Add
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
          <StorePicker api={api} malls={malls.data ?? []} exclude={have} onPick={(s) => setBranches([...have, s.id])} />
        </div>
      )}
    </section>
  );
}

function StorePicker({ api, malls, exclude, onPick }: { api: Api; malls: Mall[]; exclude: Set<string>; onPick: (s: Store) => void }) {
  const [mallId, setMallId] = useState('');
  const [q, setQ] = useState('');
  const stores = useLoad(() => (mallId && q.trim().length >= 2 ? api.stores(mallId, q.trim()) : Promise.resolve([])), [api.baseUrl, mallId, q]);
  const mall = malls.find((m) => m.id === mallId);
  return (
    <div className="picker">
      <h4>Add a branch by hand</h4>
      <div className="row wrap">
        <label>
          Mall
          <select value={mallId} onChange={(e) => setMallId(e.target.value)}>
            <option value="">Choose a mall</option>
            {malls
              .filter((m) => m.storeCount > 0)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <label className="grow">
          Store name
          <input value={q} onChange={(e) => setQ(e.target.value)} disabled={!mallId} placeholder="Type 2+ letters" />
        </label>
      </div>
      {stores.data && stores.data.length > 0 && (
        <ul className="branch-list">
          {stores.data
            .filter((s) => !exclude.has(s.id))
            .slice(0, 10)
            .map((s) => (
              <li key={s.id}>
                <span>
                  {s.name} <span className="muted small">· {mall?.floors.find((f) => f.index === s.floorIndex)?.label ?? 'floor unknown'}</span>
                </span>
                <button className="link" onClick={() => onPick(s)}>
                  Add
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

const SAMPLE = 'external_id,name,name_ar,category,mcc,mids,mall_id,store_name\nM-1001,Costa Coffee,كوستا كوفي,Cafe,5814,100001;100002,mall-of-oman,Costa Coffee\nM-1001,Costa Coffee,,,,,oman-avenues-mall,\nM-1002,Carrefour,كارفور,Hypermarket,5411,200001,,\n';

function ImportFlow({ api, onDone }: { api: Api; onDone: () => void }) {
  const [rows, setRows] = useState<MerchantInput[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [plan, setPlan] = useState<ImportResult | null>(null);
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);

  const load = async (file: File) => {
    setError(null);
    setPlan(null);
    const text = await file.text();
    const r = merchantsFromCsv(text);
    setProblems(r.problems);
    if (!r.merchants.length) return setRows(null);
    if (r.merchants.length > 500) return setError('Up to 500 merchants per file; split the file.');
    setRows(r.merchants);
    setBusy(true);
    try {
      setPlan(await api.importMerchants(r.merchants, true));
      setPicked({});
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (row: number, storeId: string) => {
    const s = new Set(picked[row] ?? []);
    if (s.has(storeId)) s.delete(storeId);
    else s.add(storeId);
    setPicked({ ...picked, [row]: s });
  };

  const apply = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const res = await api.importMerchants(rows, false);
      for (const r of res.results) {
        const extra = picked[r.row];
        if (r.merchantId && extra?.size) {
          const current = await api.merchant(r.merchantId);
          await api.setBranches(r.merchantId, [...new Set([...current.branches.map((b) => b.storeId), ...extra])]);
        }
      }
      setDone(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const sampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + SAMPLE)}`;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Import merchants</h2>
          <p className="muted">
            A CSV file with one row per branch. Columns: <code>external_id, name, name_ar, category, mcc, mids, mall_id, store_name</code>. Without a mall, Locus looks for the merchant’s
            stores in every mall by name. Nothing is saved until you confirm.
          </p>
        </div>
        <button className="link" onClick={onDone}>
          Back to merchants
        </button>
      </div>
      {!done && (
        <div className="card row wrap">
          <label className="grow">
            CSV file
            <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
          </label>
          <a className="link align-end" href={sampleHref} download="locus-merchants-sample.csv">
            Download a sample file
          </a>
        </div>
      )}
      {busy && <p className="muted">Working…</p>}
      {error && <p className="error">{error}</p>}
      {problems.length > 0 && (
        <div className="note">
          {problems.slice(0, 5).map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      {done && (
        <div className="card">
          <h3>Imported</h3>
          <p>
            {done.summary.created} created, {done.summary.updated} updated, {done.summary.branchesLinked} branches linked automatically
            {Object.values(picked).reduce((a, s) => a + s.size, 0) > 0 && `, ${Object.values(picked).reduce((a, s) => a + s.size, 0)} added from review`}.
          </p>
          <button className="primary" onClick={onDone}>
            Done
          </button>
        </div>
      )}
      {plan && !done && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="muted small">New merchants</span>
              <strong>{plan.summary.created}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Updated</span>
              <strong>{plan.summary.updated}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Branches matched</span>
              <strong>{plan.summary.branchesLinked}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Possible matches to review</span>
              <strong>{plan.summary.toReview}</strong>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Matched branches</th>
                  <th>Review (tick to add)</th>
                </tr>
              </thead>
              <tbody>
                {plan.results.map((r) => (
                  <tr key={r.row}>
                    <td>
                      <strong>{r.name ?? `Row ${r.row + 2}`}</strong>
                      <div className="muted small">{r.action}</div>
                      {r.errors.map((e) => (
                        <div key={e} className="error-text small">
                          {e}
                        </div>
                      ))}
                    </td>
                    <td className="small">
                      {r.linked.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        r.linked.map((b) => (
                          <div key={b.storeId}>
                            {b.mallName} · {b.floorLabel ?? '?'} · {b.storeName}
                          </div>
                        ))
                      )}
                    </td>
                    <td className="small">
                      {r.review.map((b) => (
                        <label key={b.storeId} className="check">
                          <input type="checkbox" checked={picked[r.row]?.has(b.storeId) ?? false} onChange={() => toggle(r.row, b.storeId)} />
                          {b.mallName} · {b.floorLabel ?? '?'} · {b.storeName} <span className="muted">{Math.round((b.score ?? 0) * 100)}%</span>
                        </label>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" onClick={apply} disabled={busy}>
              Import {rows?.length} merchant(s)
            </button>
          </div>
        </>
      )}
    </section>
  );
}
