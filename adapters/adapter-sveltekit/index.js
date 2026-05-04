import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { POLYFILLS, FETCH_OVERRIDE } from '../shared/polyfills.js';

/** @type {import('@sveltejs/kit').Adapter} */
export default function (options = {}) {
  const {
    out = 'build',
    precompress = false,
    envPrefix = '',
  } = options;

  return {
    name: '@slate/adapter-quickjs',

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
      const entryTmpPath = join(serverDir, '_slate_entry.js');
      writeFileSync(entryTmpPath, entryContent);

      // 5. Bundle with rolldown → IIFE single file
      const bundle = await rolldown({
        input: entryTmpPath,
        resolve: {
          // Resolve node_modules packages
        },
        external: [
          // SvelteKit dynamically imports node:async_hooks for AsyncLocalStorage
          // in dev mode — never used in production SSR. Mark as external to
          // suppress UNRESOLVED_IMPORT warnings.
          'node:async_hooks',
        ],
        plugins: [],
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
        codeSplitting: false,
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
  return `// @slate/adapter-quickjs — server entry (bundled to IIFE)
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
var _initError = null;

// ━━ __render Entry Point ━━
// Called by SsrEngine::render() for each SSR request.
globalThis.__render = async function(request) {
  // Ensure server.init() has completed before responding.
  if (!_initDone) {
    try {
      await _initPromise;
      _initDone = true;
    } catch(e) {
      _initError = e;
      _initDone = true;
      throw new Error('SvelteKit server.init() failed: ' + (e && e.message || String(e)));
    }
  }
  if (_initError) {
    throw new Error('SvelteKit server.init() failed: ' + (_initError && _initError.message || String(_initError)));
  }

  const webRequest = new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers || {}),
    body: request.body != null ? request.body : undefined,
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
      body = new TextDecoder().decode(response.body);
    }
  }

  // Serialize headers — merge multi-value headers (e.g. set-cookie) with ", " joining
  // per WHATWG spec. Object.fromEntries would lose duplicate keys.
  var hdrs = {};
  response.headers.forEach(function(v, k) {
    if (k in hdrs) {
      hdrs[k] = hdrs[k] + ', ' + v;
    } else {
      hdrs[k] = v;
    }
  });

  return {
    status: response.status,
    headers: hdrs,
    body: body || '',
  };
};
`;
}
