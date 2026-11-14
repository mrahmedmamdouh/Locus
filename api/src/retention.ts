import type { Db } from './db';

/** Audit entries are kept two years; consent records five years after an install's last record. */
export const AUDIT_DAYS = 730;
export const CONSENT_PROOF_DAYS = 5 * 365;
/** Webhook delivery records are operational only. */
export const WEBHOOK_DAYS = 30;

const ago = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

/**
 * Deletes what is past its retention, per client. Run once a day (Workers cron, Node timer).
 * Installs with no activity in the retention period are removed too.
 */
export async function purgeExpired(db: Db, now: Date): Promise<Record<string, number>> {
  const out: Record<string, number> = { events: 0, conversions: 0, installs: 0, webhooks: 0, consents: 0, audit: 0 };
  const tenants = await db.all<{ id: string; retention_days: number }>('SELECT id, retention_days FROM tenants');
  for (const t of tenants) {
    const cut = ago(now, t.retention_days);
    out.events! += (await db.run('DELETE FROM events WHERE tenant_id = ? AND t < ?', [t.id, cut])).changes;
    out.conversions! += (await db.run('DELETE FROM conversions WHERE tenant_id = ? AND t < ?', [t.id, cut])).changes;
    out.installs! += (await db.run('DELETE FROM installs WHERE tenant_id = ? AND updated_at < ?', [t.id, cut])).changes;
  }
  out.webhooks = (await db.run('DELETE FROM webhook_deliveries WHERE created_at < ?', [ago(now, WEBHOOK_DAYS)])).changes;
  // Consent proof: drop an install's whole consent history five years after its latest record.
  out.consents = (
    await db.run(
      'DELETE FROM consents WHERE (tenant_id, install_id) IN (SELECT tenant_id, install_id FROM consents GROUP BY tenant_id, install_id HAVING MAX(t) < ?)',
      [ago(now, CONSENT_PROOF_DAYS)],
    )
  ).changes;
  out.audit = (await db.run('DELETE FROM audit_log WHERE t < ?', [ago(now, AUDIT_DAYS)])).changes;
  return out;
}
