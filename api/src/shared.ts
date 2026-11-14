import type { Context } from 'hono';
import type { Db } from './db';
import { ApiError, bad, obj } from './validate';
import type { FetchLike } from './webhook';

export interface AppDeps {
  db: Db;
  /** SHA-256 hex of the Locus platform key (operators only). Null disables the platform routes. */
  platformKeyHash: string | null;
  /** Browser origins allowed to call the admin routes (the bank console). */
  consoleOrigins: string[];
  now?: () => Date;
  /** HTTP client for bank webhooks (default: global fetch). */
  fetchImpl?: FetchLike;
  /** Keeps background work alive after the response (Workers: ctx.waitUntil). */
  defer?: (p: Promise<unknown>) => void;
}

export interface Services {
  db: Db;
  now: () => Date;
  fetchImpl: FetchLike;
  defer: (p: Promise<unknown>) => void;
}

export type Vars = { tenantId: string };
export type Ctx = Context<{ Variables: Vars }>;

export const COUNTRIES = ['OM', 'EG'] as const;
export const OFFER_STATUSES = ['draft', 'active', 'paused'] as const;
export const EVENT_TYPES = ['arrived', 'floor', 'left', 'offer_delivered', 'offer_opened', 'offer_dismissed'] as const;
export const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_BODY_BYTES = 512 * 1024;

export interface MallRow {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  radius_m: number;
  entrance_floor_index: number;
  status: string;
  updated_at: string;
}
export interface FloorRow {
  mall_id: string;
  floor_index: number;
  label: string;
  z_min_m: number;
  z_max_m: number;
}
export interface OfferRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  merchant_name?: string;
  merchant_name_ar?: string | null;
  mall_id: string | null;
  floor_index: number | null;
  store_id: string | null;
  store_name?: string | null;
  all_branches: number;
  title: string;
  body: string;
  title_ar: string | null;
  body_ar: string | null;
  cta_url: string | null;
  starts_at: string;
  ends_at: string;
  priority: number;
  daily_cap_per_user: number;
  segments: string | null;
  max_deliveries: number | null;
  max_conversions: number | null;
  holdout_pct: number;
  status: string;
  created_at: string;
  updated_at: string;
}
export interface TenantRow {
  id: string;
  name: string;
  country: string;
  timezone: string;
  delivery_mode: 'sdk' | 'webhook';
  webhook_url: string | null;
  webhook_secret: string | null;
  quiet_start: string | null;
  quiet_end: string | null;
  max_pushes_per_day: number;
  consent_mode: 'sdk' | 'bank';
  retention_days: number;
}

export const OFFER_SELECT = `SELECT o.*, m.name AS merchant_name, m.name_ar AS merchant_name_ar, s.name AS store_name FROM offers o
  JOIN merchants m ON m.id = o.merchant_id LEFT JOIN stores s ON s.id = o.store_id`;

export async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', 'Request body is too large.');
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', 'Request body is too large.');
  try {
    return obj(JSON.parse(text));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw bad('Body must be JSON.');
  }
}

export const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');

export async function floorsByMall(db: Db, mallIds: string[]): Promise<Map<string, FloorRow[]>> {
  const map = new Map<string, FloorRow[]>();
  const ids = [...new Set(mallIds)];
  if (ids.length === 0) return map;
  const rows = await db.all<FloorRow>(`SELECT * FROM floors WHERE mall_id IN (${inList(ids.length)}) ORDER BY floor_index`, ids);
  for (const r of rows) map.set(r.mall_id, [...(map.get(r.mall_id) ?? []), r]);
  return map;
}

export async function floorLabels(db: Db, mallIds: (string | null)[]) {
  const f = await floorsByMall(db, mallIds.filter((x): x is string => !!x));
  return (mallId: string | null, idx: number | null) => (idx === null || !mallId ? null : (f.get(mallId)?.find((x) => x.floor_index === idx)?.label ?? null));
}

export function mallJson(m: MallRow, floors: FloorRow[]) {
  return {
    id: m.id,
    name: m.name,
    city: m.city,
    country: m.country,
    status: m.status,
    boundary: { lat: m.lat, lon: m.lon, radiusM: m.radius_m },
    entranceFloorIndex: m.entrance_floor_index,
    floors: floors.map((f) => ({ index: f.floor_index, label: f.label, zMinM: f.z_min_m, zMaxM: f.z_max_m })),
    updatedAt: m.updated_at,
  };
}

export function parseSegments(s: string | null): string[] | null {
  if (!s) return null;
  try {
    const a = JSON.parse(s) as unknown;
    return Array.isArray(a) && a.length ? a.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export function offerJson(o: OfferRow, floorLabel: string | null) {
  return {
    id: o.id,
    merchant: { id: o.merchant_id, name: o.merchant_name ?? null, nameAr: o.merchant_name_ar ?? null },
    mallId: o.mall_id,
    allBranches: o.all_branches === 1,
    floorIndex: o.floor_index,
    floorLabel,
    storeId: o.store_id,
    storeName: o.store_name ?? null,
    title: o.title,
    body: o.body,
    titleAr: o.title_ar,
    bodyAr: o.body_ar,
    ctaUrl: o.cta_url,
    startsAt: o.starts_at,
    endsAt: o.ends_at,
    priority: o.priority,
    dailyCapPerUser: o.daily_cap_per_user,
    segments: parseSegments(o.segments),
    maxDeliveries: o.max_deliveries,
    maxConversions: o.max_conversions,
    holdoutPct: o.holdout_pct,
    status: o.status,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}
