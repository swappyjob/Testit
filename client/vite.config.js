import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite serves the app on :5173 and proxies API + uploaded images to the
// Express server on :3000. In prod, `vite build` emits static files that Express
// serves directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
