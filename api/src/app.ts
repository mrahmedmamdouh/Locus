import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearer, keyKindOf, safeEqualHex, sha256Hex, type KeyKind } from './auth';
import { adminRoutes } from './routes/admin';
import { platformRoutes } from './routes/platform';
import { sdkRoutes } from './routes/sdk';
import type { AppDeps, Ctx, Services, Vars } from './shared';
import { ApiError } from './validate';
import type { FetchLike } from './webhook';

export type { AppDeps } from './shared';

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const svc: Services = {
    db,
    now: deps.now ?? (() => new Date()),
    fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>),
    defer: deps.defer ?? ((p) => void p.catch((e) => console.error('background task failed', e))),
  };
  const app = new Hono<{ Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route.' } }, 404));

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
  });
  // The console (bank staff and Locus operators) calls the admin and platform routes from the browser.
  const consoleCors = cors({ origin: (o) => (deps.consoleOrigins.includes(o) ? o : null), allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], maxAge: 600 });
  app.use('/v1/admin/*', consoleCors);
  app.use('/v1/platform/*', consoleCors);

  app.get('/', (c) => c.json({ name: 'Locus API', version: 'v1', docs: 'https://github.com/mrahmedmamdouh/Locus/blob/main/docs/api.md' }));
  app.get('/health', async (c) => {
    await db.first('SELECT 1 AS ok');
    return c.json({ ok: true });
  });

  const requireKey = (kind: KeyKind) => async (c: Ctx, next: () => Promise<void>) => {
    const key = bearer(c.req.header('Authorization'));
    if (!key || keyKindOf(key) !== kind) throw new ApiError(401, 'unauthorized', `Send a ${kind} key: Authorization: Bearer lk_${kind === 'publishable' ? 'pub' : 'sec'}_…`);
    const row = await db.first<{ tenant_id: string }>('SELECT tenant_id FROM api_keys WHERE key_hash = ? AND kind = ? AND revoked_at IS NULL', [await sha256Hex(key), kind]);
    if (!row) throw new ApiError(401, 'unauthorized', 'Unknown or revoked key.');
    c.set('tenantId', row.tenant_id);
    await next();
    if (kind === 'secret') await audit(c, row.tenant_id, key.slice(0, 12));
  };

  /** Records changes (not reads) made with secret or platform keys: who, what, when. Never bodies or keys. */
  const audit = async (c: Ctx, tenantId: string | null, actor: string) => {
    if (c.req.method === 'GET' || c.req.method === 'OPTIONS') return;
    try {
      await db.run('INSERT INTO audit_log (tenant_id, actor, method, path, status, ip_country, t) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        tenantId,
        actor,
        c.req.method,
        new URL(c.req.url).pathname.slice(0, 200),
        c.res.status,
        c.req.header('CF-IPCountry') ?? null,
        svc.now().toISOString(),
      ]);
    } catch (e) {
      console.error('audit log failed', e);
    }
  };

  const requirePlatform = async (c: Ctx, next: () => Promise<void>) => {
    const key = bearer(c.req.header('Authorization'));
    if (!deps.platformKeyHash || !key || !safeEqualHex(await sha256Hex(key), deps.platformKeyHash)) {
      throw new ApiError(401, 'unauthorized', 'Platform key required.');
    }
    await next();
    // The demo-data batches are logged once, by the setup call that starts them.
    if (c.req.path.endsWith('/demo-data/activity')) return;
    const m = /^\/v1\/platform\/tenants\/([a-z0-9-]+)/.exec(new URL(c.req.url).pathname);
    await audit(c, m ? m[1]! : null, 'locus-operator');
  };

  app.route('/v1/sdk', sdkRoutes(svc, requireKey('publishable') as never));
  app.route('/v1/admin', adminRoutes(svc, requireKey('secret') as never));
  app.route('/v1/platform', platformRoutes(svc, requirePlatform as never));
  return app;
}
