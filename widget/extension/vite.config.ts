import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';

// Builds the content script as a single IIFE (MV3 content scripts can't use ESM)
// and copies the manifest next to it → load dist-extension/ as an unpacked extension.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-manifest',
      closeBundle() {
        mkdirSync(resolve(__dirname, '../dist-extension'), { recursive: true });
        copyFileSync(resolve(__dirname, 'manifest.json'), resolve(__dirname, '../dist-extension/manifest.json'));
      },
    },
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(__dirname, '../dist-extension'),
    emptyOutDir: true,
    lib: { entry: resolve(__dirname, 'content.tsx'), name: 'AiFinPayWallet', formats: ['iife'], fileName: () => 'content.js' },
    rollupOptions: { output: { extend: true } },
  },
})
