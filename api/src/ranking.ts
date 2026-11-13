/**
 * Offer ranking for one shopper at one mall and floor. Pure, so the rules are easy to test.
 *
 * - Only the client's own active offers for this mall, live at `now`.
 * - Floor-specific offers match only that floor; mall-wide offers (floor null) match every floor.
 *   A phone that cannot tell its floor (no barometer) gets mall-wide offers only.
 * - Score: priority × 10, plus 5 for a floor-specific match (the shopper is right there).
 * - At most one push per floor per visit: none if this install already got a push on this floor
 *   in the last `floorRepeatMs`. Offers over their daily cap for this install are not pushed
 *   (they still appear in the list, e.g. for an in-app "offers here" screen).
 */
export interface RankableOffer {
  id: string;
  floorIndex: number | null;
  priority: number;
  dailyCapPerUser: number;
  startsAt: string;
  endsAt: string;
}

export interface RankInput<T extends RankableOffer> {
  offers: T[];
  floorIndex: number | null;
  now: Date;
  /** Times this install was delivered each offer today. */
  deliveredToday: Map<string, number>;
  /** Whether this install already got a push on this mall + floor recently. */
  floorAlreadyNotified: boolean;
}

export interface RankResult<T> {
  offers: T[];
  push: T | null;
  reason: 'ok' | 'no-offers' | 'floor-already-notified' | 'daily-cap-reached';
}

export const FLOOR_REPEAT_MS = 2 * 60 * 60_000;

export function rankOffers<T extends RankableOffer>(input: RankInput<T>): RankResult<T> {
  const t = input.now.getTime();
  const live = input.offers.filter((o) => Date.parse(o.startsAt) <= t && t < Date.parse(o.endsAt));
  const eligible = live.filter((o) => o.floorIndex === null || (input.floorIndex !== null && o.floorIndex === input.floorIndex));
  const score = (o: T) => o.priority * 10 + (o.floorIndex !== null ? 5 : 0);
  const ranked = [...eligible].sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ranked.length === 0) return { offers: [], push: null, reason: 'no-offers' };
  if (input.floorAlreadyNotified) return { offers: ranked, push: null, reason: 'floor-already-notified' };
  const push = ranked.find((o) => (input.deliveredToday.get(o.id) ?? 0) < o.dailyCapPerUser) ?? null;
  return { offers: ranked, push, reason: push ? 'ok' : 'daily-cap-reached' };
}

/** Start of the UTC+4 day (Gulf Standard Time) containing `now`, as an ISO string. Daily caps reset at local midnight in Oman. */
export function startOfGulfDay(now: Date): string {
  const shifted = new Date(now.getTime() + 4 * 3600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 4 * 3600_000).toISOString();
}
