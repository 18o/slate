//! End-to-end integration test with Axum.
//!
//! Tests the full Axum → AxumDispatcher → QuickJS flow,
//! including internal dispatch, cache behavior, and error handling.

#![cfg(feature = "axum")]

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request as AxumRequest;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use http_body_util::BodyExt;
use rust_embed::RustEmbed;

use slate::axum::{AxumDispatcher, ReqwestFetcher, SsrHandler};
use slate::handler_common::SsrConfig;
use slate::{InternalDispatcher, SsrEngine};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test API handlers — minimal, no feature-gated extractors
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Returns JSON with query param "name".
async fn api_hello(req: AxumRequest) -> impl IntoResponse {
  let name = req
    .uri()
    .query()
    .and_then(|q| {
      q.split('&').find_map(|pair| {
        let (key, val) = pair.split_once('=')?;
        if key == "name" { Some(val.to_string()) } else { None }
      })
    })
    .unwrap_or_else(|| "world".into());

  (StatusCode::OK, [("content-type", "application/json")], format!("{{\"message\":\"hello {name}\"}}"))
}

/// Echoes the request body back as JSON.
async fn api_echo(req: AxumRequest) -> impl IntoResponse {
  let body_bytes = axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024).await.unwrap_or_default();
  let body_str = String::from_utf8(body_bytes.to_vec()).unwrap_or_default();

  (StatusCode::OK, [("content-type", "application/json")], format!("{{\"echo\":{body_str}}}"))
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test assets
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(RustEmbed)]
#[folder = "tests/fixtures/"]
struct TestAssets;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AxumDispatcher unit tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[tokio::test]
async fn test_axum_dispatcher_get() {
  let router = axum::Router::new().route("/api/hello", get(api_hello));
  let dispatcher = AxumDispatcher::new(router);

  let result = dispatcher.dispatch("GET", "/api/hello?name=test", None, &[]).await;

  assert_eq!(result.status, 200);
  assert!(String::from_utf8_lossy(&result.body).contains("hello test"));
}

