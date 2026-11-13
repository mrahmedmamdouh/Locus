import { useEffect, useState, type FormEvent } from 'react';
import type { Api, ConsentRecord, Settings as S } from '../api';
import { useLoad } from './useLoad';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Settings({ api }: { api: Api }) {
  const s = useLoad(() => api.settings(), [api.baseUrl]);
  const deliveries = useLoad(() => api.deliveries(), [api.baseUrl]);
  const [form, setForm] = useState<S | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (s.data) {
      setForm(s.data);
      setQuiet(!!s.data.quietHours);
    }
  }, [s.data]);

  if (!form) return s.error ? <p className="error">{s.error}</p> : <p className="muted">Loading…</p>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const saved = await api.updateSettings({
        timezone: form.timezone,
        maxPushesPerDay: form.maxPushesPerDay,
        quietHours: quiet ? (form.quietHours ?? { start: '22:00', end: '08:00' }) : null,
        webhookUrl: form.webhookUrl?.trim() || null,
        deliveryMode: form.deliveryMode,
        consentMode: form.consentMode,
      });
      s.setData(saved);
      setMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    }
  };

  const rotate = async () => {
    if (form.webhookSecretSet && !window.confirm('Create a new signing secret? The current one stops working at once.')) return;
    try {
      setSecret(await api.newWebhookSecret());
      setForm({ ...form, webhookSecretSet: true });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    }
  };

  const test = async () => {
    try {
      const r = await api.testWebhook();
      setMsg(r.ok ? { ok: true, text: `Your server answered ${r.status}.` } : { ok: false, text: `Test failed: ${r.status ? `HTTP ${r.status}` : r.error}` });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Settings</h2>
          <p className="muted">How and when your customers receive offers.</p>
        </div>
      </div>
      <form className="card form" onSubmit={save}>
        <h3>Limits</h3>
        <div className="grid2">
          <label>
            Offers per customer per day <span className="muted">(across all offers)</span>
            <input type="number" min={1} max={20} value={form.maxPushesPerDay} onChange={(e) => setForm({ ...form, maxPushesPerDay: Number(e.target.value) })} />
          </label>
          <label>
            Time zone
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              <option value="Asia/Muscat">Oman (Asia/Muscat)</option>
              <option value="Africa/Cairo">Egypt (Africa/Cairo)</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} /> Quiet hours: no offers between
        </label>
        {quiet && (
          <div className="row">
            <label>
              From
              <input type="time" value={form.quietHours?.start ?? '22:00'} onChange={(e) => setForm({ ...form, quietHours: { start: e.target.value, end: form.quietHours?.end ?? '08:00' } })} />
            </label>
            <label>
              To
              <input type="time" value={form.quietHours?.end ?? '08:00'} onChange={(e) => setForm({ ...form, quietHours: { start: form.quietHours?.start ?? '22:00', end: e.target.value } })} />
            </label>
          </div>
        )}

        <h3>Consent</h3>
        <label className="check">
          <input type="radio" checked={form.consentMode === 'sdk'} onChange={() => setForm({ ...form, consentMode: 'sdk' })} />
          <span>
            <strong>Recorded through the SDK</strong> (recommended). Your app shows the opt-in and calls setConsent; Locus keeps who agreed, when and to which wording, and serves
            nothing to customers who have not agreed.
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={form.consentMode === 'bank'} onChange={() => setForm({ ...form, consentMode: 'bank' })} />
          <span>
            <strong>Recorded by the bank.</strong> Your own systems hold the consent and your app starts the SDK only after it. Locus still logs any consent the SDK sends.
          </span>
        </label>

        <h3>Delivery</h3>
        <label className="check">
          <input type="radio" checked={form.deliveryMode === 'sdk'} onChange={() => setForm({ ...form, deliveryMode: 'sdk' })} />
          <span>
            <strong>In the app (SDK).</strong> The SDK hands the offer to your app the moment the customer reaches the floor; your app shows it.
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={form.deliveryMode === 'webhook'} onChange={() => setForm({ ...form, deliveryMode: 'webhook' })} />
          <span>
            <strong>Through your push service (webhook).</strong> Locus calls your server with the customer reference and the offer; you push it with Firebase, Braze or your own service.
          </span>
        </label>
        <label>
          Webhook address <span className="muted">(https)</span>
          <input type="url" value={form.webhookUrl ?? ''} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} placeholder="https://push.yourbank.example/locus" />
        </label>
        <div className="row wrap">
          <button type="button" className="secondary" onClick={rotate}>
            {form.webhookSecretSet ? 'New signing secret' : 'Create signing secret'}
          </button>
          <button type="button" className="secondary" onClick={test} disabled={!s.data?.webhookUrl || !form.webhookSecretSet}>
            Send a test
          </button>
        </div>
        {secret && (
          <div className="note">
            <strong>Signing secret (shown once):</strong> <code>{secret}</code>
            <div className="small">Store it on your server. Each call carries Locus-Signature: t=…,v1=HMAC-SHA256(secret, “t.body”).</div>
          </div>
        )}
        {msg && <p className={msg.ok ? 'ok-text' : 'error'}>{msg.text}</p>}
        <div className="row">
          <button className="primary">Save settings</button>
        </div>
      </form>

      <ConsentLookup api={api} />

      {deliveries.data && deliveries.data.length > 0 && (
        <div className="card">
          <h3>Recent webhook deliveries</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.slice(0, 20).map((d) => (
                  <tr key={d.id}>
                    <td className="small">{new Date(d.createdAt).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${d.status === 'sent' ? 'live' : d.status === 'pending' ? 'scheduled' : 'paused'}`}>{d.status}</span>
                    </td>
                    <td className="num">{d.attempts}</td>
                    <td className="small muted">{d.lastError ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** Look up a customer's consent history and erase their data (customer requests, audits). */
function ConsentLookup({ api }: { api: Api }) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{ installs: string[]; records: ConsentRecord[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const query = () => (q.trim().startsWith('install-') || /^[0-9a-f-]{36}$/.test(q.trim()) ? { installId: q.trim() } : { customerRef: q.trim() });

  const find = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      setResult(await api.consents(query()));
    } catch (err) {
      setMsg(errText(err));
    }
  };

  const erase = async () => {
    if (!window.confirm(`Erase all Locus data of ${q.trim()}? Visits, offers and purchases are deleted; the consent trail stays as proof.`)) return;
    try {
      const r = await api.forgetCustomer(query());
      setMsg(`Erased ${r.erasedInstalls} app install(s).`);
      setResult(await api.consents(query()));
    } catch (err) {
      setMsg(errText(err));
    }
  };

  return (
    <div className="card">
      <h3>Consent records</h3>
      <p className="muted small">Find a customer by your customer reference (or an install id) to see what they agreed to, and erase their data on request.</p>
      <form className="row wrap" onSubmit={find}>
        <label className="grow">
          Customer reference or install id
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="cust-7f3a" required />
        </label>
        <button className="secondary align-end">Look up</button>
      </form>
      {msg && <p className="note">{msg}</p>}
      {result && (
        <>
          {result.records.length === 0 ? (
            <p className="muted">No consent records.</p>
          ) : (
            <div className="table-wrap flat">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Choice</th>
                    <th>Wording</th>
                    <th>Install</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {result.records.map((r, i) => (
                    <tr key={i}>
                      <td className="small">{new Date(r.t).toLocaleString()}</td>
                      <td>
                        <span className={`badge ${r.status === 'granted' ? 'live' : 'paused'}`}>{r.status === 'granted' ? 'agreed' : 'withdrew'}</span>
                      </td>
                      <td className="small">
                        {r.policyVersion}
                        {r.language ? ` · ${r.language}` : ''}
                        {r.textHash && <div className="muted">text {r.textHash.slice(0, 12)}…</div>}
                      </td>
                      <td className="small muted">
                        {r.installId.slice(0, 13)}
                        {r.platform ? ` · ${r.platform}` : ''}
                      </td>
                      <td className="small">{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.installs.length > 0 && (
            <button className="danger" onClick={erase} style={{ marginTop: 12 }}>
              Erase this customer’s data
            </button>
          )}
        </>
      )}
    </div>
  );
}
