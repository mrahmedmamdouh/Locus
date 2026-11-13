import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { sha256Hex } from '../src/auth';
import { openNodeDb } from '../src/db-node';
import { holdoutBucket, inHoldout } from '../src/holdout';
import { matchStores, nameSimilarity, normalizeName } from '../src/match';
import { isPublicHttpsUrl } from '../src/routes/admin';
import { inQuietHours, localClock } from '../src/time';
import { retryDueDeliveries, signWebhook, type FetchLike } from '../src/webhook';

const PLATFORM_KEY = 'test-platform-key';
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

describe('name matching', () => {
  it('normalises legal suffixes, punctuation and case', () => {
    expect(normalizeName('COSTA COFFEE L.L.C.')).toBe('costa coffee');
    expect(normalizeName('H&M')).toBe(normalizeName('H and M'));
    expect(normalizeName('Café Nero')).toBe('cafe nero');
  });
  it('scores the same words 1, containment high, unrelated low', () => {
    expect(nameSimilarity('Coffee Costa LLC', 'Costa Coffee')).toBe(1);
    expect(nameSimilarity('Costa', 'Costa Coffee')).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity('Starbucks', 'Costa Coffee')).toBeLessThan(0.6);
  });
  it('returns candidates above the review threshold, best first', () => {
    const stores = [
      { id: 'a', name: 'Costa Coffee', mall_id: 'm', floor_index: 1 },
      { id: 'b', name: 'Costa Coffee Kiosk', mall_id: 'm', floor_index: 0 },
      { id: 'c', name: 'Zara', mall_id: 'm', floor_index: 0 },
    ];
    expect(matchStores('COSTA COFFEE LLC', stores).map((c) => c.storeId)).toEqual(['a', 'b']);
  });
});

describe('local time, quiet hours, holdout', () => {
  it('finds local midnight in Muscat and Cairo', () => {
    const now = new Date('2026-12-01T21:30:00Z'); // 01:30 on 2 Dec in Muscat, 23:30 on 1 Dec in Cairo
    expect(localClock(now, 'Asia/Muscat')).toEqual({ minutes: 90, dayStartIso: '2026-12-01T20:00:00.000Z' });
    expect(localClock(now, 'Africa/Cairo')).toEqual({ minutes: 23 * 60 + 30, dayStartIso: '2026-11-30T22:00:00.000Z' });
  });
  it('handles quiet hours that wrap past midnight', () => {
    expect(inQuietHours(23 * 60, '22:00', '08:00')).toBe(true);
    expect(inQuietHours(7 * 60 + 59, '22:00', '08:00')).toBe(true);
    expect(inQuietHours(8 * 60, '22:00', '08:00')).toBe(false);
    expect(inQuietHours(13 * 60, '12:00', '14:00')).toBe(true);
    expect(inQuietHours(13 * 60, null, null)).toBe(false);
  });
  it('puts about the configured share in the control group, stably', () => {
    const n = 5000;
    const held = Array.from({ length: n }, (_, i) => inHoldout(`install-${i}`, 'offer-1', 10)).filter(Boolean).length;
    expect(held / n).toBeGreaterThan(0.08);
    expect(held / n).toBeLessThan(0.12);
    expect(holdoutBucket('install-1', 'offer-1')).toBe(holdoutBucket('install-1', 'offer-1'));
    expect(inHoldout('install-1', 'offer-1', 0)).toBe(false);
  });
  it('rejects private webhook addresses', () => {
    expect(isPublicHttpsUrl('https://hooks.bank.example/locus')).toBe(true);
    for (const u of ['http://bank.example', 'https://localhost/x', 'https://10.0.0.5/x', 'https://192.168.1.2', 'https://169.254.169.254/latest', 'https://172.20.0.1', 'https://[::1]/x']) {
      expect(isPublicHttpsUrl(u), u).toBe(false);
    }
  });
});

