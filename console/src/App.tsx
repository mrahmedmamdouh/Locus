import { useEffect, useState, type FormEvent } from 'react';
import { Api } from './api';
import { Malls } from './pages/Malls';
import { Merchants } from './pages/Merchants';
import { Offers } from './pages/Offers';
import { Reports } from './pages/Reports';

type Tab = 'offers' | 'merchants' | 'malls' | 'reports';
const TABS: { id: Tab; label: string }[] = [
  { id: 'offers', label: 'Offers' },
  { id: 'merchants', label: 'Merchants' },
  { id: 'malls', label: 'Malls' },
  { id: 'reports', label: 'Reports' },
];
const SESSION_KEY = 'locus-console-session';
const DEFAULT_API = (import.meta.env.VITE_LOCUS_API_URL as string | undefined) ?? '';

interface Session {
  apiUrl: string;
  key: string;
  tenantName: string;
}

// The secret key lives only in this tab's session storage and is gone when the tab closes.
function loadSession(): Session | null {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    return s ? (JSON.parse(s) as Session) : null;
  } catch {
    return null;
  }
}
function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // private mode: the session lasts until reload
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [tab, setTab] = useState<Tab>('offers');
  const api = session ? new Api(session.apiUrl, session.key) : null;

  const signOut = () => {
    saveSession(null);
    setSession(null);
  };

  if (!session || !api) return <SignIn onSignedIn={(s) => (saveSession(s), setSession(s))} />;
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            L
          </span>
          <div>
            <strong>Locus Console</strong>
            <span className="muted">{session.tenantName}</span>
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              {t.label}
            </button>
          ))}
        </nav>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content">
        {tab === 'offers' && <Offers api={api} />}
        {tab === 'merchants' && <Merchants api={api} />}
        {tab === 'malls' && <Malls api={api} />}
        {tab === 'reports' && <Reports api={api} />}
      </main>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), [apiUrl, key]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.startsWith('lk_sec_')) return setError('Use your secret key (it starts with lk_sec_).');
    setBusy(true);
    try {
      const url = apiUrl.trim().replace(/\/$/, '');
      const me = await new Api(url, key.trim()).me();
      onSignedIn({ apiUrl: url, key: key.trim(), tenantName: me.tenant.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form className="card narrow" onSubmit={submit}>
        <h1>Locus Console</h1>
        <p className="muted">Manage your merchants and mall offers, and see how they perform.</p>
        <label>
          API address
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://locus-api.example.workers.dev" required inputMode="url" />
        </label>
        <label>
          Secret key
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="lk_sec_…" required autoComplete="off" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p className="muted small">The key stays in this browser tab only and is forgotten when you close it.</p>
      </form>
    </div>
  );
}
