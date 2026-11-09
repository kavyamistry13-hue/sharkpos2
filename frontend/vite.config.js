import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    strictPort: true,
    port: 5174,
    host: '0.0.0.0',
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': 'http://localhost:4001' },
  },
});
