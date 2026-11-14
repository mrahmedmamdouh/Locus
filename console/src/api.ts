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
export interface Branch {
  storeId: string;
  storeName: string;
  mallId: string;
  mallName: string;
  floorIndex: number | null;
  floorLabel: string | null;
  source?: string;
  score?: number;
}
export interface Merchant {
  id: string;
  externalId: string | null;
  name: string;
  nameAr: string | null;
  category: string | null;
  mcc: string | null;
  offerCount: number;
  branchCount: number;
  midCount: number;
}
export interface MerchantFull {
  id: string;
  externalId: string | null;
  name: string;
  nameAr: string | null;
  category: string | null;
  mcc: string | null;
  mids: string[];
  branches: Branch[];
}
export interface MerchantInput {
  externalId?: string | null;
  name: string;
  nameAr?: string | null;
  category?: string | null;
  mcc?: string | null;
  mids?: string[];
  branches?: ({ storeId: string } | { mallId: string; storeName?: string })[];
  autoMatch?: boolean;
}
export interface ImportResult {
  dryRun: boolean;
  summary: { created: number; updated: number; skipped: number; branchesLinked: number; toReview: number };
  results: { row: number; name: string | null; action: 'create' | 'update' | 'skip'; merchantId: string | null; linked: Branch[]; review: Branch[]; errors: string[] }[];
}
export type OfferStatus = 'draft' | 'active' | 'paused';
export interface Offer {
  id: string;
  merchant: { id: string; name: string | null; nameAr: string | null };
  mallId: string | null;
  allBranches: boolean;
  floorIndex: number | null;
  floorLabel: string | null;
  storeId: string | null;
  storeName: string | null;
  title: string;
  body: string;
  titleAr: string | null;
  bodyAr: string | null;
  ctaUrl: string | null;
  startsAt: string;
  endsAt: string;
  priority: number;
  dailyCapPerUser: number;
  segments: string[] | null;
  maxDeliveries: number | null;
  maxConversions: number | null;
  holdoutPct: number;
  status: OfferStatus;
  updatedAt: string;
}
export interface OfferInput {
  merchantId: string;
  allBranches: boolean;
  mallId?: string;
  floorIndex: number | null;
  storeId: string | null;
  title: string;
  body: string;
  titleAr: string | null;
  bodyAr: string | null;
  ctaUrl: string | null;
  startsAt: string;
  endsAt: string;
  priority: number;
  dailyCapPerUser: number;
  segments: string[] | null;
  maxDeliveries: number | null;
  maxConversions: number | null;
  holdoutPct: number;
  status: OfferStatus;
}
export interface Settings {
  timezone: string;
  deliveryMode: 'sdk' | 'webhook';
  webhookUrl: string | null;
  webhookSecretSet: boolean;
  quietHours: { start: string; end: string } | null;
  maxPushesPerDay: number;
  consentMode: 'sdk' | 'bank';
  retentionDays: number;
}
export interface AuditEntry {
  actor: string;
  method: string;
  path: string;
  status: number;
  country: string | null;
  t: string;
}
export interface ConsentRecord {
  installId: string;
  customerRef: string | null;
  status: 'granted' | 'withdrawn';
  policyVersion: string;
  textHash: string | null;
  language: string | null;
  platform: string | null;
  source: string;
  t: string;
  receivedAt: string;
}
export interface Delivery {
  id: string;
  offerId: string;
  status: 'pending' | 'sent' | 'failed' | 'expired';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
export interface Summary {
  from: string;
  to: string;
  arrivals: number;
  uniqueInstalls: number;
  byMall: { mallId: string; name: string | null; arrivals: number; uniqueInstalls: number }[];
  byFloor: { mallId: string; floorIndex: number; floorLabel: string | null; visits: number }[];
  offers: {
    offerId: string;
    title: string | null;
    delivered: number;
    opened: number;
    dismissed: number;
    openRate: number | null;
    treatment: { customers: number; converted: number; purchases: number; revenue: number; rate: number | null };
    control: { customers: number; converted: number; rate: number | null };
    liftPts: number | null;
  }[];
  webhooks: Partial<Record<'pending' | 'sent' | 'failed' | 'expired', number>>;
  consent: { optedIn: number; optedOut: number };
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
  merchant = (id: string) => this.req<{ merchant: MerchantFull }>('GET', `/v1/admin/merchants/${id}`).then((r) => r.merchant);
  createMerchant = (m: MerchantInput) => this.req<{ merchant: MerchantFull }>('POST', '/v1/admin/merchants', m).then((r) => r.merchant);
  updateMerchant = (id: string, m: Partial<MerchantInput>) => this.req<{ merchant: MerchantFull }>('PATCH', `/v1/admin/merchants/${id}`, m).then((r) => r.merchant);
  deleteMerchant = (id: string) => this.req('DELETE', `/v1/admin/merchants/${id}`);
  setBranches = (id: string, storeIds: string[]) => this.req<{ merchant: MerchantFull }>('PUT', `/v1/admin/merchants/${id}/branches`, { storeIds }).then((r) => r.merchant);
  suggestions = (id: string) => this.req<{ suggestions: Branch[] }>('GET', `/v1/admin/merchants/${id}/suggestions`).then((r) => r.suggestions);
  importMerchants = (merchants: MerchantInput[], dryRun: boolean) => this.req<ImportResult>('POST', '/v1/admin/merchants/import', { merchants, dryRun });
  offers = () => this.req<{ offers: Offer[] }>('GET', '/v1/admin/offers').then((r) => r.offers);
  createOffer = (o: OfferInput) => this.req<{ offer: Offer }>('POST', '/v1/admin/offers', o);
  updateOffer = (id: string, o: Partial<OfferInput>) => this.req<{ offer: Offer }>('PATCH', `/v1/admin/offers/${id}`, o);
  deleteOffer = (id: string) => this.req('DELETE', `/v1/admin/offers/${id}`);
  settings = () => this.req<{ settings: Settings }>('GET', '/v1/admin/settings').then((r) => r.settings);
  updateSettings = (s: Partial<Omit<Settings, 'webhookSecretSet'>>) => this.req<{ settings: Settings }>('PATCH', '/v1/admin/settings', s).then((r) => r.settings);
  newWebhookSecret = () => this.req<{ secret: string }>('POST', '/v1/admin/settings/webhook-secret', {}).then((r) => r.secret);
  testWebhook = () => this.req<{ ok: boolean; status: number; error?: string }>('POST', '/v1/admin/settings/webhook-test', {});
  consents = (q: { installId?: string; customerRef?: string }) =>
    this.req<{ installs: string[]; records: ConsentRecord[] }>('GET', `/v1/admin/consents?${new URLSearchParams(q as Record<string, string>).toString()}`);
  forgetCustomer = (q: { installId?: string; customerRef?: string }) => this.req<{ erasedInstalls: number }>('POST', '/v1/admin/customers/forget', q);
  audit = () => this.req<{ entries: AuditEntry[] }>('GET', '/v1/admin/audit').then((r) => r.entries);
  deliveries = () => this.req<{ deliveries: Delivery[] }>('GET', '/v1/admin/deliveries').then((r) => r.deliveries);
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

/** Splits a CSV text into rows of cells (RFC 4180: quotes, doubled quotes, commas and newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * Merchant import file: one row per branch (or one row per merchant without branches).
 * Columns (header names, any order): external_id, name, name_ar, category, mcc, mids (separated
 * by ; or space), mall_id, store_name. Rows with the same external_id (or name) form one merchant.
 */
export function merchantsFromCsv(text: string): { merchants: MerchantInput[]; problems: string[] } {
  const rows = parseCsv(text);
  const problems: string[] = [];
  if (rows.length < 2) return { merchants: [], problems: ['The file has no data rows.'] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = (name: string) => header.indexOf(name);
  if (col('name') < 0) return { merchants: [], problems: ['The file needs a "name" column.'] };
  const byKey = new Map<string, MerchantInput>();
  rows.slice(1).forEach((r, i) => {
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
    const name = get('name');
    if (!name) {
      problems.push(`Row ${i + 2}: no name, skipped.`);
      return;
    }
    const externalId = get('external_id') || null;
    const key = externalId ?? name.toLowerCase();
    let m = byKey.get(key);
    if (!m) {
      m = { externalId, name, nameAr: get('name_ar') || null, category: get('category') || null, mcc: get('mcc') || null };
      byKey.set(key, m);
    }
    const mids = get('mids').split(/[;\s]+/).filter(Boolean);
    if (mids.length) m.mids = [...new Set([...(m.mids ?? []), ...mids])];
    const mallId = get('mall_id');
    if (mallId) m.branches = [...(m.branches ?? []), { mallId, ...(get('store_name') ? { storeName: get('store_name') } : {}) }];
  });
  return { merchants: [...byKey.values()], problems };
}
