//! Salvo + Slate SSR example.
//!
//! Works with any frontend build. Default: SvelteKit.
//!
//! ```sh
//! cd ../sveltekit && npm install && npm run build   # or ../vue, ../react
//! cd ../salvo && cargo run
//! ```

use rust_embed::RustEmbed;
use salvo::prelude::*;

// ── Frontend selection ──────────────────────────────────────────
// Change this path to switch frontends:
//   SvelteKit  →  #[folder = "../sveltekit/build/"]
//   Vue        →  #[folder = "../vue/build/"]
//   React      →  #[folder = "../react/build/"]
// The Rust server code below is the same for all frameworks.
#[derive(RustEmbed)]
#[folder = "../sveltekit/build/"]
struct FrontendAssets;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::fmt::init();

  let router = slate::salvo::init_ssr::<FrontendAssets, _, _>(|| async {
    Router::new().push(Router::with_path("/api/hello").get(api_hello)).push(Router::with_path("/api/time").get(api_time))
  })
  .await?;

  let listener = TcpListener::new(&"0.0.0.0:3000").bind().await;
  Server::new(listener).serve(router).await;

  Ok(())
}

#[handler]
async fn api_hello(res: &mut Response) {
  res.render(Json(serde_json::json!({
    "message": "Hello from Slate SSR!"
  })));
}

#[handler]
async fn api_time(res: &mut Response) {
  let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
  res.render(Json(serde_json::json!({
    "time": format!("2026-05-04T00:00:00Z"),
    "unix": now,
  })));
}
