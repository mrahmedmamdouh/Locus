import { validateFloors, type Floor } from '@locus/altitude-core';
import { Hono } from 'hono';
import { generateKey, sha256Hex, type KeyKind } from '../auth';
import type { SqlValue } from '../db';
import { COUNTRIES, floorsByMall, mallJson, readBody, type MallRow, type Services, type Vars } from '../shared';
import { DEMO_BATCH, DEMO_INSTALLS, demoActivity, demoSetup } from '../demo';
import { isValidTimeZone } from '../time';
import { ApiError, bad, ID_PATTERN, int, num, obj, oneOf, optInt, optStr, str } from '../validate';

/** Platform routes (Locus operators): clients, keys, the places catalogue. */
export function platformRoutes(svc: Services, auth: (c: never, next: () => Promise<void>) => Promise<void>) {
  const { db, now } = svc;
  const platform = new Hono<{ Variables: Vars }>();
  platform.use('*', auth as never);

  const issueKey = async (tenantId: string, kind: KeyKind) => {
    const key = generateKey(kind);
    const id = crypto.randomUUID();
    await db.run('INSERT INTO api_keys (id, tenant_id, kind, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, tenantId, kind, await sha256Hex(key), key.slice(0, 12), now().toISOString()]);
    return { id, kind, key, prefix: key.slice(0, 12) };
  };

  platform.get('/tenants', async (c) => {
    const tenants = await db.all<{ id: string; name: string; country: string; created_at: string }>('SELECT * FROM tenants ORDER BY created_at');
    const keys = await db.all<{ id: string; tenant_id: string; kind: string; prefix: string; created_at: string; revoked_at: string | null }>(
      'SELECT id, tenant_id, kind, prefix, created_at, revoked_at FROM api_keys ORDER BY created_at',
    );
    return c.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        country: t.country,
        createdAt: t.created_at,
        keys: keys.filter((k) => k.tenant_id === t.id).map((k) => ({ id: k.id, kind: k.kind, prefix: k.prefix, createdAt: k.created_at, revokedAt: k.revoked_at })),
      })),
    });
  });

  platform.post('/tenants', async (c) => {
    const b = await readBody(c);
    const id = b.id === undefined ? crypto.randomUUID() : str(b.id, 'id', { max: 64, pattern: ID_PATTERN });
    const name = str(b.name, 'name', { max: 80 });
    const country = oneOf(b.country, 'country', COUNTRIES);
    const timezone = b.timezone === undefined ? (country === 'EG' ? 'Africa/Cairo' : 'Asia/Muscat') : str(b.timezone, 'timezone', { max: 64 });
    if (!isValidTimeZone(timezone)) throw bad('timezone must be an IANA time zone.');
    if (await db.first('SELECT 1 FROM tenants WHERE id = ?', [id])) throw new ApiError(409, 'conflict', 'A client with this id exists.');
    await db.run('INSERT INTO tenants (id, name, country, created_at, timezone) VALUES (?, ?, ?, ?, ?)', [id, name, country, now().toISOString(), timezone]);
    const publishable = await issueKey(id, 'publishable');
    const secret = await issueKey(id, 'secret');
    return c.json({ tenant: { id, name, country }, keys: { publishable: publishable.key, secret: secret.key }, note: 'Keys are shown once. Store them now.' }, 201);
  });

  platform.post('/tenants/:id/keys', async (c) => {
    const b = await readBody(c);
    const kind = oneOf(b.kind, 'kind', ['publishable', 'secret'] as const);
    if (!(await db.first('SELECT 1 FROM tenants WHERE id = ?', [c.req.param('id')]))) throw new ApiError(404, 'not_found', 'Unknown client.');
    return c.json({ key: await issueKey(c.req.param('id'), kind) }, 201);
  });

  /**
   * Demo data for sales demos, only for clients whose id starts with "demo". In steps so each
   * request stays small: POST …/demo-data wipes the client and creates merchants and offers, then
   * POST …/demo-data/activity {"from":0} … adds synthetic customers in batches until "next" is null.
   */
  const demoClient = async (id: string) => {
    if (!id.startsWith('demo')) throw new ApiError(403, 'forbidden', 'Demo data can only be loaded into a client whose id starts with "demo".');
    if (!(await db.first('SELECT 1 FROM tenants WHERE id = ?', [id]))) throw new ApiError(404, 'not_found', 'Unknown client.');
  };
  platform.post('/tenants/:id/demo-data', async (c) => {
    const id = c.req.param('id');
    await demoClient(id);
    if (!(await db.first("SELECT 1 FROM malls WHERE status = 'pilot'"))) throw bad('Upload the places catalogue first: demo merchants are matched to its stores.');
    return c.json({ ...(await demoSetup(db, id, now())), next: 0 });
  });
  platform.post('/tenants/:id/demo-data/activity', async (c) => {
    const id = c.req.param('id');
    await demoClient(id);
    const b = await readBody(c);
    const from = b.from === undefined ? 0 : int(b.from, 'from', 0, DEMO_INSTALLS);
    const r = await demoActivity(db, id, now(), from, DEMO_BATCH);
    return c.json({ ...r, next: from + DEMO_BATCH < DEMO_INSTALLS ? from + DEMO_BATCH : null });
  });

  platform.post('/keys/:id/revoke', async (c) => {
    const r = await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now().toISOString(), c.req.param('id')]);
    if (r.changes === 0) throw new ApiError(404, 'not_found', 'Unknown or already revoked key.');
    return c.json({ revoked: true });
  });

  /** Create or replace a mall and its floor table. */
  platform.put('/malls/:id', async (c) => {
    const id = str(c.req.param('id'), 'id', { max: 64, pattern: ID_PATTERN });
    const b = await readBody(c);
    const m = {
      name: str(b.name, 'name', { max: 100 }),
      city: str(b.city, 'city', { max: 100 }),
      country: oneOf(b.country, 'country', COUNTRIES),
      lat: num(b.lat, 'lat', -90, 90),
      lon: num(b.lon, 'lon', -180, 180),
      radiusM: num(b.radiusM, 'radiusM', 50, 2000),
      entranceFloorIndex: int(b.entranceFloorIndex ?? 0, 'entranceFloorIndex', -10, 200),
      status: oneOf(b.status ?? 'listed', 'status', ['pilot', 'listed'] as const),
    };
    if (!Array.isArray(b.floors) || b.floors.length === 0 || b.floors.length > 60) throw bad('floors must be an array of 1–60 floors.');
    const floors: Floor[] = b.floors.map((raw, i) => {
      const f = obj(raw, `floors[${i}]`);
      return { index: int(f.index, `floors[${i}].index`, -10, 200), label: str(f.label, `floors[${i}].label`, { max: 40 }), zMinM: num(f.zMinM, `floors[${i}].zMinM`, -200, 1000), zMaxM: num(f.zMaxM, `floors[${i}].zMaxM`, -200, 1000) };
    });
    const problems = validateFloors(floors);
    if (problems.length) throw bad(problems.join(' '));
    if (m.status === 'pilot' && !floors.some((f) => f.index === m.entranceFloorIndex)) throw bad('entranceFloorIndex must be one of the floors.');
    await db.batch([
      {
        sql: `INSERT INTO malls (id, name, city, country, lat, lon, radius_m, entrance_floor_index, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, city = excluded.city, country = excluded.country, lat = excluded.lat, lon = excluded.lon,
              radius_m = excluded.radius_m, entrance_floor_index = excluded.entrance_floor_index, status = excluded.status, updated_at = excluded.updated_at`,
        params: [id, m.name, m.city, m.country, m.lat, m.lon, m.radiusM, m.entranceFloorIndex, m.status, now().toISOString()],
      },
      { sql: 'DELETE FROM floors WHERE mall_id = ?', params: [id] },
      ...floors.map((f) => ({ sql: 'INSERT INTO floors (mall_id, floor_index, label, z_min_m, z_max_m) VALUES (?, ?, ?, ?, ?)', params: [id, f.index, f.label, f.zMinM, f.zMaxM] })),
    ]);
    const row = (await db.first<MallRow>('SELECT * FROM malls WHERE id = ?', [id]))!;
    return c.json({ mall: mallJson(row, (await floorsByMall(db, [id])).get(id) ?? []) });
  });

  /** Add stores to a mall (replace: true removes stores that are not referenced by offers first). */
  platform.post('/malls/:id/stores', async (c) => {
    const mallId = c.req.param('id');
    if (!(await db.first('SELECT 1 FROM malls WHERE id = ?', [mallId]))) throw new ApiError(404, 'not_found', 'Unknown mall.');
    const b = await readBody(c);
    if (!Array.isArray(b.stores) || b.stores.length > 2000) throw bad('stores must be an array of up to 2000 stores.');
    const stores = b.stores.map((raw, i) => {
      const s = obj(raw, `stores[${i}]`);
      const name = str(s.name, `stores[${i}].name`, { max: 100 });
      const id = s.id === undefined ? `${mallId}--${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 100) : str(s.id, `stores[${i}].id`, { max: 100 });
      return { id, name, floorIndex: optInt(s.floorIndex, `stores[${i}].floorIndex`, -10, 200), unit: optStr(s.unit, `stores[${i}].unit`, { max: 40 }), category: optStr(s.category, `stores[${i}].category`, { max: 60 }) };
    });
    const statements: { sql: string; params: SqlValue[] }[] = [];
    if (b.replace === true) statements.push({ sql: 'DELETE FROM stores WHERE mall_id = ? AND id NOT IN (SELECT store_id FROM offers WHERE store_id IS NOT NULL)', params: [mallId] });
    for (const s of stores) {
      statements.push({
        sql: `INSERT INTO stores (id, mall_id, name, floor_index, unit, category) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, floor_index = excluded.floor_index, unit = excluded.unit, category = excluded.category`,
        params: [s.id, mallId, s.name, s.floorIndex, s.unit, s.category],
      });
    }
    await db.batch(statements);
    return c.json({ upserted: stores.length });
  });

  return platform;
}
