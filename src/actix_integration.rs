//! Actix Web integration — ActixDispatcher, SsrHandler, ssr_handler(), init_ssr().
//!
//! This module is only compiled when the `actix` feature is enabled.
//!
//! # Send safety
//!
//! Actix uses `Rc<>` internally, making its service types `!Send`. Because
//! `InternalDispatcher::dispatch` requires `Send`, the Actix dispatcher
//! spawns a short-lived OS thread per dispatch call to run the Actix service
//! on the same thread where it was created. This is acceptable because SSR
//! dispatch is the slow path — the thread overhead is negligible compared
//! to JS render time.

use std::sync::Arc;

use actix_web::http::{Method, StatusCode};
use actix_web::{HttpRequest, HttpResponse, web};
use rust_embed::RustEmbed;

use crate::engine::{SsrEngine, SsrRequest};
use crate::handler_common::{IncomingRequest, RenderOutcome, SsrConfig, SsrHandlerCore};
use crate::shared::ReqwestFetcher;
use crate::static_files::{self, StaticAsset};
use crate::traits::{DispatchResult, InternalDispatcher};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ActixDispatcher: internal routing (zero HTTP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Dispatches relative-path fetches through Actix's internal router.
pub struct ActixDispatcher {
  api_config: Arc<dyn Fn(&mut web::ServiceConfig) + Send + Sync>,
}

impl ActixDispatcher {
  pub fn new(api_config: Arc<dyn Fn(&mut web::ServiceConfig) + Send + Sync>) -> Self {
    Self { api_config }
  }
}

impl InternalDispatcher for ActixDispatcher {
  async fn dispatch(&self, method: &str, path: &str, body: Option<&[u8]>, headers: &[(String, String)]) -> DispatchResult {
    let api_config = self.api_config.clone();
    let method = method.to_string();
    let path = path.to_string();
    let body = body.map(|b| b.to_vec());
    let headers = headers.to_vec();

    tracing::debug!("SSR internal dispatch (actix): {method} {path}");

    let (tx, rx) = tokio::sync::oneshot::channel();

    // Actix types are !Send — run entirely on a dedicated thread
    std::thread::spawn(move || {
      let rt = actix_web::rt::System::new();
      rt.block_on(async move {
        let result = dispatch_sync(&api_config, &method, &path, body.as_deref(), &headers).await;
        let _ = tx.send(result);
      });
    });

    rx.await.unwrap_or_else(|_| DispatchResult::error(500, "actix dispatch thread panicked"))
  }
}

/// Run Actix dispatch on the current thread (called from the spawned thread).
async fn dispatch_sync(
  api_config: &Arc<dyn Fn(&mut web::ServiceConfig) + Send + Sync>,
  method: &str,
  path: &str,
  body: Option<&[u8]>,
  headers: &[(String, String)],
) -> DispatchResult {
  let app = actix_web::App::new().configure(|cfg| {
    api_config(cfg);
  });

  let http_method = method.parse::<Method>().unwrap_or(Method::GET);
  let mut test_req = actix_web::test::TestRequest::with_uri(path).method(http_method);

  for (k, v) in headers {
    if let (Ok(name), Ok(val)) =
      (actix_web::http::header::HeaderName::from_bytes(k.as_bytes()), actix_web::http::header::HeaderValue::from_bytes(v.as_bytes()))
    {
      test_req = test_req.insert_header((name, val));
    }
  }

  if let Some(b) = body {
    test_req = test_req.set_payload(b.to_vec());
  }

  let actix_req = test_req.to_request();
  let svc = actix_web::test::init_service(app).await;
  let resp = actix_web::test::call_service(&svc, actix_req).await;

  let status = resp.status().as_u16();

  let hdrs: Vec<(String, String)> = resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();

  let body_bytes = actix_web::body::to_bytes(resp.into_body()).await.unwrap_or_default();

  DispatchResult { status, headers: hdrs, body: body_bytes.to_vec() }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SsrHandler: shared SSR state (parallels Salvo/Axum SsrHandler)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Actix SSR handler — holds the engine and cache.
///
/// Stored in `web::Data<SsrHandler>` and consumed by the
/// [`ssr_handler`] function. `Clone` is cheap (Arcs).
///
/// # Example
///
/// ```ignore
/// let handler = slate::actix::init_ssr::<Assets>(api_config).await?;
/// HttpServer::new(move || {
///     App::new()
///         .app_data(web::Data::new(handler.clone()))
///         .configure(api_routes)
///         .default_service(web::to(slate::actix::ssr_handler::<Assets>))
/// })
/// ```
pub struct SsrHandler {
  core: SsrHandlerCore<ActixDispatcher, ReqwestFetcher>,
}

impl Clone for SsrHandler {
  fn clone(&self) -> Self {
    Self { core: SsrHandlerCore::new(self.core.engine().clone(), &SsrConfig::default()) }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ssr_handler: Actix handler function
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Actix handler: serves static files from RustEmbed, falls through to SSR.
///
/// Register as the default service:
/// ```ignore
/// .default_service(web::to(slate::actix::ssr_handler::<Assets>))
/// ```
pub async fn ssr_handler<T: RustEmbed + 'static>(req: HttpRequest, body: web::Bytes, state: web::Data<SsrHandler>) -> HttpResponse {
  let path = req.path().to_string();

  // 1. Try static assets
  let accepts_br =
    req.headers().get(actix_web::http::header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).map(|s| s.contains("br")).unwrap_or(false);

  if let Some(asset) = static_files::lookup_static_asset::<T>(&path, accepts_br) {
    return build_asset_response(asset);
  }

  // 2. SSR via SsrHandlerCore (shared with Salvo/Axum)
  let incoming = IncomingRequest { path, has_query: req.uri().query().is_some(), ssr_request: extract_request(req, body).await };

  match state.core.handle(incoming).await {
    RenderOutcome::CacheHit(cached) => build_ssr_response(cached.status, &cached.headers, &cached.body, "HIT"),
    RenderOutcome::Rendered(ssr_res) => build_ssr_response(ssr_res.status, &ssr_res.headers, &ssr_res.body, "MISS"),
    RenderOutcome::Error => {
      HttpResponse::InternalServerError().insert_header(("content-type", "text/html; charset=utf-8")).body(state.core.error_html())
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Response builders
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

fn build_asset_response(asset: StaticAsset) -> HttpResponse {
  let mut builder = HttpResponse::Ok();
  add_header(&mut builder, "content-type", &asset.mime);
  if let Some(ref enc) = asset.content_encoding {
    add_header(&mut builder, "content-encoding", enc);
  }
  add_header(&mut builder, "vary", "Accept-Encoding");
  if asset.immutable {
    add_header(&mut builder, "cache-control", "public, max-age=31536000, immutable");
  }
  builder.body(asset.data)
}

fn build_ssr_response(status: u16, headers: &[(String, String)], body_str: &str, cache_value: &str) -> HttpResponse {
  let sc = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
  let mut builder = HttpResponse::build(sc);
  for (k, v) in headers {
    if k.eq_ignore_ascii_case("content-length") {
      continue;
    }
    add_header(&mut builder, k, v);
  }
  add_header(&mut builder, "x-ssr-cache", cache_value);
  builder.body(body_str.to_string())
}

fn add_header(builder: &mut actix_web::HttpResponseBuilder, name: &str, value: &str) {
  if let (Ok(n), Ok(v)) =
    (actix_web::http::header::HeaderName::from_bytes(name.as_bytes()), actix_web::http::header::HeaderValue::from_bytes(value.as_bytes()))
  {
    builder.insert_header((n, v));
  }
}

async fn extract_request(req: HttpRequest, body: web::Bytes) -> SsrRequest {
  let method = req.method().as_str().to_string();
  let url = req.uri().to_string();
  let headers: std::collections::HashMap<String, String> =
    req.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|val| (k.to_string(), val.to_string()))).collect();
  let remote_addr = req.peer_addr().map(|a| a.to_string()).unwrap_or_else(|| "127.0.0.1".to_string());
  let body = if body.is_empty() { None } else { String::from_utf8(body.to_vec()).ok() };

  SsrRequest { method, url, headers, body, remote_addr }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// init_ssr
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Create the SSR engine. Returns an [`SsrHandler`] for `web::Data`.
///
/// ```ignore
/// let handler = slate::actix::init_ssr::<Assets, _>(
///     |cfg: &mut web::ServiceConfig| {
///         cfg.service(web::resource("/api/hello").to(hello));
///     }
/// ).await?;
///
/// HttpServer::new(move || {
///     App::new()
///         .app_data(web::Data::new(handler.clone()))
///         .configure(api_routes)
///         .default_service(web::to(slate::actix::ssr_handler::<Assets>))
/// })
/// .bind("0.0.0.0:3000")?
/// .run()
/// .await
/// ```
pub async fn init_ssr<T, F>(api_config: F) -> anyhow::Result<SsrHandler>
where
  T: RustEmbed + Send + Sync + 'static,
  F: Fn(&mut web::ServiceConfig) + Clone + Send + Sync + 'static,
{
  init_ssr_with_config::<T, F>(api_config, SsrConfig::default()).await
}

/// Create the SSR engine with custom [`SsrConfig`]. Returns an [`SsrHandler`] for `web::Data`.
pub async fn init_ssr_with_config<T, F>(api_config: F, config: SsrConfig) -> anyhow::Result<SsrHandler>
where
  T: RustEmbed + Send + Sync + 'static,
  F: Fn(&mut web::ServiceConfig) + Clone + Send + Sync + 'static,
{
  let render_timeout = config.render_timeout;
  let dispatcher = ActixDispatcher::new(Arc::new(api_config));
  let engine = SsrEngine::new::<T>(dispatcher, ReqwestFetcher::new()?, render_timeout).await?;

  Ok(SsrHandler { core: SsrHandlerCore::new(Arc::new(engine), &config) })
}
