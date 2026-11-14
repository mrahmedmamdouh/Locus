import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { sha256Hex } from '../src/auth';
import { openNodeDb } from '../src/db-node';
import { purgeExpired } from '../src/retention';

const PLATFORM_KEY = 'test-platform-key';
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
let clock = new Date('2026-12-01T10:00:00Z');

async function setup(tenantId = 'bank-a') {
  const db = openNodeDb(':memory:');
  db.migrate(MIGRATIONS);
  const app = createApp({ db, platformKeyHash: await sha256Hex(PLATFORM_KEY), consoleOrigins: [], now: () => clock, defer: () => {} });
  const call = async (method: string, path: string, key: string | null, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const t = await call('POST', '/v1/platform/tenants', PLATFORM_KEY, { id: tenantId, name: 'Bank', country: 'OM' });
  return { db, call, pub: t.json.keys.publishable as string, sec: t.json.keys.secret as string };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  clock = new Date('2026-12-01T10:00:00Z');
  env = await setup();
});

const days = (n: number) => new Date(clock.getTime() - n * 86_400_000).toISOString();

describe('retention', () => {
  it('defaults to 395 days and accepts 30–1095', async () => {
    expect((await env.call('GET', '/v1/admin/settings', env.sec)).json.settings.retentionDays).toBe(395);
    expect((await env.call('PATCH', '/v1/admin/settings', env.sec, { retentionDays: 20 })).status).toBe(400);
    expect((await env.call('PATCH', '/v1/admin/settings', env.sec, { retentionDays: 90 })).json.settings.retentionDays).toBe(90);
  });

  it('deletes data past each client’s period and keeps consent proof for 5 years', async () => {
    await env.call('PATCH', '/v1/admin/settings', env.sec, { retentionDays: 90 });
    const ev = (install: string, t: string) =>
      env.db.run("INSERT INTO events (tenant_id, install_id, type, mall_id, t, received_at) VALUES ('bank-a', ?, 'arrived', 'mall-of-oman', ?, ?)", [install, t, t]);
    await ev('old', days(100));
    await ev('new', days(10));
    await env.db.run("INSERT INTO installs (tenant_id, install_id, updated_at) VALUES ('bank-a', 'old', ?), ('bank-a', 'new', ?)", [days(100), days(10)]);
    const con = (install: string, t: string) =>
      env.db.run("INSERT INTO consents (tenant_id, install_id, status, policy_version, t, received_at) VALUES ('bank-a', ?, 'granted', 'v1', ?, ?)", [install, t, t]);
    await con('ancient', days(6 * 365));
    await con('old', days(100));
    await env.db.run("INSERT INTO audit_log (tenant_id, actor, method, path, status, t) VALUES ('bank-a', 'x', 'POST', '/p', 200, ?)", [days(800)]);

    const r = await purgeExpired(env.db, clock);
    expect(r).toMatchObject({ events: 1, installs: 1, consents: 1, audit: 1 });
    const left = async (sql: string) => (await env.db.all<{ install_id: string }>(sql)).map((x) => x.install_id).sort();
    expect(await left('SELECT install_id FROM events')).toEqual(['new']);
    expect(await left('SELECT install_id FROM installs')).toEqual(['new']);
    expect(await left('SELECT install_id FROM consents')).toEqual(['old']);
  });
});

describe('audit log', () => {
  it('records changes made with the secret key and by operators, not reads or keys', async () => {
    await env.call('GET', '/v1/admin/offers', env.sec);
    await env.call('POST', '/v1/platform/tenants/bank-a/keys', PLATFORM_KEY, { kind: 'publishable' });
    await env.call('POST', '/v1/admin/merchants', env.sec, { name: 'Costa Coffee' });
    await env.call('PATCH', '/v1/admin/settings', env.sec, { maxPushesPerDay: 2 });
    const log = (await env.call('GET', '/v1/admin/audit', env.sec)).json.entries as { actor: string; method: string; path: string; status: number }[];
    expect(log.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual(['PATCH /v1/admin/settings 200', 'POST /v1/admin/merchants 201', 'POST /v1/platform/tenants/bank-a/keys 201']);
    expect(log[0]!.actor).toBe(env.sec.slice(0, 12));
    expect(log[2]!.actor).toBe('locus-operator');
    expect(JSON.stringify(log)).not.toContain(env.sec);
  });
});

describe('demo data', () => {
  const loadCatalogue = async () => {
    await env.call('POST', '/v1/platform/malls/mall-of-oman/stores', PLATFORM_KEY, {
      stores: [
        { name: 'Costa Coffee', floorIndex: 0 },
        { name: 'Carrefour', floorIndex: 0 },
      ],
    });
    await env.call('POST', '/v1/platform/malls/oman-avenues-mall/stores', PLATFORM_KEY, {
      stores: [
        { name: 'Starbucks', floorIndex: 1 },
        { name: 'H&M', floorIndex: 1 },
      ],
    });
  };

  it('is only for demo clients', async () => {
    await loadCatalogue();
    expect((await env.call('POST', '/v1/platform/tenants/bank-a/demo-data', PLATFORM_KEY, {})).status).toBe(403);
  });

  it('fills a demo client with merchants, offers and four weeks of activity, the same each time', async () => {
    env = await setup('demo-bank');
    await loadCatalogue();
    const load = async () => {
      const s = (await env.call('POST', '/v1/platform/tenants/demo-bank/demo-data', PLATFORM_KEY, {})).json;
      expect(s).toMatchObject({ merchants: 5, offers: 5, next: 0 });
      expect(s.branches).toBeGreaterThanOrEqual(4);
      let next: number | null = 0;
      while (next !== null) next = (await env.call('POST', '/v1/platform/tenants/demo-bank/demo-data/activity', PLATFORM_KEY, { from: next })).json.next;
      return (await env.call('GET', `/v1/admin/reports/summary?from=${days(29)}&to=${clock.toISOString()}`, env.sec)).json;
    };
    const first = await load();
    expect(first.arrivals).toBeGreaterThan(1000);
    expect(first.consent.optedIn).toBeGreaterThan(900);
    expect(first.offers.length).toBe(4);
    const all = first.offers.reduce(
      (a: { t: number; tc: number; c: number; cc: number }, o: { treatment: { customers: number; converted: number }; control: { customers: number; converted: number } }) => ({
        t: a.t + o.treatment.customers,
        tc: a.tc + o.treatment.converted,
        c: a.c + o.control.customers,
        cc: a.cc + o.control.converted,
      }),
      { t: 0, tc: 0, c: 0, cc: 0 },
    );
    expect(all.c).toBeGreaterThan(50);
    expect(all.tc / all.t).toBeGreaterThan(all.cc / all.c); // the offers show a lift
    const second = await load(); // reloading replaces, never duplicates
    expect(second.arrivals).toBe(first.arrivals);
    expect((await env.call('GET', '/v1/admin/merchants', env.sec)).json.merchants.length).toBe(5);
    const log = (await env.call('GET', '/v1/admin/audit', env.sec)).json.entries as { path: string }[];
    expect(log.filter((e) => e.path.includes('demo-data')).length).toBe(2); // one per load, not per batch
  });
});
