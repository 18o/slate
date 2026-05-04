//! SvelteKit + Actix example.
//!
//! ```sh
//! cd frontend && npm install && npm run build
//! cargo run
//! ```

use actix_web::{web, App, HttpServer, HttpResponse};
use rust_embed::RustEmbed;
use serde_json::json;

#[derive(RustEmbed)]
#[folder = "frontend/build/"]
struct FrontendAssets;

fn api_routes(cfg: &mut web::ServiceConfig) {
  cfg
    .service(web::resource("/api/hello").to(api_hello))
    .service(web::resource("/api/time").to(api_time));
}

#[actix_web::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::fmt::init();

  let handler = slate::actix::init_ssr::<FrontendAssets, _>(api_routes).await?;

  HttpServer::new(move || {
    App::new()
      .app_data(web::Data::new(handler.clone()))
      .configure(api_routes)
      .default_service(web::to(slate::actix::ssr_handler::<FrontendAssets>))
  })
  .bind("0.0.0.0:3000")?
  .run()
  .await?;

  Ok(())
}

async fn api_hello() -> HttpResponse {
  HttpResponse::Ok().json(json!({
    "message": "Hello from SvelteKit + Actix + Slate SSR!"
  }))
}

async fn api_time() -> HttpResponse {
  HttpResponse::Ok().json(json!({
    "time": "2026-05-04T00:00:00Z"
  }))
}
