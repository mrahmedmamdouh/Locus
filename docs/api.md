# Locus pilot API

One small service for the pilot: the **places catalogue** (malls, floors, stores) that Locus owns, each client's **merchants and offers**, **offer ranking** for the SDK, **events** from the SDK and **reports**. Code: [`api/`](../api). It runs on Cloudflare Workers with a D1 (SQLite) database (both free for a pilot), or on any Node 22 host with a SQLite file.

## Who calls what

| Routes | Key | Caller |
| --- | --- | --- |
| `/v1/sdk/*` | publishable `lk_pub_…` | The SDK inside the bank's app |
| `/v1/admin/*` | secret `lk_sec_…` | The bank's console and servers |
| `/v1/platform/*` | the Locus platform key | Locus operators: clients, keys, catalogue |

Send keys as `Authorization: Bearer <key>`. Keys are stored only as SHA-256 hashes. Errors are `{"error": {"code": "...", "message": "..."}}` with status 400, 401, 404, 409 or 413.

## SDK routes

| Method and path | Body / query | Returns |
| --- | --- | --- |
| `GET /v1/sdk/malls` | `lat`, `lon` (rough), `limit` (≤ 100) | Pilot malls nearest first, each with `boundary {lat, lon, radiusM}`, `entranceFloorIndex` and `floors [{index, label, zMinM, zMaxM}]` |
| `POST /v1/sdk/offers` | `installId`, `mallId`, `floorIndex` (null = unknown), and optionally `customerRef`, `segments` (tags), `locale` (`en`/`ar`), `platform`, `mode: "list"` (in-app list: no push decision) | `offers` (ranked), `push` (the one to show now, or null), `delivery` (`sdk`: the app shows it; `webhook`: sent to the bank's server) and `reason` |
| `POST /v1/sdk/consent` | `installId`, `status` (`granted`/`withdrawn`), `policyVersion`, optional `textHash` (SHA-256 of the wording shown), `customerRef`, `language`, `platform`, `t` | `{recorded}`. Append-only. |
| `POST /v1/sdk/forget` | `installId` | `{erased}`: deletes the install's events, purchases and profile; consent records stay as proof. |
| `POST /v1/sdk/events` | `installId`, `platform`, `events: [{type, mallId, floorIndex?, offerId?, t}]` (1–50) | `{accepted}`. Refused with 403 `consent_required` without consent. Types: `arrived`, `floor`, `left`, `offer_delivered`, `offer_opened`, `offer_dismissed`. Extra fields such as coordinates are dropped. |

**Consent.** With the client's consent mode `sdk` (the default), Locus serves nothing and stores nothing for an install whose latest consent record is not `granted`: `/offers` answers `reason: "no-consent"`, `/events` answers 403. With mode `bank`, the bank records consent in its own systems and only starts the SDK afterwards.

**Which offers and which push** ([`routes/sdk.ts`](../api/src/routes/sdk.ts), [`ranking.ts`](../api/src/ranking.ts)). The checks run in this order; the first that stops a push becomes the `reason`:

1. **Eligible offers.** Only the client's own active offers that are live now count:
    - offers for this mall;
    - "all branches" offers of merchants with a branch here, placed on that branch's floor;
    - offers with segments, only when the customer has one of those segments;
    - offers under their budgets (shown count, matched purchases).

    Floor offers match that floor only. Whole-mall offers match everywhere, including phones that cannot tell their floor. None left: `no-offers`.
2. **Ranking.** Score is `priority × 10`, plus 5 for a floor match.
3. **One push per floor.** None if this install got a push, or was held out, on the same mall and floor in the last 2 hours: `floor-already-notified`.
4. **Quiet hours** in the client's time zone: `quiet-hours`.
5. **Daily limit across all offers** per customer (default 3): `daily-limit`.
6. **Per-offer daily cap** per customer: `daily-cap-reached`.
7. **Control group.** A stable `holdoutPct` share of customers (default 10%) never gets this offer pushed. Locus records an `offer_held_out` event for them instead: `holdout`.

All "per day" counts reset at local midnight in the client's time zone (`Asia/Muscat`, `Africa/Cairo`).

Responses come in Arabic when `locale` is `ar` and the offer has Arabic text. Otherwise they are in English.

## Delivering through the bank's push service (webhook)

With `deliveryMode: "webhook"`, Locus does not ask the SDK to show the push. It calls the bank's server, which pushes through Firebase, Braze, MoEngage or its own service. The bank links `customerRef`, its own pseudonymous customer reference that the app passes to the SDK, to the customer's devices.

```
POST <webhookUrl>
Content-Type: application/json
Locus-Event: offer.ready
Locus-Delivery: 7b0c…            (same on retries: de-duplicate on it)
Locus-Signature: t=1795000000,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

{"type":"offer.ready","deliveryId":"7b0c…","tenantId":"demo-bank","installId":"…","customerRef":"cust-7f3a",
 "createdAt":"…","expiresAt":"… (+10 min)","mall":{"id":"mall-of-oman","name":"Mall of Oman"},
 "floor":{"index":1,"label":"Level 2"},
 "offer":{"id":"…","merchant":{"id":"…","name":"Costa Coffee","nameAr":"كوستا"},"title":"…","body":"…",
          "titleAr":"…","bodyAr":"…","ctaUrl":null,"storeName":"Costa Coffee","endsAt":"…"}}
```

- **Verify every call.** Recompute the HMAC over `t` + `.` + the raw body with your signing secret and compare. Reject calls whose `t` is more than 5 minutes old.
- **Answer any 2xx** to accept the call.
- **Retries.** Other answers are retried after 30 s, 1, 2 and 4 minutes. Calls not delivered by `expiresAt` (10 minutes) are dropped, since the shopper has moved on.
- **Delivered count.** The offer counts as delivered when Locus hands it to you.
- **Testing.** "Send a test" in the console sends a signed `ping`.

## Admin routes (bank console or the bank's servers)

**Settings**

- `GET|PATCH /v1/admin/settings` covers:
    - `timezone`
    - `deliveryMode` (`sdk` | `webhook`)
    - `webhookUrl` (public https only)
    - `quietHours {start, end}` (`HH:MM`, may wrap past midnight) or `null`
    - `maxPushesPerDay` (1–20)
- `POST /v1/admin/settings/webhook-secret` returns a new signing secret **once**.
- `POST /v1/admin/settings/webhook-test` sends a signed `ping`.
- `GET /v1/admin/deliveries?status=` lists the last 100 webhook deliveries.

**Consent and erasure**

- `GET /v1/admin/consents?customerRef=` or `?installId=` returns the consent history, newest first: when, agreed or withdrew, wording version and hash, platform and source (`app`, `erasure`).
- `POST /v1/admin/customers/forget {customerRef | installId}` erases all of a customer's installs (customer requests); the consent trail stays.
- Settings: `consentMode` (`sdk` | `bank`). Reports: `consent {optedIn, optedOut}` (installs whose latest record is each).

**Catalogue and merchants**

- `GET /v1/admin/malls` (all malls with floors and store counts) and `GET /v1/admin/malls/{id}/stores?q=`.
- `GET|POST /v1/admin/merchants`, `GET|PATCH|DELETE /v1/admin/merchants/{id}`.
    - Merchant fields: `name`, `nameAr`, `category`, `mcc` (4 digits), `externalId` (your id, for re-imports), `mids` (card-acceptor IDs as on your transactions).
    - A MID belongs to one merchant only.
    - Deleting a merchant fails while it has active offers.
- `PUT /v1/admin/merchants/{id}/branches {storeIds}` sets the merchant's branches (catalogue stores). `GET /v1/admin/merchants/{id}/suggestions` lists stores with similar names.
- `POST /v1/admin/merchants/import {merchants, dryRun}` takes up to 500 merchants per call. Each item has the merchant fields above, plus:
    - `branches: [{storeId} | {mallId, storeName?}]`;
    - `autoMatch` (default true; with no branches given, Locus searches every mall by name).

    It creates or updates by `externalId`, else by exact name. Name matches scoring ≥ 0.9 are linked; 0.6–0.9 come back for review. `dryRun: true` writes nothing.

**Offers**

- `GET|POST /v1/admin/offers`, `GET|PATCH|DELETE /v1/admin/offers/{id}`.

  | Field | Rule |
  | --- | --- |
  | `merchantId` | One of your merchants |
  | `allBranches` | `true`: every branch of the merchant, each on its floor (`mallId`, `floorIndex`, `storeId` not used); needs at least one branch |
  | `mallId` | A catalogue mall (when not `allBranches`) |
  | `floorIndex` | `null` = whole mall; otherwise a floor of that mall |
  | `storeId` | Optional catalogue store; sets the floor |
  | `title`, `titleAr` | Up to 80 characters (Arabic optional) |
  | `body`, `bodyAr` | Up to 280 characters (Arabic optional) |
  | `ctaUrl` | `https` only |
  | `startsAt`, `endsAt` | ISO with a time zone |
  | `priority` | 0–100 |
  | `dailyCapPerUser` | 1–10 |
  | `segments` | Up to 20 tags (`a-z 0-9 -`), or `null` for everyone |
  | `maxDeliveries`, `maxConversions` | Optional budgets: stop after this many shown / matched purchases |
  | `holdoutPct` | 0–50, default 10: the control group |
  | `status` | `draft`, `active` or `paused` |

**Purchases and reports**

- `POST /v1/admin/transactions {transactions: [{ref, installId | customerRef, mid, amount, currency, t}]}` takes up to 1000 per call, from the bank's servers.
    - A purchase is a **conversion** when its MID belongs to a merchant whose offer this customer was shown (treatment) or held out from (control) in the 7 days before.
    - Unmatched purchases are not stored. `ref` is stored only as a hash, and sending the same purchase twice is ignored.
    - Returns `{received, matched, duplicates, unmatched}`.
- `GET /v1/admin/reports/summary?from&to` (default: the last 30 days) returns:
    - arrivals and unique installs;
    - arrivals by mall and visits by floor;
    - webhook delivery counts;
    - per offer:
        - shown, opened, dismissed and open rate;
        - `treatment` and `control` (customers, converted, rate; revenue for treatment);
        - `liftPts`: purchase rate with the offer minus without, in percentage points.

## Platform routes (Locus)

- `POST /v1/platform/tenants {id?, name, country: OM|EG}` creates a client and returns its publishable and secret keys **once**.
- `GET /v1/platform/tenants` lists clients with key prefixes. `POST /v1/platform/tenants/{id}/keys {kind}` issues a key; `POST /v1/platform/keys/{id}/revoke` revokes one.
- `PUT /v1/platform/malls/{id}` creates or replaces a mall and its floor table. The fields are name, city, country, lat, lon, radiusM, entranceFloorIndex, status (`pilot` | `listed`) and floors. Floors are validated: sorted and non-overlapping.
- `POST /v1/platform/malls/{id}/stores {stores, replace?}` adds or updates stores, up to 2000 per call.

The three pilot malls (Mall of Oman, Oman Avenues Mall, City Centre Muscat) are created by migration [`0002_pilot_malls.sql`](../api/migrations/0002_pilot_malls.sql), with the floor heights measured in the field tests.

## Run it locally

```bash
npm ci
LOCUS_PLATFORM_KEY=choose-a-long-random-string npm run dev --workspace api   # http://localhost:8787
```

The data goes to `api/locus-dev.sqlite`. Create a client and load the catalogue, which is kept outside this public repository:

```bash
curl -s -X POST localhost:8787/v1/platform/tenants -H "Authorization: Bearer $LOCUS_PLATFORM_KEY" \
  -H 'Content-Type: application/json' -d '{"id":"demo-bank","name":"Demo Bank","country":"OM"}'

LOCUS_API_URL=http://localhost:8787 LOCUS_PLATFORM_KEY=… \
  npm run import-catalogue --workspace api -- path/to/malls.csv path/to/stores.csv
```

Run the console against it with `npm run dev --workspace console` (http://localhost:5174). Sign in with the API address and the secret key.

## Deploy to Cloudflare from GitHub (free tier)

GitHub deploys the API for you. You only give it access to your Cloudflare account, once.

**1. Create a Cloudflare API token.** Sign in at dash.cloudflare.com (a free account is enough), then:

1. Go to **My Profile → API Tokens → Create Token** and pick the template **Edit Cloudflare Workers**.
2. Under **Permissions**, add **Account → D1 → Edit**.
3. Under **Account Resources**, choose your account. **Continue → Create Token** and copy the token.
4. Also copy your **Account ID**: Workers & Pages → Account details (or the right-hand column of the account home).

**2. Add three repository secrets on GitHub.** Go to the repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID |
| `LOCUS_PLATFORM_KEY` | a long random password you make up (24+ characters, from your password manager). It is the Locus operator key. |

**3. Run the deploy.** Go to **Actions → Deploy API to Cloudflare → Run workflow**. In about 3 minutes it:

- creates a workers.dev subdomain if the account has none (your GitHub name, else a variant);
- creates the D1 database `locus`;
- applies the migrations, which create the tables and the three pilot malls;
- deploys the Worker;
- stores the SHA-256 of `LOCUS_PLATFORM_KEY` as a Worker secret;
- checks `/health` and the key.

The run's **Summary** shows the API address, e.g. `https://locus-api.mrahmedmamdouh.workers.dev`. No key is ever printed, because the repository and its logs are public. After this, every change to `api/` deploys itself.

**4. Finish in the console.** Open https://mrahmedmamdouh.github.io/Locus/console/, choose **Locus operator**, and sign in with the API address and `LOCUS_PLATFORM_KEY`:

1. **Clients:** create *Demo Bank* and copy its publishable key (for the app) and secret key (for bank staff). They are shown once.
2. **Catalogue:** upload `malls.csv` and `stores.csv` (29 malls, 1,210 stores).

Optional repository variables (Settings → Secrets and variables → Actions → Variables):

- `LOCUS_API_URL`: fills in the API address on the console sign-in page.
- `LOCUS_DEMO_PUBLISHABLE_KEY`: builds the Android demo app with the key already in.

## Deploy from your computer instead


**One command, from your Mac** (Node 22+, the repo cloned). It needs your own Cloudflare login, which is why it runs on your computer:

```bash
cd ~/Locus && git pull && npm ci
npm run setup:cloudflare --workspace api -- --catalogue ~/Downloads/malls.csv ~/Downloads/stores.csv
```

What it does:

1. Signs you in to Cloudflare (a browser window opens; a free account is enough).
2. Creates the D1 database `locus` and writes its id into `api/wrangler.toml`.
3. Applies the migrations, which create the tables and the three pilot malls.
4. Deploys the Worker and prints its address (`https://locus-api.<your-subdomain>.workers.dev`). The first time, Cloudflare asks you to pick a workers.dev subdomain.
5. Creates the platform key, stores only its SHA-256 as a Worker secret, and saves the key at once to `~/locus-api-keys-<date>.txt` (readable only by you).
6. Checks `/health`.
7. Creates the first client, `demo-bank` by default (`--client-id`, `--client-name`, `--client-country`), and prints its publishable and secret keys.
8. Imports the places catalogue from the two CSV files.

It is safe to run again. It reuses the database, applies new migrations and redeploys. It keeps the platform key unless you pass `--rotate-platform-key`. To create clients or import on a later run, put `LOCUS_PLATFORM_KEY=<key>` in front of the command.

After the first run:

- Commit `api/wrangler.toml` (it now holds the database id).
- Optional: set the repository variable `LOCUS_API_URL` so the console's sign-in page fills in the address.
- Optional: set `LOCUS_DEMO_PUBLISHABLE_KEY` so the demo app builds come with the key.
- Optional, for automatic deploys from GitHub: add the repository secrets `CLOUDFLARE_API_TOKEN` (Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" template, plus D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`. The **Deploy API to Cloudflare** workflow then applies migrations and deploys on every change to `api/`. Without them it skips with a notice.

Webhook retries run every minute from the cron trigger in `wrangler.toml`. The deployment was checked on the local Workers runtime with D1 (`wrangler dev`): migrations, catalogue import, consent, offers, events, purchases, reports and erasure.

## Limits of the pilot setup

- No rate limiting yet. Cloudflare's free plan can add a rate-limiting rule on `/v1/sdk/*`.
- The console signs in with the secret key and keeps it in the browser tab's session storage. Before production, replace this with per-user sign-in (SSO) and roles.
- The webhook signing secret is stored in the database as is; encrypt it at rest before production.
