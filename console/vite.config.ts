import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Production CSP: scripts only from this site; the API is the only thing the page talks to.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src https: http://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'locus-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

// Served from the dashboard's Pages site under /console/, so the base is relative.
export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
