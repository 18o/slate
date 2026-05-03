//! SvelteKit + Axum example.
//!
//! ```sh
//! cd frontend && npm install && npm run build
//! cargo run
//! ```

use axum::{routing::get, Json};
use rust_embed::RustEmbed;
use serde_json::{json, Value};

#[derive(RustEmbed)]
#[folder = "frontend/build/"]
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
  Json(json!({ "message": "Hello from SvelteKit + Axum + Slate SSR!" }))
}

async fn api_time() -> Json<Value> {
  Json(json!({ "time": "2026-05-04T00:00:00Z" }))
}
