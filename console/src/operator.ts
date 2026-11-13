import { parseCsv } from './api';

/** Calls to the Locus platform routes with the platform key (Locus operators only). */
export interface Tenant {
  id: string;
  name: string;
  country: string;
  createdAt: string;
  keys: { id: string; kind: 'publishable' | 'secret'; prefix: string; createdAt: string; revokedAt: string | null }[];
}

export class PlatformApi {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
  ) {}

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('Cannot reach the API. Check the address and your connection.');
    }
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status}).`);
    return json as T;
  }

  tenants = () => this.req<{ tenants: Tenant[] }>('GET', '/v1/platform/tenants').then((r) => r.tenants);
  createTenant = (t: { id: string; name: string; country: string }) =>
    this.req<{ tenant: { id: string; name: string; country: string }; keys: { publishable: string; secret: string } }>('POST', '/v1/platform/tenants', t);
  newKey = (tenantId: string, kind: 'publishable' | 'secret') => this.req<{ key: { key: string; prefix: string } }>('POST', `/v1/platform/tenants/${tenantId}/keys`, { kind });
  revokeKey = (keyId: string) => this.req('POST', `/v1/platform/keys/${keyId}/revoke`, {});
}

const PILOT = new Set(['mall-of-oman', 'oman-avenues-mall', 'city-centre-muscat']);
const FLOOR_M = 5.5;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function records(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/**
 * Loads the places catalogue (malls.csv + stores.csv from the Locus catalogue build) through the
 * platform routes. Same rules as api/scripts/catalogue.ts: pilot malls keep their measured floors;
 * other malls are listed with uniform 5.5 m floors.
 */
export async function importCatalogue(api: PlatformApi, mallsText: string, storesText: string, progress: (done: number, total: number, mall: string) => void) {
  const malls = records(mallsText);
  const stores = records(storesText);
  if (!malls.length || !('mall_id' in malls[0]!)) throw new Error('malls.csv needs a mall_id column.');
  if (!stores.length || !('store_name' in stores[0]!)) throw new Error('stores.csv needs mall_id and store_name columns.');
  let storeCount = 0;
  for (let n = 0; n < malls.length; n++) {
    const m = malls[n]!;
    const id = m.mall_id!;
    progress(n, malls.length, m.name ?? id);
    const own = stores.filter((s) => s.mall_id === id);
    if (!PILOT.has(id)) {
      const labelIndex = new Map<string, number>();
      for (const s of own) if (s.floor_label && s.floor_index !== '') labelIndex.set(s.floor_label.toLowerCase(), Number(s.floor_index));
      const labels = (m.floors ?? '').split('|').map((l) => l.trim()).filter(Boolean);
      const floors = labels.length ? labels.map((label, i) => ({ index: labelIndex.get(label.toLowerCase()) ?? i, label })) : [{ index: 0, label: 'Ground' }];
      const seen = new Set<number>();
      const clean = floors.filter((f) => !seen.has(f.index) && seen.add(f.index)).sort((a, b) => a.index - b.index);
      await api.req('PUT', `/v1/platform/malls/${id}`, {
        name: m.name,
        city: m.city || m.governorate || 'Oman',
        country: 'OM',
        lat: Number(m.lat),
        lon: Number(m.lon),
        radiusM: 300,
        entranceFloorIndex: clean.some((f) => f.index === 0) ? 0 : clean[0]!.index,
        status: 'listed',
        floors: clean.map((f) => ({ index: f.index, label: f.label, zMinM: f.index * FLOOR_M - FLOOR_M / 2, zMaxM: f.index * FLOOR_M + FLOOR_M / 2 })),
      });
    }
    const payload = own.map((s) => ({
      id: `${id}--${slug(s.store_name!)}${s.floor_index !== '' ? `--${s.floor_index}` : ''}`.slice(0, 100),
      name: s.store_name!.slice(0, 100),
      floorIndex: s.floor_index === '' || s.floor_index === undefined ? null : Number(s.floor_index),
      unit: s.unit ? s.unit.slice(0, 40) : null,
      category: s.category ? s.category.slice(0, 60) : null,
    }));
    for (let i = 0; i < payload.length; i += 100) await api.req('POST', `/v1/platform/malls/${id}/stores`, { stores: payload.slice(i, i + 100) });
    storeCount += own.length;
  }
  progress(malls.length, malls.length, '');
  return { malls: malls.length, stores: storeCount };
}
