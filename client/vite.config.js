import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite serves the app on :5173 and proxies API + uploaded images to the
// Express server on :3000. In prod, `vite build` emits static files that Express
// serves directly.
export default defineConfig({
  plugins: [react()],
  // Ketcher's bundled chemistry engine references the Node global `global`; map it
  // to the browser's globalThis so it runs client-side.
  define: {
    global: 'globalThis',
  },
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
