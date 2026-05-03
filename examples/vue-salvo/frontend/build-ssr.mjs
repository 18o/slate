// Vue SSR build script for Slate.
// Builds the client first, then the server SSR IIFE bundle.
import buildVueSSR from '@slate/adapter-vue';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';

// 1. Build client bundle (for browser)
await build({
  plugins: [vue()],
  build: {
    outDir: 'dist/client',
    ssrManifest: true,
  },
});

// 2. Build SSR IIFE bundle (for QuickJS)
await buildVueSSR({
  entry: 'src/entry-server.js',
  out: '../build',
  clientDir: 'dist/client',
});

console.log('✅ Vue SSR build complete');
