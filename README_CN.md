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

## 定位：SEO 用 SSR，不是 Node.js 替代品

Slate 为**搜索引擎和首屏加载**渲染前端页面。**不是**通用的 Node.js 运行时。

### ✅ 适用场景

| 场景 | 原因 |
|------|------|
| **SPA 的 SEO** | Google/Bing 能看到完整渲染的 HTML，而不是空的 `<div id="app">` |
| **首屏加速** | 用户立刻获得完整页面，随后 SvelteKit 进行 hydration |
| **单二进制部署** | 无需安装 Node.js / bun，不用管理单独的 SSR 进程 |
| **前后端同进程** | SSR 中的 API 调用是进程内零 HTTP —— 无网络往返 |

### ❌ 不适用场景

| 场景 | 原因 |
|------|------|
| **重度依赖 Node.js 能力** | Slate 运行在 QuickJS 上 —— 没有 `Buffer`、`stream`、`child_process`、`fs`、C++ 原生模块 |
| **服务端业务逻辑** | 业务逻辑应该放在 Rust handler 里。前端只负责**渲染 HTML，不应做业务计算** |
| **WebSocket / SSE / 流式响应** | SSR 是一次性 `request → HTML`。实时功能应该放在客户端 |
| **极高 QPS (>1000 RPS)** | QuickJS 是解释器而非 JIT。超高吞吐请用构建时预渲染或加 CDN |

### 架构哲学

```
┌─ 前端 (SvelteKit/Vue/React) ──┐      ┌─ 后端 (Rust) ────────────┐
│  load() {                       │      │  async fn api_handler() { │
│    // 仅做轻量数据获取          │      │    // 全部业务逻辑       │
│    const data = await fetch(    │      │    // 数据库查询         │
│      '/api/users'               │      │    // 认证/权限          │
│    );                           │      │    // 数据转换           │
│    return { data };  // → 渲染  │      │    // 重计算             │
│  }                              │      │  }                      │
│  // hydration 之后:             │      └─────────────────────────┘
│  //   客户端交互                │               ▲
│  //   实时通信 (WebSocket/SSE)  │               │ 进程内零 HTTP
│  //   动画、过渡                │               │
└────────────────────────────────┘               │
         ▲                                       │
         │  SSR: 为 SEO + 首屏提供 HTML          │
         └───────────────────────────────────────┘
```

> **核心原则**：如果你发现自己在前端 `load()` 或服务端路由里写复杂数据处理，把它移到 Rust。前端只管展示。Slate 在同一个进程里桥接两者。

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