describe('migration 0003 keeps existing data', () => {
  it('upgrades offers and events written before the batch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locus-mig-'));
    for (const f of readdirSync(MIGRATIONS).filter((f) => f < '0003')) cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = openNodeDb(':memory:');
    db.migrate(dir);
    const raw = db as unknown as { run: (s: string, p?: unknown[]) => Promise<unknown> };
    return (async () => {
      await raw.run("INSERT INTO tenants (id, name, country, created_at) VALUES ('t', 'T', 'EG', 'x')");
      await raw.run("INSERT INTO merchants (id, tenant_id, name, created_at) VALUES ('m', 't', 'M', 'x')");
      await raw.run("INSERT INTO offers (id, tenant_id, merchant_id, mall_id, title, starts_at, ends_at, status, created_at, updated_at) VALUES ('o', 't', 'm', 'mall-of-oman', 'Old', 'a', 'b', 'active', 'x', 'x')");
      await raw.run("INSERT INTO events (tenant_id, install_id, type, mall_id, t, received_at) VALUES ('t', 'install-1', 'arrived', 'mall-of-oman', 'x', 'x')");
      db.migrate(MIGRATIONS);
      const o = await db.first<{ title: string; all_branches: number; holdout_pct: number }>("SELECT title, all_branches, holdout_pct FROM offers WHERE id = 'o'");
      expect(o).toEqual({ title: 'Old', all_branches: 0, holdout_pct: 0 });
      expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM events'))!.n).toBe(1);
      expect((await db.first<{ timezone: string }>("SELECT timezone FROM tenants WHERE id = 't'"))!.timezone).toBe('Africa/Cairo');
    })();
  });
});

// ------------------------------------------------------------------------------------------------
// End-to-end through the HTTP routes
// ------------------------------------------------------------------------------------------------

let clock: Date;
let sent: { url: string; headers: Record<string, string>; body: string }[];
let bankStatus: number;
let deferred: Promise<unknown>[];

async function setup() {
  const db = openNodeDb(':memory:');
  db.migrate(MIGRATIONS);
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { ok: bankStatus >= 200 && bankStatus < 300, status: bankStatus };
  };
  const app = createApp({ db, platformKeyHash: await sha256Hex(PLATFORM_KEY), consoleOrigins: [], now: () => clock, fetchImpl, defer: (p) => deferred.push(p) });
  const call = async (method: string, path: string, key: string | null, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const t = await call('POST', '/v1/platform/tenants', PLATFORM_KEY, { id: 'bank-a', name: 'Bank A', country: 'OM' });
  // Consent is tested in consent.test.ts.
  await call('PATCH', '/v1/admin/settings', t.json.keys.secret, { consentMode: 'bank' });
  await call('POST', '/v1/platform/malls/mall-of-oman/stores', PLATFORM_KEY, {
    stores: [
      { id: 'moo-costa', name: 'Costa Coffee', floorIndex: 1 },
      { id: 'moo-carrefour', name: 'Carrefour', floorIndex: 0 },
      { id: 'moo-kiosk', name: 'Costa Coffee Kiosk', floorIndex: 2 },
    ],
  });
  await call('POST', '/v1/platform/malls/oman-avenues-mall/stores', PLATFORM_KEY, { stores: [{ id: 'oam-costa', name: 'Costa Coffee', floorIndex: 0 }] });
  return { db, call, pub: t.json.keys.publishable as string, sec: t.json.keys.secret as string };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  clock = new Date('2026-12-01T10:00:00Z'); // 14:00 in Muscat
  sent = [];
  bankStatus = 200;
  deferred = [];
  env = await setup();
});

const offer = (merchantId: string, extra: Record<string, unknown> = {}) => ({
  merchantId,
  mallId: 'mall-of-oman',
  title: 'Free cookie with any coffee',
  titleAr: 'كوكيز مجانية مع أي قهوة',
  startsAt: '2026-11-30T00:00:00+04:00',
  endsAt: '2026-12-31T00:00:00+04:00',
  status: 'active',
  holdoutPct: 0,
  ...extra,
});
const ask = (floorIndex: number | null, extra: Record<string, unknown> = {}) =>
  env.call('POST', '/v1/sdk/offers', env.pub, { installId: 'install-0001', mallId: 'mall-of-oman', floorIndex, ...extra });

