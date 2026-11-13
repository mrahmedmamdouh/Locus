import type { Db, SqlValue } from './db';

export type ConsentMode = 'sdk' | 'bank';

/** Latest consent record of an install for mall offers, or null. */
export async function latestConsent(db: Db, tenantId: string, installId: string) {
  return db.first<{ status: 'granted' | 'withdrawn'; policy_version: string; t: string }>(
    "SELECT status, policy_version, t FROM consents WHERE tenant_id = ? AND install_id = ? AND purpose = 'mall_offers' ORDER BY id DESC LIMIT 1",
    [tenantId, installId],
  );
}

/** Whether Locus may process this install: always in 'bank' mode, else only after a 'granted' record. */
export async function mayProcess(db: Db, tenantId: string, mode: ConsentMode, installId: string): Promise<boolean> {
  if (mode === 'bank') return true;
  return (await latestConsent(db, tenantId, installId))?.status === 'granted';
}

/** Deletes what Locus holds about these installs (consent records stay, as proof). */
export function erasureStatements(tenantId: string, installIds: string[]): { sql: string; params: SqlValue[] }[] {
  const out: { sql: string; params: SqlValue[] }[] = [];
  for (const id of installIds) {
    for (const table of ['events', 'conversions', 'webhook_deliveries', 'installs']) {
      out.push({ sql: `DELETE FROM ${table} WHERE tenant_id = ? AND install_id = ?`, params: [tenantId, id] });
    }
  }
  return out;
}
