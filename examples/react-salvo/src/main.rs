//! React + Salvo example.
//!
//! Demonstrates a minimal production deployment using Slate's SSR engine
//! with React frontend and Salvo web framework.
//!
//! # Running
//!
//! ```sh
//! # 1. Build the frontend
//! cd frontend && npm install && npm run build:ssr
//!
//! # 2. Run the server
//! cargo run
//!
//! # 3. Visit http://localhost:3000
//! ```

use rust_embed::RustEmbed;
use salvo::prelude::*;
use slate;

/// Embedded frontend assets from React SSR build output.
///
/// The `@slate/adapter-react` adapter produces:
/// - `client/` — static assets (JS, CSS, images)
/// - `entry.js` — IIFE bundle with `__render()` for SSR
#[derive(RustEmbed)]
#[folder = "frontend/build/"]
struct FrontendAssets;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::fmt::init();

  let router = slate::init_ssr::<FrontendAssets, _, _>(|| async {
    Router::new()
      .push(Router::with_path("/api/hello").get(api_hello))
      .push(Router::with_path("/api/time").get(api_time))
  })
  .await?;

  let listener = TcpListener::new(&"0.0.0.0:3000").bind().await;
  Server::new(listener).serve(router).await;

  Ok(())
}

#[handler]
async fn api_hello(res: &mut Response) {
  res.render(Json(serde_json::json!({
    "message": "Hello from React + Salvo + Slate SSR!"
  })));
}

#[handler]
async fn api_time(res: &mut Response) {
  res.render(Json(serde_json::json!({
    "time": "2026-05-03T00:00:00Z",
  })));
}
