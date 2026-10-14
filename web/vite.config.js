import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The only chunks over 500 kB are mermaid's diagram engines (elk, cytoscape),
    // which the file viewer loads on demand for a document that needs them;
    // the board's own bundle stays well under the default.
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 7421,
    proxy: {
      '/api': 'http://localhost:7420',
      '/ws': { target: 'ws://localhost:7420', ws: true },
    },
  },
});