describe('merchant import, MIDs and branches', () => {
  it('dry-runs, then imports with automatic and reviewed branch matches', async () => {
    const body = {
      merchants: [
        { externalId: 'M-1', name: 'COSTA COFFEE LLC', nameAr: 'كوستا كوفي', mcc: '5814', mids: ['100001', '100002'] },
        { externalId: 'M-2', name: 'Carrefour Hypermarket', branches: [{ mallId: 'mall-of-oman', storeName: 'Carrefour' }] },
        { externalId: 'M-3', name: 'Nowhere Shop', mids: ['100001'] },
      ],
    };
    const dry = await env.call('POST', '/v1/admin/merchants/import', env.sec, { ...body, dryRun: true });
    expect(dry.json.summary).toMatchObject({ created: 3, branchesLinked: 3 });
    expect((await env.call('GET', '/v1/admin/merchants', env.sec)).json.merchants).toEqual([]);

    const r = await env.call('POST', '/v1/admin/merchants/import', env.sec, body);
    const costa = r.json.results[0];
    expect(costa.linked.map((x: { storeId: string }) => x.storeId).sort()).toEqual(['moo-costa', 'oam-costa']);
    expect(costa.review.map((x: { storeId: string }) => x.storeId)).toContain('moo-kiosk');
    expect(r.json.results[1].linked[0]).toMatchObject({ storeId: 'moo-carrefour', mallName: 'Mall of Oman', floorLabel: 'Level 1' });
    expect(r.json.results[2].errors[0]).toMatch(/MID 100001/);

    const list = (await env.call('GET', '/v1/admin/merchants', env.sec)).json.merchants;
    const c = list.find((m: { externalId: string }) => m.externalId === 'M-1');
    expect(c).toMatchObject({ nameAr: 'كوستا كوفي', mcc: '5814', branchCount: 2, midCount: 2 });

    // Re-import by externalId updates instead of duplicating.
    const again = await env.call('POST', '/v1/admin/merchants/import', env.sec, { merchants: [{ externalId: 'M-1', name: 'Costa Coffee', autoMatch: false }] });
    expect(again.json.summary).toMatchObject({ created: 0, updated: 1 });
    expect((await env.call('GET', '/v1/admin/merchants', env.sec)).json.merchants).toHaveLength(3);
  });

  it('edits branches and MIDs directly and suggests stores', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Costa Coffee', mids: ['555'] })).json.merchant;
    expect(m.branches).toEqual([]);
    const s = await env.call('GET', `/v1/admin/merchants/${m.id}/suggestions`, env.sec);
    expect(s.json.suggestions.map((x: { storeId: string }) => x.storeId)).toContain('moo-costa');
    const b = await env.call('PUT', `/v1/admin/merchants/${m.id}/branches`, env.sec, { storeIds: ['moo-costa'] });
    expect(b.json.merchant.branches[0]).toMatchObject({ storeId: 'moo-costa', floorLabel: 'Level 2', source: 'manual' });
    expect((await env.call('PUT', `/v1/admin/merchants/${m.id}/branches`, env.sec, { storeIds: ['nope'] })).status).toBe(400);
    const other = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Other' })).json.merchant;
    expect((await env.call('PATCH', `/v1/admin/merchants/${other.id}`, env.sec, { mids: ['555'] })).status).toBe(409);
  });
});

