import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { sha256Hex } from '../src/auth';
import { openNodeDb } from '../src/db-node';
import { rankOffers, startOfGulfDay } from '../src/ranking';

const PLATFORM_KEY = 'test-platform-key';
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
let clock = new Date('2026-12-01T10:00:00Z');

async function setup() {
  const db = openNodeDb(':memory:');
  db.migrate(MIGRATIONS);
  const app = createApp({ db, platformKeyHash: await sha256Hex(PLATFORM_KEY), consoleOrigins: ['https://console.example'], now: () => clock });
  const call = async (method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const created = await call('POST', '/v1/platform/tenants', PLATFORM_KEY, { id: 'bank-a', name: 'Bank A', country: 'OM' });
  const other = await call('POST', '/v1/platform/tenants', PLATFORM_KEY, { id: 'bank-b', name: 'Bank B', country: 'OM' });
  // These tests cover offers and reports; consent is tested in consent.test.ts.
  for (const t of [created, other]) await call('PATCH', '/v1/admin/settings', t.json.keys.secret, { consentMode: 'bank' });
  return { db, app, call, pub: created.json.keys.publishable as string, sec: created.json.keys.secret as string, otherSec: other.json.keys.secret as string, otherPub: other.json.keys.publishable as string };
}

type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;

const offerBody = (merchantId: string, extra: Record<string, unknown> = {}) => ({
  merchantId,
  mallId: 'mall-of-oman',
  title: '20% off with your card',
  body: 'Valid on purchases over 10 OMR.',
  startsAt: '2026-11-30T00:00:00+04:00',
  endsAt: '2026-12-31T00:00:00+04:00',
  status: 'active',
  holdoutPct: 0,
  ...extra,
});

async function merchant(name = 'Costa Coffee', key = env.sec) {
  return (await env.call('POST', '/v1/admin/merchants', key, { name, category: 'Cafe' })).json.merchant.id as string;
}

beforeEach(async () => {
  clock = new Date('2026-12-01T10:00:00Z');
  env = await setup();
});

describe('auth', () => {
  it('rejects missing, wrong-kind and unknown keys', async () => {
    expect((await env.call('GET', '/v1/sdk/malls', null)).status).toBe(401);
    expect((await env.call('GET', '/v1/sdk/malls', env.sec)).status).toBe(401);
    expect((await env.call('GET', '/v1/admin/me', env.pub)).status).toBe(401);
    expect((await env.call('GET', '/v1/admin/me', 'lk_sec_00000000000000000000000000000000')).status).toBe(401);
    expect((await env.call('GET', '/v1/platform/tenants', env.sec)).status).toBe(401);
    expect((await env.call('GET', '/v1/admin/me', env.sec)).json.tenant.name).toBe('Bank A');
  });

  it('stores only key hashes and supports revocation', async () => {
    const keys = await env.db.all<{ key_hash: string; prefix: string }>('SELECT key_hash, prefix FROM api_keys');
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k.key_hash) && k.prefix.length === 12)).toBe(true);
    const list = await env.call('GET', '/v1/platform/tenants', PLATFORM_KEY);
    const secId = list.json.tenants[0].keys.find((k: { kind: string }) => k.kind === 'secret').id;
    expect((await env.call('POST', `/v1/platform/keys/${secId}/revoke`, PLATFORM_KEY, {})).status).toBe(200);
    expect((await env.call('GET', '/v1/admin/me', env.sec)).status).toBe(401);
  });

  it('allows CORS only from the console origin, on admin routes', async () => {
    const ok = await env.app.request('/v1/admin/me', { method: 'OPTIONS', headers: { Origin: 'https://console.example', 'Access-Control-Request-Method': 'GET' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://console.example');
    const no = await env.app.request('/v1/admin/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const op = await env.app.request('/v1/platform/tenants', { method: 'OPTIONS', headers: { Origin: 'https://console.example', 'Access-Control-Request-Method': 'POST' } });
    expect(op.headers.get('Access-Control-Allow-Origin')).toBe('https://console.example');
  });
});

describe('catalogue', () => {
  it('serves pilot malls with floors, nearest first', async () => {
    const r = await env.call('GET', '/v1/sdk/malls?lat=23.59&lon=58.41&limit=2', env.pub);
    expect(r.status).toBe(200);
    expect(r.json.malls.map((m: { id: string }) => m.id)).toEqual(['oman-avenues-mall', 'mall-of-oman']);
    const moo = r.json.malls[1];
    expect(moo.floors.map((f: { label: string }) => f.label)).toEqual(['Level 1', 'Level 2', 'Level 3']);
    expect(moo.boundary.radiusM).toBe(400);
  });

  it('lets the platform upsert malls and stores, with floor validation', async () => {
    const mall = { name: 'Test Mall', city: 'Muscat', country: 'OM', lat: 23.6, lon: 58.5, radiusM: 200, status: 'pilot', floors: [{ index: 0, label: 'G', zMinM: -3, zMaxM: 3 }, { index: 1, label: '1', zMinM: 3, zMaxM: 9 }] };
    expect((await env.call('PUT', '/v1/platform/malls/test-mall', PLATFORM_KEY, mall)).status).toBe(200);
    const overlap = { ...mall, floors: [{ index: 0, label: 'G', zMinM: -3, zMaxM: 4 }, { index: 1, label: '1', zMinM: 3, zMaxM: 9 }] };
    expect((await env.call('PUT', '/v1/platform/malls/test-mall', PLATFORM_KEY, overlap)).status).toBe(400);
    const s = await env.call('POST', '/v1/platform/malls/test-mall/stores', PLATFORM_KEY, { stores: [{ name: 'Café Nero', floorIndex: 1 }] });
    expect(s.json.upserted).toBe(1);
    const stores = await env.call('GET', '/v1/admin/malls/test-mall/stores?q=nero', env.sec);
    expect(stores.json.stores[0]).toMatchObject({ id: 'test-mall--caf-nero', floorIndex: 1 });
  });
});

describe('merchants and offers', () => {
  it('validates offers against the catalogue and the client', async () => {
    const m = await merchant();
    expect((await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { floorIndex: 7 }))).json.error.message).toMatch(/not a floor/);
    expect((await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { mallId: 'nowhere' }))).status).toBe(400);
    expect((await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { endsAt: '2026-11-01T00:00:00Z' }))).json.error.message).toMatch(/after/);
    expect((await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { ctaUrl: 'http://x.example' }))).status).toBe(400);
    expect((await env.call('POST', '/v1/admin/offers', env.otherSec, offerBody(m))).json.error.message).toMatch(/not one of your merchants/);
    const ok = await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { floorIndex: 1 }));
    expect(ok.status).toBe(201);
    expect(ok.json.offer).toMatchObject({ floorIndex: 1, floorLabel: 'Level 2', merchant: { name: 'Costa Coffee' } });
  });

  it('takes the floor from a catalogue store', async () => {
    await env.call('POST', '/v1/platform/malls/mall-of-oman/stores', PLATFORM_KEY, { stores: [{ id: 'moo-costa', name: 'Costa Coffee', floorIndex: 1 }] });
    const m = await merchant();
    const r = await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { storeId: 'moo-costa' }));
    expect(r.json.offer).toMatchObject({ floorIndex: 1, storeName: 'Costa Coffee' });
    expect((await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { storeId: 'moo-costa', floorIndex: 2 }))).status).toBe(400);
  });

  it('keeps clients apart', async () => {
    const m = await merchant();
    const o = (await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m))).json.offer.id;
    expect((await env.call('GET', `/v1/admin/offers/${o}`, env.otherSec)).status).toBe(404);
    expect((await env.call('PATCH', `/v1/admin/offers/${o}`, env.otherSec, { title: 'x' })).status).toBe(404);
    expect((await env.call('DELETE', `/v1/admin/offers/${o}`, env.otherSec)).status).toBe(404);
    expect((await env.call('GET', '/v1/admin/offers', env.otherSec)).json.offers).toEqual([]);
    const sdk = await env.call('POST', '/v1/sdk/offers', env.otherPub, { installId: 'install-0001', mallId: 'mall-of-oman', floorIndex: 0 });
    expect(sdk.json.offers).toEqual([]);
  });

  it('updates offers partially and blocks deleting a merchant with active offers', async () => {
    const m = await merchant();
    const o = (await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m))).json.offer.id;
    const p = await env.call('PATCH', `/v1/admin/offers/${o}`, env.sec, { status: 'paused', priority: 5 });
    expect(p.json.offer).toMatchObject({ status: 'paused', priority: 5, title: '20% off with your card' });
    await env.call('PATCH', `/v1/admin/offers/${o}`, env.sec, { status: 'active' });
    expect((await env.call('DELETE', `/v1/admin/merchants/${m}`, env.sec)).status).toBe(409);
    await env.call('DELETE', `/v1/admin/offers/${o}`, env.sec);
    expect((await env.call('DELETE', `/v1/admin/merchants/${m}`, env.sec)).status).toBe(204);
  });
});

