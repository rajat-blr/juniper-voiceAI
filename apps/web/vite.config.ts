import { defineConfig } from 'vite';
export default defineConfig({ server: { proxy: {
  '/api': { target: 'http://127.0.0.1:3001', rewrite: (path) => path.replace(/^\/api/, '') },
} }, build: { rollupOptions: { output: { manualChunks(id) {
  if (id.includes('/node_modules/livekit-client/')) return 'livekit';
  if (id.includes('/node_modules/')) return 'vendor';
} } } } });
