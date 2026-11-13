import { Hono } from 'hono';
import { sha256Hex } from '../auth';
import type { Db, SqlValue } from '../db';
import { AUTO_LINK, matchStores, type MatchCandidate } from '../match';
import {
  floorLabels,
  floorsByMall,
  inList,
  mallJson,
  OFFER_SELECT,
  OFFER_STATUSES,
  offerJson,
  readBody,
  SEGMENT_PATTERN,
  type MallRow,
  type OfferRow,
  type Services,
  type TenantRow,
  type Vars,
} from '../shared';
import { HHMM, isValidTimeZone } from '../time';
import { ApiError, bad, httpsUrl, ID_PATTERN, INSTALL_ID_PATTERN, int, isoTime, num, obj, oneOf, optInt, optStr, str } from '../validate';
import { generateWebhookSecret, signWebhook } from '../webhook';

const MID_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const ATTRIBUTION_MS = 7 * 86_400_000;

interface MerchantRow {
  id: string;
  tenant_id: string;
  name: string;
  name_ar: string | null;
  category: string | null;
  mcc: string | null;
  external_id: string | null;
  created_at: string;
}
interface StoreRow {
  id: string;
  name: string;
  mall_id: string;
  floor_index: number | null;
}

/** Block webhook URLs that point at private networks (the API host could otherwise be used to reach them). */
export function isPublicHttpsUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return false;
  return true;
}

