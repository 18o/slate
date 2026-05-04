# slate

[English](./README.md)

进程内 SSR 引擎，基于 QuickJS。在 Rust 二进制文件内渲染 SvelteKit、Vue 或 React 页面 —— 无需 Node.js、无需 bun、无外部进程。

## 工作原理

```
浏览器 → Rust 服务器 → QuickJS（持久工作线程）
                            │
                            ├─ 静态文件？→ 从内存提供（RustEmbed）
                            │
                            └─ 页面请求？→ __render(request) → HTML
                                               │
                                               └─ fetch('/api/...') → 零 HTTP 内部调度
```

- **单个工作线程**，QuickJS 上下文预初始化（启动时 eval 一次，类似 Node.js 生命周期）
- **零 HTTP 调度**：JS 中的 `fetch('/api/...')` 直接走 Rust 路由器，无 TCP 开销
- **静态资源**通过 `RustEmbed` 从嵌入内存中提供
- **内存 HTML 缓存**，响应头 `X-SSR-Cache: HIT/MISS`

## 快速开始

### 1. 用 Slate 适配器构建前端

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
SSR_ADAPTER=quickjs bunx vite build  # 输出 build/entry.js + build/client/
```

#### Vue 3

```bash
cd your-frontend
bun add @slate/adapter-vue
```

创建 `src/entry-server.js`：

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

创建 `build-ssr.mjs`：

```js
import buildVueSSR from '@slate/adapter-vue';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';

await build({ plugins: [vue()], build: { outDir: 'dist/client' } });
await buildVueSSR({ entry: 'src/entry-server.js', out: 'build', clientDir: 'dist/client' });
```

```bash
node build-ssr.mjs  # 输出 build/entry.js + build/client/
```

#### React

```bash
cd your-frontend
bun add @slate/adapter-react
```

创建 `src/entry-server.jsx`：

```jsx
import App from './App';

export function render({ url }) {
  return <App url={url} />;
}
```

创建 `build-ssr.mjs`：

```js
import buildReactSSR from '@slate/adapter-react';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

await build({ plugins: [react()], build: { outDir: 'dist/client' } });
await buildReactSSR({ entry: 'src/entry-server.jsx', out: 'build', clientDir: 'dist/client' });
```

```bash
node build-ssr.mjs  # 输出 build/entry.js + build/client/
```

### 2. 在 Rust 项目中引入 slate

#### Salvo

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

`init_ssr` 自动处理：
- 构建两份 API 路由（Salvo Router 不可 Clone，需要工厂模式）
- 创建 QuickJS 工作线程
- 一次性 eval IIFE bundle
- 添加 catch-all 处理器：静态文件 + 页面渲染

#### Axum

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

Axum 的 `Router` 实现了 `Clone`（基于 Arc），所以 `init_ssr` 只需要一份路由，无需工厂模式。

## 架构

### 核心（框架无关）

| 组件 | 用途 |
|------|------|
| `SsrEngine<D, F>` | 工作线程 + 基于管道的渲染循环 |
| `InternalDispatcher` trait | 调度 `fetch('/api/...')` 请求 |
| `ExternalFetcher` trait | 通过 HTTP 请求绝对 URL |
| `SsrRequest` / `SsrResponse` | 纯数据结构，不依赖任何 Web 框架 |

### JS 框架适配器

每个适配器将框架构建输出打包为单个 IIFE `entry.js`，暴露 `globalThis.__render(request) → { status, headers, body }`。

| 适配器 | 状态 | 原理 |
|--------|------|------|
| `adapter-sveltekit` | ✅ 可用 | 接入 `builder.adapt()`，rolldown → IIFE |
| `adapter-vue` | ✅ 可用 | 调用 `vue/server-renderer` 的 `renderToString()` |
| `adapter-react` | ✅ 可用 | 调用 `react-dom/server` 的 `renderToString()` |

所有适配器共享 `adapters/shared/polyfills.js`（Headers、Request、Response、URL、TextEncoder/Decoder、console）。

### Web 框架集成

| Feature | 提供 | 调度方式 |
|---------|------|---------|
| `salvo` | `SalvoDispatcher`、`SsrHandler`、`ProductionHandler`、`init_ssr()`、`SsrCache` | 工厂模式（Router 不可 Clone） |
| `axum` | `AxumDispatcher`、`SsrHandler`、`ProductionHandler`、`init_ssr()`、`SsrCache` | Clone 模式（Router 基于 Arc） |
| `actix` | 计划中 | — |

## Feature flags

```toml
slate = { version = "0.1" }            # 仅核心（engine + traits）
slate = { version = "0.1", features = ["salvo"] }  # + Salvo 集成
slate = { version = "0.1", features = ["axum"] }   # + Axum 集成
```

## 测试状态

> **注意：** 目前仅在 **SvelteKit + Salvo** 组合上经过生产验证。其他组合（SvelteKit + Axum、Vue + Salvo、React + Axum 等）尚未实际测试，适配器和集成已实现但可能需要微调。

## 性能

QuickJS 上下文在启动时**只初始化一次**（eval bundle、注入 polyfill）。每次 `render()` 调用只在持久上下文上执行 `__render()` —— 无线程创建、无重复编译。

```
启动：  eval bundle ~10-50ms（一次性）
请求：  __render()  ~1-10ms （每次请求）
```

静态资源从嵌入内存中提供，content-hashed 路径自动附加 `immutable` 缓存头。

## License

MIT
