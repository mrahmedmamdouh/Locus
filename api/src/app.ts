import { haversineM, validateFloors, type Floor } from '@locus/altitude-core';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bearer, generateKey, keyKindOf, safeEqualHex, sha256Hex, type KeyKind } from './auth';
import type { Db, SqlValue } from './db';
import { FLOOR_REPEAT_MS, rankOffers, startOfGulfDay } from './ranking';
import {
  ApiError,
  bad,
  httpsUrl,
  ID_PATTERN,
  INSTALL_ID_PATTERN,
  int,
  isoTime,
  num,
  obj,
  oneOf,
  optInt,
  optStr,
  str,
} from './validate';

export interface AppDeps {
  db: Db;
  /** SHA-256 hex of the Locus platform key (operators only). Null disables the platform routes. */
  platformKeyHash: string | null;
  /** Browser origins allowed to call the admin routes (the bank console). */
  consoleOrigins: string[];
  now?: () => Date;
}

type Vars = { tenantId: string };
type Ctx = Context<{ Variables: Vars }>;

const COUNTRIES = ['OM', 'EG'] as const;
const OFFER_STATUSES = ['draft', 'active', 'paused'] as const;
const EVENT_TYPES = ['arrived', 'floor', 'left', 'offer_delivered', 'offer_opened', 'offer_dismissed'] as const;
const MAX_BODY_BYTES = 256 * 1024;