export function adminRoutes(svc: Services, auth: (c: never, next: () => Promise<void>) => Promise<void>) {
  const { db, now } = svc;
  const admin = new Hono<{ Variables: Vars }>();
  admin.use('*', auth as never);

  const tenantOf = async (id: string) => (await db.first<TenantRow>('SELECT * FROM tenants WHERE id = ?', [id]))!;

  admin.get('/me', async (c) => {
    const t = await tenantOf(c.get('tenantId'));
    return c.json({ tenant: { id: t.id, name: t.name, country: t.country } });
  });

  // ---------------------------------------------------------------------------------------------
  // Settings: time zone, delivery mode, webhook, quiet hours, daily limit
  // ---------------------------------------------------------------------------------------------

  const settingsJson = (t: TenantRow) => ({
    timezone: t.timezone,
    deliveryMode: t.delivery_mode,
    webhookUrl: t.webhook_url,
    webhookSecretSet: !!t.webhook_secret,
    quietHours: t.quiet_start && t.quiet_end ? { start: t.quiet_start, end: t.quiet_end } : null,
    maxPushesPerDay: t.max_pushes_per_day,
  });

  admin.get('/settings', async (c) => c.json({ settings: settingsJson(await tenantOf(c.get('tenantId'))) }));

  admin.patch('/settings', async (c) => {
    const cur = await tenantOf(c.get('tenantId'));
    const b = await readBody(c);
    const timezone = b.timezone === undefined ? cur.timezone : str(b.timezone, 'timezone', { max: 64 });
    if (!isValidTimeZone(timezone)) throw bad('timezone must be an IANA time zone, e.g. Asia/Muscat.');
    let webhookUrl = cur.webhook_url;
    if (b.webhookUrl !== undefined) {
      webhookUrl = httpsUrl(b.webhookUrl, 'webhookUrl');
      if (webhookUrl && !isPublicHttpsUrl(webhookUrl)) throw bad('webhookUrl must be a public https address.');
    }
    const deliveryMode = b.deliveryMode === undefined ? cur.delivery_mode : oneOf(b.deliveryMode, 'deliveryMode', ['sdk', 'webhook'] as const);
    if (deliveryMode === 'webhook' && (!webhookUrl || !cur.webhook_secret)) throw bad('Set webhookUrl and create a webhook secret before switching to webhook delivery.');
    let quietStart = cur.quiet_start;
    let quietEnd = cur.quiet_end;
    if (b.quietHours !== undefined) {
      if (b.quietHours === null) {
        quietStart = null;
        quietEnd = null;
      } else {
        const q = obj(b.quietHours, 'quietHours');
        quietStart = str(q.start, 'quietHours.start', { max: 5, pattern: HHMM });
        quietEnd = str(q.end, 'quietHours.end', { max: 5, pattern: HHMM });
      }
    }
    const max = b.maxPushesPerDay === undefined ? cur.max_pushes_per_day : int(b.maxPushesPerDay, 'maxPushesPerDay', 1, 20);
    await db.run('UPDATE tenants SET timezone = ?, delivery_mode = ?, webhook_url = ?, quiet_start = ?, quiet_end = ?, max_pushes_per_day = ? WHERE id = ?', [
      timezone,
      deliveryMode,
      webhookUrl,
      quietStart,
      quietEnd,
      max,
      cur.id,
    ]);
    return c.json({ settings: settingsJson(await tenantOf(cur.id)) });
  });

  /** New webhook signing secret, shown once. The old one stops working immediately. */
  admin.post('/settings/webhook-secret', async (c) => {
    const secret = generateWebhookSecret();
    await db.run('UPDATE tenants SET webhook_secret = ? WHERE id = ?', [secret, c.get('tenantId')]);
    return c.json({ secret, note: 'Shown once. Verify Locus-Signature with it.' }, 201);
  });

  /** Sends a signed "ping" to the webhook URL and reports the result. */
  admin.post('/settings/webhook-test', async (c) => {
    const t = await tenantOf(c.get('tenantId'));
    if (!t.webhook_url || !t.webhook_secret) throw bad('Set webhookUrl and create a webhook secret first.');
    const body = JSON.stringify({ type: 'ping', tenantId: t.id, createdAt: now().toISOString() });
    const ts = Math.floor(now().getTime() / 1000);
    try {
      const res = await svc.fetchImpl(t.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Locus-Event': 'ping', 'Locus-Delivery': crypto.randomUUID(), 'Locus-Signature': `t=${ts},v1=${await signWebhook(t.webhook_secret, ts, body)}` },
        body,
      });
      return c.json({ ok: res.ok, status: res.status });
    } catch (e) {
      return c.json({ ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' });
    }
  });

  admin.get('/deliveries', async (c) => {
    const status = c.req.query('status');
    const rows = await db.all<{ id: string; offer_id: string; install_id: string; status: string; attempts: number; last_error: string | null; created_at: string; sent_at: string | null }>(
      `SELECT id, offer_id, install_id, status, attempts, last_error, created_at, sent_at FROM webhook_deliveries WHERE tenant_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 100`,
      status ? [c.get('tenantId'), oneOf(status, 'status', ['pending', 'sent', 'failed', 'expired'] as const)] : [c.get('tenantId')],
    );
    return c.json({
      deliveries: rows.map((r) => ({ id: r.id, offerId: r.offer_id, installId: r.install_id, status: r.status, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at, sentAt: r.sent_at })),
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Catalogue (read-only for clients)
  // ---------------------------------------------------------------------------------------------

  admin.get('/malls', async (c) => {
    const malls = await db.all<MallRow & { store_count: number }>(
      "SELECT m.*, (SELECT COUNT(*) FROM stores s WHERE s.mall_id = m.id) AS store_count FROM malls m ORDER BY CASE m.status WHEN 'pilot' THEN 0 ELSE 1 END, m.name",
    );
    const floors = await floorsByMall(db, malls.map((m) => m.id));
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

  // ---------------------------------------------------------------------------------------------
  // Merchants, MIDs and branches
  // ---------------------------------------------------------------------------------------------

  const merchantFull = async (tenantId: string, m: MerchantRow) => {
    const mids = await db.all<{ mid: string }>('SELECT mid FROM merchant_mids WHERE tenant_id = ? AND merchant_id = ? ORDER BY mid', [tenantId, m.id]);
    const branches = await db.all<{ store_id: string; source: string; name: string; mall_id: string; floor_index: number | null; mall_name: string }>(
      `SELECT mb.store_id, mb.source, s.name, s.mall_id, s.floor_index, ml.name AS mall_name FROM merchant_branches mb
       JOIN stores s ON s.id = mb.store_id JOIN malls ml ON ml.id = s.mall_id WHERE mb.merchant_id = ? ORDER BY ml.name, s.floor_index`,
      [m.id],
    );
    const label = await floorLabels(db, branches.map((b) => b.mall_id));
    return {
      id: m.id,
      externalId: m.external_id,
      name: m.name,
      nameAr: m.name_ar,
      category: m.category,
      mcc: m.mcc,
      mids: mids.map((x) => x.mid),
      branches: branches.map((b) => ({ storeId: b.store_id, storeName: b.name, mallId: b.mall_id, mallName: b.mall_name, floorIndex: b.floor_index, floorLabel: label(b.mall_id, b.floor_index), source: b.source })),
      createdAt: m.created_at,
    };
  };

  const loadMerchant = async (tenantId: string, id: string) => {
    const m = await db.first<MerchantRow>('SELECT * FROM merchants WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!m) throw new ApiError(404, 'not_found', 'Unknown merchant.');
    return m;
  };

  const parseMids = (v: unknown, name: string): string[] => {
    if (!Array.isArray(v) || v.length > 200) throw bad(`${name} must be an array of up to 200 merchant IDs.`);
    return [...new Set(v.map((x, i) => str(typeof x === 'number' ? String(x) : x, `${name}[${i}]`, { max: 32, pattern: MID_PATTERN })))];
  };

  /** MIDs already used by another merchant of this client. */
  const midConflicts = async (tenantId: string, merchantId: string | null, mids: string[]) => {
    if (!mids.length) return [];
    const rows = await db.all<{ mid: string; merchant_id: string }>(`SELECT mid, merchant_id FROM merchant_mids WHERE tenant_id = ? AND mid IN (${inList(mids.length)})`, [tenantId, ...mids]);
    return rows.filter((r) => r.merchant_id !== merchantId).map((r) => r.mid);
  };

  admin.get('/merchants', async (c) => {
    const tenantId = c.get('tenantId');
    const rows = await db.all<MerchantRow & { offer_count: number; branch_count: number; mid_count: number }>(
      `SELECT m.*, (SELECT COUNT(*) FROM offers o WHERE o.merchant_id = m.id) AS offer_count,
        (SELECT COUNT(*) FROM merchant_branches b WHERE b.merchant_id = m.id) AS branch_count,
        (SELECT COUNT(*) FROM merchant_mids x WHERE x.merchant_id = m.id) AS mid_count
       FROM merchants m WHERE m.tenant_id = ? ORDER BY m.name`,
      [tenantId],
    );
    return c.json({
      merchants: rows.map((m) => ({
        id: m.id,
        externalId: m.external_id,
        name: m.name,
        nameAr: m.name_ar,
        category: m.category,
        mcc: m.mcc,
        offerCount: Number(m.offer_count),
        branchCount: Number(m.branch_count),
        midCount: Number(m.mid_count),
        createdAt: m.created_at,
      })),
    });
  });

  admin.get('/merchants/:id', async (c) => c.json({ merchant: await merchantFull(c.get('tenantId'), await loadMerchant(c.get('tenantId'), c.req.param('id'))) }));

  const merchantFields = (b: Record<string, unknown>, cur: MerchantRow | null) => ({
    name: b.name === undefined && cur ? cur.name : str(b.name, 'name', { max: 80 }),
    nameAr: b.nameAr === undefined ? (cur?.name_ar ?? null) : optStr(b.nameAr, 'nameAr', { max: 80 }),
    category: b.category === undefined ? (cur?.category ?? null) : optStr(b.category, 'category', { max: 40 }),
    mcc: b.mcc === undefined ? (cur?.mcc ?? null) : optStr(typeof b.mcc === 'number' ? String(b.mcc) : b.mcc, 'mcc', { max: 4, pattern: /^\d{4}$/ }),
    externalId: b.externalId === undefined ? (cur?.external_id ?? null) : optStr(b.externalId, 'externalId', { max: 64 }),
  });

  const saveMids = (tenantId: string, merchantId: string, mids: string[]) => [
    { sql: 'DELETE FROM merchant_mids WHERE tenant_id = ? AND merchant_id = ?', params: [tenantId, merchantId] as SqlValue[] },
    ...mids.map((mid) => ({ sql: 'INSERT INTO merchant_mids (tenant_id, mid, merchant_id) VALUES (?, ?, ?)', params: [tenantId, mid, merchantId] as SqlValue[] })),
  ];

  admin.post('/merchants', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await readBody(c);
    const f = merchantFields(b, null);
    const mids = b.mids === undefined ? [] : parseMids(b.mids, 'mids');
    const clash = await midConflicts(tenantId, null, mids);
    if (clash.length) throw new ApiError(409, 'conflict', `Merchant IDs already used by another merchant: ${clash.join(', ')}.`);
    if (f.externalId && (await db.first('SELECT 1 FROM merchants WHERE tenant_id = ? AND external_id = ?', [tenantId, f.externalId]))) {
      throw new ApiError(409, 'conflict', 'A merchant with this externalId exists.');
    }
    const id = crypto.randomUUID();
    await db.batch([
      {
        sql: 'INSERT INTO merchants (id, tenant_id, name, name_ar, category, mcc, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, tenantId, f.name, f.nameAr, f.category, f.mcc, f.externalId, now().toISOString()],
      },
      ...saveMids(tenantId, id, mids),
    ]);
    return c.json({ merchant: await merchantFull(tenantId, await loadMerchant(tenantId, id)) }, 201);
  });

  admin.patch('/merchants/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const cur = await loadMerchant(tenantId, c.req.param('id'));
    const b = await readBody(c);
    const f = merchantFields(b, cur);
    const statements: { sql: string; params: SqlValue[] }[] = [
      { sql: 'UPDATE merchants SET name = ?, name_ar = ?, category = ?, mcc = ?, external_id = ? WHERE id = ?', params: [f.name, f.nameAr, f.category, f.mcc, f.externalId, cur.id] },
    ];
    if (b.mids !== undefined) {
      const mids = parseMids(b.mids, 'mids');
      const clash = await midConflicts(tenantId, cur.id, mids);
      if (clash.length) throw new ApiError(409, 'conflict', `Merchant IDs already used by another merchant: ${clash.join(', ')}.`);
      statements.push(...saveMids(tenantId, cur.id, mids));
    }
    await db.batch(statements);
    return c.json({ merchant: await merchantFull(tenantId, await loadMerchant(tenantId, cur.id)) });
  });

  admin.delete('/merchants/:id', async (c) => {
    const n = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM offers WHERE merchant_id = ? AND tenant_id = ? AND status = 'active'", [c.req.param('id'), c.get('tenantId')]);
    if (Number(n?.n ?? 0) > 0) throw new ApiError(409, 'conflict', 'Pause or delete this merchant’s active offers first.');
    const r = await db.run('DELETE FROM merchants WHERE id = ? AND tenant_id = ?', [c.req.param('id'), c.get('tenantId')]);
    if (r.changes === 0) throw new ApiError(404, 'not_found', 'Unknown merchant.');
    return c.body(null, 204);
  });

  /** Replace the merchant's branches with these catalogue stores. */
  admin.put('/merchants/:id/branches', async (c) => {
    const tenantId = c.get('tenantId');
    const m = await loadMerchant(tenantId, c.req.param('id'));
    const b = await readBody(c);
    if (!Array.isArray(b.storeIds) || b.storeIds.length > 500) throw bad('storeIds must be an array of up to 500 store ids.');
    const ids = [...new Set(b.storeIds.map((x, i) => str(x, `storeIds[${i}]`, { max: 100 })))];
    if (ids.length) {
      const found = await db.all<{ id: string }>(`SELECT id FROM stores WHERE id IN (${inList(ids.length)})`, ids);
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw bad(`Unknown store ids: ${missing.slice(0, 5).join(', ')}.`);
    }
    const prev = new Map((await db.all<{ store_id: string; source: string }>('SELECT store_id, source FROM merchant_branches WHERE merchant_id = ?', [m.id])).map((r) => [r.store_id, r.source]));
    await db.batch([
      { sql: 'DELETE FROM merchant_branches WHERE merchant_id = ?', params: [m.id] },
      ...ids.map((id) => ({ sql: 'INSERT INTO merchant_branches (merchant_id, store_id, source) VALUES (?, ?, ?)', params: [m.id, id, prev.get(id) ?? 'manual'] as SqlValue[] })),
    ]);
    return c.json({ merchant: await merchantFull(tenantId, m) });
  });

  /** Catalogue stores whose names look like this merchant (not yet linked). */
  admin.get('/merchants/:id/suggestions', async (c) => {
    const tenantId = c.get('tenantId');
    const m = await loadMerchant(tenantId, c.req.param('id'));
    const linked = new Set((await db.all<{ store_id: string }>('SELECT store_id FROM merchant_branches WHERE merchant_id = ?', [m.id])).map((r) => r.store_id));
    const stores = await db.all<StoreRow>('SELECT id, name, mall_id, floor_index FROM stores');
    const out = await describeCandidates(db, matchStores(m.name, stores, 50).filter((x) => !linked.has(x.storeId)));
    return c.json({ suggestions: out });
  });

  /**
   * Bulk import (create or update by externalId, else by exact name). Branches come from explicit
   * store ids, from {mallId, storeName}, or from automatic name matching across the catalogue:
   * matches ≥ 0.9 are linked, 0.6–0.9 are returned for review. dryRun: nothing is written.
   */
  admin.post('/merchants/import', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await readBody(c);
    const dryRun = b.dryRun === true;
    if (!Array.isArray(b.merchants) || b.merchants.length === 0 || b.merchants.length > 500) throw bad('merchants must be an array of 1–500 merchants.');
    const stores = await db.all<StoreRow>('SELECT id, name, mall_id, floor_index FROM stores');
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const existing = await db.all<MerchantRow>('SELECT * FROM merchants WHERE tenant_id = ?', [tenantId]);
    const usedMids = new Map((await db.all<{ mid: string; merchant_id: string }>('SELECT mid, merchant_id FROM merchant_mids WHERE tenant_id = ?', [tenantId])).map((r) => [r.mid, r.merchant_id]));
    const seenMids = new Map<string, number>();

    type Plan = {
      row: number;
      action: 'create' | 'update';
      merchantId: string;
      fields: ReturnType<typeof merchantFields>;
      mids: string[] | null;
      link: { storeId: string; source: 'manual' | 'auto' }[];
      review: MatchCandidate[];
      errors: string[];
    };
    const plans: Plan[] = [];
    for (let i = 0; i < b.merchants.length; i++) {
      const errors: string[] = [];
      let p: Plan;
      try {
        const item = obj(b.merchants[i], `merchants[${i}]`);
        const f = merchantFields(item, null);
        const cur = (f.externalId && existing.find((m) => m.external_id === f.externalId)) || existing.find((m) => m.name.toLowerCase() === f.name.toLowerCase()) || null;
        const merchantId = cur?.id ?? crypto.randomUUID();
        let mids: string[] | null = null;
        if (item.mids !== undefined) {
          mids = [];
          for (const mid of parseMids(item.mids, `merchants[${i}].mids`)) {
            const owner = usedMids.get(mid);
            const dupRow = seenMids.get(mid);
            if ((owner && owner !== merchantId) || (dupRow !== undefined && dupRow !== i)) errors.push(`MID ${mid} already belongs to another merchant; skipped.`);
            else {
              mids.push(mid);
              seenMids.set(mid, i);
            }
          }
        }
        const link: Plan['link'] = [];
        const review: MatchCandidate[] = [];
        if (item.branches !== undefined) {
          if (!Array.isArray(item.branches) || item.branches.length > 200) throw bad(`merchants[${i}].branches must be an array of up to 200 branches.`);
          item.branches.forEach((raw, j) => {
            const br = obj(raw, `merchants[${i}].branches[${j}]`);
            if (br.storeId !== undefined) {
              const id = str(br.storeId, `merchants[${i}].branches[${j}].storeId`, { max: 100 });
              if (storeById.has(id)) link.push({ storeId: id, source: 'manual' });
              else errors.push(`Unknown store id ${id}.`);
              return;
            }
            const mallId = str(br.mallId, `merchants[${i}].branches[${j}].mallId`, { max: 64, pattern: ID_PATTERN });
            const storeName = br.storeName === undefined ? f.name : str(br.storeName, `merchants[${i}].branches[${j}].storeName`, { max: 100 });
            const cands = matchStores(storeName, stores.filter((s) => s.mall_id === mallId), 5);
            if (cands[0] && cands[0].score >= AUTO_LINK) link.push({ storeId: cands[0].storeId, source: 'auto' });
            else if (cands.length) review.push(...cands);
            else errors.push(`No store like “${storeName}” in ${mallId}.`);
          });
        } else if (item.autoMatch !== false) {
          for (const cand of matchStores(f.name, stores, 50)) {
            if (cand.score >= AUTO_LINK) link.push({ storeId: cand.storeId, source: 'auto' });
            else review.push(cand);
          }
        }
        p = { row: i, action: cur ? 'update' : 'create', merchantId, fields: f, mids, link, review, errors };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        p = { row: i, action: 'create', merchantId: '', fields: null as never, mids: null, link: [], review: [], errors: [e.message] };
      }
      plans.push(p);
    }

    const valid = plans.filter((p) => p.merchantId);
    if (!dryRun && valid.length) {
      const statements: { sql: string; params: SqlValue[] }[] = [];
      const t = now().toISOString();
      for (const p of valid) {
        const f = p.fields;
        if (p.action === 'create') {
          statements.push({ sql: 'INSERT INTO merchants (id, tenant_id, name, name_ar, category, mcc, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: [p.merchantId, tenantId, f.name, f.nameAr, f.category, f.mcc, f.externalId, t] });
        } else {
          statements.push({
            sql: 'UPDATE merchants SET name = ?, name_ar = COALESCE(?, name_ar), category = COALESCE(?, category), mcc = COALESCE(?, mcc), external_id = COALESCE(?, external_id) WHERE id = ?',
            params: [f.name, f.nameAr, f.category, f.mcc, f.externalId, p.merchantId],
          });
        }
        if (p.mids) statements.push(...saveMids(tenantId, p.merchantId, p.mids));
        for (const l of p.link) statements.push({ sql: 'INSERT OR IGNORE INTO merchant_branches (merchant_id, store_id, source) VALUES (?, ?, ?)', params: [p.merchantId, l.storeId, l.source] });
      }
      await db.batch(statements);
    }

    const describe = async (p: Plan) => ({
      row: p.row,
      name: p.fields?.name ?? null,
      action: p.merchantId ? p.action : 'skip',
      merchantId: p.merchantId || null,
      linked: await describeCandidates(db, p.link.map((l) => ({ storeId: l.storeId, storeName: storeById.get(l.storeId)!.name, mallId: storeById.get(l.storeId)!.mall_id, floorIndex: storeById.get(l.storeId)!.floor_index, score: 1 }))),
      review: await describeCandidates(db, p.review),
      errors: p.errors,
    });
    const results = [];
    for (const p of plans) results.push(await describe(p));
    return c.json({
      dryRun,
      summary: {
        created: valid.filter((p) => p.action === 'create').length,
        updated: valid.filter((p) => p.action === 'update').length,
        skipped: plans.length - valid.length,
        branchesLinked: valid.reduce((a, p) => a + p.link.length, 0),
        toReview: valid.reduce((a, p) => a + p.review.length, 0),
      },
      results,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Offers
  // ---------------------------------------------------------------------------------------------

  /** Validates offer fields against the catalogue and the client; `cur` is the stored offer for a PATCH. */
  const offerFields = async (tenantId: string, b: Record<string, unknown>, cur: OfferRow | null) => {
    const pick = <T>(key: string, parse: (v: unknown) => T, fallback: T | undefined): T => {
      if (b[key] === undefined) {
        if (fallback === undefined) throw bad(`${key} is required.`);
        return fallback;
      }
      return parse(b[key]);
    };
    const allBranches = pick('allBranches', (v) => (typeof v === 'boolean' ? v : (() => { throw bad('allBranches must be true or false.'); })()), cur ? cur.all_branches === 1 : false);
    const merchantId = pick('merchantId', (v) => str(v, 'merchantId', { max: 64 }), cur?.merchant_id);
    let mallId = allBranches ? null : pick('mallId', (v) => str(v, 'mallId', { max: 64, pattern: ID_PATTERN }), cur?.mall_id ?? undefined);
    let floorIndex = allBranches ? null : pick('floorIndex', (v) => optInt(v, 'floorIndex', -10, 200), cur ? cur.floor_index : null);
    const storeId = allBranches ? null : pick('storeId', (v) => optStr(v, 'storeId', { max: 100 }), cur ? cur.store_id : null);
    const title = pick('title', (v) => str(v, 'title', { max: 80 }), cur?.title);
    const bodyText = pick('body', (v) => (v === null ? '' : str(v, 'body', { min: 0, max: 280 })), cur?.body ?? '');
    const titleAr = pick('titleAr', (v) => optStr(v, 'titleAr', { max: 80 }), cur ? cur.title_ar : null);
    const bodyAr = pick('bodyAr', (v) => optStr(v, 'bodyAr', { max: 280 }), cur ? cur.body_ar : null);
    const ctaUrl = pick('ctaUrl', (v) => httpsUrl(v, 'ctaUrl'), cur ? cur.cta_url : null);
    const startsAt = pick('startsAt', (v) => isoTime(v, 'startsAt'), cur?.starts_at);
    const endsAt = pick('endsAt', (v) => isoTime(v, 'endsAt'), cur?.ends_at);
    const priority = pick('priority', (v) => int(v, 'priority', 0, 100), cur?.priority ?? 0);
    const dailyCap = pick('dailyCapPerUser', (v) => int(v, 'dailyCapPerUser', 1, 10), cur?.daily_cap_per_user ?? 1);
    const segments = pick(
      'segments',
      (v) => {
        if (v === null) return null;
        if (!Array.isArray(v) || v.length > 20) throw bad('segments must be an array of up to 20 tags, or null for everyone.');
        const s = [...new Set(v.map((x, i) => str(x, `segments[${i}]`, { max: 40, pattern: SEGMENT_PATTERN })))];
        return s.length ? JSON.stringify(s) : null;
      },
      cur ? cur.segments : null,
    );
    const maxDeliveries = pick('maxDeliveries', (v) => optInt(v, 'maxDeliveries', 1, 10_000_000), cur ? cur.max_deliveries : null);
    const maxConversions = pick('maxConversions', (v) => optInt(v, 'maxConversions', 1, 10_000_000), cur ? cur.max_conversions : null);
    const holdoutPct = pick('holdoutPct', (v) => int(v, 'holdoutPct', 0, 50), cur ? cur.holdout_pct : 10);
    const status = pick('status', (v) => oneOf(v, 'status', OFFER_STATUSES), (cur?.status as (typeof OFFER_STATUSES)[number] | undefined) ?? 'draft');
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw bad('endsAt must be after startsAt.');
    if (!(await db.first('SELECT 1 FROM merchants WHERE id = ? AND tenant_id = ?', [merchantId, tenantId]))) throw bad('merchantId is not one of your merchants.');
    if (allBranches) {
      if (!(await db.first('SELECT 1 FROM merchant_branches WHERE merchant_id = ?', [merchantId]))) throw bad('This merchant has no branches yet; add branches or pick a mall.');
    } else {
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
    }
    if (allBranches) mallId = null;
    return { merchantId, mallId, floorIndex, storeId, allBranches, title, body: bodyText, titleAr, bodyAr, ctaUrl, startsAt, endsAt, priority, dailyCap, segments, maxDeliveries, maxConversions, holdoutPct, status };
  };

  const loadOffer = async (tenantId: string, id: string) => {
    const o = await db.first<OfferRow>(`${OFFER_SELECT} WHERE o.id = ? AND o.tenant_id = ?`, [id, tenantId]);
    if (!o) throw new ApiError(404, 'not_found', 'Unknown offer.');
    return o;
  };

  const offerOut = async (o: OfferRow) => offerJson(o, (await floorLabels(db, [o.mall_id]))(o.mall_id, o.floor_index));

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
    const label = await floorLabels(db, rows.map((r) => r.mall_id));
    return c.json({ offers: rows.map((o) => offerJson(o, label(o.mall_id, o.floor_index))) });
  });

  admin.get('/offers/:id', async (c) => c.json({ offer: await offerOut(await loadOffer(c.get('tenantId'), c.req.param('id'))) }));

  const OFFER_COLUMNS =
    'merchant_id, mall_id, floor_index, store_id, all_branches, title, body, title_ar, body_ar, cta_url, starts_at, ends_at, priority, daily_cap_per_user, segments, max_deliveries, max_conversions, holdout_pct, status';
  const offerValues = (f: Awaited<ReturnType<typeof offerFields>>): SqlValue[] => [
    f.merchantId,
    f.mallId,
    f.floorIndex,
    f.storeId,
    f.allBranches ? 1 : 0,
    f.title,
    f.body,
    f.titleAr,
    f.bodyAr,
    f.ctaUrl,
    f.startsAt,
    f.endsAt,
    f.priority,
    f.dailyCap,
    f.segments,
    f.maxDeliveries,
    f.maxConversions,
    f.holdoutPct,
    f.status,
  ];

  admin.post('/offers', async (c) => {
    const tenantId = c.get('tenantId');
    const f = await offerFields(tenantId, await readBody(c), null);
    const id = crypto.randomUUID();
    const t = now().toISOString();
    await db.run(`INSERT INTO offers (id, tenant_id, ${OFFER_COLUMNS}, created_at, updated_at) VALUES (?, ?, ${inList(19)}, ?, ?)`, [id, tenantId, ...offerValues(f), t, t]);
    return c.json({ offer: await offerOut(await loadOffer(tenantId, id)) }, 201);
  });

  admin.patch('/offers/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const cur = await loadOffer(tenantId, c.req.param('id'));
    const f = await offerFields(tenantId, await readBody(c), cur);
    const sets = OFFER_COLUMNS.split(', ').map((col) => `${col} = ?`).join(', ');
    await db.run(`UPDATE offers SET ${sets}, updated_at = ? WHERE id = ? AND tenant_id = ?`, [...offerValues(f), now().toISOString(), cur.id, tenantId]);
    return c.json({ offer: await offerOut(await loadOffer(tenantId, cur.id)) });
  });

  admin.delete('/offers/:id', async (c) => {
    const r = await db.run('DELETE FROM offers WHERE id = ? AND tenant_id = ?', [c.req.param('id'), c.get('tenantId')]);
    if (r.changes === 0) throw new ApiError(404, 'not_found', 'Unknown offer.');
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------------------------------------
  // Card transactions → conversions
  // ---------------------------------------------------------------------------------------------

  /**
   * The bank sends card purchases (from its servers). A purchase counts as a conversion when its
   * MID belongs to a merchant whose offer this customer was shown (treatment) or held out from
   * (control) in the 7 days before. Unmatched purchases are not stored.
   */
  admin.post('/transactions', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await readBody(c);
    if (!Array.isArray(b.transactions) || b.transactions.length === 0 || b.transactions.length > 1000) throw bad('transactions must be an array of 1–1000 purchases.');
    const t = now();
    let matched = 0;
    let duplicates = 0;
    let unmatched = 0;
    for (let i = 0; i < b.transactions.length; i++) {
      const x = obj(b.transactions[i], `transactions[${i}]`);
      const ref = str(x.ref, `transactions[${i}].ref`, { max: 128 });
      const mid = str(typeof x.mid === 'number' ? String(x.mid) : x.mid, `transactions[${i}].mid`, { max: 32, pattern: MID_PATTERN });
      const amount = num(x.amount, `transactions[${i}].amount`, 0, 1e9);
      const currency = str(x.currency, `transactions[${i}].currency`, { max: 3, pattern: /^[A-Z]{3}$/ });
      const at = isoTime(x.t, `transactions[${i}].t`);
      const installId = optStr(x.installId, `transactions[${i}].installId`, { max: 64, pattern: INSTALL_ID_PATTERN });
      const customerRef = optStr(x.customerRef, `transactions[${i}].customerRef`, { max: 128 });
      if (!installId && !customerRef) throw bad(`transactions[${i}] needs installId or customerRef.`);
      const merchant = await db.first<{ merchant_id: string }>('SELECT merchant_id FROM merchant_mids WHERE tenant_id = ? AND mid = ?', [tenantId, mid]);
      if (!merchant) {
        unmatched++;
        continue;
      }
      const installs = installId
        ? [installId]
        : (await db.all<{ install_id: string }>('SELECT install_id FROM installs WHERE tenant_id = ? AND customer_ref = ?', [tenantId, customerRef])).map((r) => r.install_id);
      if (!installs.length) {
        unmatched++;
        continue;
      }
      const exposure = await db.first<{ install_id: string; offer_id: string; type: string }>(
        `SELECT e.install_id, e.offer_id, e.type FROM events e JOIN offers o ON o.id = e.offer_id
         WHERE e.tenant_id = ? AND e.type IN ('offer_delivered', 'offer_held_out') AND o.merchant_id = ?
         AND e.install_id IN (${inList(installs.length)}) AND e.t <= ? AND e.t >= ? ORDER BY e.t DESC LIMIT 1`,
        [tenantId, merchant.merchant_id, ...installs, at, new Date(Date.parse(at) - ATTRIBUTION_MS).toISOString()],
      );
      if (!exposure) {
        unmatched++;
        continue;
      }
      const r = await db.run(
        'INSERT OR IGNORE INTO conversions (tenant_id, offer_id, install_id, grp, amount, currency, txn_hash, t, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tenantId, exposure.offer_id, exposure.install_id, exposure.type === 'offer_delivered' ? 'treatment' : 'control', amount, currency, await sha256Hex(`${tenantId}:${ref}`), at, t.toISOString()],
      );
      if (r.changes) matched++;
      else duplicates++;
    }
    return c.json({ received: b.transactions.length, matched, duplicates, unmatched });
  });

  // ---------------------------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------------------------

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
    const offers = await db.all<{ offer_id: string; title: string | null; delivered: number; opened: number; dismissed: number; treated: number; held: number }>(
      `SELECT e.offer_id, o.title,
        SUM(CASE WHEN e.type = 'offer_delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN e.type = 'offer_opened' THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN e.type = 'offer_dismissed' THEN 1 ELSE 0 END) AS dismissed,
        COUNT(DISTINCT CASE WHEN e.type = 'offer_delivered' THEN e.install_id END) AS treated,
        COUNT(DISTINCT CASE WHEN e.type = 'offer_held_out' THEN e.install_id END) AS held
       FROM events e LEFT JOIN offers o ON o.id = e.offer_id
       WHERE e.tenant_id = ? AND e.t >= ? AND e.t < ? AND e.offer_id IS NOT NULL GROUP BY e.offer_id ORDER BY delivered DESC`,
      range,
    );
    const conv = await db.all<{ offer_id: string; grp: string; customers: number; purchases: number; revenue: number }>(
      `SELECT offer_id, grp, COUNT(DISTINCT install_id) AS customers, COUNT(*) AS purchases, SUM(amount) AS revenue
       FROM conversions WHERE tenant_id = ? AND t >= ? AND t < ? GROUP BY offer_id, grp`,
      range,
    );
    const webhooks = await db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM webhook_deliveries WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY status', range);
    const label = await floorLabels(db, byFloor.map((f) => f.mall_id));
    const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
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
        const tr = conv.find((x) => x.offer_id === o.offer_id && x.grp === 'treatment');
        const ct = conv.find((x) => x.offer_id === o.offer_id && x.grp === 'control');
        const treatedRate = rate(Number(tr?.customers ?? 0), Number(o.treated));
        const controlRate = rate(Number(ct?.customers ?? 0), Number(o.held));
        return {
          offerId: o.offer_id,
          title: o.title,
          delivered,
          opened,
          dismissed: Number(o.dismissed),
          openRate: rate(opened, delivered),
          treatment: { customers: Number(o.treated), converted: Number(tr?.customers ?? 0), purchases: Number(tr?.purchases ?? 0), revenue: Number(tr?.revenue ?? 0), rate: treatedRate },
          control: { customers: Number(o.held), converted: Number(ct?.customers ?? 0), rate: controlRate },
          // Percentage points: conversion rate with the offer minus without it.
          liftPts: treatedRate !== null && controlRate !== null ? Math.round((treatedRate - controlRate) * 1000) / 10 : null,
        };
      }),
      webhooks: Object.fromEntries(webhooks.map((w) => [w.status, Number(w.n)])),
    });
  });

  return admin;
}

/** Adds mall names and floor labels to match candidates. */
async function describeCandidates(db: Db, list: MatchCandidate[]) {
  const mallIds = [...new Set(list.map((x) => x.mallId))];
  const names = new Map(
    mallIds.length ? (await db.all<{ id: string; name: string }>(`SELECT id, name FROM malls WHERE id IN (${inList(mallIds.length)})`, mallIds)).map((m) => [m.id, m.name]) : [],
  );
  const label = await floorLabels(db, mallIds);
  return list.map((x) => ({ ...x, mallName: names.get(x.mallId) ?? x.mallId, floorLabel: label(x.mallId, x.floorIndex) }));
}
