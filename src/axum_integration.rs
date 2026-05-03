//! Axum integration — AxumDispatcher, SsrHandler, ProductionHandler, init_ssr().
//!
//! This module is only compiled when the `axum` feature is enabled.
//!
//! # Key difference from Salvo
//!
//! Axum's `Router` is `Clone` (Arc-based), so we don't need the
//! "build routes twice" factory pattern.

use std::collections::HashMap;
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::extract::Request as AxumRequest;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response as AxumResponse;
use axum::routing::Router;
use rust_embed::RustEmbed;
use tower::Service;
use tower::ServiceExt;

use crate::engine::SsrResponse;
use crate::handler_common::{self, SsrHandlerCore};
use crate::shared::ReqwestFetcher;
use crate::traits::{DispatchResult, InternalDispatcher};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AxumDispatcher: internal routing (zero HTTP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Dispatches relative-path fetches through Axum's internal router.
pub struct AxumDispatcher {
  router: Router,
}

impl AxumDispatcher {
  pub fn new(router: Router) -> Self {
    Self { router }
  }
}

impl InternalDispatcher for AxumDispatcher {
  async fn dispatch(&self, method: &str, path: &str, body: Option<&[u8]>, headers: &[(String, String)]) -> DispatchResult {
    tracing::debug!("SSR internal dispatch: {method} {path}");

    let http_method: Method = method.parse().unwrap_or(Method::GET);
    let uri: Uri = path.parse().unwrap_or_else(|_| Uri::from_static("/"));

    let mut builder = axum::http::request::Builder::new().method(http_method).uri(uri);

    for (key, value) in headers {
      if let (Ok(name), Ok(val)) = (key.parse::<HeaderName>(), value.parse::<HeaderValue>()) {
        builder.headers_mut().unwrap().insert(name, val);
      }
    }

    let axum_body = body.map(|b| Body::from(b.to_vec())).unwrap_or(Body::empty());

    let request =
      builder.body(axum_body).unwrap_or_else(|_| AxumRequest::builder().method(Method::GET).uri("/").body(Body::empty()).unwrap());

    let mut router = self.router.clone();
    let response = match router.as_service().ready().await {
      Ok(svc) => match svc.call(request).await {
        Ok(res) => res,
        Err(e) => {
          tracing::error!("SSR internal dispatch error: {e}");
          return DispatchResult { status: 500, headers: HashMap::new(), body: r#"{"error":"internal dispatch failed"}"#.to_string() };
        }
      },
      Err(e) => {
        tracing::error!("SSR internal dispatch ready error: {e}");
        return DispatchResult { status: 500, headers: HashMap::new(), body: r#"{"error":"service not ready"}"#.to_string() };
      }
    };

    let status = response.status().as_u16();

    let hdrs: HashMap<String, String> =
      response.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();

    let body_bytes = to_bytes(response.into_body(), handler_common::MAX_BODY_SIZE).await.unwrap_or_else(|e| {
      tracing::error!("SSR dispatch body read error: {e}");
      bytes::Bytes::new()
    });
    let body = String::from_utf8(body_bytes.to_vec()).unwrap_or_default();

    tracing::debug!("SSR internal dispatch result: {status} ({} bytes)", body.len());

    DispatchResult { status, headers: hdrs, body }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SsrHandler: Axum handler for SSR rendering
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Axum handler that renders pages via QuickJS SSR.
///
/// Delegates caching and rendering logic to [`SsrHandlerCore`],
/// then converts the result into an Axum `Response`.
pub struct SsrHandler {
  core: SsrHandlerCore<AxumDispatcher>,
}

impl SsrHandler {
  /// Create a new SsrHandler wrapping the given engine.
  pub fn new(engine: Arc<crate::engine::SsrEngine<AxumDispatcher, ReqwestFetcher>>) -> Self {
    Self { core: SsrHandlerCore::new(engine) }
  }
}

impl Clone for SsrHandler {
  fn clone(&self) -> Self {
    Self { core: SsrHandlerCore::new_from_parts(self.core.engine().clone(), self.core.cache().clone()) }
  }
}

impl axum::handler::Handler<(), ()> for SsrHandler {
  type Future = Pin<Box<dyn Future<Output = AxumResponse> + Send + 'static>>;

  fn call(self, req: AxumRequest, _state: ()) -> Self::Future {
    Box::pin(async move {
      use handler_common::RenderOutcome;

      let method = req.method().clone();
      let uri = req.uri().clone();
      let path = uri.path().to_string();
      let has_query = uri.query().is_some();

      let headers = extract_axum_headers(&req);
      let remote_addr =
        req.extensions().get::<std::net::SocketAddr>().map(|addr| addr.to_string()).unwrap_or_else(|| "127.0.0.1".to_string());
      let body = extract_body(req).await;

      let incoming = handler_common::IncomingRequest {
        path,
        has_query,
        ssr_request: crate::engine::SsrRequest { method: method.to_string(), url: format!("{uri}"), headers, body, remote_addr },
      };

      let outcome = self.core.handle(incoming).await;

      match outcome {
        RenderOutcome::CacheHit(cached) => {
          let mut response = AxumResponse::builder().status(cached.status).body(Body::from(cached.body)).unwrap();
          for (k, v) in &cached.headers {
            if let (Ok(name), Ok(val)) = (k.parse::<HeaderName>(), v.parse::<HeaderValue>()) {
              response.headers_mut().insert(name, val);
            }
          }
          response.headers_mut().insert(HeaderName::from_static("x-ssr-cache"), HeaderValue::from_static("HIT"));
          response
        }
        RenderOutcome::Rendered(ssr_res) => {
          let mut response = build_axum_response(ssr_res);
          response.headers_mut().insert(HeaderName::from_static("x-ssr-cache"), HeaderValue::from_static("MISS"));
          response
        }
        RenderOutcome::Error => AxumResponse::builder()
          .status(StatusCode::INTERNAL_SERVER_ERROR)
          .header("content-type", "text/html; charset=utf-8")
          .body(Body::from(handler_common::ERROR_PAGE_500))
          .unwrap(),
      }
    })
  }
}

fn extract_axum_headers(req: &AxumRequest) -> HashMap<String, String> {
  req.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|val| (k.to_string(), val.to_string()))).collect()
}

async fn extract_body(req: AxumRequest) -> Option<String> {
  let bytes = to_bytes(req.into_body(), handler_common::MAX_BODY_SIZE).await.ok()?;
  Some(String::from_utf8(bytes.to_vec()).unwrap_or_default())
}

fn build_axum_response(ssr_res: SsrResponse) -> AxumResponse {
  let mut builder = AxumResponse::builder().status(ssr_res.status);
  for (k, v) in &ssr_res.headers {
    if let (Ok(name), Ok(val)) = (k.parse::<HeaderName>(), v.parse::<HeaderValue>()) {
      builder = builder.header(name, val);
    }
  }
  builder.body(Body::from(ssr_res.body)).unwrap()
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

impl<T: RustEmbed> Clone for ProductionHandler<T> {
  fn clone(&self) -> Self {
    Self { ssr: self.ssr.clone(), _assets: PhantomData }
  }
}

impl<T: RustEmbed + Send + Sync + 'static> axum::handler::Handler<(), ()> for ProductionHandler<T> {
  type Future = Pin<Box<dyn Future<Output = AxumResponse> + Send + 'static>>;

  fn call(self, req: AxumRequest, _state: ()) -> Self::Future {
    Box::pin(async move {
      let path = req.uri().path();

      if let Some(asset) = handler_common::lookup_static_asset::<T>(path) {
        let mut response =
          AxumResponse::builder().status(StatusCode::OK).header("content-type", &asset.mime).body(Body::from(asset.data)).unwrap();

        if asset.immutable {
          response
            .headers_mut()
            .insert(HeaderName::from_static("cache-control"), HeaderValue::from_static("public, max-age=31536000, immutable"));
        }

        return response;
      }

      axum::handler::Handler::call(self.ssr, req, ()).await
    })
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// init_ssr: one-call router setup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Build a production-ready Axum Router with SSR in a single call.
pub async fn init_ssr<T>(api_router: Router) -> anyhow::Result<Router>
where
  T: RustEmbed + Send + Sync + 'static,
{
  let dispatch_router = api_router.clone();

  let engine = crate::engine::SsrEngine::new::<T>(AxumDispatcher::new(dispatch_router), ReqwestFetcher::new()).await?;

  let handler = ProductionHandler::<T>::new(SsrHandler::new(Arc::new(engine)));

  Ok(api_router.fallback(handler))
}