describe('targeting', () => {
  it('serves an all-branches offer on each branch floor, in Arabic when asked', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Costa Coffee', nameAr: 'كوستا' })).json.merchant;
    expect((await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { allBranches: true, mallId: undefined }))).json.error.message).toMatch(/no branches/);
    await env.call('PUT', `/v1/admin/merchants/${m.id}/branches`, env.sec, { storeIds: ['moo-costa', 'oam-costa'] });
    const o = await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { allBranches: true }));
    expect(o.json.offer).toMatchObject({ allBranches: true, mallId: null, floorIndex: null });

    expect((await ask(0)).json.offers).toEqual([]);
    const onCostaFloor = await ask(1, { locale: 'ar' });
    expect(onCostaFloor.json.push).toMatchObject({ title: 'كوكيز مجانية مع أي قهوة', storeName: 'Costa Coffee', floorLabel: 'Level 2', merchant: { name: 'كوستا' } });
    const avenues = await env.call('POST', '/v1/sdk/offers', env.pub, { installId: 'install-0002', mallId: 'oman-avenues-mall', floorIndex: 0 });
    expect(avenues.json.push.floorLabel).toBe('Ground');
    expect(avenues.json.push.title).toBe('Free cookie with any coffee');
  });

  it('shows segment offers only to customers in the segment', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour' })).json.merchant;
    await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { segments: ['visa-infinite'] }));
    expect((await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { segments: ['Bad Tag'] }))).status).toBe(400);
    expect((await ask(0)).json.offers).toHaveLength(0);
    expect((await ask(0, { segments: ['debit'] })).json.offers).toHaveLength(0);
    expect((await ask(0, { segments: ['debit', 'visa-infinite'] })).json.push).not.toBeNull();
    const row = await env.db.first<{ segments: string }>("SELECT segments FROM installs WHERE install_id = 'install-0001'");
    expect(JSON.parse(row!.segments)).toEqual(['debit', 'visa-infinite']);
  });
});

describe('push rules', () => {
  it('holds pushes in quiet hours and after the daily limit across offers', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour' })).json.merchant;
    for (let i = 0; i < 3; i++) await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { title: `Offer ${i}`, floorIndex: i }));
    await env.call('PATCH', '/v1/admin/settings', env.sec, { quietHours: { start: '22:00', end: '08:00' }, maxPushesPerDay: 2 });
    clock = new Date('2026-12-01T19:00:00Z'); // 23:00 in Muscat
    expect((await ask(0)).json).toMatchObject({ push: null, reason: 'quiet-hours' });
    clock = new Date('2026-12-01T10:00:00Z');
    const deliver = async (floor: number) => {
      const r = await ask(floor);
      if (r.json.push) await env.call('POST', '/v1/sdk/events', env.pub, { installId: 'install-0001', events: [{ type: 'offer_delivered', mallId: 'mall-of-oman', floorIndex: floor, offerId: r.json.push.id, t: clock.toISOString() }] });
      return r.json;
    };
    expect((await deliver(0)).reason).toBe('ok');
    expect((await deliver(1)).reason).toBe('ok');
    expect((await deliver(2)).reason).toBe('daily-limit');
  });

  it('lists offers for an in-app screen without a push decision', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour' })).json.merchant;
    await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { holdoutPct: 50 }));
    for (let i = 0; i < 10; i++) {
      const r = await env.call('POST', '/v1/sdk/offers', env.pub, { installId: `install-${3000 + i}`, mallId: 'mall-of-oman', floorIndex: 0, mode: 'list' });
      expect(r.json).toMatchObject({ push: null, delivery: null, reason: 'list' });
      expect(r.json.offers).toHaveLength(1);
    }
    expect((await env.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'offer_held_out'"))!.n).toBe(0);
  });

  it('stops an offer at its delivery budget', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour' })).json.merchant;
    const o = (await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { maxDeliveries: 1 }))).json.offer;
    await env.call('POST', '/v1/sdk/events', env.pub, { installId: 'install-0009', events: [{ type: 'offer_delivered', mallId: 'mall-of-oman', offerId: o.id, t: clock.toISOString() }] });
    expect((await ask(0)).json).toMatchObject({ offers: [], reason: 'no-offers' });
  });

  it('keeps a control group: held-out customers get no push and are recorded', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour' })).json.merchant;
    const o = (await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { holdoutPct: 50 }))).json.offer;
    let held = 0;
    for (let i = 0; i < 40; i++) {
      const r = await env.call('POST', '/v1/sdk/offers', env.pub, { installId: `install-${1000 + i}`, mallId: 'mall-of-oman', floorIndex: 0 });
      if (r.json.reason === 'holdout') held++;
      expect(r.json.reason === 'holdout' || r.json.push?.id === o.id).toBe(true);
    }
    expect(held).toBeGreaterThan(5);
    expect(held).toBeLessThan(35);
    expect((await env.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'offer_held_out'"))!.n).toBe(held);
  });
});

