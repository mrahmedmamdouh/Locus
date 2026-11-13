import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isoToLocalInput, localInputToIso, offerState, type Api, type Mall, type Merchant, type Offer, type OfferInput, type OfferStatus, type Store } from '../api';
import { useLoad } from './useLoad';

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Offers({ api }: { api: Api }) {
  const offers = useLoad(() => api.offers(), [api.baseUrl]);
  const malls = useLoad(() => api.malls(), [api.baseUrl]);
  const merchants = useLoad(() => api.merchants(), [api.baseUrl]);
  const [editing, setEditing] = useState<Offer | 'new' | null>(null);
  const [filter, setFilter] = useState<'all' | 'live' | 'draft' | 'paused' | 'ended'>('all');
  const mallName = (id: string | null) => (id ? (malls.data?.find((m) => m.id === id)?.name ?? id) : 'All branches');

  const shown = useMemo(
    () => (offers.data ?? []).filter((o) => filter === 'all' || offerState(o) === filter || (filter === 'live' && offerState(o) === 'scheduled')),
    [offers.data, filter],
  );

  if (editing) {
    return (
      <OfferEditor
        api={api}
        offer={editing === 'new' ? null : editing}
        malls={malls.data ?? []}
        merchants={merchants.data ?? []}
        onDone={(changed) => {
          setEditing(null);
          if (changed) void offers.reload();
        }}
      />
    );
  }

  const setStatus = async (o: Offer, status: OfferStatus) => {
    try {
      await api.updateOffer(o.id, { status });
      void offers.reload();
    } catch (e) {
      alertError(e);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Offers</h2>
          <p className="muted">Offers are shown to your customers when they arrive at a mall, or reach the floor you choose. One offer per floor per visit.</p>
        </div>
        <button className="primary" onClick={() => setEditing('new')} disabled={!merchants.data?.length}>
          New offer
        </button>
      </div>
      {merchants.data && merchants.data.length === 0 && <p className="note">Add a merchant first (Merchants tab), then create offers for it.</p>}
      <div className="filters" role="group" aria-label="Filter">
        {(['all', 'live', 'draft', 'paused', 'ended'] as const).map((f) => (
          <button key={f} className={filter === f ? 'chip active' : 'chip'} onClick={() => setFilter(f)}>
            {f === 'live' ? 'live & scheduled' : f}
          </button>
        ))}
      </div>
      {offers.error && <p className="error">{offers.error}</p>}
      {offers.loading && !offers.data ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="muted">No offers here yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Offer</th>
                <th>Where</th>
                <th>When</th>
                <th>Priority</th>
                <th>State</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const state = offerState(o);
                return (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.title}</strong>
                      <div className="muted small">{o.merchant.name}</div>
                    </td>
                    <td>
                      {mallName(o.mallId)}
                      <div className="muted small">
                        {o.allBranches ? 'Each branch’s floor' : (o.floorLabel ?? 'Whole mall')}
                        {o.storeName ? ` · ${o.storeName}` : ''}
                        {o.segments ? ` · ${o.segments.join(', ')}` : ''}
                      </div>
                    </td>
                    <td className="small">
                      {fmt(o.startsAt)}
                      <div className="muted">to {fmt(o.endsAt)}</div>
                    </td>
                    <td>{o.priority}</td>
                    <td>
                      <span className={`badge ${state}`}>{state}</span>
                    </td>
                    <td className="actions">
                      <button className="link" onClick={() => setEditing(o)}>
                        Edit
                      </button>
                      {o.status === 'active' ? (
                        <button className="link" onClick={() => setStatus(o, 'paused')}>
                          Pause
                        </button>
                      ) : (
                        <button className="link" onClick={() => setStatus(o, 'active')}>
                          Activate
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function branchNote(m: Merchant | undefined): string {
  if (!m) return '';
  return m.branchCount === 0 ? 'This merchant has no branches yet: add them on the Merchants tab.' : `Shown on the floor of each of its ${m.branchCount} branches.`;
}

function alertError(e: unknown) {
  window.alert(e instanceof Error ? e.message : String(e));
}

function OfferEditor({ api, offer, malls, merchants, onDone }: { api: Api; offer: Offer | null; malls: Mall[]; merchants: Merchant[]; onDone: (changed: boolean) => void }) {
  const pilot = malls.filter((m) => m.status === 'pilot');
  const listed = malls.filter((m) => m.status !== 'pilot');
  const now = new Date();
  const [merchantId, setMerchantId] = useState(offer?.merchant.id ?? merchants[0]?.id ?? '');
  const [allBranches, setAllBranches] = useState(offer?.allBranches ?? false);
  const [mallId, setMallId] = useState(offer?.mallId ?? pilot[0]?.id ?? malls[0]?.id ?? '');
  const [titleAr, setTitleAr] = useState(offer?.titleAr ?? '');
  const [bodyAr, setBodyAr] = useState(offer?.bodyAr ?? '');
  const [segments, setSegments] = useState(offer?.segments?.join(', ') ?? '');
  const [maxDeliveries, setMaxDeliveries] = useState(offer?.maxDeliveries == null ? '' : String(offer.maxDeliveries));
  const [maxConversions, setMaxConversions] = useState(offer?.maxConversions == null ? '' : String(offer.maxConversions));
  const [holdoutPct, setHoldoutPct] = useState(offer?.holdoutPct ?? 10);
  const [floor, setFloor] = useState<string>(offer?.floorIndex == null ? '' : String(offer.floorIndex));
  const [store, setStore] = useState<{ id: string; name: string } | null>(offer?.storeId ? { id: offer.storeId, name: offer.storeName ?? offer.storeId } : null);
  const [title, setTitle] = useState(offer?.title ?? '');
  const [body, setBody] = useState(offer?.body ?? '');
  const [ctaUrl, setCtaUrl] = useState(offer?.ctaUrl ?? '');
  const [startsAt, setStartsAt] = useState(isoToLocalInput(offer?.startsAt ?? now.toISOString()));
  const [endsAt, setEndsAt] = useState(isoToLocalInput(offer?.endsAt ?? new Date(now.getTime() + 30 * 86_400_000).toISOString()));
  const [priority, setPriority] = useState(offer?.priority ?? 0);
  const [cap, setCap] = useState(offer?.dailyCapPerUser ?? 1);
  const [status, setStatus] = useState<OfferStatus>(offer?.status ?? 'draft');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [stores, setStores] = useState<Store[]>([]);
  const mall = malls.find((m) => m.id === mallId);

  useEffect(() => {
    if (!mallId || q.trim().length < 2) {
      setStores([]);
      return;
    }
    const t = setTimeout(() => {
      api.stores(mallId, q.trim()).then(setStores, () => setStores([]));
    }, 250);
    return () => clearTimeout(t);
  }, [api, mallId, q]);

  const pickStore = (s: Store) => {
    setStore({ id: s.id, name: s.name });
    if (s.floorIndex !== null) setFloor(String(s.floorIndex));
    setQ('');
    setStores([]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const s = localInputToIso(startsAt);
    const en = localInputToIso(endsAt);
    if (!s || !en) return setError('Enter a start and an end.');
    const segs = segments
      .split(/[,\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const input: OfferInput = {
      merchantId,
      allBranches,
      ...(allBranches ? {} : { mallId }),
      floorIndex: allBranches || floor === '' ? null : Number(floor),
      storeId: allBranches ? null : (store?.id ?? null),
      title: title.trim(),
      body: body.trim(),
      titleAr: titleAr.trim() || null,
      bodyAr: bodyAr.trim() || null,
      segments: segs.length ? segs : null,
      maxDeliveries: maxDeliveries ? Number(maxDeliveries) : null,
      maxConversions: maxConversions ? Number(maxConversions) : null,
      holdoutPct,
      ctaUrl: ctaUrl.trim() || null,
      startsAt: s,
      endsAt: en,
      priority,
      dailyCapPerUser: cap,
      status,
    };
    setBusy(true);
    try {
      if (offer) await api.updateOffer(offer.id, input);
      else await api.createOffer(input);
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!offer || !window.confirm(`Delete “${offer.title}”? Its report history stays.`)) return;
    try {
      await api.deleteOffer(offer.id);
      onDone(true);
    } catch (e) {
      alertError(e);
    }
  };

  return (
    <section>
      <div className="section-head">
        <h2>{offer ? 'Edit offer' : 'New offer'}</h2>
        <button className="link" onClick={() => onDone(false)}>
          Back to offers
        </button>
      </div>
      <form className="card form" onSubmit={submit}>
        <div className="grid2">
          <label>
            Merchant
            <select value={merchantId} onChange={(e) => setMerchantId(e.target.value)} required>
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="where">
            <legend>Where</legend>
            <label className="check">
              <input type="radio" checked={!allBranches} onChange={() => setAllBranches(false)} /> One mall
            </label>
            <label className="check">
              <input type="radio" checked={allBranches} onChange={() => setAllBranches(true)} /> All the merchant’s branches
            </label>
            {allBranches && <span className="muted small">{branchNote(merchants.find((m) => m.id === merchantId))}</span>}
          </fieldset>
          {!allBranches && (
          <>
          <label>
            Mall
            <select
              value={mallId}
              onChange={(e) => {
                setMallId(e.target.value);
                setFloor('');
                setStore(null);
              }}
              required
            >
              <optgroup label="Pilot malls (offers are delivered)">
                {pilot.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
              {listed.length > 0 && (
                <optgroup label="Catalogue only (not delivered yet)">
                  {listed.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <label>
            Store <span className="muted">(optional, sets the floor)</span>
            {store ? (
              <span className="picked">
                {store.name}
                <button type="button" className="link" onClick={() => setStore(null)}>
                  Remove
                </button>
              </span>
            ) : (
              <>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the mall directory" />
                {stores.length > 0 && (
                  <ul className="suggest" role="listbox">
                    {stores.slice(0, 8).map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => pickStore(s)}>
                          {s.name}
                          <span className="muted small"> {s.floorIndex === null ? '' : `· ${mall?.floors.find((f) => f.index === s.floorIndex)?.label ?? `floor ${s.floorIndex}`}`}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </label>
          <label>
            Floor
            <select value={floor} onChange={(e) => setFloor(e.target.value)}>
              <option value="">Whole mall (also for phones that cannot tell the floor)</option>
              {mall?.floors.map((f) => (
                <option key={f.index} value={String(f.index)}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          </>
          )}
        </div>
        <label>
          Title <span className="muted">({title.length}/80)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required placeholder="20% off with your card" />
        </label>
        <label>
          Details <span className="muted">({body.length}/280)</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={280} rows={3} placeholder="Valid on purchases over 10 OMR. Show your card at the till." />
        </label>
        <div className="grid2">
          <label>
            Title in Arabic <span className="muted">(optional, {titleAr.length}/80)</span>
            <input value={titleAr} onChange={(e) => setTitleAr(e.target.value)} maxLength={80} dir="rtl" lang="ar" placeholder="خصم ٢٠٪ عند الدفع ببطاقتك" />
          </label>
          <label>
            Details in Arabic <span className="muted">(optional, {bodyAr.length}/280)</span>
            <textarea value={bodyAr} onChange={(e) => setBodyAr(e.target.value)} maxLength={280} rows={2} dir="rtl" lang="ar" />
          </label>
        </div>
        <label>
          Link <span className="muted">(optional, https)</span>
          <input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} type="url" placeholder="https://yourbank.example/offers/costa" />
        </label>
        <div className="grid2">
          <label>
            Starts
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
          </label>
          <label>
            Ends
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
          </label>
          <label>
            Priority <span className="muted">(0–100, higher first)</span>
            <input type="number" min={0} max={100} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
          </label>
          <label>
            Times per customer per day
            <input type="number" min={1} max={10} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
          </label>
          <label>
            Customer segments <span className="muted">(optional, comma-separated; empty = everyone)</span>
            <input value={segments} onChange={(e) => setSegments(e.target.value)} placeholder="visa-infinite, salary" />
          </label>
          <label>
            Stop after this many offers shown <span className="muted">(optional)</span>
            <input type="number" min={1} value={maxDeliveries} onChange={(e) => setMaxDeliveries(e.target.value)} />
          </label>
          <label>
            Stop after this many purchases <span className="muted">(optional)</span>
            <input type="number" min={1} value={maxConversions} onChange={(e) => setMaxConversions(e.target.value)} />
          </label>
          <label>
            Control group <span className="muted">(% never shown, to measure the effect)</span>
            <input type="number" min={0} max={50} value={holdoutPct} onChange={(e) => setHoldoutPct(Number(e.target.value))} />
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as OfferStatus)}>
              <option value="draft">Draft (not shown)</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </label>
        </div>
        <div className="row wrap">
          <div className="preview" aria-label="Notification preview">
            <span className="muted small">Preview</span>
            <strong>{title || 'Offer title'}</strong>
            <span>{body || (allBranches ? 'At the nearest branch' : `${store?.name ? `${store.name}, ` : ''}${mall?.name ?? ''}`)}</span>
          </div>
          {(titleAr || bodyAr) && (
            <div className="preview" dir="rtl" lang="ar" aria-label="Arabic preview">
              <span className="muted small">معاينة</span>
              <strong>{titleAr || title}</strong>
              <span>{bodyAr || body}</span>
            </div>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : offer ? 'Save changes' : 'Create offer'}
          </button>
          {offer && (
            <button type="button" className="danger" onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
