# slate

[中文文档](./README_CN.md)

In-process SSR engine via QuickJS. Render SvelteKit, Vue, or React pages inside your Rust binary — no Node.js, no bun, no external process.

## How it works

```
Browser → Rust server → QuickJS (persistent worker thread)
                              │
                              ├─ static file? → serve from memory (RustEmbed)
                              │
                              └─ page request? → __render(request) → HTML
                                                    │
                                                    └─ fetch('/api/...') → zero-HTTP internal dispatch
```

- **One worker thread** with a pre-initialized QuickJS context (bundle eval'd once at startup, like Node.js)
- **Zero-HTTP dispatch**: JS `fetch('/api/...')` calls route directly through your web framework's router — no TCP overhead
- **Static assets** served from embedded memory via `RustEmbed`
- **In-memory HTML cache** with `X-SSR-Cache: HIT/MISS` headers

## Designed for SEO SSR — not a Node.js replacement

Slate renders your frontend pages **for search engines and first-load performance**. It is NOT a general-purpose Node.js runtime.

### ✅ When to use

| Scenario | Why it fits |
|----------|-------------|
| **SEO for SPAs** | Google/Bing see fully rendered HTML instead of an empty `<div id="app">` |
| **First-load speed** | Users get a complete page immediately, then SvelteKit hydrates it |
| **Single binary deployment** | No need to install Node.js, bun, or manage a separate SSR process |
| **Co-located frontend + backend** | API calls from SSR are zero-HTTP (in-process) — no network round-trip |

### ❌ When NOT to use

| Scenario | Why it won't work |
|----------|-------------------|
| **Deep Node.js dependencies** | Slate runs QuickJS — no `Buffer`, `stream`, `child_process`, `fs`, native C++ modules |
| **Server-side business logic** | Put that in your Rust handlers. The frontend should **render HTML, not compute business rules** |
| **WebSocket / SSE / streaming** | SSR is one-shot `request → HTML`. Real-time features belong on the client side |
| **High QPS (>1000 RPS)** | QuickJS is an interpreter, not a JIT. For extreme throughput, pre-render at build time or add a CDN |

### Architecture philosophy

```
┌─ Frontend (SvelteKit/Vue/React) ─┐      ┌─ Backend (Rust) ──────────┐
│  load() {                         │      │  async fn api_handler() {  │
│    // Light data fetching only    │      │    // All business logic   │
│    const data = await fetch(      │      │    // Database queries     │
│      '/api/users'                 │      │    // Auth / permissions   │
│    );                             │      │    // Data transformation  │
│    return { data };  // → render  │      │    // Heavy computation    │
│  }                                │      │  }                        │
│  // After hydration:              │      └───────────────────────────┘
│  //   Client-side interactivity   │               ▲
│  //   Real-time (WebSocket/SSE)   │               │ zero-HTTP
│  //   Animations, transitions     │               │ in-process
└──────────────────────────────────┘               │
         ▲                                         │
         │  SSR: HTML for SEO + first load         │
         └─────────────────────────────────────────┘
```

> **Key rule**: If you find yourself writing complex data processing in `load()` functions or server-side routes, move it to Rust. The frontend is for presentation. Slate bridges the two in one process.

## Quick start

### 1. Build your frontend with a Slate adapter

#### SvelteKit

```bash
cd your-frontend
bun add -D @slate/adapter-sveltekit
```

```js
// svelte.config.js
import adapterSveltekit from "@slate/adapter-sveltekit";

export default {
  kit: {
    adapter: adapterSveltekit({ out: "build" }),
  },
};
```

```bash
SSR_ADAPTER=quickjs bunx vite build  # outputs build/entry.js + build/client/
```

#### Vue 3

```bash
cd your-frontend
bun add @slate/adapter-vue
```

Create `src/entry-server.js`:

```js
import { createSSRApp } from 'vue';
import App from './App.vue';
import { createRouter } from './router';

export function createApp({ url }) {
  const app = createSSRApp(App);
  const router = createRouter();
  router.push(url);
  app.use(router);
  return app;
}
```

Create `build-ssr.mjs`:

```js
import buildVueSSR from '@slate/adapter-vue';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';

await build({ plugins: [vue()], build: { outDir: 'dist/client' } });
await buildVueSSR({ entry: 'src/entry-server.js', out: 'build', clientDir: 'dist/client' });
```

```bash
node build-ssr.mjs  # outputs build/entry.js + build/client/
```

#### React

```bash
cd your-frontend
bun add @slate/adapter-react
```

Create `src/entry-server.jsx`:

```jsx
import App from './App';

export function render({ url }) {
  return <App url={url} />;
}
```

Create `build-ssr.mjs`:

```js
import buildReactSSR from '@slate/adapter-react';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

await build({ plugins: [react()], build: { outDir: 'dist/client' } });
await buildReactSSR({ entry: 'src/entry-server.jsx', out: 'build', clientDir: 'dist/client' });
```

```bash
node build-ssr.mjs  # outputs build/entry.js + build/client/
```

### 2. Add slate to your Rust project

#### With Salvo

```toml
[dependencies]
slate = { version = "0.1", features = ["salvo"] }
rust-embed = "8"
salvo = "0.93"
```

```rust
use rust_embed::RustEmbed;
use salvo::prelude::*;

#[derive(RustEmbed)]
#[folder = "frontend/build/"]
struct Assets;

#[tokio::main]
async fn main() {
    let router = slate::init_ssr::<Assets, _, _>(|| async {
        build_api_routes().await
    })
    .await
    .unwrap();

    let listener = TcpListener::new("0.0.0.0:3000").bind().await;
    Server::new(listener).serve(router).await;
}
```

`init_ssr` handles everything:
- Builds your API router twice (Salvo Router is not Clone, so factory pattern)
- Creates the QuickJS worker thread
- Evaluates the IIFE bundle once
- Adds a catch-all handler that serves static files + renders pages

#### With Axum

```toml
[dependencies]
slate = { version = "0.1", features = ["axum"] }
rust-embed = "8"
axum = "0.8"
```

```rust
use axum::routing::get;
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "frontend/build/"]
struct Assets;

#[tokio::main]
async fn main() {
    let api_router = axum::Router::new()
        .route("/api/hello", get(hello_handler));

    let app = slate::axum::init_ssr::<Assets>(api_router).await.unwrap();

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

Axum's `Router` is `Clone` (Arc-based), so `init_ssr` only needs the router once — no factory pattern needed.

## Architecture

### Core (framework-agnostic)

| Component | Purpose |
|-----------|---------|
| `SsrEngine<D, F>` | Worker thread + channel-based render loop |
| `InternalDispatcher` trait | Dispatch `fetch('/api/...')` calls |
| `ExternalFetcher` trait | Fetch absolute URLs via HTTP |
| `SsrRequest` / `SsrResponse` | Plain data structs, no web framework dependency |

### JS framework adapters

Each adapter takes a framework build output and produces a single IIFE `entry.js` that exposes `globalThis.__render(request) → { status, headers, body }`.

| Adapter | Status | How it works |
|---------|--------|-------------|
| `adapter-sveltekit` | ✅ Ready | Hooks into `builder.adapt()`, rolldown → IIFE |
| `adapter-vue` | ✅ Ready | Calls `renderToString()` from `vue/server-renderer` |
| `adapter-react` | ✅ Ready | Calls `renderToString()` from `react-dom/server` |

All adapters share polyfills from `adapters/shared/polyfills.js` (Headers, Request, Response, URL, TextEncoder/Decoder, console).

### Web framework integrations

| Feature | Provides | Key trait |
|---------|----------|-----------|
| `salvo` | `SalvoDispatcher`, `SsrHandler`, `ProductionHandler`, `init_ssr()`, `SsrCache` | Factory pattern (Router not Clone) |
| `axum` | `AxumDispatcher`, `SsrHandler`, `ProductionHandler`, `init_ssr()`, `SsrCache` | Clone pattern (Router is Arc-based) |
| `actix` | Future | — |

## Feature flags

```toml
slate = { version = "0.1" }            # core only (engine + traits)
slate = { version = "0.1", features = ["salvo"] }  # + Salvo integration
slate = { version = "0.1", features = ["axum"] }   # + Axum integration
```

## Testing status

> **Note:** Currently only **SvelteKit + Salvo** has been tested in production. Other combinations (SvelteKit + Axum, Vue + Salvo, React + Axum, etc.) have not been verified yet. The adapters and integrations are implemented but may need minor adjustments for real-world use.

## Performance

The QuickJS context is initialized **once** at startup (eval bundle, inject polyfills). Each `render()` call only invokes `__render()` on the persistent context — no thread spawn, no re-compilation.

```
Startup:  eval bundle ~10-50ms (one time)
Request:  __render()  ~1-10ms   (per request)
```

Static assets are served from embedded memory with `immutable` cache headers for content-hashed paths.

## License

MIT
