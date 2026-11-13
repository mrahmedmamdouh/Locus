import { useEffect, useState, type FormEvent } from 'react';
import { Api } from './api';
import { Malls } from './pages/Malls';
import { Merchants } from './pages/Merchants';
import { Offers } from './pages/Offers';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Operator } from './pages/Operator';
import { PlatformApi } from './operator';

type Tab = 'offers' | 'merchants' | 'malls' | 'reports' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'offers', label: 'Offers' },
  { id: 'merchants', label: 'Merchants' },
  { id: 'malls', label: 'Malls' },
  { id: 'reports', label: 'Reports' },
  { id: 'settings', label: 'Settings' },
];
const SESSION_KEY = 'locus-console-session';
const DEFAULT_API = (import.meta.env.VITE_LOCUS_API_URL as string | undefined) ?? '';

interface Session {
  /** 'bank': a client's secret key; 'operator': the Locus platform key. */
  role?: 'bank' | 'operator';
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
  const [opTab, setOpTab] = useState<'clients' | 'catalogue'>('clients');

  const signOut = () => {
    saveSession(null);
    setSession(null);
  };

  if (!session) return <SignIn onSignedIn={(s) => (saveSession(s), setSession(s))} />;
  const operator = session.role === 'operator';
  const tabs = operator
    ? [
        { id: 'clients', label: 'Clients' },
        { id: 'catalogue', label: 'Catalogue' },
      ]
    : TABS;
  const current = operator ? opTab : tab;
  const api = new Api(session.apiUrl, session.key);
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
          {tabs.map((t) => (
            <button
              key={t.id}
              className={current === t.id ? 'tab active' : 'tab'}
              onClick={() => (operator ? setOpTab(t.id as 'clients' | 'catalogue') : setTab(t.id as Tab))}
              aria-current={current === t.id ? 'page' : undefined}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content">
        {operator && <Operator api={new PlatformApi(session.apiUrl, session.key)} tab={opTab} />}
        {!operator && tab === 'offers' && <Offers api={api} />}
        {!operator && tab === 'merchants' && <Merchants api={api} />}
        {!operator && tab === 'malls' && <Malls api={api} />}
        {!operator && tab === 'reports' && <Reports api={api} />}
        {!operator && tab === 'settings' && <Settings api={api} />}
      </main>
    </div>
  );
}

const LAST_API = 'locus-console-api-url';
function lastApiUrl(): string {
  try {
    return localStorage.getItem(LAST_API) ?? DEFAULT_API;
  } catch {
    return DEFAULT_API;
  }
}

function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [role, setRole] = useState<'bank' | 'operator'>('bank');
  const [apiUrl, setApiUrl] = useState(lastApiUrl);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), [apiUrl, key, role]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (role === 'bank' && !key.startsWith('lk_sec_')) return setError('Use your secret key (it starts with lk_sec_).');
    setBusy(true);
    try {
      const url = apiUrl.trim().replace(/\/$/, '');
      let tenantName: string;
      if (role === 'bank') {
        tenantName = (await new Api(url, key.trim()).me()).tenant.name;
      } else {
        await new PlatformApi(url, key.trim()).tenants();
        tenantName = 'Locus operator';
      }
      try {
        localStorage.setItem(LAST_API, url);
      } catch {
        // not remembered; fine
      }
      onSignedIn({ role, apiUrl: url, key: key.trim(), tenantName });
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
        <div className="filters" role="group" aria-label="Who are you">
          <button type="button" className={role === 'bank' ? 'chip active' : 'chip'} onClick={() => setRole('bank')}>
            Bank staff
          </button>
          <button type="button" className={role === 'operator' ? 'chip active' : 'chip'} onClick={() => setRole('operator')}>
            Locus operator
          </button>
        </div>
        <p className="muted">
          {role === 'bank' ? 'Manage your merchants and mall offers, and see how they perform.' : 'Create clients and their keys, and load the places catalogue.'}
        </p>
        <label>
          API address
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://locus-api.example.workers.dev" required inputMode="url" />
        </label>
        <label>
          {role === 'bank' ? 'Secret key' : 'Platform key'}
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder={role === 'bank' ? 'lk_sec_…' : 'LOCUS_PLATFORM_KEY'} required autoComplete="off" />
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
