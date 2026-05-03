//! SvelteKit + Axum example.
//!
//! Demonstrates a minimal production deployment using Slate's SSR engine
//! with SvelteKit frontend and Axum web framework.
//!
//! # Key difference from Salvo
//!
//! Axum's Router is `Clone` (Arc-based), so we don't need the "build routes
//! twice" factory pattern. Just pass the router to `init_ssr()` and it clones
//! internally for the dispatch service.
//!
//! # Running
//!
//! ```sh
//! # 1. Build the frontend
//! cd frontend && npm install && npm run build
//!
//! # 2. Run the server
//! cargo run
//!
//! # 3. Visit http://localhost:3000
//! ```

use axum::{routing::get, Json};
use rust_embed::RustEmbed;
use serde_json::{json, Value};

/// Embedded frontend assets from SvelteKit build output.
#[derive(RustEmbed)]
#[folder = "frontend/build/"]
struct FrontendAssets;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::fmt::init();

  // Build API routes
  let api_router = axum::Router::new()
    .route("/api/hello", get(api_hello))
    .route("/api/time", get(api_time));

  // Production: wrap with SSR + static file serving
  let app = slate::axum::init_ssr::<FrontendAssets>(api_router).await?;

  let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
  axum::serve(listener, app).await?;

  Ok(())
}

/// Simple JSON API endpoint.
async fn api_hello() -> Json<Value> {
  Json(json!({
    "message": "Hello from Axum + Slate SSR!"
  }))
}

/// Returns current server time — useful for testing SSR data fetching.
async fn api_time() -> Json<Value> {
  Json(json!({
    "time": "2026-05-03T00:00:00Z",
    "unix": 1746230400,
  }))
}
