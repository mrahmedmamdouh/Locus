-- Locus pilot API schema (SQLite: Cloudflare D1 in production, node:sqlite locally and in tests).
-- Locus owns the places layer (malls, floors, stores). Each client (bank / fintech) owns its merchants and offers.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Keys are stored as SHA-256 hashes; the plain key is shown once at creation.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('publishable', 'secret')),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE malls (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius_m REAL NOT NULL,
  entrance_floor_index INTEGER NOT NULL DEFAULT 0,
  -- 'pilot' malls are served to SDKs; 'listed' malls are in the catalogue only.
  status TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('pilot', 'listed')),
  updated_at TEXT NOT NULL
);

-- Floor bands in metres relative to height 0 of the table (the entrance floor is usually centred on 0).
CREATE TABLE floors (
  mall_id TEXT NOT NULL REFERENCES malls(id) ON DELETE CASCADE,
  floor_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  z_min_m REAL NOT NULL,
  z_max_m REAL NOT NULL,
  PRIMARY KEY (mall_id, floor_index)
);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  mall_id TEXT NOT NULL REFERENCES malls(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  floor_index INTEGER,
  unit TEXT,
  category TEXT
);
CREATE INDEX stores_mall ON stores(mall_id);

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX merchants_tenant ON merchants(tenant_id);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  mall_id TEXT NOT NULL REFERENCES malls(id),
  -- NULL = the whole mall.
  floor_index INTEGER,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  cta_url TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  daily_cap_per_user INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX offers_tenant_mall ON offers(tenant_id, mall_id);

-- What the SDK reports: results, never location history. install_id is a random id per app install.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  install_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('arrived', 'floor', 'left', 'offer_delivered', 'offer_opened', 'offer_dismissed')),
  mall_id TEXT NOT NULL,
  floor_index INTEGER,
  offer_id TEXT,
  platform TEXT,
  t TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX events_tenant_t ON events(tenant_id, t);
CREATE INDEX events_install_offer ON events(tenant_id, install_id, offer_id, t);
