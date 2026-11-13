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
| `POST /v1/sdk/offers` | `installId`, `mallId`, `floorIndex` (null = unknown) | `offers` (ranked) and `push` (the one to show now, or null) with `reason`: `ok`, `no-offers`, `floor-already-notified`, `daily-cap-reached` |
| `POST /v1/sdk/events` | `installId`, `platform`, `events: [{type, mallId, floorIndex?, offerId?, t}]` (1–50) | `{accepted}`. Types: `arrived`, `floor`, `left`, `offer_delivered`, `offer_opened`, `offer_dismissed`. Extra fields such as coordinates are dropped. |

**Ranking rules** ([`ranking.ts`](../api/src/ranking.ts)):

- Only the client's own active offers for that mall that are live now are considered.
- Offers for a floor match only that floor. Whole-mall offers match everywhere, including phones that cannot tell their floor.
- Score is `priority × 10`, plus 5 for a floor match.
- At most one push per floor: none if this install got a push on the same mall and floor in the last 2 hours.
- Offers over their daily cap for this install are not pushed. Caps reset at midnight Muscat time.

## Admin routes (bank console)

- `GET /v1/admin/me`
- `GET /v1/admin/malls` (all malls with floors and store counts)
- `GET /v1/admin/malls/{id}/stores?q=`
- `GET|POST /v1/admin/merchants`
- `PATCH|DELETE /v1/admin/merchants/{id}` (deleting fails while it has active offers)
- `GET|POST /v1/admin/offers`, `GET|PATCH|DELETE /v1/admin/offers/{id}`

  Offer fields:

  | Field | Rule |
  | --- | --- |
  | `merchantId` | One of your merchants |
  | `mallId` | A catalogue mall |
  | `floorIndex` | `null` = whole mall; otherwise a floor of that mall |
  | `storeId` | Optional catalogue store; sets the floor |
  | `title` | Up to 80 characters |
  | `body` | Up to 280 characters |
  | `ctaUrl` | `https` only |
  | `startsAt`, `endsAt` | ISO with a time zone |
  | `priority` | 0–100 |
  | `dailyCapPerUser` | 1–10 |
  | `status` | `draft`, `active` or `paused` |

- `GET /v1/admin/reports/summary?from&to` (default: the last 30 days) returns:
  - arrivals and unique installs
  - arrivals by mall
  - visits by floor
  - per offer: shown, opened, dismissed and open rate

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

## Deploy to Cloudflare (free tier)

One time, from the repo root on your Mac:

```bash
cd api
npx wrangler login                                   # opens the browser
npx wrangler d1 create locus                         # copy the database_id it prints
#   → paste it into api/wrangler.toml (database_id = "…")
npx wrangler d1 migrations apply locus --remote      # creates tables and the 3 pilot malls
openssl rand -hex 32                                 # your platform key; keep it in a password manager
echo -n '<platform key>' | shasum -a 256             # its SHA-256
npx wrangler secret put PLATFORM_KEY_SHA256          # paste the hash
npx wrangler deploy                                  # prints https://locus-api.<you>.workers.dev
```

Then:

1. Create the first client with `POST /v1/platform/tenants`, as in the local example but against the workers.dev address.
2. Import the catalogue with `LOCUS_API_URL` set to that address.
3. Set the repository variable `LOCUS_API_URL` (Settings → Secrets and variables → Actions → Variables) so the console's sign-in page fills in the address.
4. Keep `CONSOLE_ORIGINS` in `wrangler.toml` set to the console's origin (`https://mrahmedmamdouh.github.io`).

Later schema changes: add `api/migrations/000N_*.sql`, then `npx wrangler d1 migrations apply locus --remote` and `npx wrangler deploy`.

## Limits of the pilot setup

- No rate limiting yet. Cloudflare's free plan can add a rate-limiting rule on `/v1/sdk/*`.
- The console signs in with the secret key and keeps it in the browser tab's session storage. Before production, replace this with per-user sign-in (SSO) and roles.
- Daily caps use Muscat midnight for every client. Egyptian clients need their own time zone.
