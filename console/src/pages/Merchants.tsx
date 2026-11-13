import { useState, type FormEvent } from 'react';
import type { Api, Merchant } from '../api';
import { useLoad } from './useLoad';

export function Merchants({ api }: { api: Api }) {
  const list = useLoad(() => api.merchants(), [api.baseUrl]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createMerchant(name.trim(), category.trim() || null);
      setName('');
      setCategory('');
      setError(null);
      void list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rename = async (m: Merchant) => {
    const n = window.prompt('Merchant name', m.name);
    if (!n || n.trim() === m.name) return;
    try {
      await api.updateMerchant(m.id, n.trim(), m.category);
      void list.reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (m: Merchant) => {
    if (!window.confirm(`Delete ${m.name} and its ${m.offerCount} offer(s)?`)) return;
    try {
      await api.deleteMerchant(m.id);
      void list.reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Merchants</h2>
          <p className="muted">Your own merchant partners. Other clients never see them.</p>
        </div>
      </div>
      <form className="card row wrap" onSubmit={add}>
        <label className="grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Costa Coffee" />
        </label>
        <label>
          Category
          <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} placeholder="Cafe" />
        </label>
        <button className="primary align-end">Add merchant</button>
      </form>
      {error && <p className="error">{error}</p>}
      {list.error && <p className="error">{list.error}</p>}
      {list.data && list.data.length === 0 && <p className="muted">No merchants yet.</p>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Offers</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.name}</strong>
                  </td>
                  <td>{m.category ?? <span className="muted">—</span>}</td>
                  <td>{m.offerCount}</td>
                  <td className="actions">
                    <button className="link" onClick={() => rename(m)}>
                      Rename
                    </button>
                    <button className="link danger-text" onClick={() => remove(m)}>
                      Delete
                    </button>
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