describe('bank webhook delivery', () => {
  async function enableWebhook() {
    expect((await env.call('PATCH', '/v1/admin/settings', env.sec, { deliveryMode: 'webhook', webhookUrl: 'https://hooks.bank.example/locus' })).status).toBe(400);
    const secret = (await env.call('POST', '/v1/admin/settings/webhook-secret', env.sec, {})).json.secret as string;
    expect((await env.call('PATCH', '/v1/admin/settings', env.sec, { webhookUrl: 'https://127.0.0.1/hook' })).status).toBe(400);
    const s = await env.call('PATCH', '/v1/admin/settings', env.sec, { deliveryMode: 'webhook', webhookUrl: 'https://hooks.bank.example/locus' });
    expect(s.json.settings).toMatchObject({ deliveryMode: 'webhook', webhookSecretSet: true });
    return secret;
  }

  it('sends a signed offer.ready to the bank and records the delivery', async () => {
    const secret = await enableWebhook();
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour' })).json.merchant;
    await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id));
    const r = await ask(0, { customerRef: 'cust-7f3a' });
    expect(r.json).toMatchObject({ delivery: 'webhook', reason: 'ok' });
    await Promise.all(deferred);
    expect(sent).toHaveLength(1);
    const h = sent[0]!.headers;
    const [, ts, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h['Locus-Signature']!)!;
    expect(v1).toBe(await signWebhook(secret, Number(ts), sent[0]!.body));
    const payload = JSON.parse(sent[0]!.body);
    expect(payload).toMatchObject({ type: 'offer.ready', customerRef: 'cust-7f3a', installId: 'install-0001', mall: { name: 'Mall of Oman' }, floor: { index: 0, label: 'Level 1' }, offer: { titleAr: 'كوكيز مجانية مع أي قهوة' } });
    expect(h['Locus-Delivery']).toBe(payload.deliveryId);
    // Counted as delivered now, so the same floor is not notified twice.
    expect((await ask(0)).json.reason).toBe('floor-already-notified');
    const d = await env.call('GET', '/v1/admin/deliveries', env.sec);
    expect(d.json.deliveries[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('retries a failing bank with back-off and expires after 10 minutes', async () => {
    await enableWebhook();
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour' })).json.merchant;
    await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id));
    bankStatus = 503;
    await ask(0);
    await Promise.all(deferred);
    const fetchImpl: FetchLike = async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { ok: bankStatus < 300, status: bankStatus };
    };
    expect(await retryDueDeliveries(env.db, fetchImpl, new Date(clock.getTime() + 10_000))).toEqual({ attempted: 0, expired: 0 }); // not due yet
    bankStatus = 200;
    expect(await retryDueDeliveries(env.db, fetchImpl, new Date(clock.getTime() + 31_000))).toEqual({ attempted: 1, expired: 0 });
    expect((await env.call('GET', '/v1/admin/deliveries?status=sent', env.sec)).json.deliveries).toHaveLength(1);
    expect(sent.map((s) => s.headers['Locus-Delivery'])).toEqual([sent[0]!.headers['Locus-Delivery'], sent[0]!.headers['Locus-Delivery']]);

    // A second delivery that the bank never accepts expires.
    clock = new Date(clock.getTime() + 3 * 3600_000);
    bankStatus = 500;
    await env.call('POST', '/v1/sdk/offers', env.pub, { installId: 'install-0002', mallId: 'mall-of-oman', floorIndex: 0 });
    await Promise.all(deferred);
    expect((await retryDueDeliveries(env.db, fetchImpl, new Date(clock.getTime() + 11 * 60_000))).expired).toBe(1);
  });

  it('pings the webhook from settings', async () => {
    await enableWebhook();
    const r = await env.call('POST', '/v1/admin/settings/webhook-test', env.sec, {});
    expect(r.json).toEqual({ ok: true, status: 200 });
    expect(sent[0]!.headers['Locus-Event']).toBe('ping');
  });
});