interface MallRow {
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
interface FloorRow {
  mall_id: string;
  floor_index: number;
  label: string;
  z_min_m: number;
  z_max_m: number;
}
interface OfferRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  merchant_name?: string;
  mall_id: string;
  floor_index: number | null;
  store_id: string | null;
  store_name?: string | null;
  title: string;
  body: string;
  cta_url: string | null;
  starts_at: string;
  ends_at: string;
  priority: number;
  daily_cap_per_user: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono<{ Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route.' } }, 404));

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
  });
  app.use(
    '/v1/admin/*',
    cors({ origin: (o) => (deps.consoleOrigins.includes(o) ? o : null), allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'], maxAge: 600 }),
  );

  app.get('/', (c) => c.json({ name: 'Locus API', version: 'v1', docs: 'https://github.com/mrahmedmamdouh/Locus/blob/main/docs/api.md' }));
  app.get('/health', async (c) => {
    await db.first('SELECT 1 AS ok');
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------------------------

  const requireKey = (kind: KeyKind) => async (c: Ctx, next: () => Promise<void>) => {
    const key = bearer(c.req.header('Authorization'));
    if (!key || keyKindOf(key) !== kind) throw new ApiError(401, 'unauthorized', `Send a ${kind} key: Authorization: Bearer lk_${kind === 'publishable' ? 'pub' : 'sec'}_…`);
    const row = await db.first<{ tenant_id: string }>('SELECT tenant_id FROM api_keys WHERE key_hash = ? AND kind = ? AND revoked_at IS NULL', [await sha256Hex(key), kind]);
    if (!row) throw new ApiError(401, 'unauthorized', 'Unknown or revoked key.');
    c.set('tenantId', row.tenant_id);
    await next();
  };

  const requirePlatform = async (c: Ctx, next: () => Promise<void>) => {
    const key = bearer(c.req.header('Authorization'));
    if (!deps.platformKeyHash || !key || !safeEqualHex(await sha256Hex(key), deps.platformKeyHash)) {
      throw new ApiError(401, 'unauthorized', 'Platform key required.');
    }
    await next();
  };

  const body = async (c: Ctx): Promise<Record<string, unknown>> => {
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
  };

  // ---------------------------------------------------------------------------------------------
  // Shared queries
  // ---------------------------------------------------------------------------------------------

  const floorsByMall = async (mallIds: string[]): Promise<Map<string, FloorRow[]>> => {
    const map = new Map<string, FloorRow[]>();
    if (mallIds.length === 0) return map;
    const rows = await db.all<FloorRow>(`SELECT * FROM floors WHERE mall_id IN (${mallIds.map(() => '?').join(',')}) ORDER BY floor_index`, mallIds);
    for (const r of rows) map.set(r.mall_id, [...(map.get(r.mall_id) ?? []), r]);
    return map;
  };

  const mallJson = (m: MallRow, floors: FloorRow[]) => ({
    id: m.id,
    name: m.name,
    city: m.city,
    country: m.country,
    status: m.status,
    boundary: { lat: m.lat, lon: m.lon, radiusM: m.radius_m },
    entranceFloorIndex: m.entrance_floor_index,
    floors: floors.map((f) => ({ index: f.floor_index, label: f.label, zMinM: f.z_min_m, zMaxM: f.z_max_m })),
    updatedAt: m.updated_at,
  });

  const offerJson = (o: OfferRow, floorLabel: string | null) => ({
    id: o.id,
    merchant: { id: o.merchant_id, name: o.merchant_name ?? null },
    mallId: o.mall_id,
    floorIndex: o.floor_index,
    floorLabel,
    storeId: o.store_id,
    storeName: o.store_name ?? null,
    title: o.title,
    body: o.body,
    ctaUrl: o.cta_url,
    startsAt: o.starts_at,
    endsAt: o.ends_at,
    priority: o.priority,
    dailyCapPerUser: o.daily_cap_per_user,
    status: o.status,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  });

  const OFFER_SELECT = `SELECT o.*, m.name AS merchant_name, s.name AS store_name FROM offers o
    JOIN merchants m ON m.id = o.merchant_id LEFT JOIN stores s ON s.id = o.store_id`;

  const floorLabels = async (mallIds: string[]) => {
    const f = await floorsByMall([...new Set(mallIds)]);
    return (mallId: string, idx: number | null) => (idx === null ? null : (f.get(mallId)?.find((x) => x.floor_index === idx)?.label ?? null));
  };

  // ---------------------------------------------------------------------------------------------
  // SDK routes (publishable key, called from the bank's app)
  // ---------------------------------------------------------------------------------------------

  const sdk = new Hono<{ Variables: Vars }>();
  sdk.use('*', requireKey('publishable'));

  /** Pilot malls to monitor, nearest first when a rough position is given (iOS monitors at most 20 regions). */
  sdk.get('/malls', async (c) => {
    const latQ = c.req.query('lat');
    const lonQ = c.req.query('lon');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
    let malls = await db.all<MallRow>("SELECT * FROM malls WHERE status = 'pilot' ORDER BY id");
    if (latQ !== undefined && lonQ !== undefined) {
      const lat = num(Number(latQ), 'lat', -90, 90);
      const lon = num(Number(lonQ), 'lon', -180, 180);
      malls = malls.map((m) => ({ m, d: haversineM(lat, lon, m.lat, m.lon) })).sort((a, b) => a.d - b.d).map((x) => x.m);
    }
    malls = malls.slice(0, limit);
    const floors = await floorsByMall(malls.map((m) => m.id));
    return c.json({ malls: malls.map((m) => mallJson(m, floors.get(m.id) ?? [])), refreshAfterSeconds: 86_400 });
  });

  /** Ranked offers for this shopper at this mall and floor, and which one (if any) to push now. */
  sdk.post('/offers', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await body(c);
    const installId = str(b.installId, 'installId', { min: 8, max: 64, pattern: INSTALL_ID_PATTERN });
    const mallId = str(b.mallId, 'mallId', { max: 64, pattern: ID_PATTERN });
    const floorIndex = optInt(b.floorIndex, 'floorIndex', -10, 200);
    const mall = await db.first<MallRow>("SELECT * FROM malls WHERE id = ? AND status = 'pilot'", [mallId]);
    if (!mall) throw new ApiError(404, 'not_found', 'Unknown mall.');
    const t = now();
    const offers = await db.all<OfferRow>(`${OFFER_SELECT} WHERE o.tenant_id = ? AND o.mall_id = ? AND o.status = 'active'`, [tenantId, mallId]);
    const delivered = await db.all<{ offer_id: string; n: number }>(
      "SELECT offer_id, COUNT(*) AS n FROM events WHERE tenant_id = ? AND install_id = ? AND type = 'offer_delivered' AND t >= ? GROUP BY offer_id",
      [tenantId, installId, startOfGulfDay(t)],
    );
    const recent = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND install_id = ? AND type = 'offer_delivered' AND mall_id = ? AND floor_index IS ? AND t >= ?",
      [tenantId, installId, mallId, floorIndex, new Date(t.getTime() - FLOOR_REPEAT_MS).toISOString()],
    );
    const ranked = rankOffers({
      offers: offers.map((o) => ({ ...o, floorIndex: o.floor_index, priority: o.priority, dailyCapPerUser: o.daily_cap_per_user, startsAt: o.starts_at, endsAt: o.ends_at })),
      floorIndex,
      now: t,
      deliveredToday: new Map(delivered.map((d) => [d.offer_id, Number(d.n)])),
      floorAlreadyNotified: Number(recent?.n ?? 0) > 0,
    });
    const label = await floorLabels([mallId]);
    const shopperJson = (o: OfferRow) => {
      const j = offerJson(o, label(o.mall_id, o.floor_index));
      return { id: j.id, merchant: j.merchant, floorIndex: j.floorIndex, floorLabel: j.floorLabel, storeName: j.storeName, title: j.title, body: j.body, ctaUrl: j.ctaUrl, endsAt: j.endsAt };
    };
    return c.json({ mallId, floorIndex, offers: ranked.offers.map(shopperJson), push: ranked.push ? shopperJson(ranked.push) : null, reason: ranked.reason });
  });

  /** Results the SDK reports (arrivals, floors, offer delivery). Never coordinates. */
  sdk.post('/events', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await body(c);
    const installId = str(b.installId, 'installId', { min: 8, max: 64, pattern: INSTALL_ID_PATTERN });
    const platform = b.platform === undefined ? null : oneOf(b.platform, 'platform', ['ios', 'android'] as const);
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > 50) throw bad('events must be an array of 1–50 events.');
    const t = now();
    const received = t.toISOString();
    const offerIds = new Set<string>();
    const rows = b.events.map((raw, i) => {
      const e = obj(raw, `events[${i}]`);
      const type = oneOf(e.type, `events[${i}].type`, EVENT_TYPES);
      const mallId = str(e.mallId, `events[${i}].mallId`, { max: 64, pattern: ID_PATTERN });
      const floorIndex = optInt(e.floorIndex, `events[${i}].floorIndex`, -10, 200);
      const offerId = optStr(e.offerId, `events[${i}].offerId`, { max: 64 });
      if (type.startsWith('offer_') && !offerId) throw bad(`events[${i}].offerId is required for ${type}.`);
      const at = isoTime(e.t, `events[${i}].t`);
      if (Math.abs(Date.parse(at) - t.getTime()) > 7 * 86_400_000) throw bad(`events[${i}].t must be within 7 days of now.`);
      if (offerId) offerIds.add(offerId);
      return [tenantId, installId, type, mallId, floorIndex, offerId, platform, at, received] as SqlValue[];
    });
    if (offerIds.size) {
      const ids = [...offerIds];
      const own = await db.all<{ id: string }>(`SELECT id FROM offers WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [tenantId, ...ids]);
      if (own.length !== ids.length) throw bad('An offerId does not belong to this client.');
    }
    await db.batch(rows.map((params) => ({ sql: 'INSERT INTO events (tenant_id, install_id, type, mall_id, floor_index, offer_id, platform, t, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', params })));
    return c.json({ accepted: rows.length });
  });

  app.route('/v1/sdk', sdk);

  // ---------------------------------------------------------------------------------------------
  // Admin routes (secret key, called from the bank console or the bank's servers)
  // ---------------------------------------------------------------------------------------------

  const admin = new Hono<{ Variables: Vars }>();
  admin.use('*', requireKey('secret'));

  admin.get('/me', async (c) => {
    const t = await db.first<{ id: string; name: string; country: string }>('SELECT id, name, country FROM tenants WHERE id = ?', [c.get('tenantId')]);
    return c.json({ tenant: t });
  });

  admin.get('/malls', async (c) => {
    const malls = await db.all<MallRow & { store_count: number }>('SELECT m.*, (SELECT COUNT(*) FROM stores s WHERE s.mall_id = m.id) AS store_count FROM malls m ORDER BY m.status, m.name');
    const floors = await floorsByMall(malls.map((m) => m.id));
    return c.json({ malls: malls.map((m) => ({ ...mallJson(m, floors.get(m.id) ?? []), storeCount: Number(m.store_count) })) });
  });

  admin.get('/malls/:id/stores', async (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 50);
    const rows = await db.all<{ id: string; name: string; floor_index: number | null; unit: string | null; category: string | null }>(
      `SELECT id, name, floor_index, unit, category FROM stores WHERE mall_id = ? ${q ? 'AND name LIKE ?' : ''} ORDER BY name LIMIT 500`,
      q ? [c.req.param('id'), `%${q}%`] : [c.req.param('id')],
    );
    return c.json({ stores: rows.map((s) => ({ id: s.id, name: s.name, floorIndex: s.floor_index, unit: s.unit, category: s.category })) });
  });

  // Merchants -------------------------------------------------------------------------------------

  admin.get('/merchants', async (c) => {
    const rows = await db.all<{ id: string; name: string; category: string | null; created_at: string; offer_count: number }>(
      'SELECT m.*, (SELECT COUNT(*) FROM offers o WHERE o.merchant_id = m.id) AS offer_count FROM merchants m WHERE m.tenant_id = ? ORDER BY m.name',
      [c.get('tenantId')],
    );
    return c.json({ merchants: rows.map((m) => ({ id: m.id, name: m.name, category: m.category, offerCount: Number(m.offer_count), createdAt: m.created_at })) });
  });

  admin.post('/merchants', async (c) => {
    const b = await body(c);
    const m = { id: crypto.randomUUID(), name: str(b.name, 'name', { max: 80 }), category: optStr(b.category, 'category', { max: 40 }), createdAt: now().toISOString() };
    await db.run('INSERT INTO merchants (id, tenant_id, name, category, created_at) VALUES (?, ?, ?, ?, ?)', [m.id, c.get('tenantId'), m.name, m.category, m.createdAt]);
    return c.json({ merchant: { ...m, offerCount: 0 } }, 201);
  });

  admin.patch('/merchants/:id', async (c) => {
    const b = await body(c);
    const cur = await db.first<{ id: string; name: string; category: string | null }>('SELECT * FROM merchants WHERE id = ? AND tenant_id = ?', [c.req.param('id'), c.get('tenantId')]);
    if (!cur) throw new ApiError(404, 'not_found', 'Unknown merchant.');
    const name = b.name === undefined ? cur.name : str(b.name, 'name', { max: 80 });
    const category = b.category === undefined ? cur.category : optStr(b.category, 'category', { max: 40 });
    await db.run('UPDATE merchants SET name = ?, category = ? WHERE id = ?', [name, category, cur.id]);
    return c.json({ merchant: { id: cur.id, name, category } });
  });

  admin.delete('/merchants/:id', async (c) => {
    const n = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM offers WHERE merchant_id = ? AND tenant_id = ? AND status = 'active'", [c.req.param('id'), c.get('tenantId')]);
    if (Number(n?.n ?? 0) > 0) throw new ApiError(409, 'conflict', 'Pause or delete this merchant’s active offers first.');
    const r = await db.run('DELETE FROM merchants WHERE id = ? AND tenant_id = ?', [c.req.param('id'), c.get('tenantId')]);
    if (r.changes === 0) throw new ApiError(404, 'not_found', 'Unknown merchant.');
    return c.body(null, 204);
  });

  // Offers ----------------------------------------------------------------------------------------

  /** Validates offer fields against the catalogue; `cur` is the stored offer for a PATCH. */
  const offerFields = async (tenantId: string, b: Record<string, unknown>, cur: OfferRow | null) => {
    const pick = <T>(key: string, parse: (v: unknown) => T, fallback: T | undefined): T => {
      if (b[key] === undefined) {
        if (fallback === undefined) throw bad(`${key} is required.`);
        return fallback;
      }
      return parse(b[key]);
    };
    const merchantId = pick('merchantId', (v) => str(v, 'merchantId', { max: 64 }), cur?.merchant_id);
    const mallId = pick('mallId', (v) => str(v, 'mallId', { max: 64, pattern: ID_PATTERN }), cur?.mall_id);
    let floorIndex = pick('floorIndex', (v) => optInt(v, 'floorIndex', -10, 200), cur ? cur.floor_index : null);
    const storeId = pick('storeId', (v) => optStr(v, 'storeId', { max: 100 }), cur ? cur.store_id : null);
    const title = pick('title', (v) => str(v, 'title', { max: 80 }), cur?.title);
    const bodyText = pick('body', (v) => (v === null ? '' : str(v, 'body', { min: 0, max: 280 })), cur?.body ?? '');
    const ctaUrl = pick('ctaUrl', (v) => httpsUrl(v, 'ctaUrl'), cur ? cur.cta_url : null);
    const startsAt = pick('startsAt', (v) => isoTime(v, 'startsAt'), cur?.starts_at);
    const endsAt = pick('endsAt', (v) => isoTime(v, 'endsAt'), cur?.ends_at);
    const priority = pick('priority', (v) => int(v, 'priority', 0, 100), cur?.priority ?? 0);
    const dailyCap = pick('dailyCapPerUser', (v) => int(v, 'dailyCapPerUser', 1, 10), cur?.daily_cap_per_user ?? 1);
    const status = pick('status', (v) => oneOf(v, 'status', OFFER_STATUSES), (cur?.status as (typeof OFFER_STATUSES)[number] | undefined) ?? 'draft');
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw bad('endsAt must be after startsAt.');
    if (!(await db.first('SELECT 1 FROM merchants WHERE id = ? AND tenant_id = ?', [merchantId, tenantId]))) throw bad('merchantId is not one of your merchants.');
    if (!(await db.first('SELECT 1 FROM malls WHERE id = ?', [mallId]))) throw bad('mallId is not in the catalogue.');
    if (storeId !== null) {
      const store = await db.first<{ floor_index: number | null }>('SELECT floor_index FROM stores WHERE id = ? AND mall_id = ?', [storeId, mallId]);
      if (!store) throw bad('storeId is not a store in this mall.');
      if (floorIndex === null && b.floorIndex === undefined) floorIndex = store.floor_index;
      if (store.floor_index !== null && floorIndex !== null && store.floor_index !== floorIndex) throw bad('floorIndex does not match the store’s floor.');
    }
    if (floorIndex !== null && !(await db.first('SELECT 1 FROM floors WHERE mall_id = ? AND floor_index = ?', [mallId, floorIndex]))) {
      throw bad('floorIndex is not a floor of this mall.');
    }
    return { merchantId, mallId, floorIndex, storeId, title, body: bodyText, ctaUrl, startsAt, endsAt, priority, dailyCap, status };
  };

  const loadOffer = async (tenantId: string, id: string) => {
    const o = await db.first<OfferRow>(`${OFFER_SELECT} WHERE o.id = ? AND o.tenant_id = ?`, [id, tenantId]);
    if (!o) throw new ApiError(404, 'not_found', 'Unknown offer.');
    return o;
  };

  admin.get('/offers', async (c) => {
    const where = ['o.tenant_id = ?'];
    const params: SqlValue[] = [c.get('tenantId')];
    const status = c.req.query('status');
    if (status) {
      where.push('o.status = ?');
      params.push(oneOf(status, 'status', OFFER_STATUSES));
    }
    const mallId = c.req.query('mallId');
    if (mallId) {
      where.push('o.mall_id = ?');
      params.push(mallId);
    }
    const rows = await db.all<OfferRow>(`${OFFER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC`, params);
    const label = await floorLabels(rows.map((r) => r.mall_id));
    return c.json({ offers: rows.map((o) => offerJson(o, label(o.mall_id, o.floor_index))) });
  });

  admin.get('/offers/:id', async (c) => {
    const o = await loadOffer(c.get('tenantId'), c.req.param('id'));
    const label = await floorLabels([o.mall_id]);
    return c.json({ offer: offerJson(o, label(o.mall_id, o.floor_index)) });
  });

  admin.post('/offers', async (c) => {
    const tenantId = c.get('tenantId');
    const f = await offerFields(tenantId, await body(c), null);
    const id = crypto.randomUUID();
    const t = now().toISOString();
    await db.run(
      'INSERT INTO offers (id, tenant_id, merchant_id, mall_id, floor_index, store_id, title, body, cta_url, starts_at, ends_at, priority, daily_cap_per_user, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, tenantId, f.merchantId, f.mallId, f.floorIndex, f.storeId, f.title, f.body, f.ctaUrl, f.startsAt, f.endsAt, f.priority, f.dailyCap, f.status, t, t],
    );
    const o = await loadOffer(tenantId, id);
    const label = await floorLabels([o.mall_id]);
    return c.json({ offer: offerJson(o, label(o.mall_id, o.floor_index)) }, 201);
  });

  admin.patch('/offers/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const cur = await loadOffer(tenantId, c.req.param('id'));
    const f = await offerFields(tenantId, await body(c), cur);
    await db.run(
      'UPDATE offers SET merchant_id = ?, mall_id = ?, floor_index = ?, store_id = ?, title = ?, body = ?, cta_url = ?, starts_at = ?, ends_at = ?, priority = ?, daily_cap_per_user = ?, status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [f.merchantId, f.mallId, f.floorIndex, f.storeId, f.title, f.body, f.ctaUrl, f.startsAt, f.endsAt, f.priority, f.dailyCap, f.status, now().toISOString(), cur.id, tenantId],
    );
    const o = await loadOffer(tenantId, cur.id);
    const label = await floorLabels([o.mall_id]);
    return c.json({ offer: offerJson(o, label(o.mall_id, o.floor_index)) });
  });

  admin.delete('/offers/:id', async (c) => {
    const r = await db.run('DELETE FROM offers WHERE id = ? AND tenant_id = ?', [c.req.param('id'), c.get('tenantId')]);
    if (r.changes === 0) throw new ApiError(404, 'not_found', 'Unknown offer.');
    return c.body(null, 204);
  });

  // Reports ---------------------------------------------------------------------------------------

  admin.get('/reports/summary', async (c) => {
    const tenantId = c.get('tenantId');
    const to = c.req.query('to') ? isoTime(c.req.query('to'), 'to') : now().toISOString();
    const from = c.req.query('from') ? isoTime(c.req.query('from'), 'from') : new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
    const range = [tenantId, from, to];
    const totals = await db.first<{ arrivals: number; installs: number }>(
      "SELECT COUNT(*) AS arrivals, COUNT(DISTINCT install_id) AS installs FROM events WHERE tenant_id = ? AND t >= ? AND t < ? AND type = 'arrived'",
      range,
    );
    const byMall = await db.all<{ mall_id: string; name: string | null; arrivals: number; installs: number }>(
      "SELECT e.mall_id, m.name, COUNT(*) AS arrivals, COUNT(DISTINCT e.install_id) AS installs FROM events e LEFT JOIN malls m ON m.id = e.mall_id WHERE e.tenant_id = ? AND e.t >= ? AND e.t < ? AND e.type = 'arrived' GROUP BY e.mall_id ORDER BY arrivals DESC",
      range,
    );
    const byFloor = await db.all<{ mall_id: string; floor_index: number; visits: number }>(
      "SELECT mall_id, floor_index, COUNT(*) AS visits FROM events WHERE tenant_id = ? AND t >= ? AND t < ? AND type = 'floor' AND floor_index IS NOT NULL GROUP BY mall_id, floor_index ORDER BY mall_id, floor_index",
      range,
    );
    const offers = await db.all<{ offer_id: string; title: string | null; delivered: number; opened: number; dismissed: number }>(
      `SELECT e.offer_id, o.title,
        SUM(CASE WHEN e.type = 'offer_delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN e.type = 'offer_opened' THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN e.type = 'offer_dismissed' THEN 1 ELSE 0 END) AS dismissed
       FROM events e LEFT JOIN offers o ON o.id = e.offer_id
       WHERE e.tenant_id = ? AND e.t >= ? AND e.t < ? AND e.offer_id IS NOT NULL GROUP BY e.offer_id ORDER BY delivered DESC`,
      range,
    );
    const label = await floorLabels(byFloor.map((f) => f.mall_id));
    return c.json({
      from,
      to,
      arrivals: Number(totals?.arrivals ?? 0),
      uniqueInstalls: Number(totals?.installs ?? 0),
      byMall: byMall.map((m) => ({ mallId: m.mall_id, name: m.name, arrivals: Number(m.arrivals), uniqueInstalls: Number(m.installs) })),
      byFloor: byFloor.map((f) => ({ mallId: f.mall_id, floorIndex: f.floor_index, floorLabel: label(f.mall_id, f.floor_index), visits: Number(f.visits) })),
      offers: offers.map((o) => {
        const delivered = Number(o.delivered);
        const opened = Number(o.opened);
        return { offerId: o.offer_id, title: o.title, delivered, opened, dismissed: Number(o.dismissed), openRate: delivered ? Math.round((opened / delivered) * 1000) / 1000 : null };
      }),
    });
  });

  app.route('/v1/admin', admin);

  // ---------------------------------------------------------------------------------------------
  // Platform routes (Locus operators): clients, keys, the places catalogue
  // ---------------------------------------------------------------------------------------------

  const platform = new Hono<{ Variables: Vars }>();
  platform.use('*', requirePlatform);

  const issueKey = async (tenantId: string, kind: KeyKind) => {
    const key = generateKey(kind);
    const id = crypto.randomUUID();
    await db.run('INSERT INTO api_keys (id, tenant_id, kind, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, tenantId, kind, await sha256Hex(key), key.slice(0, 12), now().toISOString()]);
    return { id, kind, key, prefix: key.slice(0, 12) };
  };

  platform.get('/tenants', async (c) => {
    const tenants = await db.all<{ id: string; name: string; country: string; created_at: string }>('SELECT * FROM tenants ORDER BY created_at');
    const keys = await db.all<{ id: string; tenant_id: string; kind: string; prefix: string; created_at: string; revoked_at: string | null }>(
      'SELECT id, tenant_id, kind, prefix, created_at, revoked_at FROM api_keys ORDER BY created_at',
    );
    return c.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        country: t.country,
        createdAt: t.created_at,
        keys: keys.filter((k) => k.tenant_id === t.id).map((k) => ({ id: k.id, kind: k.kind, prefix: k.prefix, createdAt: k.created_at, revokedAt: k.revoked_at })),
      })),
    });
  });

  platform.post('/tenants', async (c) => {
    const b = await body(c);
    const id = b.id === undefined ? crypto.randomUUID() : str(b.id, 'id', { max: 64, pattern: ID_PATTERN });
    const name = str(b.name, 'name', { max: 80 });
    const country = oneOf(b.country, 'country', COUNTRIES);
    if (await db.first('SELECT 1 FROM tenants WHERE id = ?', [id])) throw new ApiError(409, 'conflict', 'A client with this id exists.');
    await db.run('INSERT INTO tenants (id, name, country, created_at) VALUES (?, ?, ?, ?)', [id, name, country, now().toISOString()]);
    const publishable = await issueKey(id, 'publishable');
    const secret = await issueKey(id, 'secret');
    return c.json({ tenant: { id, name, country }, keys: { publishable: publishable.key, secret: secret.key }, note: 'Keys are shown once. Store them now.' }, 201);
  });

  platform.post('/tenants/:id/keys', async (c) => {
    const b = await body(c);
    const kind = oneOf(b.kind, 'kind', ['publishable', 'secret'] as const);
    if (!(await db.first('SELECT 1 FROM tenants WHERE id = ?', [c.req.param('id')]))) throw new ApiError(404, 'not_found', 'Unknown client.');
    return c.json({ key: await issueKey(c.req.param('id'), kind) }, 201);
  });

  platform.post('/keys/:id/revoke', async (c) => {
    const r = await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now().toISOString(), c.req.param('id')]);
    if (r.changes === 0) throw new ApiError(404, 'not_found', 'Unknown or already revoked key.');
    return c.json({ revoked: true });
  });

  /** Create or replace a mall and its floor table. */
  platform.put('/malls/:id', async (c) => {
    const id = str(c.req.param('id'), 'id', { max: 64, pattern: ID_PATTERN });
    const b = await body(c);
    const m = {
      name: str(b.name, 'name', { max: 100 }),
      city: str(b.city, 'city', { max: 100 }),
      country: oneOf(b.country, 'country', COUNTRIES),
      lat: num(b.lat, 'lat', -90, 90),
      lon: num(b.lon, 'lon', -180, 180),
      radiusM: num(b.radiusM, 'radiusM', 50, 2000),
      entranceFloorIndex: int(b.entranceFloorIndex ?? 0, 'entranceFloorIndex', -10, 200),
      status: oneOf(b.status ?? 'listed', 'status', ['pilot', 'listed'] as const),
    };
    if (!Array.isArray(b.floors) || b.floors.length === 0 || b.floors.length > 60) throw bad('floors must be an array of 1–60 floors.');
    const floors: Floor[] = b.floors.map((raw, i) => {
      const f = obj(raw, `floors[${i}]`);
      return { index: int(f.index, `floors[${i}].index`, -10, 200), label: str(f.label, `floors[${i}].label`, { max: 40 }), zMinM: num(f.zMinM, `floors[${i}].zMinM`, -200, 1000), zMaxM: num(f.zMaxM, `floors[${i}].zMaxM`, -200, 1000) };
    });
    const problems = validateFloors(floors);
    if (problems.length) throw bad(problems.join(' '));
    if (m.status === 'pilot' && !floors.some((f) => f.index === m.entranceFloorIndex)) throw bad('entranceFloorIndex must be one of the floors.');
    await db.batch([
      {
        sql: `INSERT INTO malls (id, name, city, country, lat, lon, radius_m, entrance_floor_index, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, city = excluded.city, country = excluded.country, lat = excluded.lat, lon = excluded.lon,
              radius_m = excluded.radius_m, entrance_floor_index = excluded.entrance_floor_index, status = excluded.status, updated_at = excluded.updated_at`,
        params: [id, m.name, m.city, m.country, m.lat, m.lon, m.radiusM, m.entranceFloorIndex, m.status, now().toISOString()],
      },
      { sql: 'DELETE FROM floors WHERE mall_id = ?', params: [id] },
      ...floors.map((f) => ({ sql: 'INSERT INTO floors (mall_id, floor_index, label, z_min_m, z_max_m) VALUES (?, ?, ?, ?, ?)', params: [id, f.index, f.label, f.zMinM, f.zMaxM] })),
    ]);
    const row = (await db.first<MallRow>('SELECT * FROM malls WHERE id = ?', [id]))!;
    return c.json({ mall: mallJson(row, (await floorsByMall([id])).get(id) ?? []) });
  });

  /** Add stores to a mall (replace: true removes stores that are not referenced by offers first). */
  platform.post('/malls/:id/stores', async (c) => {
    const mallId = c.req.param('id');
    if (!(await db.first('SELECT 1 FROM malls WHERE id = ?', [mallId]))) throw new ApiError(404, 'not_found', 'Unknown mall.');
    const b = await body(c);
    if (!Array.isArray(b.stores) || b.stores.length > 2000) throw bad('stores must be an array of up to 2000 stores.');
    const stores = b.stores.map((raw, i) => {
      const s = obj(raw, `stores[${i}]`);
      const name = str(s.name, `stores[${i}].name`, { max: 100 });
      const id = s.id === undefined ? `${mallId}--${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 100) : str(s.id, `stores[${i}].id`, { max: 100 });
      return { id, name, floorIndex: optInt(s.floorIndex, `stores[${i}].floorIndex`, -10, 200), unit: optStr(s.unit, `stores[${i}].unit`, { max: 40 }), category: optStr(s.category, `stores[${i}].category`, { max: 60 }) };
    });
    const statements: { sql: string; params: SqlValue[] }[] = [];
    if (b.replace === true) statements.push({ sql: 'DELETE FROM stores WHERE mall_id = ? AND id NOT IN (SELECT store_id FROM offers WHERE store_id IS NOT NULL)', params: [mallId] });
    for (const s of stores) {
      statements.push({
        sql: `INSERT INTO stores (id, mall_id, name, floor_index, unit, category) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, floor_index = excluded.floor_index, unit = excluded.unit, category = excluded.category`,
        params: [s.id, mallId, s.name, s.floorIndex, s.unit, s.category],
      });
    }
    await db.batch(statements);
    return c.json({ upserted: stores.length });
  });

  app.route('/v1/platform', platform);
  return app;
}
