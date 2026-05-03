import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { replacePlugin } from 'rolldown/plugins';
import { POLYFILLS, FETCH_OVERRIDE } from '../shared/polyfills.js';

/**
 * @typedef {Object} SlateVueAdapterOptions
 * @property {string} [entry='src/entry-server.js'] - Path to user's server entry file.
 *   This file should export a function `createApp({ url, path })` that returns a Vue app instance.
 * @property {string} [out='build'] - Output directory for the SSR bundle.
 * @property {string} [clientDir='dist/client'] - Client build output (copied to build/client/).
 * @property {Record<string, string>} [define] - Additional define replacements for rolldown.
 */

/**
 * Vue 3 SSR adapter for Slate.
 *
 * Takes a Vue 3 + Vue Router app and produces an IIFE bundle (`entry.js`)
 * that exposes `globalThis.__render(request)` for QuickJS SSR rendering.
 *
 * Unlike SvelteKit which has a built-in `adapt()` API, Vue doesn't have
 * a standard adapter pattern. This adapter is called directly from a build
 * script or vite config.
 *
 * # User's entry-server.js contract
 *
 * The user's entry file must export a `createApp` function:
 *
 * ```js
 * // src/entry-server.js
 * import { createSSRApp } from 'vue';
 * import App from './App.vue';
 * import { createRouter } from './router';
 *
 * export function createApp({ url }) {
 *   const app = createSSRApp(App);
 *   const router = createRouter();
 *   router.push(url);
 *   app.use(router);
 *   return app;
 * }
 * ```
 *
 * @param {SlateVueAdapterOptions} options
 * @returns {Promise<void>}
 */
export default async function buildVueSSR(options = {}) {
  const {
    entry = 'src/entry-server.js',
    out = 'build',
    clientDir = 'dist/client',
    define = {},
  } = options;

  const entryAbs = resolve(entry);

  if (!existsSync(entryAbs)) {
    throw new Error(`Vue SSR entry not found: ${entryAbs}`);
  }

  // 1. Clean output directory
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const serverDir = join(out, 'server');
  const clientOutDir = join(out, 'client');

  // 2. Copy client assets if they exist
  if (existsSync(clientDir)) {
    copyDir(clientDir, clientOutDir);
  }

  // 3. Generate the server entry wrapper
  //    This imports the user's createApp and wraps it with polyfills + __render
  const entryContent = generateServerEntry(entryAbs);
  const entryTmpPath = join(serverDir, '_slate_entry.js');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(entryTmpPath, entryContent);

  // 4. Bundle with rolldown → IIFE
  const bundle = await rolldown({
    input: entryTmpPath,
    plugins: [
      replacePlugin({
        'process.env.NODE_ENV': JSON.stringify('production'),
        ...define,
      }),
    ],
    onLog(level, log) {
      if (log.code === 'CIRCULAR_DEPENDENCY') return;
      if (log.code === 'EVAL') return;
      if (log.message && log.message.includes('this')) return;
      if (level === 'warn') console.warn(`[rolldown] ${log.message}`);
    },
  });

  await bundle.write({
    file: join(out, 'entry.js'),
    format: 'iife',
    name: 'SlateVueSSR',
    exports: 'none',
    codeSplitting: false,
  });

  await bundle.close();

  // 5. Clean up temp entry
  rmSync(entryTmpPath, { force: true });
  rmSync(serverDir, { recursive: true, force: true });

  console.log(`[adapter-vue] Slate SSR build complete: ${resolve(out)}`);
  console.log(`  entry.js  → ${join(out, 'entry.js')} (IIFE)`);
  if (existsSync(clientOutDir)) {
    console.log(`  client/   → ${clientOutDir}`);
  }
}

/**
 * Generate the server entry that rolldown will bundle.
 *
 * Structure:
 * 1. Polyfills (Headers, Request, Response, URL, etc.)
 * 2. Fetch override (routes to __rust_internal_dispatch / __rust_http_fetch)
 * 3. Import user's createApp from their entry-server.js
 * 4. Define __render that calls createApp + renderToString for each request
 */
function generateServerEntry(userEntryPath) {
  return `// @slate/adapter-vue — server entry (bundled to IIFE)
// This file is the rolldown entry point.
// After bundling, the output is a single IIFE entry.js with no imports.

${POLYFILLS}

${FETCH_OVERRIDE}

// ━━ Import user's app factory ━━
import { createApp } from ${JSON.stringify(userEntryPath)};

// ━━ Vue SSR ━━
import { renderToString } from 'vue/server-renderer';

// ━━ __render Entry Point ━━
globalThis.__render = async function(request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname + url.search;

    // Create the Vue app for this request using user's factory
    const app = createApp({ url: request.url, path });

    // Render to HTML string
    const html = await renderToString(app);

    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: html,
    };
  } catch (e) {
    var _escHtml = function(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    return {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>500 SSR Error</h1><pre>' + _escHtml(e?.message || String(e)) + '</pre></body></html>',
    };
  }
};
`;
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
