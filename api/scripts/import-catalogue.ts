/**
 * Load the Oman places catalogue (malls.csv + stores.csv, kept outside this public repo) into a
 * running Locus API through its platform routes.
 *
 *   LOCUS_API_URL=https://locus-api.<you>.workers.dev LOCUS_PLATFORM_KEY=… \
 *     npm run import-catalogue --workspace api -- path/to/malls.csv path/to/stores.csv
 *
 * Pilot malls (already in the database with measured floor heights) keep their floor table; only
 * their stores are loaded. Other malls are added as 'listed' with uniform 5.5 m floors from the
 * catalogue's floor labels, until someone measures them.
 */
import { readFileSync } from 'node:fs';

const [mallsPath, storesPath] = process.argv.slice(2).filter((a) => a !== '--');
const api = process.env.LOCUS_API_URL?.replace(/\/$/, '');
const key = process.env.LOCUS_PLATFORM_KEY;
if (!mallsPath || !storesPath || !api || !key) {
  console.error('Usage: LOCUS_API_URL=… LOCUS_PLATFORM_KEY=… npm run import-catalogue --workspace api -- malls.csv stores.csv');
  process.exit(1);
}

/** RFC 4180 CSV (quoted fields, doubled quotes, commas and newlines inside quotes). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(header!.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function call(method: string, path: string, body: unknown) {
  const res = await fetch(`${api}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error?.message ?? ''}`);
  return json;
}

const malls = parseCsv(readFileSync(mallsPath, 'utf8'));
const stores = parseCsv(readFileSync(storesPath, 'utf8'));
const res = await fetch(`${api}/v1/platform/tenants`, { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) throw new Error(`Platform key rejected (${res.status}).`);
const PILOT = new Set(['mall-of-oman', 'oman-avenues-mall', 'city-centre-muscat']);
const FLOOR_M = 5.5;

for (const m of malls) {
  const id = m.mall_id!;
  const own = stores.filter((s) => s.mall_id === id);
  if (!PILOT.has(id)) {
    // Floor indexes as the catalogue assigned them to stores; labels without stores follow in order.
    const labelIndex = new Map<string, number>();
    for (const s of own) if (s.floor_label && s.floor_index !== '') labelIndex.set(s.floor_label.toLowerCase(), Number(s.floor_index));
    const labels = (m.floors ?? '').split('|').map((l) => l.trim()).filter(Boolean);
    const floors = labels.length
      ? labels.map((label, i) => ({ index: labelIndex.get(label.toLowerCase()) ?? i, label }))
      : [{ index: 0, label: 'Ground' }];
    const seen = new Set<number>();
    const clean = floors.filter((f) => !seen.has(f.index) && seen.add(f.index)).sort((a, b) => a.index - b.index);
    await call('PUT', `/v1/platform/malls/${id}`, {
      name: m.name,
      city: m.city || m.governorate || 'Oman',
      country: 'OM',
      lat: Number(m.lat),
      lon: Number(m.lon),
      radiusM: 300,
      entranceFloorIndex: clean.some((f) => f.index === 0) ? 0 : clean[0]!.index,
      status: 'listed',
      floors: clean.map((f) => ({ index: f.index, label: f.label, zMinM: f.index * FLOOR_M - FLOOR_M / 2, zMaxM: f.index * FLOOR_M + FLOOR_M / 2 })),
    });
  }
  if (own.length) {
    const payload = own.map((s) => ({
      id: `${id}--${slug(s.store_name!)}${s.floor_index !== '' ? `--${s.floor_index}` : ''}`.slice(0, 100),
      name: s.store_name!.slice(0, 100),
      floorIndex: s.floor_index === '' ? null : Number(s.floor_index),
      unit: s.unit ? s.unit.slice(0, 40) : null,
      category: s.category ? s.category.slice(0, 60) : null,
    }));
    for (let i = 0; i < payload.length; i += 500) await call('POST', `/v1/platform/malls/${id}/stores`, { stores: payload.slice(i, i + 500) });
  }
  console.log(`${id}: ${PILOT.has(id) ? 'pilot (floors kept)' : 'listed'}, ${own.length} stores`);
}
