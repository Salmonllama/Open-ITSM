/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Keep the browser's Host so the server's CSRF origin check sees the same site as Origin.
// (The string shorthand would set changeOrigin: true and every write would be refused.)
const apiProxy = {
  target: process.env.API_URL ?? 'http://localhost:3000',
  changeOrigin: false,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@open-itsm/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      '/api': apiProxy,
      '/healthz': apiProxy,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
