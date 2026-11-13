import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { sha256Hex } from './auth';
import { openNodeDb } from './db-node';

/**
 * Local server: `npm run dev --workspace api`. Uses a SQLite file (LOCUS_DB, default ./locus-dev.sqlite).
 * LOCUS_PLATFORM_KEY enables the platform routes; CONSOLE_ORIGINS defaults to the Vite dev server.
 */
const db = openNodeDb(process.env.LOCUS_DB ?? 'locus-dev.sqlite');
db.migrate(fileURLToPath(new URL('../migrations', import.meta.url)));
const platformKey = process.env.LOCUS_PLATFORM_KEY ?? null;
const app = createApp({
  db,
  platformKeyHash: platformKey ? await sha256Hex(platformKey) : null,
  consoleOrigins: (process.env.CONSOLE_ORIGINS ?? 'http://localhost:5174').split(',').map((s) => s.trim()),
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`Locus API on http://localhost:${port}${platformKey ? '' : ' (platform routes off: set LOCUS_PLATFORM_KEY)'}`);
