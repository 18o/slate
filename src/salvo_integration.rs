//! Salvo integration — SalvoDispatcher, SsrHandler, ProductionHandler, init_ssr().
//!
//! This module is only compiled when the `salvo` feature is enabled.

use std::future::Future;
use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::BodyExt;
use rust_embed::RustEmbed;
use salvo::async_trait;
use salvo::conn::SocketAddr;
use salvo::handler::Handler as SalvoHandler;
use salvo::http::body::ResBody;
use salvo::http::{ReqBody, StatusCode};
use salvo::routing::Router;
use salvo::{Depot, FlowCtrl, Request, Response, Service};

use crate::engine::SsrResponse;
use crate::handler_common::{self, SsrConfig, SsrHandlerCore};
use crate::shared::ReqwestFetcher;
use crate::traits::{DispatchResult, InternalDispatcher};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// InternalDispatchMarker
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Marker type injected into `Request::extensions` so that middleware
/// can detect internal dispatch requests and skip certain processing.
#[derive(Debug, Clone, Copy)]
pub struct InternalDispatchMarker;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SalvoDispatcher: internal routing (zero HTTP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Dispatches relative-path fetches through Salvo's internal router.
pub struct SalvoDispatcher {
  service: Arc<Service>,
}

impl SalvoDispatcher {
  pub fn new(service: Arc<Service>) -> Self {
    Self { service }
  }
}

impl InternalDispatcher for SalvoDispatcher {
  async fn dispatch(&self, method: &str, path: &str, body: Option<&[u8]>, headers: &[(String, String)]) -> DispatchResult {
    tracing::debug!("SSR internal dispatch: {method} {path}");

    let mut req = Request::new();
    *req.method_mut() = method.parse().unwrap_or(http::Method::GET);
    req.set_uri(path.parse().unwrap_or_else(|_| http::Uri::from_static("/")));

    if let Some(body) = body {
      req.replace_body(ReqBody::Once(body.to_vec().into()));
    }

    for (key, value) in headers {
      if let Ok(header_name) = key.parse::<http::header::HeaderName>()
        && let Ok(header_value) = value.parse::<http::header::HeaderValue>()
      {
        req.headers_mut().insert(header_name, header_value);
      }
    }

    req.extensions_mut().insert(InternalDispatchMarker);

    let local_addr: SocketAddr = std::net::SocketAddr::from(([127, 0, 0, 1], 0)).into();
    let remote_addr: SocketAddr = std::net::SocketAddr::from(([127, 0, 0, 1], 0)).into();
    let handler = self.service.hyper_handler(local_addr, remote_addr, http::uri::Scheme::HTTP, None, None);
    let res = handler.handle(req).await;

    let status = res.status_code.unwrap_or(StatusCode::OK).as_u16();

    let hdrs: Vec<(String, String)> = res.headers.iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();

    let body = match read_res_body(res.body).await {
      Ok(b) => b,
      Err(err) => return err,
    };

    tracing::debug!("SSR internal dispatch result: {status} ({} bytes)", body.len());
    DispatchResult { status, headers: hdrs, body }
  }
}

/// Read body bytes from a Salvo ResBody.
///
/// Applies [`handler_common::MAX_BODY_SIZE`] limit to all variants.
/// Returns `Err(DispatchResult)` on overflow so callers can propagate the error.
async fn read_res_body(body: ResBody) -> Result<Vec<u8>, DispatchResult> {
  match body {
    ResBody::Once(bytes) => {
      if bytes.len() > handler_common::MAX_BODY_SIZE {
        tracing::warn!("SSR internal dispatch: body exceeds limit ({} bytes)", bytes.len());
        return Err(DispatchResult::error(502, "internal dispatch: response body exceeds size limit"));
      }
      Ok(bytes.to_vec())
    }
    ResBody::Chunks(chunks) => {
      let bytes: Vec<u8> = chunks.into_iter().flat_map(|c| c.to_vec()).collect();
      if bytes.len() > handler_common::MAX_BODY_SIZE {
        tracing::warn!("SSR internal dispatch: chunked body exceeds limit ({} bytes)", bytes.len());
        return Err(DispatchResult::error(502, "internal dispatch: response body exceeds size limit"));
      }
      Ok(bytes)
    }
    other => match other.collect().await {
      Ok(collected) => {
        let bytes = collected.to_bytes().to_vec();
        if bytes.len() > handler_common::MAX_BODY_SIZE {
          tracing::warn!("SSR internal dispatch: collected body exceeds limit ({} bytes)", bytes.len());
          return Err(DispatchResult::error(502, "internal dispatch: response body exceeds size limit"));
        }
        Ok(bytes)
      }
      Err(_) => Ok(Vec::new()),
    },
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SsrHandler: Salvo Handler for SSR rendering
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Salvo Handler that renders pages via QuickJS SSR.
///
/// Delegates caching and rendering logic to [`SsrHandlerCore`],
/// then converts the result into a Salvo `Response`.
pub struct SsrHandler {
  core: SsrHandlerCore<SalvoDispatcher, ReqwestFetcher>,
}

impl SsrHandler {
  /// Create a new SsrHandler wrapping the given engine.
  pub fn new(engine: Arc<crate::engine::SsrEngine<SalvoDispatcher, ReqwestFetcher>>, config: &SsrConfig) -> Self {
    Self { core: SsrHandlerCore::new(engine, config) }
  }
}

#[async_trait]
impl SalvoHandler for SsrHandler {
  async fn handle(&self, req: &mut Request, _depot: &mut Depot, res: &mut Response, _ctrl: &mut FlowCtrl) {
    use handler_common::RenderOutcome;

    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let has_query = req.uri().query().is_some();

    let headers = extract_salvo_headers(req);
    let body = extract_body(req).await;
    let remote_addr = req.remote_addr().to_string();
    let uri = format!("{}", req.uri());

    let incoming = handler_common::IncomingRequest {
      path,
      has_query,
      ssr_request: crate::engine::SsrRequest { method, url: uri, headers, body, remote_addr },
    };

    let outcome = self.core.handle(incoming).await;

    match outcome {
      RenderOutcome::CacheHit(cached) => {
        apply_ssr_response(
          res,
          SsrResponse { status: cached.status, headers: cached.headers.clone(), body: cached.body.clone(), fetched: false },
        );
        let _ = res.headers.insert(http::header::HeaderName::from_static("x-ssr-cache"), http::header::HeaderValue::from_static("HIT"));
      }
      RenderOutcome::Rendered(ssr_res) => {
        apply_ssr_response(res, ssr_res);
        let _ = res.headers.insert(http::header::HeaderName::from_static("x-ssr-cache"), http::header::HeaderValue::from_static("MISS"));
      }
      RenderOutcome::Error => {
        res.status_code = Some(StatusCode::INTERNAL_SERVER_ERROR);
        let _ = res.headers.insert(http::header::CONTENT_TYPE, http::header::HeaderValue::from_static("text/html; charset=utf-8"));
        res.body = ResBody::Once(self.core.error_html().into());
      }
    }
  }
}

/// Apply an SsrResponse to a Salvo Response.
fn apply_ssr_response(res: &mut Response, ssr_res: SsrResponse) {
  res.status_code = Some(StatusCode::from_u16(ssr_res.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
  for (key, value) in &ssr_res.headers {
    // Skip content-length — Salvo/hyper computes it from the actual body.
    // SvelteKit SSR may report a different length than what QuickJS returns.
    if key.eq_ignore_ascii_case("content-length") {
      continue;
    }
    if let (Ok(name), Ok(val)) = (key.parse::<http::header::HeaderName>(), value.parse::<http::header::HeaderValue>()) {
      res.headers.append(name, val);
    }
  }
  res.body = ResBody::Once(ssr_res.body.into_bytes().into());
}

fn extract_salvo_headers(req: &Request) -> std::collections::HashMap<String, String> {
  let mut headers = std::collections::HashMap::new();
  for (key, value) in req.headers() {
    if let Ok(val) = value.to_str() {
      headers.insert(key.to_string(), val.to_string());
    }
  }
  headers
}

async fn extract_body(req: &mut Request) -> Option<String> {
  req.payload().await.ok().filter(|bytes| bytes.len() <= handler_common::MAX_BODY_SIZE).and_then(|bytes| {
    match String::from_utf8(bytes.to_vec()) {
      Ok(s) => Some(s),
      Err(e) => {
        tracing::debug!("SSR: non-UTF-8 request body, ignoring: {e}");
        None
      }
    }
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProductionHandler: static files + SSR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Combined handler for production mode: serves static files from embedded
/// assets, then falls through to QuickJS SSR rendering.
pub struct ProductionHandler<T: RustEmbed> {
  ssr: SsrHandler,
  _assets: PhantomData<T>,
}

impl<T: RustEmbed> ProductionHandler<T> {
  pub fn new(ssr: SsrHandler) -> Self {
    Self { ssr, _assets: PhantomData }
  }
}

#[async_trait]
impl<T: RustEmbed + Send + Sync + 'static> SalvoHandler for ProductionHandler<T> {
  async fn handle(&self, req: &mut Request, depot: &mut Depot, res: &mut Response, ctrl: &mut FlowCtrl) {
    let path = req.uri().path();

    // Check if client accepts brotli-compressed responses
    let accepts_br =
      req.headers().get(salvo::http::header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).map(|s| s.contains("br")).unwrap_or(false);

    if let Some(asset) = crate::static_files::lookup_static_asset::<T>(path, accepts_br) {
      if let Ok(val) = asset.mime.parse() {
        let _ = res.headers.insert(salvo::http::header::CONTENT_TYPE, val);
      }

      if let Some(ref encoding) = asset.content_encoding
        && let Ok(val) = encoding.as_str().parse()
      {
        let _ = res.headers.insert(salvo::http::header::CONTENT_ENCODING, val);
      }

      let _ = res.headers.insert(salvo::http::header::VARY, "Accept-Encoding".parse().unwrap());

      if asset.immutable {
        let _ = res.headers.insert(
          salvo::http::header::CACHE_CONTROL,
          "public, max-age=31536000, immutable".parse().unwrap_or_else(|_| http::header::HeaderValue::from_static("public")),
        );
      }

      res.body = ResBody::Once(asset.data.into());
      return;
    }

    self.ssr.handle(req, depot, res, ctrl).await;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// init_ssr: one-call router setup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Build a production-ready router with SSR in a single call.
pub async fn init_ssr<T, F, Fut>(router_factory: F) -> anyhow::Result<Router>
where
  T: RustEmbed + Send + Sync + 'static,
  F: Fn() -> Fut,
  Fut: Future<Output = Router>,
{
  init_ssr_with_config::<T, F, Fut>(router_factory, SsrConfig::default()).await
}

/// Build a production-ready router with SSR in a single call,
/// using a custom [`SsrConfig`].
pub async fn init_ssr_with_config<T, F, Fut>(router_factory: F, config: SsrConfig) -> anyhow::Result<Router>
where
  T: RustEmbed + Send + Sync + 'static,
  F: Fn() -> Fut,
  Fut: Future<Output = Router>,
{
  let render_timeout = config.render_timeout;
  let dispatch_router = router_factory().await;
  let dispatch_service = Arc::new(Service::new(dispatch_router));

  let engine = crate::engine::SsrEngine::new::<T>(SalvoDispatcher::new(dispatch_service), ReqwestFetcher::new()?, render_timeout).await?;
  let handler = engine.handler(&config);

  let main_router = router_factory().await.push(Router::with_path("{*rest}").goal(ProductionHandler::<T>::new(handler)));

  Ok(main_router)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Salvo convenience methods on SsrEngine
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

impl crate::engine::SsrEngine<SalvoDispatcher, ReqwestFetcher> {
  /// Create engine with Salvo dispatcher and reqwest fetcher.
  pub async fn with_salvo<T: RustEmbed>(service: Arc<Service>) -> anyhow::Result<Self> {
    Self::new::<T>(SalvoDispatcher::new(service), ReqwestFetcher::new()?, Duration::from_secs(30)).await
  }

  /// Create a Salvo-compatible Handler for this engine.
  pub fn handler(self, config: &SsrConfig) -> SsrHandler {
    SsrHandler::new(Arc::new(self), config)
  }
}
