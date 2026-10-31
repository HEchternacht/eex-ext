import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: import.meta.dirname,
  base: './',   // assets (codicon font) resolve next to index.css inside the webview
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, '../dist/webview'),
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
    sourcemap: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/main.tsx'),
      output: { entryFileNames: 'index.js', assetFileNames: 'index[extname]', inlineDynamicImports: true },
    },
  },
});
