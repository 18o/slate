//! Axum + Slate SSR example.
//!
//! Works with any frontend build. Default: SvelteKit.
//!
//! ```sh
//! cd ../sveltekit && npm install && npm run build   # or ../vue, ../react
//! cd ../axum && cargo run
//! ```

use axum::{routing::get, Json};
use rust_embed::RustEmbed;
use serde_json::{json, Value};

// ── Frontend selection ──────────────────────────────────────────
// Change this path to switch frontends:
//   SvelteKit  →  #[folder = "../sveltekit/build/"]
//   Vue        →  #[folder = "../vue/build/"]
//   React      →  #[folder = "../react/build/"]
#[derive(RustEmbed)]
#[folder = "../sveltekit/build/"]
struct FrontendAssets;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::fmt::init();

  let api_router = axum::Router::new()
    .route("/api/hello", get(api_hello))
    .route("/api/time", get(api_time));

  let app = slate::axum::init_ssr::<FrontendAssets>(api_router).await?;

  let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
  axum::serve(listener, app).await?;

  Ok(())
}

async fn api_hello() -> Json<Value> {
  Json(json!({ "message": "Hello from Slate SSR!" }))
}

async fn api_time() -> Json<Value> {
  Json(json!({ "time": "2026-05-04T00:00:00Z" }))
}
