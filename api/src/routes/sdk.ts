import { haversineM } from '@locus/altitude-core';
import { Hono } from 'hono';
import type { SqlValue } from '../db';
import { erasureStatements, mayProcess } from '../consent';
import { inHoldout } from '../holdout';
import { FLOOR_REPEAT_MS, rankOffers } from '../ranking';
import {
  EVENT_TYPES,
  floorLabels,
  floorsByMall,
  inList,
  mallJson,
  OFFER_SELECT,
  parseSegments,
  readBody,
  SEGMENT_PATTERN,
  type MallRow,
  type OfferRow,
  type Services,
  type TenantRow,
  type Vars,
} from '../shared';
import { inQuietHours, localClock } from '../time';
import { ApiError, bad, ID_PATTERN, INSTALL_ID_PATTERN, isoTime, num, obj, oneOf, optInt, optStr, str } from '../validate';
import { attemptDelivery, WEBHOOK_TTL_MS, type OfferReadyPayload } from '../webhook';

export type PushReason = 'no-consent' | 'list' | 'ok' | 'no-offers' | 'floor-already-notified' | 'quiet-hours' | 'daily-limit' | 'daily-cap-reached' | 'holdout';

/** The SDK routes (publishable key, called from the bank's app). */
export function sdkRoutes(svc: Services, auth: (c: never, next: () => Promise<void>) => Promise<void>) {
  const { db, now } = svc;
  const sdk = new Hono<{ Variables: Vars }>();
  sdk.use('*', auth as never);

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
    const floors = await floorsByMall(db, malls.map((m) => m.id));
    return c.json({ malls: malls.map((m) => mallJson(m, floors.get(m.id) ?? [])), refreshAfterSeconds: 86_400 });
  });

  /**
   * Ranked offers for this customer at this mall and floor, and which one (if any) to push now.
   * Order of checks: eligible offers → one push per floor → quiet hours → daily limit across
   * offers → per-offer daily cap → control group. With delivery mode 'webhook' the push goes to
   * the bank's server and the SDK only lists it.
   */
  sdk.post('/offers', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await readBody(c);
    const installId = str(b.installId, 'installId', { min: 8, max: 64, pattern: INSTALL_ID_PATTERN });
    const mallId = str(b.mallId, 'mallId', { max: 64, pattern: ID_PATTERN });
    const floorIndex = optInt(b.floorIndex, 'floorIndex', -10, 200);
    const customerRef = optStr(b.customerRef, 'customerRef', { max: 128, pattern: /^[A-Za-z0-9._:-]+$/ });
    const locale = b.locale === undefined || b.locale === null ? null : oneOf(b.locale, 'locale', ['en', 'ar'] as const);
    const platform = b.platform === undefined || b.platform === null ? null : oneOf(b.platform, 'platform', ['ios', 'android'] as const);
    let segments: string[] = [];
    if (b.segments !== undefined && b.segments !== null) {
      if (!Array.isArray(b.segments) || b.segments.length > 20) throw bad('segments must be an array of up to 20 tags.');
      segments = b.segments.map((s, i) => str(s, `segments[${i}]`, { max: 40, pattern: SEGMENT_PATTERN }));
    }
    const mall = await db.first<MallRow>("SELECT * FROM malls WHERE id = ? AND status = 'pilot'", [mallId]);
    if (!mall) throw new ApiError(404, 'not_found', 'Unknown mall.');
    const tenant = (await db.first<TenantRow>('SELECT * FROM tenants WHERE id = ?', [tenantId]))!;
    // No consent for mall offers: nothing is stored and nothing is offered.
    if (!(await mayProcess(db, tenantId, tenant.consent_mode, installId))) {
      return c.json({ mallId, floorIndex, language: locale === 'ar' ? 'ar' : 'en', offers: [], push: null, delivery: null, reason: 'no-consent' as PushReason });
    }
    const t = now();
    const tIso = t.toISOString();
    await db.run(
      `INSERT INTO installs (tenant_id, install_id, customer_ref, segments, locale, platform, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, install_id) DO UPDATE SET customer_ref = excluded.customer_ref, segments = excluded.segments,
       locale = excluded.locale, platform = COALESCE(excluded.platform, installs.platform), updated_at = excluded.updated_at`,
      [tenantId, installId, customerRef, segments.length ? JSON.stringify(segments) : null, locale, platform, tIso],
    );

    // Offers at this mall, plus "all branches" offers of merchants with a branch here.
    const rows = await db.all<OfferRow>(`${OFFER_SELECT} WHERE o.tenant_id = ? AND o.status = 'active' AND (o.mall_id = ? OR o.all_branches = 1)`, [tenantId, mallId]);
    const branchMerchants = [...new Set(rows.filter((o) => o.all_branches === 1).map((o) => o.merchant_id))];
    const branches = branchMerchants.length
      ? await db.all<{ merchant_id: string; store_id: string; floor_index: number | null; name: string }>(
          `SELECT mb.merchant_id, s.id AS store_id, s.floor_index, s.name FROM merchant_branches mb JOIN stores s ON s.id = mb.store_id
           WHERE s.mall_id = ? AND mb.merchant_id IN (${inList(branchMerchants.length)}) ORDER BY s.id`,
          [mallId, ...branchMerchants],
        )
      : [];
    const resolved: OfferRow[] = [];
    for (const o of rows) {
      const segs = parseSegments(o.segments);
      if (segs && !segs.some((s) => segments.includes(s))) continue;
      if (o.all_branches !== 1) {
        resolved.push(o);
        continue;
      }
      const here = branches.filter((x) => x.merchant_id === o.merchant_id);
      const onFloor = floorIndex === null ? undefined : here.find((x) => x.floor_index === floorIndex);
      const anyFloor = here.find((x) => x.floor_index === null);
      const at = onFloor ?? anyFloor;
      if (!at) continue; // no branch here, or only on other floors
      resolved.push({ ...o, mall_id: mallId, floor_index: at.floor_index, store_id: at.store_id, store_name: at.name });
    }

    // Budgets: deliveries and matched purchases so far.
    const ids = resolved.map((o) => o.id);
    const budgeted = resolved.filter((o) => o.max_deliveries !== null || o.max_conversions !== null).map((o) => o.id);
    const used = new Map<string, { d: number; c: number }>();
    if (budgeted.length) {
      for (const r of await db.all<{ offer_id: string; n: number }>(
        `SELECT offer_id, COUNT(*) AS n FROM events WHERE tenant_id = ? AND type = 'offer_delivered' AND offer_id IN (${inList(budgeted.length)}) GROUP BY offer_id`,
        [tenantId, ...budgeted],
      )) used.set(r.offer_id, { d: Number(r.n), c: 0 });
      for (const r of await db.all<{ offer_id: string; n: number }>(
        `SELECT offer_id, COUNT(*) AS n FROM conversions WHERE tenant_id = ? AND grp = 'treatment' AND offer_id IN (${inList(budgeted.length)}) GROUP BY offer_id`,
        [tenantId, ...budgeted],
      )) used.set(r.offer_id, { d: used.get(r.offer_id)?.d ?? 0, c: Number(r.n) });
    }
    const withinBudget = resolved.filter((o) => {
      const u = used.get(o.id) ?? { d: 0, c: 0 };
      return (o.max_deliveries === null || u.d < o.max_deliveries) && (o.max_conversions === null || u.c < o.max_conversions);
    });

    const clock = localClock(t, tenant.timezone);
    const exposureToday = ids.length
      ? await db.all<{ offer_id: string; n: number }>(
          `SELECT offer_id, COUNT(*) AS n FROM events WHERE tenant_id = ? AND install_id = ? AND type IN ('offer_delivered', 'offer_held_out') AND t >= ? AND offer_id IN (${inList(ids.length)}) GROUP BY offer_id`,
          [tenantId, installId, clock.dayStartIso, ...ids],
        )
      : [];
    const recent = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND install_id = ? AND type IN ('offer_delivered', 'offer_held_out') AND mall_id = ? AND floor_index IS ? AND t >= ?",
      [tenantId, installId, mallId, floorIndex, new Date(t.getTime() - FLOOR_REPEAT_MS).toISOString()],
    );
    const ranked = rankOffers({
      offers: withinBudget.map((o) => ({ ...o, floorIndex: o.floor_index, priority: o.priority, dailyCapPerUser: o.daily_cap_per_user, startsAt: o.starts_at, endsAt: o.ends_at })),
      floorIndex,
      now: t,
      deliveredToday: new Map(exposureToday.map((d) => [d.offer_id, Number(d.n)])),
      floorAlreadyNotified: Number(recent?.n ?? 0) > 0,
    });

    let push = ranked.push;
    let reason: PushReason = ranked.reason;
    // An in-app "offers here" list: no push decision, so no control-group or delivery records.
    if (b.mode === 'list') {
      push = null;
      reason = 'list';
    }
    if (push && inQuietHours(clock.minutes, tenant.quiet_start, tenant.quiet_end)) {
      push = null;
      reason = 'quiet-hours';
    }
    if (push) {
      const today = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND install_id = ? AND type = 'offer_delivered' AND t >= ?", [tenantId, installId, clock.dayStartIso]);
      if (Number(today?.n ?? 0) >= tenant.max_pushes_per_day) {
        push = null;
        reason = 'daily-limit';
      }
    }
    if (push && inHoldout(installId, push.id, push.holdout_pct)) {
      // Control group: record the moment we would have pushed, so later purchases can be compared.
      await db.run("INSERT INTO events (tenant_id, install_id, type, mall_id, floor_index, offer_id, platform, t, received_at) VALUES (?, ?, 'offer_held_out', ?, ?, ?, ?, ?, ?)", [
        tenantId,
        installId,
        mallId,
        floorIndex,
        push.id,
        platform,
        tIso,
        tIso,
      ]);
      push = null;
      reason = 'holdout';
    }

    const label = await floorLabels(db, [mallId]);
    const ar = locale === 'ar';
    const shopperJson = (o: OfferRow) => ({
      id: o.id,
      merchant: { id: o.merchant_id, name: (ar && o.merchant_name_ar) || o.merchant_name || null },
      floorIndex: o.floor_index,
      floorLabel: label(mallId, o.floor_index),
      storeName: o.store_name ?? null,
      title: (ar && o.title_ar) || o.title,
      body: (ar && o.body_ar) || o.body,
      ctaUrl: o.cta_url,
      endsAt: o.ends_at,
    });

    let delivery: 'sdk' | 'webhook' | null = push ? 'sdk' : null;
    if (push && tenant.delivery_mode === 'webhook') {
      delivery = 'webhook';
      const deliveryId = crypto.randomUUID();
      const expiresAt = new Date(t.getTime() + WEBHOOK_TTL_MS).toISOString();
      const payload: OfferReadyPayload = {
        type: 'offer.ready',
        deliveryId,
        tenantId,
        installId,
        customerRef,
        createdAt: tIso,
        expiresAt,
        mall: { id: mall.id, name: mall.name },
        floor: floorIndex === null ? null : { index: floorIndex, label: label(mallId, floorIndex) },
        offer: {
          id: push.id,
          merchant: { id: push.merchant_id, name: push.merchant_name ?? null, nameAr: push.merchant_name_ar ?? null },
          title: push.title,
          body: push.body,
          titleAr: push.title_ar,
          bodyAr: push.body_ar,
          ctaUrl: push.cta_url,
          storeName: push.store_name ?? null,
          endsAt: push.ends_at,
        },
      };
      const body = JSON.stringify(payload);
      await db.batch([
        {
          sql: "INSERT INTO events (tenant_id, install_id, type, mall_id, floor_index, offer_id, platform, t, received_at) VALUES (?, ?, 'offer_delivered', ?, ?, ?, ?, ?, ?)",
          params: [tenantId, installId, mallId, floorIndex, push.id, platform, tIso, tIso],
        },
        {
          sql: "INSERT INTO webhook_deliveries (id, tenant_id, offer_id, install_id, body, status, attempts, created_at, expires_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
          params: [deliveryId, tenantId, push.id, installId, body, tIso, expiresAt, tIso],
        },
      ]);
      svc.defer(attemptDelivery(db, svc.fetchImpl, { id: deliveryId, tenant_id: tenantId, body, attempts: 0, expires_at: expiresAt }, t));
    }

    return c.json({
      mallId,
      floorIndex,
      language: ar ? 'ar' : 'en',
      offers: ranked.offers.map((o) => shopperJson(o as unknown as OfferRow)),
      push: push ? shopperJson(push) : null,
      delivery,
      reason,
    });
  });

  /** Results the SDK reports (arrivals, floors, offer delivery). Never coordinates. */
  sdk.post('/events', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await readBody(c);
    const installId = str(b.installId, 'installId', { min: 8, max: 64, pattern: INSTALL_ID_PATTERN });
    const platform = b.platform === undefined ? null : oneOf(b.platform, 'platform', ['ios', 'android'] as const);
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > 50) throw bad('events must be an array of 1–50 events.');
    const mode = (await db.first<{ consent_mode: 'sdk' | 'bank' }>('SELECT consent_mode FROM tenants WHERE id = ?', [tenantId]))!.consent_mode;
    if (!(await mayProcess(db, tenantId, mode, installId))) throw new ApiError(403, 'consent_required', 'This install has not agreed to mall offers; events are not accepted.');
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
      const list = [...offerIds];
      const own = await db.all<{ id: string }>(`SELECT id FROM offers WHERE tenant_id = ? AND id IN (${inList(list.length)})`, [tenantId, ...list]);
      if (own.length !== list.length) throw bad('An offerId does not belong to this client.');
    }
    await db.batch(rows.map((params) => ({ sql: 'INSERT INTO events (tenant_id, install_id, type, mall_id, floor_index, offer_id, platform, t, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', params })));
    return c.json({ accepted: rows.length });
  });

  /**
   * Records the customer's choice about mall offers (append-only). Withdrawing stops processing at
   * once; the SDK also stops monitoring. Data already collected stays until erased (/forget).
   */
  sdk.post('/consent', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await readBody(c);
    const installId = str(b.installId, 'installId', { min: 8, max: 64, pattern: INSTALL_ID_PATTERN });
    const status = oneOf(b.status, 'status', ['granted', 'withdrawn'] as const);
    const policyVersion = str(b.policyVersion, 'policyVersion', { max: 64, pattern: /^[A-Za-z0-9._:-]+$/ });
    const textHash = optStr(b.textHash, 'textHash', { max: 64, pattern: /^[0-9a-f]{64}$/ });
    const customerRef = optStr(b.customerRef, 'customerRef', { max: 128, pattern: /^[A-Za-z0-9._:-]+$/ });
    const language = b.language === undefined || b.language === null ? null : oneOf(b.language, 'language', ['en', 'ar'] as const);
    const platform = b.platform === undefined || b.platform === null ? null : oneOf(b.platform, 'platform', ['ios', 'android'] as const);
    const t = now();
    const at = b.t === undefined ? t.toISOString() : isoTime(b.t, 't');
    if (Math.abs(Date.parse(at) - t.getTime()) > 7 * 86_400_000) throw bad('t must be within 7 days of now.');
    await db.run(
      "INSERT INTO consents (tenant_id, install_id, customer_ref, purpose, status, policy_version, text_hash, language, platform, source, t, received_at) VALUES (?, ?, ?, 'mall_offers', ?, ?, ?, ?, ?, 'app', ?, ?)",
      [tenantId, installId, customerRef, status, policyVersion, textHash, language, platform, at, t.toISOString()],
    );
    return c.json({ recorded: true, status });
  });

  /** "Delete my data": erases this install's events, purchases and profile; consent records stay as proof. */
  sdk.post('/forget', async (c) => {
    const tenantId = c.get('tenantId');
    const b = await readBody(c);
    const installId = str(b.installId, 'installId', { min: 8, max: 64, pattern: INSTALL_ID_PATTERN });
    const t = now().toISOString();
    const last = await db.first<{ policy_version: string }>("SELECT policy_version FROM consents WHERE tenant_id = ? AND install_id = ? ORDER BY id DESC LIMIT 1", [tenantId, installId]);
    await db.batch([
      ...erasureStatements(tenantId, [installId]),
      {
        sql: "INSERT INTO consents (tenant_id, install_id, purpose, status, policy_version, source, t, received_at) VALUES (?, ?, 'mall_offers', 'withdrawn', ?, 'erasure', ?, ?)",
        params: [tenantId, installId, last?.policy_version ?? 'unknown', t, t],
      },
    ]);
    return c.json({ erased: true });
  });

  return sdk;
}
