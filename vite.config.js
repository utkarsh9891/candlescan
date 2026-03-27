import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { chartCacheDevPlugin } from './vite-plugin-chart-cache.mjs';

export default defineConfig({
  plugins: [react(), chartCacheDevPlugin()],
  base: '/candlescan/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin fetch in dev — avoids third-party CORS proxies (and console noise).
      '/__candlescan-yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__candlescan-yahoo/, ''),
      },
      '/candlescan/__candlescan-nse': {
        target: 'https://www.nseindia.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/candlescan\/__candlescan-nse/, ''),
      },
    },
  },
});
