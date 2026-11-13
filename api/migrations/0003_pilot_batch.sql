-- Pilot batch (Nov 2026): merchant branches and MIDs, Arabic, segment targeting, budgets,
-- control groups, bank webhook delivery, quiet hours and caps, conversions.

-- Client settings ------------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Muscat';
-- 'sdk': the SDK shows the offer on the phone; 'webhook': Locus tells the bank's server, the bank pushes.
ALTER TABLE tenants ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'sdk';
ALTER TABLE tenants ADD COLUMN webhook_url TEXT;
ALTER TABLE tenants ADD COLUMN webhook_secret TEXT;
-- Local times 'HH:MM'; no pushes from quiet_start to quiet_end (may wrap past midnight).
ALTER TABLE tenants ADD COLUMN quiet_start TEXT;
ALTER TABLE tenants ADD COLUMN quiet_end TEXT;
-- Across all offers, per customer, per local day.
ALTER TABLE tenants ADD COLUMN max_pushes_per_day INTEGER NOT NULL DEFAULT 3;
UPDATE tenants SET timezone = 'Africa/Cairo' WHERE country = 'EG';

-- Merchants: external id for re-imports, Arabic name, MCC, card-acceptor ids, branches -----------
ALTER TABLE merchants ADD COLUMN external_id TEXT;
ALTER TABLE merchants ADD COLUMN name_ar TEXT;
ALTER TABLE merchants ADD COLUMN mcc TEXT;
CREATE UNIQUE INDEX merchants_external ON merchants(tenant_id, external_id) WHERE external_id IS NOT NULL;

-- Merchant IDs (MIDs) as the acquirer sends them on card transactions; used to match conversions.
CREATE TABLE merchant_mids (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mid TEXT NOT NULL,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, mid)
);

-- Where the merchant is: catalogue stores (Locus places layer).
CREATE TABLE merchant_branches (
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- 'manual' (chosen by the client) or 'auto' (name match accepted at import)
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (merchant_id, store_id)
);
CREATE INDEX merchant_branches_store ON merchant_branches(store_id);

-- Offers: rebuilt so mall_id can be NULL (an offer at all the merchant's branches) ---------------
CREATE TABLE offers_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  -- NULL with all_branches = 1: wherever the merchant has a branch, on that branch's floor.
  mall_id TEXT REFERENCES malls(id),
  floor_index INTEGER,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  all_branches INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  title_ar TEXT,
  body_ar TEXT,
  cta_url TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  daily_cap_per_user INTEGER NOT NULL DEFAULT 1,
  -- JSON array of segment tags; NULL = every customer.
  segments TEXT,
  -- Budgets: stop pushing after this many deliveries / matched purchases (NULL = no limit).
  max_deliveries INTEGER,
  max_conversions INTEGER,
  -- Share of customers (0–50 %) kept as a control group: never pushed this offer, used to measure lift.
  holdout_pct INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((all_branches = 1 AND mall_id IS NULL) OR (all_branches = 0 AND mall_id IS NOT NULL))
);
-- Offers created before this batch keep holdout 0, so their existing reports stay comparable.
INSERT INTO offers_new (id, tenant_id, merchant_id, mall_id, floor_index, store_id, all_branches, title, body, cta_url,
  starts_at, ends_at, priority, daily_cap_per_user, holdout_pct, status, created_at, updated_at)
  SELECT id, tenant_id, merchant_id, mall_id, floor_index, store_id, 0, title, body, cta_url,
  starts_at, ends_at, priority, daily_cap_per_user, 0, status, created_at, updated_at FROM offers;
DROP TABLE offers;
ALTER TABLE offers_new RENAME TO offers;
CREATE INDEX offers_tenant_mall ON offers(tenant_id, mall_id);

-- Events: rebuilt to allow 'offer_held_out' (control group) ------------------------------------
CREATE TABLE events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('arrived', 'floor', 'left', 'offer_delivered', 'offer_opened', 'offer_dismissed', 'offer_held_out')),
  mall_id TEXT NOT NULL,
  floor_index INTEGER,
  offer_id TEXT,
  platform TEXT,
  t TEXT NOT NULL,
  received_at TEXT NOT NULL
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX events_tenant_t ON events(tenant_id, t);
CREATE INDEX events_install_offer ON events(tenant_id, install_id, offer_id, t);

-- Installs: what the app told the SDK about its customer (no personal data) ----------------------
CREATE TABLE installs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL,
  -- The bank's pseudonymous customer reference (never a national ID or account number).
  customer_ref TEXT,
  segments TEXT,
  locale TEXT,
  platform TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, install_id)
);
CREATE INDEX installs_customer ON installs(tenant_id, customer_ref);

-- Webhook deliveries to the bank (delivery_mode 'webhook') --------------------------------------
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX webhook_pending ON webhook_deliveries(status, next_attempt_at);

-- Conversions: card purchases at the offer's merchant after a delivery (treatment) or a hold-out
-- (control). Only matched purchases are kept; the transaction reference is stored hashed.
CREATE TABLE conversions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  grp TEXT NOT NULL CHECK (grp IN ('treatment', 'control')),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  txn_hash TEXT NOT NULL,
  t TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (tenant_id, txn_hash)
);
CREATE INDEX conversions_offer ON conversions(tenant_id, offer_id);
