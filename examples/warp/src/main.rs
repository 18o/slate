//! Warp + Slate SSR example.
//!
//! Works with any frontend build. Default: SvelteKit.
//!
//! ```sh
//! cd ../sveltekit && npm install && npm run build   # or ../vue, ../react
//! cd ../warp && cargo run
//! ```

use rust_embed::RustEmbed;
use warp::Filter;
use warp::reply::Reply;
use slate::handler_common::SsrConfig;

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

  // API routes — must return Response via .into_response()
  let hello = warp::path("api")
    .and(warp::path("hello"))
    .map(|| {
      warp::reply::json(&serde_json::json!({
        "message": "Hello from Slate SSR!"
      })).into_response()
    });

  let time = warp::path("api")
    .and(warp::path("time"))
    .map(|| {
      warp::reply::json(&serde_json::json!({
        "time": "2026-05-04T00:00:00Z"
      })).into_response()
    });

  let api = hello.or(time).unify().boxed();

  let routes = slate::warp::init_ssr::<FrontendAssets, _>(api, &SsrConfig::default()).await?;

  warp::serve(routes).run(([0, 0, 0, 0], 3000)).await;

  Ok(())
}
