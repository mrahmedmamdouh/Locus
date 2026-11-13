/**
 * Control group: a stable share of customers never gets a given offer pushed, so purchases in
 * that group show what would have happened anyway. Deterministic per install and offer (FNV-1a).
 */
export function holdoutBucket(installId: string, offerId: string): number {
  let h = 0x811c9dc5;
  const s = `${installId}:${offerId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

export function inHoldout(installId: string, offerId: string, pct: number): boolean {
  return pct > 0 && holdoutBucket(installId, offerId) < pct;
}
