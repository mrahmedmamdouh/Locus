#!/usr/bin/env bash
# Deploys the Locus API to Cloudflare from GitHub Actions, first time and every time after.
#
# Needs (repository secrets): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, LOCUS_PLATFORM_KEY.
# Does, idempotently:
#   1. a workers.dev subdomain for the account (created if missing: locus-<owner>)
#   2. the D1 database "locus" (created if missing; its id is written into wrangler.toml on the runner)
#   3. migrations, 4. deploy, 5. the platform key's SHA-256 as a Worker secret, 6. checks.
# Never prints a key: the repository and its logs are public.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?missing}" "${CLOUDFLARE_ACCOUNT_ID:?missing}" "${LOCUS_PLATFORM_KEY:?missing}"
export WRANGLER_SEND_METRICS=false
CF="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
OWNER="${GITHUB_REPOSITORY_OWNER:-locus}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
json() { node -e "let s=require('fs').readFileSync(0,'utf8');s=s.slice(s.search(/[[{]/));const v=JSON.parse(s);const r=($1);process.stdout.write(r===undefined||r===null?'':String(r))"; }
cfapi() { curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" "$@"; }

echo "::group::1. workers.dev subdomain"
sub=$(cfapi "${CF}/workers/subdomain" | json 'v.result && v.result.subdomain')
if [ -z "$sub" ]; then
  base=$(echo "${OWNER}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-' | cut -c1-50)
  # Subdomains are global: try the GitHub owner's name, then variants.
  for want in "${base}" "locus-${base}" "locus-${base}-$(date +%s | tail -c 5)"; do
    echo "No workers.dev subdomain yet; trying ${want}"
    res=$(cfapi -X PUT "${CF}/workers/subdomain" --data "{\"subdomain\":\"${want}\"}")
    sub=$(echo "$res" | json 'v.result && v.result.subdomain')
    [ -n "$sub" ] && break
    echo "  not available: $(echo "$res" | json 'JSON.stringify(v.errors)')"
  done
  [ -n "$sub" ] || { echo "::error::Could not create a workers.dev subdomain. Open Cloudflare → Workers & Pages once to pick one, then run again."; exit 1; }
fi
echo "Subdomain: ${sub}.workers.dev"
echo "::endgroup::"

echo "::group::2. D1 database"
db=$(npx wrangler d1 list --json | json 'v.find(d=>d.name==="locus")?.uuid')
if [ -z "$db" ]; then
  npx wrangler d1 create locus
  db=$(npx wrangler d1 list --json | json 'v.find(d=>d.name==="locus")?.uuid')
fi
[ -n "$db" ] || { echo "::error::The D1 database could not be created or found."; exit 1; }
sed -i.bak "s/database_id = \"[^\"]*\"/database_id = \"${db}\"/" wrangler.toml && rm -f wrangler.toml.bak
echo "Database: ${db}"
echo "::endgroup::"

echo "::group::3. Migrations"
npx wrangler d1 migrations apply locus --remote
echo "::endgroup::"

echo "::group::4. Deploy"
npx wrangler deploy
url="https://locus-api.${sub}.workers.dev"
echo "::endgroup::"

echo "::group::5. Platform key"
hash=$(printf '%s' "$LOCUS_PLATFORM_KEY" | sha256sum | cut -d' ' -f1)
echo "::add-mask::${hash}"
printf '%s' "$hash" | npx wrangler secret put PLATFORM_KEY_SHA256
echo "::endgroup::"

echo "::group::6. Checks"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS "${url}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || { echo "::error::${url}/health does not answer. Run the workflow again in a minute."; exit 1; }
key_ok=""
for _ in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${LOCUS_PLATFORM_KEY}" "${url}/v1/platform/tenants")
  if [ "$code" = "200" ]; then key_ok=1; break; fi
  sleep 5
done
[ -n "$key_ok" ] || { echo "::error::The API is up but does not accept the platform key yet. Run the workflow again in a minute."; exit 1; }
echo "API ${url} is up and accepts the platform key."
echo "::endgroup::"

{
  echo "## Locus API is live"
  echo
  echo "**Address:** ${url}"
  echo
  echo "Next, in the console (https://${OWNER}.github.io/Locus/console/), choose **Locus operator**, sign in with this address and your LOCUS_PLATFORM_KEY, then:"
  echo "1. **Clients** → create *Demo Bank* and copy its two keys (shown once)."
  echo "2. **Catalogue** → upload malls.csv and stores.csv."
} >> "$SUMMARY"
echo "url=${url}" >> "${GITHUB_OUTPUT:-/dev/null}"
