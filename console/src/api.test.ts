import { describe, expect, it } from 'vitest';
import { isoToLocalInput, localInputToIso, offerState } from './api';

describe('console helpers', () => {
  it('round-trips datetime-local values', () => {
    const iso = localInputToIso('2026-12-01T09:30')!;
    expect(isoToLocalInput(iso)).toBe('2026-12-01T09:30');
    expect(localInputToIso('')).toBeNull();
  });
  it('labels offer states', () => {
    const now = new Date('2026-12-10T00:00:00Z');
    const base = { startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z' };
    expect(offerState({ ...base, status: 'active' }, now)).toBe('live');
    expect(offerState({ ...base, status: 'active', startsAt: '2026-12-20T00:00:00Z' }, now)).toBe('scheduled');
    expect(offerState({ ...base, status: 'active', endsAt: '2026-12-05T00:00:00Z' }, now)).toBe('ended');
    expect(offerState({ ...base, status: 'paused' }, now)).toBe('paused');
  });
});

describe('merchant import file', () => {
  it('groups branch rows into merchants', async () => {
    const { merchantsFromCsv } = await import('./api');
    const csv = '﻿external_id,name,name_ar,mcc,mids,mall_id,store_name\r\nM-1,"Costa Coffee, LLC",كوستا,5814,100001;100002,mall-of-oman,Costa Coffee\nM-1,"Costa Coffee, LLC",,,100003,oman-avenues-mall,\n,Carrefour,,,,,\n,,,,,,\n';
    const r = merchantsFromCsv(csv);
    expect(r.merchants).toHaveLength(2);
    expect(r.merchants[0]).toMatchObject({ externalId: 'M-1', name: 'Costa Coffee, LLC', nameAr: 'كوستا', mcc: '5814', mids: ['100001', '100002', '100003'] });
    expect(r.merchants[0]!.branches).toEqual([{ mallId: 'mall-of-oman', storeName: 'Costa Coffee' }, { mallId: 'oman-avenues-mall' }]);
    expect(r.merchants[1]).toMatchObject({ externalId: null, name: 'Carrefour' });
    expect(merchantsFromCsv('foo\n1').problems[0]).toMatch(/name/);
  });
});
