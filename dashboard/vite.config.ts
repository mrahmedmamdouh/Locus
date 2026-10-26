import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Strict Content-Security-Policy for the production build only (the dev server
// injects an inline React-refresh preamble that a strict policy would block).
// connect-src 'none' makes "no data leaves the browser" enforceable, not just a promise.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'locus-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

// Relative base so the static build works at any path / URL casing on GitHub Pages
// (e.g. https://mrahmedmamdouh.github.io/Locus/ and /locus/).
export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Separate long-lived vendor chunks so app updates don't bust the chart library cache.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          return 'charts';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