#[tokio::test]
async fn test_axum_dispatcher_post_with_body() {
  let router = axum::Router::new().route("/api/data", post(api_echo));
  let dispatcher = AxumDispatcher::new(router);

  let result = dispatcher.dispatch("POST", "/api/data", Some(br#"{"key":"value"}"#), &[]).await;

  assert_eq!(result.status, 200);
  assert!(String::from_utf8_lossy(&result.body).contains("key"));
}

#[tokio::test]
async fn test_axum_dispatcher_with_headers() {
  let router = axum::Router::new().route("/api/test", get(api_hello));
  let dispatcher = AxumDispatcher::new(router);

  let headers = vec![("authorization".to_string(), "Bearer test123".to_string()), ("x-custom".to_string(), "value".to_string())];

  let result = dispatcher.dispatch("GET", "/api/test?name=header", None, &headers).await;

  assert_eq!(result.status, 200);
}

#[tokio::test]
async fn test_axum_dispatcher_unknown_route_returns_404() {
  let router = axum::Router::new().route("/api/exists", get(api_hello));
  let dispatcher = AxumDispatcher::new(router);

  let result = dispatcher.dispatch("GET", "/api/nonexistent", None, &[]).await;

  assert_eq!(result.status, 404);
}

#[tokio::test]
async fn test_axum_dispatcher_multiple_requests() {
  let router = axum::Router::new().route("/api/a", get(api_hello)).route("/api/b", get(api_hello));
  let dispatcher = AxumDispatcher::new(router);

  let r1 = dispatcher.dispatch("GET", "/api/a?name=first", None, &[]).await;
  assert_eq!(r1.status, 200);
  assert!(String::from_utf8_lossy(&r1.body).contains("hello first"));

  let r2 = dispatcher.dispatch("GET", "/api/b?name=second", None, &[]).await;
  assert_eq!(r2.status, 200);
  assert!(String::from_utf8_lossy(&r2.body).contains("hello second"));

  let r3 = dispatcher.dispatch("GET", "/api/c", None, &[]).await;
  assert_eq!(r3.status, 404);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Full engine + SsrHandler tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[tokio::test]
async fn test_axum_ssr_handler_renders_page() {
  let api_router = axum::Router::new().route("/api/hello", get(api_hello));
  let dispatcher = AxumDispatcher::new(api_router);

  let engine = SsrEngine::new::<TestAssets>(dispatcher, ReqwestFetcher::new().unwrap(), Duration::from_secs(3))
    .await
    .expect("Engine creation should succeed");

  let handler = SsrHandler::new(Arc::new(engine), &SsrConfig::default());

  let req = AxumRequest::builder().method(Method::GET).uri("/test-page").body(Body::empty()).unwrap();

  let response = axum::handler::Handler::call(handler, req, ()).await;

  assert_eq!(response.status(), StatusCode::OK);

  let body = BodyExt::collect(response.into_body()).await.unwrap().to_bytes();
  let body_str = String::from_utf8(body.to_vec()).unwrap();
  let body_json: serde_json::Value = serde_json::from_str(&body_str).unwrap();

  assert_eq!(body_json["method"], "GET");
  assert_eq!(body_json["url"], "/test-page");
}

#[tokio::test]
async fn test_axum_ssr_handler_caches_get_requests() {
  let api_router = axum::Router::new().route("/api/hello", get(api_hello));
  let dispatcher = AxumDispatcher::new(api_router);

  let engine = SsrEngine::new::<TestAssets>(dispatcher, ReqwestFetcher::new().unwrap(), Duration::from_secs(3)).await.unwrap();
  let handler = SsrHandler::new(Arc::new(engine), &SsrConfig::default());

  // First request — MISS
  let req1 = AxumRequest::builder().method(Method::GET).uri("/cached-page").body(Body::empty()).unwrap();

  let handler_clone = handler.clone();
  let res1 = axum::handler::Handler::call(handler_clone, req1, ()).await;
  assert_eq!(res1.status(), StatusCode::OK);
  assert_eq!(res1.headers().get("x-ssr-cache").unwrap(), "MISS", "First request should be a cache MISS");

  // Second request — HIT (same URL)
  let req2 = AxumRequest::builder().method(Method::GET).uri("/cached-page").body(Body::empty()).unwrap();

  let handler_clone = handler.clone();
  let res2 = axum::handler::Handler::call(handler_clone, req2, ()).await;
  assert_eq!(res2.status(), StatusCode::OK);
  assert_eq!(res2.headers().get("x-ssr-cache").unwrap(), "HIT", "Second request should be a cache HIT");
}

#[tokio::test]
async fn test_axum_ssr_handler_does_not_cache_post() {
  let api_router = axum::Router::new().route("/api/data", post(api_echo));
  let dispatcher = AxumDispatcher::new(api_router);

  let engine = SsrEngine::new::<TestAssets>(dispatcher, ReqwestFetcher::new().unwrap(), Duration::from_secs(3)).await.unwrap();
  let handler = SsrHandler::new(Arc::new(engine), &SsrConfig::default());

  let req = AxumRequest::builder().method(Method::POST).uri("/submit").body(Body::from(r#"{"data":"test"}"#)).unwrap();

  let handler_clone = handler.clone();
  let res = axum::handler::Handler::call(handler_clone, req, ()).await;
  assert_eq!(res.status(), StatusCode::OK);

  // POST should not be cached — no HIT header
  let cache_header = res.headers().get("x-ssr-cache").map(|v| v.to_str().unwrap());
  assert!(cache_header != Some("HIT"), "POST should not produce a cache HIT");
}

#[tokio::test]
async fn test_axum_reqwest_fetcher_creation() {
  let _fetcher = ReqwestFetcher::new().unwrap();
}
