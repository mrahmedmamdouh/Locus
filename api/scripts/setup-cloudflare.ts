/**
 * Puts the Locus API online on Cloudflare (Workers + D1, free tier) in one command, from a Mac or PC:
 *
 *   cd ~/Locus && git pull && npm ci
 *   npm run setup:cloudflare --workspace api -- --catalogue ~/Downloads/malls.csv ~/Downloads/stores.csv
 *
 * Safe to run again: it reuses the database, applies new migrations, redeploys, and keeps the
 * platform key unless you pass --rotate-platform-key.
 *
 * Steps: Cloudflare login → D1 database "locus" → migrations → deploy the Worker → platform key
 * (secret) → health check → first client and its keys → catalogue import → summary file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCatalogue } from './catalogue';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOML = join(API_DIR, 'wrangler.toml');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const KEY_FILE = join(homedir(), `locus-api-keys-${new Date().toISOString().slice(0, 10)}.txt`);

// ------------------------------------------------------------------------------------------------
// Arguments
// ------------------------------------------------------------------------------------------------
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const catIdx = args.indexOf('--catalogue');
const catalogue = catIdx >= 0 ? { malls: args[catIdx + 1], stores: args[catIdx + 2] } : null;
const clientId = value('--client-id') ?? 'demo-bank';
const clientName = value('--client-name') ?? 'Demo Bank';
const clientCountry = value('--client-country') ?? 'OM';
const rotate = flag('--rotate-platform-key');
if (catalogue && (!catalogue.malls || !catalogue.stores)) fail('Use: --catalogue <malls.csv> <stores.csv>');

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------
function step(n: number, text: string) {
  console.log(`\n\x1b[1m${n}. ${text}\x1b[0m`);
}
function fail(msg: string): never {
  console.error(`\n\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
}
/** wrangler with the terminal attached (prompts and browser login work). */
function wrangler(argv: string[], input?: string) {
  const r = spawnSync('npx', ['wrangler', ...argv], { cwd: API_DIR, env, stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], input });
  return r.status ?? 1;
}
/** wrangler with stdout captured (for --json output). */
function wranglerJson<T>(argv: string[]): T {
  const r = spawnSync('npx', ['wrangler', ...argv], { cwd: API_DIR, env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (r.status !== 0) fail(`wrangler ${argv.join(' ')} failed.`);
  const out = r.stdout.trim();
  const start = out.search(/[[{]/);
  return JSON.parse(out.slice(start)) as T;
}
/** wrangler showing output live and also returning it (deploy prints the URL). */
function wranglerTee(argv: string[]): Promise<{ status: number; out: string }> {
  return new Promise((done) => {
    const p = spawn('npx', ['wrangler', ...argv], { cwd: API_DIR, env, stdio: ['inherit', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      process.stdout.write(d);
    });
    p.stderr.on('data', (d: Buffer) => {
      out += d.toString();
      process.stderr.write(d);
    });
    p.on('close', (status) => done({ status: status ?? 1, out }));
  });
}

// ------------------------------------------------------------------------------------------------
// 1. Login
// ------------------------------------------------------------------------------------------------
step(1, 'Cloudflare account');
const who = spawnSync('npx', ['wrangler', 'whoami'], { cwd: API_DIR, env, encoding: 'utf8' });
if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
  console.log('A browser window opens: sign in to Cloudflare (or create a free account) and allow Wrangler.');
  if (wrangler(['login']) !== 0) fail('Cloudflare login failed.');
} else {
  console.log((who.stdout.match(/associated with the email (\S+)/) ?? [])[0] ?? 'Already signed in.');
}

// ------------------------------------------------------------------------------------------------
// 2. Database
// ------------------------------------------------------------------------------------------------
step(2, 'D1 database "locus"');
type D1 = { uuid: string; name: string };
let db = wranglerJson<D1[]>(['d1', 'list', '--json']).find((d) => d.name === 'locus');
if (!db) {
  if (wrangler(['d1', 'create', 'locus']) !== 0) fail('Could not create the database.');
  db = wranglerJson<D1[]>(['d1', 'list', '--json']).find((d) => d.name === 'locus');
  if (!db) fail('The database was created but does not show in the list yet. Run this command again.');
} else {
  console.log(`Using the existing database (${db.uuid}).`);
}
const toml = readFileSync(TOML, 'utf8');
const patched = toml.replace(/database_id = "[^"]*"/, `database_id = "${db.uuid}"`);
if (patched !== toml) {
  writeFileSync(TOML, patched);
  console.log('Saved the database id in api/wrangler.toml (commit it so GitHub can deploy updates).');
}

// ------------------------------------------------------------------------------------------------
// 3. Migrations
// ------------------------------------------------------------------------------------------------
step(3, 'Tables and the three pilot malls (migrations)');
if (wrangler(['d1', 'migrations', 'apply', 'locus', '--remote']) !== 0) fail('Migrations failed.');

// ------------------------------------------------------------------------------------------------
// 4. Deploy
// ------------------------------------------------------------------------------------------------
step(4, 'Deploy the API');
console.log('If Cloudflare asks for a workers.dev subdomain, pick any short name (e.g. your company name).');
const dep = await wranglerTee(['deploy']);
if (dep.status !== 0) fail('Deploy failed.');
const url = (dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) ?? [])[0];
if (!url) fail('Deployed, but the address was not in the output. Open the Cloudflare dashboard → Workers → locus-api to find it.');
console.log(`\nAPI address: ${url}`);

// ------------------------------------------------------------------------------------------------
// 5. Platform key
// ------------------------------------------------------------------------------------------------
step(5, 'Platform key (for Locus operators)');
const secrets = wranglerJson<{ name: string }[]>(['secret', 'list', '--format', 'json']);
let platformKey: string | null = null;
if (!secrets.some((s) => s.name === 'PLATFORM_KEY_SHA256') || rotate) {
  platformKey = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(platformKey).digest('hex');
  if (wrangler(['secret', 'put', 'PLATFORM_KEY_SHA256'], hash) !== 0) fail('Could not save the platform key.');
  // Saved right away, so a later failure (and a re-run) never loses it.
  writeFileSync(KEY_FILE, `Locus platform key (${url}):\n${platformKey}\n`, { mode: 0o600 });
  console.log(`New platform key created and saved to ${KEY_FILE}.`);
} else {
  platformKey = process.env.LOCUS_PLATFORM_KEY ?? null;
  console.log(
    platformKey
      ? 'Keeping the existing platform key (from LOCUS_PLATFORM_KEY).'
      : `Keeping the existing platform key. To create clients or import the catalogue, run again with LOCUS_PLATFORM_KEY=<your key> in front (it is in ${KEY_FILE} or your password manager), or pass --rotate-platform-key.`,
  );
}

// ------------------------------------------------------------------------------------------------
// 6. Health check
// ------------------------------------------------------------------------------------------------
step(6, 'Health check');
let healthy = false;
for (let i = 0; i < 20 && !healthy; i++) {
  try {
    healthy = (await fetch(`${url}/health`)).ok;
  } catch {
    // DNS for a new workers.dev subdomain can take a few seconds
  }
  if (!healthy) await new Promise((r) => setTimeout(r, 3000));
}
if (!healthy) fail(`${url}/health does not answer yet. Wait a minute and run this command again.`);
console.log('The API answers.');

// ------------------------------------------------------------------------------------------------
// 7. First client and 8. catalogue
// ------------------------------------------------------------------------------------------------
let keys: { publishable: string; secret: string } | null = null;
if (platformKey) {
  step(7, `Client "${clientName}" (${clientId})`);
  // A secret set seconds ago can take a moment to reach every Cloudflare location.
  let res: Response | null = null;
  for (let i = 0; i < 10; i++) {
    res = await fetch(`${url}/v1/platform/tenants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platformKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, name: clientName, country: clientCountry }),
    });
    if (res.status !== 401) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (res!.status === 201) {
    keys = ((await res!.json()) as { keys: { publishable: string; secret: string } }).keys;
    console.log('Created, with a publishable key (apps) and a secret key (console).');
  } else if (res!.status === 409) {
    console.log('This client exists already; its keys were shown when it was created.');
  } else {
    fail(`Could not create the client: HTTP ${res!.status} ${await res!.text()}`);
  }
  if (catalogue) {
    step(8, 'Oman places catalogue');
    const r = await importCatalogue(url, platformKey, catalogue.malls!, catalogue.stores!, () => {});
    console.log(`Imported ${r.malls} malls and ${r.stores} stores.`);
  }
}

// ------------------------------------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------------------------------------
const lines = [
  'Locus API on Cloudflare',
  `Created: ${new Date().toISOString()}`,
  '',
  `API address:        ${url}`,
  `D1 database id:     ${db.uuid}`,
  platformKey ? `Platform key:       ${platformKey}   (Locus operators only)` : 'Platform key:       unchanged',
  keys ? `${clientName} publishable key: ${keys.publishable}   (goes in the app / demo app)` : '',
  keys ? `${clientName} secret key:      ${keys.secret}   (console sign-in, bank servers)` : '',
  '',
  'Console: https://mrahmedmamdouh.github.io/Locus/console/ (sign in with the API address and the secret key)',
  'Store these keys in a password manager, then delete this file.',
].filter((l, i, a) => l !== '' || a[i - 1] !== '');
const file = KEY_FILE;
if (platformKey || keys) {
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
console.log(`\n\x1b[32m✔ Done.\x1b[0m\n\n${lines.join('\n')}`);
if (platformKey || keys) console.log(`\nA copy is in ${file} (only you can read it).`);
console.log(`\nOptional: prefill the console's sign-in page:\n  gh variable set LOCUS_API_URL --body ${url} -R mrahmedmamdouh/Locus`);
