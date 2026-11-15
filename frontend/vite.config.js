import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const envFile = new URL('../.env', import.meta.url);
  // Parse connection settings without letting the backend's NODE_ENV change Vite's build mode.
  const environment = {
    ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}),
    ...process.env,
  };
  const backend = `http://127.0.0.1:${environment.API_PORT || environment.PORT || 4000}`;
  return {
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    server: {
      host: '127.0.0.1',
      port: Number(environment.FRONTEND_PORT || 5173),
      strictPort: true,
      proxy: { '/api': backend, '/v1': backend, '/downloads': backend },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            charts: ['recharts'],
          },
        },
      },
    },
  };
});
