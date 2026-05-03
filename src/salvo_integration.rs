//! Salvo integration — SalvoDispatcher, SsrHandler, ProductionHandler, init_ssr().
//!
//! This module is only compiled when the `salvo` feature is enabled.

use std::future::Future;
use std::marker::PhantomData;
use std::sync::Arc;

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
use crate::handler_common::{self, SsrHandlerCore};
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

    let hdrs: std::collections::HashMap<String, String> =
      res.headers.iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();

    let body = read_res_body(res.body).await;

    tracing::debug!("SSR internal dispatch result: {status} ({} bytes)", body.len());

    DispatchResult { status, headers: hdrs, body }
  }
}

/// Read body text from a Salvo ResBody.
async fn read_res_body(body: ResBody) -> String {
  match body {
    ResBody::Once(bytes) => String::from_utf8(bytes.to_vec()).unwrap_or_default(),
    ResBody::Chunks(chunks) => {
      let bytes: Vec<u8> = chunks.into_iter().flat_map(|c| c.to_vec()).collect();
      String::from_utf8(bytes).unwrap_or_default()
    }
    other => match other.collect().await {
      Ok(collected) => String::from_utf8(collected.to_bytes().to_vec()).unwrap_or_default(),
      Err(_) => String::new(),
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
  core: SsrHandlerCore<SalvoDispatcher>,
}

impl SsrHandler {
  /// Create a new SsrHandler wrapping the given engine.
  pub fn new(engine: Arc<crate::engine::SsrEngine<SalvoDispatcher, ReqwestFetcher>>) -> Self {
    Self { core: SsrHandlerCore::new(engine) }
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
        apply_ssr_response(res, SsrResponse { status: cached.status, headers: cached.headers, body: cached.body });
        let _ = res.headers.insert(http::header::HeaderName::from_static("x-ssr-cache"), http::header::HeaderValue::from_static("HIT"));
      }
      RenderOutcome::Rendered(ssr_res) => {
        apply_ssr_response(res, ssr_res);
        let _ = res.headers.insert(http::header::HeaderName::from_static("x-ssr-cache"), http::header::HeaderValue::from_static("MISS"));
      }
      RenderOutcome::Error => {
        res.status_code = Some(StatusCode::INTERNAL_SERVER_ERROR);
        let _ = res.headers.insert(http::header::CONTENT_TYPE, http::header::HeaderValue::from_static("text/html; charset=utf-8"));
        res.body = ResBody::Once(handler_common::ERROR_PAGE_500.into());
      }
    }
  }
}

/// Apply an SsrResponse to a Salvo Response.
fn apply_ssr_response(res: &mut Response, ssr_res: SsrResponse) {
  res.status_code = Some(StatusCode::from_u16(ssr_res.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
  for (key, value) in &ssr_res.headers {
    if let (Ok(name), Ok(val)) = (key.parse::<http::header::HeaderName>(), value.parse::<http::header::HeaderValue>()) {
      res.headers.insert(name, val);
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
  req
    .payload()
    .await
    .ok()
    .filter(|bytes| bytes.len() <= handler_common::MAX_BODY_SIZE)
    .map(|bytes| String::from_utf8(bytes.to_vec()).unwrap_or_default())
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

    if let Some(asset) = handler_common::lookup_static_asset::<T>(path) {
      if let Ok(val) = asset.mime.parse() {
        let _ = res.headers.insert(salvo::http::header::CONTENT_TYPE, val);
      }

      if asset.immutable {
        let _ = res.headers.insert(salvo::http::header::CACHE_CONTROL, "public, max-age=31536000, immutable".parse().unwrap());
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
  let dispatch_router = router_factory().await;
  let dispatch_service = Arc::new(Service::new(dispatch_router));

  let engine = crate::engine::SsrEngine::new::<T>(SalvoDispatcher::new(dispatch_service), ReqwestFetcher::new()).await?;
  let handler = engine.handler();

  let main_router = router_factory().await.push(Router::with_path("<**rest>").goal(ProductionHandler::<T>::new(handler)));

  Ok(main_router)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Salvo convenience methods on SsrEngine
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

impl crate::engine::SsrEngine<SalvoDispatcher, ReqwestFetcher> {
  /// Create engine with Salvo dispatcher and reqwest fetcher.
  pub async fn with_salvo<T: RustEmbed>(service: Arc<Service>) -> anyhow::Result<Self> {
    Self::new::<T>(SalvoDispatcher::new(service), ReqwestFetcher::new()).await
  }

  /// Create a Salvo-compatible Handler for this engine.
  pub fn handler(self) -> SsrHandler {
    SsrHandler::new(Arc::new(self))
  }
}
