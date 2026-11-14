-- Retention and audit (Nov 2026).

-- Visits, offers and purchases older than this are deleted every night (Oman PDPL as amended by
-- Royal Decree 68/2026: delete personal data once its purpose is fulfilled). 395 days = 13 months,
-- enough to compare a season with the same season a year before.
ALTER TABLE tenants ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 395;

-- Who changed what, from the console, the bank's servers or Locus operators. Never key values or
-- request bodies: only the action, its target and the key's public prefix.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  actor TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip_country TEXT,
  t TEXT NOT NULL
);
CREATE INDEX audit_tenant_t ON audit_log(tenant_id, t);
