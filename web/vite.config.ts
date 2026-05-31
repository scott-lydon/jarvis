// Vite config for the Jarvis web client.
// `npm run web:dev` serves on http://localhost:5173 with proxying the
// WebSocket path to the Node server on $PORT (default 3000).

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const SERVER_PORT = Number.parseInt(process.env['PORT'] ?? '3000', 10);

export default defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/realtime': {
        target: `ws://127.0.0.1:${String(SERVER_PORT)}`,
        ws: true,
        changeOrigin: true,
      },
      '/healthz': {
        target: `http://127.0.0.1:${String(SERVER_PORT)}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
