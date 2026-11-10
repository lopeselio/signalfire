import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_TARGET ?? 'http://localhost:8861';
export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { port: 8862, proxy: { '/api': { target: api, changeOrigin: true } } },
});
