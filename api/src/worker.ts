import { createApp } from './app';
import { d1Db, type D1Database } from './d1';

/** Cloudflare Workers entry (wrangler.toml). Secrets: PLATFORM_KEY_SHA256; vars: CONSOLE_ORIGINS. */
interface Env {
  DB: D1Database;
  PLATFORM_KEY_SHA256?: string;
  CONSOLE_ORIGINS?: string;
}

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    const app = createApp({
      db: d1Db(env.DB),
      platformKeyHash: env.PLATFORM_KEY_SHA256?.toLowerCase() ?? null,
      consoleOrigins: (env.CONSOLE_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    return app.fetch(request, env, ctx as never);
  },
};
