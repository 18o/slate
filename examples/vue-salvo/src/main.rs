//! Vue + Salvo example.
//!
//! ```sh
//! cd frontend && npm install && npm run build
//! cargo run
//! ```

use rust_embed::RustEmbed;
use salvo::prelude::*;

#[derive(RustEmbed)]
#[folder = "frontend/build/"]
struct FrontendAssets;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::fmt::init();

  let router = slate::salvo::init_ssr::<FrontendAssets, _, _>(|| async {
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
    "message": "Hello from Vue + Salvo + Slate SSR!"
  })));
}

#[handler]
async fn api_time(res: &mut Response) {
  res.render(Json(serde_json::json!({
    "time": "2026-05-04T00:00:00Z",
  })));
}
