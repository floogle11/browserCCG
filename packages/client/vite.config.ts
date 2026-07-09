import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Relative base so the build works from any path (GitHub Pages project sites
  // serve from /<repo>/, not /).
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@divinity/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 5173 },
});
