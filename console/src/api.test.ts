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
