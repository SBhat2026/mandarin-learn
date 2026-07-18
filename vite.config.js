import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.API_ORIGIN || 'http://localhost:5178';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/media': { target: API, changeOrigin: true },
    },
  },
});
