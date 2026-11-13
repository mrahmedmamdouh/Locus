import type { Db } from './db';

/**
 * Bank webhook delivery (delivery_mode 'webhook'): Locus tells the bank's server which offer to
 * push to which customer; the bank sends it through its own push service.
 *
 * Request: POST <webhook_url>, JSON body (see OfferReadyPayload), headers
 *   Locus-Event: offer.ready
 *   Locus-Delivery: <delivery id>          (the same on every retry; use it to de-duplicate)
 *   Locus-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Any 2xx = accepted. Otherwise retried with back-off until it expires (default 10 minutes:
 * after that the shopper has probably moved on).
 */
export interface OfferReadyPayload {
  type: 'offer.ready';
  deliveryId: string;
  tenantId: string;
  installId: string;
  customerRef: string | null;
  createdAt: string;
  expiresAt: string;
  mall: { id: string; name: string };
  floor: { index: number; label: string | null } | null;
  offer: {
    id: string;
    merchant: { id: string; name: string | null; nameAr: string | null };
    title: string;
    body: string;
    titleAr: string | null;
    bodyAr: string | null;
    ctaUrl: string | null;
    storeName: string | null;
    endsAt: string;
  };
}

export const WEBHOOK_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;

export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'whsec_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

interface DeliveryRow {
  id: string;
  tenant_id: string;
  body: string;
  attempts: number;
  expires_at: string;
}

/** One attempt; updates the row. Returns true when the bank accepted it. */
export async function attemptDelivery(db: Db, fetchImpl: FetchLike, row: DeliveryRow, now: Date): Promise<boolean> {
  const t = await db.first<{ webhook_url: string | null; webhook_secret: string | null }>('SELECT webhook_url, webhook_secret FROM tenants WHERE id = ?', [row.tenant_id]);
  const attempts = row.attempts + 1;
  let error: string | null = null;
  if (!t?.webhook_url || !t.webhook_secret) {
    error = 'webhook URL or secret not set';
  } else {
    const ts = Math.floor(now.getTime() / 1000);
    try {
      const res = await fetchImpl(t.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Locus-Webhook/1',
          'Locus-Event': 'offer.ready',
          'Locus-Delivery': row.id,
          'Locus-Signature': `t=${ts},v1=${await signWebhook(t.webhook_secret, ts, row.body)}`,
        },
        body: row.body,
        signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(10_000) : undefined,
      });
      if (res.ok) {
        await db.run("UPDATE webhook_deliveries SET status = 'sent', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?", [attempts, now.toISOString(), row.id]);
        return true;
      }
      error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : 'network error';
    }
  }
  // Back-off 30 s, 1 min, 2 min, 4 min; give up after MAX_ATTEMPTS or at expiry.
  const next = new Date(now.getTime() + 30_000 * 2 ** (attempts - 1));
  const final = attempts >= MAX_ATTEMPTS || next.toISOString() >= row.expires_at;
  await db.run('UPDATE webhook_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?', [final ? 'failed' : 'pending', attempts, error, next.toISOString(), row.id]);
  return false;
}

/** Retries due deliveries and expires stale ones. Run every minute (Workers cron, Node timer). */
export async function retryDueDeliveries(db: Db, fetchImpl: FetchLike, now: Date): Promise<{ attempted: number; expired: number }> {
  const iso = now.toISOString();
  const expired = await db.run("UPDATE webhook_deliveries SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [iso]);
  const due = await db.all<DeliveryRow>("SELECT id, tenant_id, body, attempts, expires_at FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50", [iso]);
  for (const row of due) await attemptDelivery(db, fetchImpl, row, now);
  return { attempted: due.length, expired: expired.changes };
}
