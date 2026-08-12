import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * AC-6. The app always calls the API with relative paths — `/auth/login`, not
 * an absolute origin. In production Fastify serves the built app, so relative
 * already means the right host. In development Vite proxies the API prefixes
 * to the local API, so the same code works with no configuration.
 *
 * That is the point: there is no base-URL setting to get wrong, and no way to
 * aim the app at someone else's server by mistake.
 */
const API_PREFIXES = ['/auth', '/categories', '/receipts', '/expenses', '/health'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [
        prefix,
        { target: 'http://localhost:3000', changeOrigin: true },
      ]),
    ),
  },
  test: {
    // happy-dom rather than jsdom, for one concrete reason: Node 26 ships its
    // own `localStorage` global that is disabled unless the process is started
    // with --localstorage-file, and it shadows jsdom's. The storage adapter is
    // the whole of AC-3, so the environment has to supply a real Storage or
    // those tests would be exercising `undefined`.
    environment: 'happy-dom',
    environmentOptions: { happyDOM: { url: 'http://localhost:5173' } },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Date-only strings are safe only while they stay strings. Pin the
    // developers' positive-offset zone by default; CI overrides it with a
    // negative offset to catch accidental `new Date('YYYY-MM-DD')` rendering.
    env: { TZ: process.env.TZ ?? 'Asia/Kuala_Lumpur' },
  },
});
