import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const publicOrigin = (process.env.VITE_PUBLIC_ORIGIN || '').trim();
const parsedAllowedHosts = (process.env.VITE_ALLOWED_HOSTS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const allowedHosts = parsedAllowedHosts.length > 0 ? parsedAllowedHosts : true;

let hmr = undefined;
if (publicOrigin) {
  const url = new URL(publicOrigin);
  const defaultClientPort = url.port
    ? Number(url.port)
    : (url.protocol === 'https:' ? 443 : 80);

  hmr = {
    protocol: process.env.VITE_HMR_PROTOCOL || (url.protocol === 'https:' ? 'wss' : 'ws'),
    host: process.env.VITE_HMR_HOST || url.hostname,
    clientPort: Number(process.env.VITE_HMR_CLIENT_PORT || defaultClientPort)
  };
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appPackage.version)
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    origin: publicOrigin || undefined,
    allowedHosts,
    hmr,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: true
      }
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  }
});
