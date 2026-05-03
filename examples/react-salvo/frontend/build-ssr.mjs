// React SSR build script for Slate.
// 1. Build client bundle (Vite)
// 2. Build SSR IIFE bundle (adapter-react → rolldown)
import buildReactSSR from '@slate/adapter-react';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

// 1. Build client bundle (for browser hydration)
await build({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
  },
});

// 2. Build SSR IIFE bundle (for QuickJS)
await buildReactSSR({
  entry: 'src/entry-server.jsx',
  out: '../build',
  clientDir: 'dist/client',
});

console.log('✅ React SSR build complete');
