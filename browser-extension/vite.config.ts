import { resolve } from 'node:path'

import { defineConfig } from 'vite'

// Multi-entry build: the MV3 service worker as an ES module, plus four
// plain HTML/TS pages (popup, options, retrieval session, offscreen). No CRX
// bundler plugin -- `public/manifest.json` is copied verbatim by Vite and
// points at the exact output filenames configured below, which keeps the
// build easy to reason about and reproduce.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/service-worker.ts'),
        popup: resolve(__dirname, 'src/popup/popup.html'),
        options: resolve(__dirname, 'src/options/options.html'),
        retrieval: resolve(__dirname, 'src/retrieval/retrieval.html'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
