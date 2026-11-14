import { createApp } from './app';
import { d1Db, type D1Database } from './d1';
import { purgeExpired } from './retention';
import { retryDueDeliveries, type FetchLike } from './webhook';

/** Cloudflare Workers entry (wrangler.toml). Secrets: PLATFORM_KEY_SHA256; vars: CONSOLE_ORIGINS. */
interface Env {
  DB: D1Database;
  PLATFORM_KEY_SHA256?: string;
  CONSOLE_ORIGINS?: string;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

const fetchImpl: FetchLike = (url, init) => fetch(url, init);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      db: d1Db(env.DB),
      platformKeyHash: env.PLATFORM_KEY_SHA256?.toLowerCase() ?? null,
      consoleOrigins: (env.CONSOLE_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      fetchImpl,
      defer: (p) => ctx.waitUntil(p),
    });
    return app.fetch(request, env, ctx as never);
  },

  /** Every minute (wrangler.toml [triggers]): retry bank webhooks that failed, expire stale ones. */
  scheduled(event: { cron?: string }, env: Env, ctx: ExecutionContext) {
    const db = d1Db(env.DB);
    // Nightly (02:00 UTC): delete what is past its retention. Every minute: webhook retries.
    if (event.cron === '0 2 * * *') ctx.waitUntil(purgeExpired(db, new Date()).then((r) => console.log('retention purge', JSON.stringify(r))));
    else ctx.waitUntil(retryDueDeliveries(db, fetchImpl, new Date()));
  },
};
