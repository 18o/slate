import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { jsonPlugin } from 'rolldown/plugins';
import { POLYFILLS, FETCH_OVERRIDE } from '../shared/polyfills.js';

/** @type {import('@sveltejs/kit').Adapter} */
export default function (options = {}) {
  const {
    out = 'build',
    precompress = false,
    envPrefix = '',
  } = options;

  return {
    name: '@twist/adapter-quickjs',

    async adapt(builder) {
      // 1. Clean output directory
      rmSync(out, { recursive: true, force: true });

      const serverDir = join(out, 'server');
      const clientDir = join(out, 'client');

      // 2. Write SvelteKit standard output
      builder.writeClient(clientDir);
      builder.writeServer(serverDir);
      builder.writePrerendered(out);

      // 3. Generate manifest
      const manifest = builder.generateManifest({ relativePath: '.' });

      // 4. Generate server-entry.js (temporary file, rolldown entry point)
      const entryContent = generateServerEntry(manifest);
      const entryTmpPath = join(serverDir, '_twist_entry.js');
      writeFileSync(entryTmpPath, entryContent);

      // 5. Bundle with rolldown → IIFE single file
      const bundle = await rolldown({
        input: entryTmpPath,
        resolve: {
          // Resolve node_modules packages
        },
        plugins: [jsonPlugin()],
        onLog(level, log) {
          // Suppress known harmless warnings
          if (log.code === 'CIRCULAR_DEPENDENCY') return;
          if (log.code === 'EVAL') return;
          if (log.message && log.message.includes('this')) return;
          if (level === 'warn') console.warn(`[rolldown] ${log.message}`);
        },
      });

      await bundle.write({
        file: join(out, 'entry.js'),
        format: 'iife',
        name: 'TwistSSR',
        exports: 'none',
        inlineDynamicImports: true,
        // QuickJS doesn't support Object.hasOwn, structuredClone, etc.
        // Target ES2015 for maximum compatibility.
        target: 'es2015',
      });

      await bundle.close();

      // 6. Delete temporary entry file
      rmSync(entryTmpPath, { force: true });

      // 7. Write env file stub
      writeFileSync(
        join(out, 'env.js'),
        '// Environment variables are injected via globalThis.__env\n' +
        '// Set env vars before calling SsrEngine::new()\n' +
        'globalThis.__env = globalThis.__env || {};\n'
      );

      builder.log.success(`QuickJS adapter output: ${resolve(out)}`);
      builder.log.minor(`  entry.js  → ${join(out, 'entry.js')} (IIFE)`);
      builder.log.minor(`  server/   → ${serverDir}`);
      builder.log.minor(`  client/   → ${clientDir}`);
    },
  };
}

function generateServerEntry(manifest) {
  return `// @twist/adapter-quickjs — server entry (bundled to IIFE)
// This file is the temporary rolldown entry point.
// After bundling, the output is a single IIFE entry.js with no imports.

${POLYFILLS}

${FETCH_OVERRIDE}

// ━━ SvelteKit Server Init ━━
import { Server } from './index.js';
import { manifest } from './manifest.js';

const server = new Server(manifest);

// IIFE does not support top-level await, so we store the init promise
// and await it inside __render before handling any requests.
// QuickJS may not reliably drive async init via ??= pattern,
// so we also provide a manual fallback to ensure hooks are set.
const _initPromise = server.init({
  env: globalThis.__env || {},
});

// Track whether init completed successfully
var _initDone = false;

// ━━ __render Entry Point ━━
// Called by SsrEngine::render() for each SSR request.
globalThis.__render = async function(request) {
  // Ensure server.init() has completed before responding.
  if (!_initDone) {
    try {
      await _initPromise;
      _initDone = true;
    } catch(e) {
      _initDone = true; // Don't retry on every request
      throw new Error('SvelteKit server.init() failed: ' + (e && e.message || String(e)));
    }
  }

  const webRequest = new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers || {}),
    body: request.body || undefined,
  });

  const response = await server.respond(webRequest, {
    getClientAddress: () => request.remote_addr || '127.0.0.1',
  });

  // Extract body: response.text() may return empty if body is Uint8Array
  // (native TextEncoder.encode returns TypedArray, Response polyfill may not handle it)
  var body;
  try {
    body = await response.text();
  } catch(e) {}
  if (!body && response.body) {
    if (typeof response.body === 'string') body = response.body;
    else if (response.body instanceof Uint8Array) {
      var arr = response.body;
      var chunks = [];
      for (var ci = 0; ci < arr.length; ci += 0x8000) {
        chunks.push(String.fromCharCode.apply(null, arr.subarray(ci, ci + 0x8000)));
      }
      body = chunks.join('');
    }
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: body || '',
  };
};
`;
}