describe('conversions', () => {
  it('matches purchases by MID to shown and held-out customers and reports lift', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour', mids: ['777001'] })).json.merchant;
    const o = (await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id, { holdoutPct: 50 }))).json.offer;
    const treated: string[] = [];
    const control: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `install-${2000 + i}`;
      const r = await env.call('POST', '/v1/sdk/offers', env.pub, { installId: id, mallId: 'mall-of-oman', floorIndex: 0, customerRef: `cust-${i}` });
      if (r.json.reason === 'holdout') control.push(id);
      else {
        treated.push(id);
        await env.call('POST', '/v1/sdk/events', env.pub, { installId: id, events: [{ type: 'offer_delivered', mallId: 'mall-of-oman', floorIndex: 0, offerId: o.id, t: clock.toISOString() }] });
      }
    }
    clock = new Date(clock.getTime() + 3600_000);
    const later = new Date(clock.getTime() - 60_000).toISOString();
    const txns = [
      ...treated.slice(0, 4).map((id, i) => ({ ref: `T${i}`, installId: id, mid: '777001', amount: 12.5, currency: 'OMR', t: later })),
      { ref: 'C0', customerRef: `cust-${Number(control[0]!.slice(8)) - 2000}`, mid: 777001, amount: 8, currency: 'OMR', t: later },
      { ref: 'X1', installId: treated[0], mid: '999999', amount: 5, currency: 'OMR', t: later },
      { ref: 'X2', installId: 'install-9999', mid: '777001', amount: 5, currency: 'OMR', t: later },
    ];
    const r = await env.call('POST', '/v1/admin/transactions', env.sec, { transactions: txns });
    expect(r.json).toEqual({ received: 7, matched: 5, duplicates: 0, unmatched: 2 });
    expect((await env.call('POST', '/v1/admin/transactions', env.sec, { transactions: txns.slice(0, 1) })).json.duplicates).toBe(1);
    expect((await env.db.all('SELECT * FROM conversions')).every((c) => !('ref' in (c as object)))).toBe(true);

    const rep = (await env.call('GET', '/v1/admin/reports/summary', env.sec)).json;
    const row = rep.offers.find((x: { offerId: string }) => x.offerId === o.id);
    expect(row.treatment).toMatchObject({ customers: treated.length, converted: 4, purchases: 4, revenue: 50 });
    expect(row.control).toMatchObject({ customers: control.length, converted: 1 });
    const expected = Math.round((Math.round((4 / treated.length) * 1000) / 1000 - Math.round((1 / control.length) * 1000) / 1000) * 1000) / 10;
    expect(row.liftPts).toBe(expected);
  });

  it('ignores purchases outside the 7-day window or before the offer was shown', async () => {
    const m = (await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Carrefour', mids: ['777001'] })).json.merchant;
    const o = (await env.call('POST', '/v1/admin/offers', env.sec, offer(m.id))).json.offer;
    await env.call('POST', '/v1/sdk/events', env.pub, { installId: 'install-0001', events: [{ type: 'offer_delivered', mallId: 'mall-of-oman', offerId: o.id, t: clock.toISOString() }] });
    const at = (ms: number) => new Date(clock.getTime() + ms).toISOString();
    const r = await env.call('POST', '/v1/admin/transactions', env.sec, {
      transactions: [
        { ref: 'early', installId: 'install-0001', mid: '777001', amount: 1, currency: 'OMR', t: at(-60_000) },
        { ref: 'late', installId: 'install-0001', mid: '777001', amount: 1, currency: 'OMR', t: at(8 * 86_400_000) },
      ],
    });
    expect(r.json).toMatchObject({ matched: 0, unmatched: 2 });
  });
});
