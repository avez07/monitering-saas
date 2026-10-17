import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(() => {
  const envFile = new URL('../.env', import.meta.url);
  // Parse connection settings without letting the backend's NODE_ENV change Vite's build mode.
  const environment = {
    ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}),
    ...process.env,
  };
  const backendUrl = `http://127.0.0.1:${environment.PORT || 4000}`;
  return {
    plugins: [react(), tailwindcss()],
    // Read connection settings at tool startup; secrets are never defined in browser code.
    server: {
      host: '127.0.0.1',
      port: Number(environment.FRONTEND_PORT || 5173),
      strictPort: true,
      proxy: { '/api': backendUrl, '/otlp': backendUrl },
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
