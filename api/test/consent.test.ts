import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { sha256Hex } from '../src/auth';
import { openNodeDb } from '../src/db-node';

const PLATFORM_KEY = 'test-platform-key';
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
let clock = new Date('2026-12-01T10:00:00Z');

async function setup() {
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
  const t = await call('POST', '/v1/platform/tenants', PLATFORM_KEY, { id: 'bank-a', name: 'Bank A', country: 'OM' });
  const pub = t.json.keys.publishable as string;
  const sec = t.json.keys.secret as string;
  const m = (await call('POST', '/v1/admin/merchants', sec, { name: 'Carrefour', mids: ['777001'] })).json.merchant;
  const o = (
    await call('POST', '/v1/admin/offers', sec, {
      merchantId: m.id,
      mallId: 'mall-of-oman',
      title: 'Offer',
      startsAt: '2026-11-30T00:00:00Z',
      endsAt: '2026-12-31T00:00:00Z',
      status: 'active',
      holdoutPct: 0,
    })
  ).json.offer;
  return { db, call, pub, sec, offerId: o.id as string };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  clock = new Date('2026-12-01T10:00:00Z');
  env = await setup();
});

const consent = (installId: string, status: 'granted' | 'withdrawn', extra: Record<string, unknown> = {}) =>
  env.call('POST', '/v1/sdk/consent', env.pub, { installId, status, policyVersion: 'mall-offers-2026-11', language: 'ar', platform: 'ios', ...extra });
const ask = (installId = 'install-0001') => env.call('POST', '/v1/sdk/offers', env.pub, { installId, mallId: 'mall-of-oman', floorIndex: 0, customerRef: 'cust-1' });
const arrived = (installId = 'install-0001') => env.call('POST', '/v1/sdk/events', env.pub, { installId, events: [{ type: 'arrived', mallId: 'mall-of-oman', t: clock.toISOString() }] });

describe('consent (default mode: the SDK records it)', () => {
  it('offers nothing and stores nothing before consent', async () => {
    expect((await ask()).json).toMatchObject({ offers: [], push: null, reason: 'no-consent' });
    expect((await arrived()).status).toBe(403);
    expect((await env.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM installs'))!.n).toBe(0);
  });

  it('works after consent and stops at once after withdrawal', async () => {
    const hash = await sha256Hex('أوافق على عروض المراكز التجارية');
    expect((await consent('install-0001', 'granted', { textHash: hash, customerRef: 'cust-1' })).json).toEqual({ recorded: true, status: 'granted' });
    expect((await ask()).json.push).not.toBeNull();
    expect((await arrived()).status).toBe(200);
    clock = new Date(clock.getTime() + 60_000);
    await consent('install-0001', 'withdrawn');
    expect((await ask()).json.reason).toBe('no-consent');
    expect((await arrived()).status).toBe(403);
  });

  it('validates the record', async () => {
    expect((await consent('install-0001', 'granted', { policyVersion: 'has spaces' })).status).toBe(400);
    expect((await consent('install-0001', 'granted', { textHash: 'nothex' })).status).toBe(400);
    expect((await env.call('POST', '/v1/sdk/consent', env.pub, { installId: 'install-0001', status: 'maybe', policyVersion: 'v1' })).status).toBe(400);
  });

  it('shows the history to the bank by customer reference', async () => {
    await consent('install-0001', 'granted', { customerRef: 'cust-1' });
    clock = new Date(clock.getTime() + 60_000);
    await consent('install-0002', 'granted', { customerRef: 'cust-1', platform: 'android' });
    clock = new Date(clock.getTime() + 60_000);
    await consent('install-0001', 'withdrawn', { customerRef: 'cust-1' });
    const h = await env.call('GET', '/v1/admin/consents?customerRef=cust-1', env.sec);
    expect(h.json.installs.sort()).toEqual(['install-0001', 'install-0002']);
    expect(h.json.records.map((r: { status: string; installId: string }) => `${r.installId}:${r.status}`)).toEqual(['install-0001:withdrawn', 'install-0002:granted', 'install-0001:granted']);
    const rep = await env.call('GET', '/v1/admin/reports/summary', env.sec);
    expect(rep.json.consent).toEqual({ optedIn: 1, optedOut: 1 });
  });

  it('erases an install on request but keeps the consent trail', async () => {
    await consent('install-0001', 'granted', { customerRef: 'cust-1' });
    await ask();
    await arrived();
    await env.call('POST', '/v1/admin/transactions', env.sec, { transactions: [{ ref: 'x', installId: 'install-0001', mid: '777001', amount: 1, currency: 'OMR', t: clock.toISOString() }] });
    expect((await env.call('POST', '/v1/sdk/forget', env.pub, { installId: 'install-0001' })).json).toEqual({ erased: true });
    for (const table of ['events', 'installs', 'conversions']) {
      expect((await env.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n, table).toBe(0);
    }
    const h = await env.call('GET', '/v1/admin/consents?installId=install-0001', env.sec);
    expect(h.json.records[0]).toMatchObject({ status: 'withdrawn', source: 'erasure' });
    expect((await ask()).json.reason).toBe('no-consent');
  });

  it('lets the bank erase a customer by reference', async () => {
    await consent('install-0001', 'granted', { customerRef: 'cust-1' });
    await consent('install-0002', 'granted', { customerRef: 'cust-1' });
    await ask('install-0001');
    await arrived('install-0002');
    const r = await env.call('POST', '/v1/admin/customers/forget', env.sec, { customerRef: 'cust-1' });
    expect(r.json.erasedInstalls).toBe(2);
    expect((await env.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM events'))!.n).toBe(0);
  });

  it('does not count purchases of customers without consent', async () => {
    await consent('install-0001', 'granted');
    await ask();
    await env.call('POST', '/v1/sdk/events', env.pub, { installId: 'install-0001', events: [{ type: 'offer_delivered', mallId: 'mall-of-oman', offerId: env.offerId, t: clock.toISOString() }] });
    clock = new Date(clock.getTime() + 60_000);
    await consent('install-0001', 'withdrawn');
    const r = await env.call('POST', '/v1/admin/transactions', env.sec, { transactions: [{ ref: 'y', installId: 'install-0001', mid: '777001', amount: 1, currency: 'OMR', t: clock.toISOString() }] });
    expect(r.json).toMatchObject({ matched: 0, unmatched: 1 });
  });
});

describe("consent mode 'bank' (the bank records consent itself)", () => {
  it('processes without SDK consent records and still logs any sent', async () => {
    await env.call('PATCH', '/v1/admin/settings', env.sec, { consentMode: 'bank' });
    expect((await ask()).json.push).not.toBeNull();
    expect((await arrived()).status).toBe(200);
    await consent('install-0001', 'granted');
    expect((await env.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM consents'))!.n).toBe(1);
    expect((await env.call('PATCH', '/v1/admin/settings', env.sec, { consentMode: 'maybe' })).status).toBe(400);
  });
});
