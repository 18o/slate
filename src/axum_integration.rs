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
///
/// **Security note**: The dispatch uses a clone of the `Router` passed to
/// [`AxumDispatcher::new()`]. Any middleware applied **after** cloning
/// (e.g., `router.layer(AuthLayer)`) will NOT be active during internal
/// dispatch. To ensure auth checks apply to internal fetches, put
/// authorization logic **inside** individual route handlers, not as outer
/// middleware layers on the router.
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
      if let (Ok(name), Ok(val)) = (key.parse::<HeaderName>(), value.parse::<HeaderValue>())
        && let Some(hdrs) = builder.headers_mut()
      {
        hdrs.insert(name, val);
      }
    }

    let axum_body = body.map(|b| Body::from(b.to_vec())).unwrap_or(Body::empty());

    // If the primary builder fails, fall back to a minimal GET / request.
    // The fallback itself uses unwrap_or_else to avoid any possibility of panic.
    let request = builder.body(axum_body).unwrap_or_else(|_| {
      AxumRequest::builder().method(Method::GET).uri("/").body(Body::empty()).unwrap_or_else(|_| AxumRequest::new(Body::empty()))
    });

    let mut router = self.router.clone();
    let response = match router.as_service().ready().await {
      Ok(svc) => match svc.call(request).await {
        Ok(res) => res,
        Err(e) => {
          tracing::error!("SSR internal dispatch error: {e}");
          return DispatchResult::error(500, "internal dispatch failed");
        }
      },
      Err(e) => {
        tracing::error!("SSR internal dispatch ready error: {e}");
        return DispatchResult::error(500, "service not ready");
      }
    };

    let status = response.status().as_u16();

    let hdrs: Vec<(String, String)> =
      response.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();

    let body_bytes = to_bytes(response.into_body(), handler_common::MAX_BODY_SIZE).await.unwrap_or_else(|e| {
      tracing::error!("SSR dispatch body read error: {e}");
      bytes::Bytes::new()
    });
    let body = body_bytes.to_vec();

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
  core: SsrHandlerCore<AxumDispatcher, ReqwestFetcher>,
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
          let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
          let mut response = safe_build_response(AxumResponse::builder().status(status), Body::from(cached.body.clone()));
          for (k, v) in &cached.headers {
            // Skip content-length — Axum/hyper computes it from the actual body.
            if k.eq_ignore_ascii_case("content-length") {
              continue;
            }
            if let (Ok(name), Ok(val)) = (k.parse::<HeaderName>(), v.parse::<HeaderValue>()) {
              response.headers_mut().append(name, val);
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
        RenderOutcome::Error => safe_build_response(
          AxumResponse::builder().status(StatusCode::INTERNAL_SERVER_ERROR).header("content-type", "text/html; charset=utf-8"),
          Body::from(handler_common::ERROR_PAGE_500),
        ),
      }
    })
  }
}

fn extract_axum_headers(req: &AxumRequest) -> HashMap<String, String> {
  req.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|val| (k.to_string(), val.to_string()))).collect()
}

async fn extract_body(req: AxumRequest) -> Option<String> {
  let bytes = to_bytes(req.into_body(), handler_common::MAX_BODY_SIZE).await.ok()?;
  match String::from_utf8(bytes.to_vec()) {
    Ok(s) => Some(s),
    Err(e) => {
      tracing::debug!("SSR: non-UTF-8 request body, ignoring: {e}");
      None
    }
  }
}

fn build_axum_response(ssr_res: SsrResponse) -> AxumResponse {
  let status = StatusCode::from_u16(ssr_res.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
  // Build response with status + body first, then apply headers via append()
  // so that multi-value headers (Set-Cookie) are preserved.
  let builder = AxumResponse::builder().status(status);
  let mut response = safe_build_response(builder, ssr_res.body);
  for (k, v) in &ssr_res.headers {
    // Skip content-length — Axum/hyper computes it from the actual body.
    if k.eq_ignore_ascii_case("content-length") {
      continue;
    }
    if let (Ok(name), Ok(val)) = (k.parse::<HeaderName>(), v.parse::<HeaderValue>()) {
      response.headers_mut().append(name, val);
    }
  }
  response
}

/// Build an Axum response without panic.
///
/// `http::response::Builder::body()` can theoretically fail if the builder
/// is in an error state. This function falls back to a minimal 200 OK
/// response with the body as-is, ensuring no panic path exists.
fn safe_build_response(builder: axum::http::response::Builder, body: impl Into<Body>) -> AxumResponse {
  builder.body(body.into()).unwrap_or_else(|_| {
    tracing::error!("SSR: failed to build Axum response, falling back to minimal 200");
    AxumResponse::new(Body::empty())
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

      // Check if client accepts brotli-compressed responses
      let accepts_br =
        req.headers().get(axum::http::header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).map(|s| s.contains("br")).unwrap_or(false);

      if let Some(asset) = crate::static_files::lookup_static_asset::<T>(path, accepts_br) {
        let mut response =
          safe_build_response(AxumResponse::builder().status(StatusCode::OK).header("content-type", &asset.mime), Body::from(asset.data));

        if let Some(ref encoding) = asset.content_encoding {
          response
            .headers_mut()
            .insert(HeaderName::from_static("content-encoding"), HeaderValue::from_str(encoding).unwrap_or(HeaderValue::from_static("br")));
        }

        response.headers_mut().insert(HeaderName::from_static("vary"), HeaderValue::from_static("Accept-Encoding"));

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

  let engine = crate::engine::SsrEngine::new::<T>(AxumDispatcher::new(dispatch_router), ReqwestFetcher::new()?).await?;

  let handler = ProductionHandler::<T>::new(SsrHandler::new(Arc::new(engine)));

  Ok(api_router.fallback(handler))
}
