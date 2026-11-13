/**
 * Matching a bank's merchant names to catalogue store names ("COSTA COFFEE LLC - MOO" ↔ "Costa Coffee").
 * Score 0–1: 1 when the meaningful words are the same set, else the Dice coefficient of
 * character bigrams. ≥ AUTO_LINK is linked at import; REVIEW–AUTO_LINK is offered for review.
 */
export const AUTO_LINK = 0.9;
export const REVIEW = 0.6;

const NOISE = new Set(['llc', 'spc', 'saoc', 'saog', 'co', 'company', 'est', 'establishment', 'trading', 'the', 'and', 'l.l.c', 'ltd', 'group', 'oman', 'egypt', 'store', 'shop', 'branch', 'outlet']);

export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !NOISE.has(w))
    .join(' ');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  if (wa.size === wb.size && [...wa].every((w) => wb.has(w))) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ga) {
    inter += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  const dice = total ? (2 * inter) / total : 0;
  // One name fully contained in the other ("costa" in "costa coffee") is a strong hint.
  const contained = na.length >= 4 && nb.length >= 4 && (` ${nb} `.includes(` ${na} `) || ` ${na} `.includes(` ${nb} `));
  return Math.round(Math.max(dice, contained ? 0.85 : 0) * 1000) / 1000;
}

export interface MatchCandidate {
  storeId: string;
  storeName: string;
  mallId: string;
  floorIndex: number | null;
  score: number;
}

export function matchStores(
  name: string,
  stores: { id: string; name: string; mall_id: string; floor_index: number | null }[],
  limit = 20,
): MatchCandidate[] {
  return stores
    .map((s) => ({ storeId: s.id, storeName: s.name, mallId: s.mall_id, floorIndex: s.floor_index, score: nameSimilarity(name, s.name) }))
    .filter((c) => c.score >= REVIEW)
    .sort((a, b) => b.score - a.score || a.storeId.localeCompare(b.storeId))
    .slice(0, limit);
}
