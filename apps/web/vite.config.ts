import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: { '@ui': resolve(__dirname, '../../packages/ui-components/src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3013',
      '/ws': { target: 'ws://127.0.0.1:3013', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
