import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { chartCacheDevPlugin } from './vite-plugin-chart-cache.mjs';

import { execSync } from 'node:child_process';

function gitVersion() {
  try {
    // v2.1.0 (on tag) or v2.1.0-3-gabcdef (3 commits after tag)
    return execSync('git describe --tags --always', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    chartCacheDevPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'CandleScan',
        short_name: 'CandleScan',
        description: 'NSE candlestick pattern scanner & risk scorer',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#1a1d26',
        background_color: '#f5f6f8',
        icons: [
          { src: 'icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: 'icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/candlescan-proxy\.utkarsh-dev\.workers\.dev/,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/config/**', 'src/utils/**', 'src/data/**'],
      exclude: ['src/**/__fixtures__/**', 'src/**/*.test.js'],
      thresholds: {
        statements: 70,
        branches: 55,
        functions: 75,
        lines: 75,
      },
    },
  },
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