describe('SDK offers and events', () => {
  const ask = (floorIndex: number | null, installId = 'install-0001') => env.call('POST', '/v1/sdk/offers', env.pub, { installId, mallId: 'mall-of-oman', floorIndex });
  const report = (events: unknown[], installId = 'install-0001') => env.call('POST', '/v1/sdk/events', env.pub, { installId, platform: 'ios', events });

  it('ranks floor offers above mall-wide ones and gives no-barometer phones mall-wide offers only', async () => {
    const m = await merchant();
    const wide = (await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { title: 'Mall-wide', priority: 1 }))).json.offer.id;
    const f1 = (await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { title: 'Level 2 cafe', floorIndex: 1, priority: 1 }))).json.offer.id;
    await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { title: 'Draft', status: 'draft' }));
    await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { title: 'Expired', endsAt: '2026-12-01T09:00:00Z', startsAt: '2026-11-01T00:00:00Z' }));
    const on1 = await ask(1);
    expect(on1.json.offers.map((o: { id: string }) => o.id)).toEqual([f1, wide]);
    expect(on1.json.push.id).toBe(f1);
    expect(on1.json.push.floorLabel).toBe('Level 2');
    const noBaro = await ask(null);
    expect(noBaro.json.offers.map((o: { id: string }) => o.id)).toEqual([wide]);
    expect((await ask(2)).json.push.id).toBe(wide);
  });

  it('pushes at most once per floor and respects the daily cap', async () => {
    const m = await merchant();
    const a = (await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { title: 'A', priority: 2 }))).json.offer.id;
    const b = (await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m, { title: 'B', priority: 1 }))).json.offer.id;
    expect((await ask(0)).json.push.id).toBe(a);
    await report([{ type: 'offer_delivered', mallId: 'mall-of-oman', floorIndex: 0, offerId: a, t: clock.toISOString() }]);
    const again = await ask(0);
    expect(again.json).toMatchObject({ push: null, reason: 'floor-already-notified' });
    // Another floor: A is capped (1 a day), so B is pushed.
    expect((await ask(1)).json.push.id).toBe(b);
    // Three hours later on floor 0: still capped for A today, B is next.
    clock = new Date(clock.getTime() + 3 * 3600_000);
    expect((await ask(0)).json.push.id).toBe(b);
    // Next day (after midnight in Muscat): A again.
    clock = new Date('2026-12-02T01:00:00Z');
    expect((await ask(0)).json.push.id).toBe(a);
    // Another shopper is unaffected.
    expect((await ask(0, 'install-0002')).json.push.id).toBe(a);
  });

  it('validates events and rejects other clients’ offers', async () => {
    expect((await report([{ type: 'teleported', mallId: 'mall-of-oman', t: clock.toISOString() }])).status).toBe(400);
    expect((await report([{ type: 'offer_opened', mallId: 'mall-of-oman', t: clock.toISOString() }])).status).toBe(400);
    expect((await report([{ type: 'arrived', mallId: 'mall-of-oman', t: '2026-01-01T00:00:00Z' }])).status).toBe(400);
    expect((await report([{ type: 'arrived', mallId: 'mall-of-oman', t: clock.toISOString(), lat: 23.5 }])).status).toBe(200);
    const theirs = await merchant('Other', env.otherSec);
    const o = (await env.call('POST', '/v1/admin/offers', env.otherSec, offerBody(theirs))).json.offer.id;
    expect((await report([{ type: 'offer_opened', mallId: 'mall-of-oman', offerId: o, t: clock.toISOString() }])).status).toBe(400);
    expect((await env.call('POST', '/v1/sdk/events', env.pub, { installId: 'bad id!', events: [] })).status).toBe(400);
  });

  it('never stores coordinates', async () => {
    await report([{ type: 'arrived', mallId: 'mall-of-oman', t: clock.toISOString(), lat: 23.5, lon: 58.4 }]);
    const cols = await env.db.all<{ name: string }>("SELECT name FROM pragma_table_info('events')");
    expect(cols.map((c) => c.name)).not.toContain('lat');
  });

  it('reports arrivals, floors and offer performance', async () => {
    const m = await merchant();
    const o = (await env.call('POST', '/v1/admin/offers', env.sec, offerBody(m))).json.offer.id;
    const t = clock.toISOString();
    await report([
      { type: 'arrived', mallId: 'mall-of-oman', t },
      { type: 'floor', mallId: 'mall-of-oman', floorIndex: 0, t },
      { type: 'floor', mallId: 'mall-of-oman', floorIndex: 1, t },
      { type: 'offer_delivered', mallId: 'mall-of-oman', floorIndex: 1, offerId: o, t },
      { type: 'offer_opened', mallId: 'mall-of-oman', floorIndex: 1, offerId: o, t },
    ]);
    await report([{ type: 'arrived', mallId: 'mall-of-oman', t }, { type: 'offer_delivered', mallId: 'mall-of-oman', floorIndex: 0, offerId: o, t }], 'install-0002');
    clock = new Date(clock.getTime() + 1000);
    const r = await env.call('GET', '/v1/admin/reports/summary', env.sec);
    expect(r.json).toMatchObject({ arrivals: 2, uniqueInstalls: 2 });
    expect(r.json.byMall[0]).toMatchObject({ mallId: 'mall-of-oman', name: 'Mall of Oman', arrivals: 2 });
    expect(r.json.byFloor).toEqual([
      { mallId: 'mall-of-oman', floorIndex: 0, floorLabel: 'Level 1', visits: 1 },
      { mallId: 'mall-of-oman', floorIndex: 1, floorLabel: 'Level 2', visits: 1 },
    ]);
    expect(r.json.offers[0]).toMatchObject({ offerId: o, delivered: 2, opened: 1, openRate: 0.5 });
    expect((await env.call('GET', '/v1/admin/reports/summary', env.otherSec)).json.arrivals).toBe(0);
  });
});

describe('ranking rules', () => {
  it('starts the daily cap at midnight in Muscat', () => {
    expect(startOfGulfDay(new Date('2026-12-01T19:59:00Z'))).toBe('2026-11-30T20:00:00.000Z');
    expect(startOfGulfDay(new Date('2026-12-01T20:00:00Z'))).toBe('2026-12-01T20:00:00.000Z');
  });
  it('breaks ties by id so results are stable', () => {
    const o = (id: string) => ({ id, floorIndex: null, priority: 0, dailyCapPerUser: 1, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' });
    const r = rankOffers({ offers: [o('b'), o('a')], floorIndex: 0, now: new Date('2026-06-01T00:00:00Z'), deliveredToday: new Map(), floorAlreadyNotified: false });
    expect(r.offers.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
