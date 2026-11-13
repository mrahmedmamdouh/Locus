-- Consent records (Nov 2026). An append-only log: who agreed to mall offers (or withdrew), when,
-- to which version of the wording, from which app install. Kept after erasure as proof.

-- 'sdk': the app records consent through the SDK, and Locus refuses offers and events without it.
-- 'bank': the bank records consent in its own systems (e.g. its terms) and only starts the SDK
--         after it; Locus logs any consent the SDK still sends.
ALTER TABLE tenants ADD COLUMN consent_mode TEXT NOT NULL DEFAULT 'sdk';

CREATE TABLE consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL,
  customer_ref TEXT,
  purpose TEXT NOT NULL DEFAULT 'mall_offers',
  status TEXT NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  -- The bank's version label of the wording shown, e.g. 'mall-offers-2026-11'.
  policy_version TEXT NOT NULL,
  -- SHA-256 of the exact text shown, so the wording can be proven later (optional).
  text_hash TEXT,
  language TEXT,
  platform TEXT,
  -- 'app' (the customer in the app), 'bank' (the bank's servers), 'erasure' (data deleted on request)
  source TEXT NOT NULL DEFAULT 'app',
  t TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX consents_install ON consents(tenant_id, install_id, id);
CREATE INDEX consents_customer ON consents(tenant_id, customer_ref);
