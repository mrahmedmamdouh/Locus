/** Typed calls to the Locus admin API with the client's secret key. */
export interface FloorInfo {
  index: number;
  label: string;
  zMinM: number;
  zMaxM: number;
}
export interface Mall {
  id: string;
  name: string;
  city: string;
  country: string;
  status: 'pilot' | 'listed';
  boundary: { lat: number; lon: number; radiusM: number };
  entranceFloorIndex: number;
  floors: FloorInfo[];
  storeCount: number;
}
export interface Store {
  id: string;
  name: string;
  floorIndex: number | null;
  unit: string | null;
  category: string | null;
}
export interface Merchant {
  id: string;
  name: string;
  category: string | null;
  offerCount: number;
}
export type OfferStatus = 'draft' | 'active' | 'paused';
export interface Offer {
  id: string;
  merchant: { id: string; name: string | null };
  mallId: string;
  floorIndex: number | null;
  floorLabel: string | null;
  storeId: string | null;
  storeName: string | null;
  title: string;
  body: string;
  ctaUrl: string | null;
  startsAt: string;
  endsAt: string;
  priority: number;
  dailyCapPerUser: number;
  status: OfferStatus;
  updatedAt: string;
}
export interface OfferInput {
  merchantId: string;
  mallId: string;
  floorIndex: number | null;
  storeId: string | null;
  title: string;
  body: string;
  ctaUrl: string | null;
  startsAt: string;
  endsAt: string;
  priority: number;
  dailyCapPerUser: number;
  status: OfferStatus;
}
export interface Summary {
  from: string;
  to: string;
  arrivals: number;
  uniqueInstalls: number;
  byMall: { mallId: string; name: string | null; arrivals: number; uniqueInstalls: number }[];
  byFloor: { mallId: string; floorIndex: number; floorLabel: string | null; visits: number }[];
  offers: { offerId: string; title: string | null; delivered: number; opened: number; dismissed: number; openRate: number | null }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the API. Check the address and your connection.');
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? `Request failed (${res.status}).`);
    return json as T;
  }

  me = () => this.req<{ tenant: { id: string; name: string; country: string } }>('GET', '/v1/admin/me');
  malls = () => this.req<{ malls: Mall[] }>('GET', '/v1/admin/malls').then((r) => r.malls);
  stores = (mallId: string, q: string) => this.req<{ stores: Store[] }>('GET', `/v1/admin/malls/${encodeURIComponent(mallId)}/stores?q=${encodeURIComponent(q)}`).then((r) => r.stores);
  merchants = () => this.req<{ merchants: Merchant[] }>('GET', '/v1/admin/merchants').then((r) => r.merchants);
  createMerchant = (name: string, category: string | null) => this.req<{ merchant: Merchant }>('POST', '/v1/admin/merchants', { name, category });
  updateMerchant = (id: string, name: string, category: string | null) => this.req('PATCH', `/v1/admin/merchants/${id}`, { name, category });
  deleteMerchant = (id: string) => this.req('DELETE', `/v1/admin/merchants/${id}`);
  offers = () => this.req<{ offers: Offer[] }>('GET', '/v1/admin/offers').then((r) => r.offers);
  createOffer = (o: OfferInput) => this.req<{ offer: Offer }>('POST', '/v1/admin/offers', o);
  updateOffer = (id: string, o: Partial<OfferInput>) => this.req<{ offer: Offer }>('PATCH', `/v1/admin/offers/${id}`, o);
  deleteOffer = (id: string) => this.req('DELETE', `/v1/admin/offers/${id}`);
  summary = (from: string, to: string) => this.req<Summary>('GET', `/v1/admin/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

/** datetime-local value (browser local time) → ISO with Z, or null. */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** ISO → datetime-local value in browser local time. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whether an offer is live now, scheduled, ended, or not active. */
export function offerState(o: Pick<Offer, 'status' | 'startsAt' | 'endsAt'>, now = new Date()): 'live' | 'scheduled' | 'ended' | 'draft' | 'paused' {
  if (o.status !== 'active') return o.status;
  const t = now.getTime();
  if (t < Date.parse(o.startsAt)) return 'scheduled';
  if (t >= Date.parse(o.endsAt)) return 'ended';
  return 'live';
}
