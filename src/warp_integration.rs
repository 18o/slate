//! Warp integration — WarpDispatcher, init_ssr().
//!
//! This module is only compiled when the `warp` feature is enabled.
//!
//! Warp uses filter-based composition. `init_ssr` takes API routes
//! as a boxed filter and returns a combined filter that serves static
//! files from RustEmbed with SSR fallback.

use std::convert::Infallible;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use rust_embed::RustEmbed;
use tower_service::Service;
use warp::Filter;
use warp::reply::Reply;

use crate::engine::{SsrEngine, SsrRequest};
use crate::handler_common::{IncomingRequest, RenderOutcome, SsrConfig, SsrHandlerCore};
use crate::shared::ReqwestFetcher;
use crate::static_files;
use crate::traits::{DispatchResult, InternalDispatcher};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WarpDispatcher: internal routing (zero HTTP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Dispatches relative-path fetches through Warp's internal filter.
///
/// Uses `warp::service()` to convert the filter into a tower service
/// and call it with a synthetic `http::Request`.
pub struct WarpDispatcher {
  api: Arc<warp::filters::BoxedFilter<(warp::reply::Response,)>>,
}

impl WarpDispatcher {
  pub fn new(api: warp::filters::BoxedFilter<(warp::reply::Response,)>) -> Self {
    Self { api: Arc::new(api) }
  }
}

impl InternalDispatcher for WarpDispatcher {
  async fn dispatch(&self, method: &str, path: &str, body: Option<&[u8]>, headers: &[(String, String)]) -> DispatchResult {
    tracing::debug!("SSR internal dispatch (warp): {method} {path}");

    let http_method = method.parse::<http::Method>().unwrap_or(http::Method::GET);

    // Build synthetic request
    let mut req = http::Request::builder().method(&http_method).uri(path);

    for (k, v) in headers {
      if let (Ok(name), Ok(val)) = (http::header::HeaderName::from_bytes(k.as_bytes()), http::header::HeaderValue::from_bytes(v.as_bytes()))
      {
        req = req.header(name, val);
      }
    }

    let body_bytes_slice = body.unwrap_or(&[]);
    let body = Full::new(Bytes::copy_from_slice(body_bytes_slice));
    let request = match req.body(body) {
      Ok(r) => r,
      Err(e) => {
        tracing::error!("SSR internal dispatch: failed to build request: {e}");
        return DispatchResult::error(500, "failed to build dispatch request");
      }
    };

    // Convert filter to service and call
    let filter = (*self.api).clone();
    let mut svc = warp::service(filter);
    let resp = match svc.call(request).await {
      Ok(r) => r,
      Err(e) => {
        tracing::error!("SSR internal dispatch error: {e}");
        return DispatchResult::error(500, "internal dispatch failed");
      }
    };

    let status = resp.status().as_u16();
    let hdrs: Vec<(String, String)> = resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();

    let (_, resp_body) = resp.into_parts();
    let body_bytes = resp_body.collect().await.map(|c| c.to_bytes().to_vec()).unwrap_or_default();

    DispatchResult { status, headers: hdrs, body: body_bytes }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// init_ssr: build the combined filter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Create a combined Warp filter: API routes + static files + SSR fallback.
///
/// ```ignore
/// let api = warp::path("api")
///     .and(warp::path("hello"))
///     .map(|| warp::reply::json(&json!({"msg": "hello"})))
///     .map(|r| r.into_response())
///     .boxed();
///
/// let routes = slate::warp::init_ssr::<Assets, _>(api, &SsrConfig::default()).await?;
/// warp::serve(routes).run(([0, 0, 0, 0], 3000)).await;
/// ```
pub async fn init_ssr<T, F>(api: F, config: &SsrConfig) -> anyhow::Result<warp::filters::BoxedFilter<(warp::reply::Response,)>>
where
  T: RustEmbed + Send + Sync + 'static,
  F: Filter<Extract = (warp::reply::Response,), Error = warp::Rejection> + Clone + Send + Sync + 'static,
{
  let pool_size = config.pool_size.max(1);
  let mut engines = Vec::with_capacity(pool_size);

  let api_boxed: warp::filters::BoxedFilter<(warp::reply::Response,)> = api.boxed();
  let dispatch_api = api_boxed.clone();

  for _ in 0..pool_size {
    let engine = SsrEngine::new::<T>(
      WarpDispatcher::new(dispatch_api.clone()),
      ReqwestFetcher::new()?,
      config.render_timeout,
      config.memory_limit,
      config.max_stack_size,
    )
    .await?;
    engines.push(Arc::new(engine));
  }

  let core = Arc::new(SsrHandlerCore::pooled(engines, config));

  // Build SSR fallback filter
  let ssr = warp::any()
    .and(warp::method())
    .and(warp::filters::path::full())
    .and(warp::filters::header::headers_cloned())
    .and(warp::filters::body::bytes())
    .map(move |method, path, req_headers, body| (method, path, req_headers, body, core.clone()))
    .and_then(ssr_handler::<T>)
    .boxed();

  Ok(api_boxed.or(ssr).unify().boxed())
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ssr_handler: the actual request handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async fn ssr_handler<T: RustEmbed + 'static>(
  (method, path, req_headers, body, core): (
    http::Method,
    warp::filters::path::FullPath,
    http::HeaderMap,
    bytes::Bytes,
    Arc<SsrHandlerCore<WarpDispatcher, ReqwestFetcher>>,
  ),
) -> Result<warp::reply::Response, Infallible> {
  let path_str = path.as_str().to_string();

  // 1. Static assets
  let accepts_br = req_headers.get(http::header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).map(|s| s.contains("br")).unwrap_or(false);

  if let Some(asset) = static_files::lookup_static_asset::<T>(&path_str, accepts_br) {
    return Ok(build_asset_response(asset));
  }

  // 2. SSR via SsrHandlerCore
  let has_query = path_str.contains('?');

  let headers: std::collections::HashMap<String, String> =
    req_headers.iter().filter_map(|(k, v)| v.to_str().ok().map(|val| (k.to_string(), val.to_string()))).collect();

  let body_str = if body.is_empty() { None } else { String::from_utf8(body.to_vec()).ok() };

  let incoming = IncomingRequest {
    path: path_str,
    has_query,
    ssr_request: SsrRequest {
      method: method.as_str().to_string(),
      url: path.as_str().to_string(),
      headers,
      body: body_str,
      remote_addr: "127.0.0.1".to_string(),
    },
  };

  Ok(match core.handle(incoming).await {
    RenderOutcome::CacheHit(cached) => build_ssr_response(cached.status, &cached.headers, &cached.body, "HIT"),
    RenderOutcome::Rendered(ssr_res) => build_ssr_response(ssr_res.status, &ssr_res.headers, &ssr_res.body, "MISS"),
    RenderOutcome::Error => {
      let mut resp = warp::reply::html(core.error_html()).into_response();
      *resp.status_mut() = http::StatusCode::INTERNAL_SERVER_ERROR;
      resp
    }
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Response builders
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

fn build_asset_response(asset: static_files::StaticAsset) -> warp::reply::Response {
  let mut resp = warp::reply::Response::new(asset.data.into());
  *resp.status_mut() = http::StatusCode::OK;

  if let Ok(val) = http::header::HeaderValue::from_str(&asset.mime) {
    resp.headers_mut().insert(http::header::CONTENT_TYPE, val);
  }
  if let Some(ref enc) = asset.content_encoding
    && let Ok(val) = http::header::HeaderValue::from_str(enc)
  {
    resp.headers_mut().insert(http::header::CONTENT_ENCODING, val);
  }
  resp.headers_mut().insert(http::header::VARY, http::header::HeaderValue::from_static("Accept-Encoding"));
  if asset.immutable {
    resp.headers_mut().insert(http::header::CACHE_CONTROL, http::header::HeaderValue::from_static("public, max-age=31536000, immutable"));
  }
  resp
}

fn build_ssr_response(status: u16, headers: &[(String, String)], body_str: &str, cache_value: &str) -> warp::reply::Response {
  let mut resp = warp::reply::html(body_str.to_string()).into_response();
  *resp.status_mut() = http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);

  for (k, v) in headers {
    if k.eq_ignore_ascii_case("content-length") {
      continue;
    }
    if let (Ok(name), Ok(val)) = (http::header::HeaderName::from_bytes(k.as_bytes()), http::header::HeaderValue::from_bytes(v.as_bytes())) {
      resp.headers_mut().append(name, val);
    }
  }

  if let Ok(val) = http::header::HeaderValue::from_str(cache_value) {
    resp.headers_mut().insert(http::header::HeaderName::from_static("x-ssr-cache"), val);
  }
  resp
}
