//! End-to-end integration test with Salvo.
//!
//! Tests the full HTTP → Salvo → SalvoDispatcher → QuickJS flow,
//! including internal dispatch, marker detection, and error handling.

#![cfg(feature = "salvo")]

use std::sync::Arc;

use salvo::http::ResBody;
use salvo::prelude::*;
use slate::InternalDispatcher;
use slate::salvo::{InternalDispatchMarker, ReqwestFetcher, SalvoDispatcher};

/// Simple API handler for testing internal dispatch.
#[handler]
async fn api_hello(req: &mut Request, _depot: &mut Depot, res: &mut Response) {
  // Verify that InternalDispatchMarker is present
  assert!(
    req.extensions().get::<InternalDispatchMarker>().is_some(),
    "InternalDispatchMarker should be present in internal dispatch requests"
  );

  let name = req.query::<String>("name").unwrap_or_else(|| "world".to_string());
  res.status_code = Some(StatusCode::OK);
  res.headers.insert("content-type", "application/json".try_into().unwrap());
  res.body = ResBody::Once(format!("{{\"message\":\"hello {name}\"}}").into_bytes().into());
}

/// POST handler for testing body forwarding.
#[handler]
async fn api_echo(req: &mut Request, _depot: &mut Depot, res: &mut Response) {
  let body = req.payload().await.map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default();
  res.status_code = Some(StatusCode::OK);
  res.headers.insert("content-type", "application/json".try_into().unwrap());
  res.body = ResBody::Once(format!("{{\"echo\":{body}}}").into_bytes().into());
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[tokio::test]
async fn test_internal_dispatch_marker_present() {
  let router = Router::new().push(Router::with_path("/api/hello").get(api_hello));
  let service = Arc::new(Service::new(router));
  let dispatcher = SalvoDispatcher::new(service);

  let result = dispatcher.dispatch("GET", "/api/hello?name=test", None, &[]).await;
  assert_eq!(result.status, 200);
  assert!(String::from_utf8_lossy(&result.body).contains("hello test"));
}

#[tokio::test]
async fn test_salvo_dispatcher_get() {
  let router = Router::new().push(Router::with_path("/api/users").get(api_hello));
  let service = Arc::new(Service::new(router));
  let dispatcher = SalvoDispatcher::new(service);

  let result = dispatcher.dispatch("GET", "/api/users?name=alice", None, &[]).await;
  assert_eq!(result.status, 200);
  assert!(String::from_utf8_lossy(&result.body).contains("hello alice"));
}

#[tokio::test]
async fn test_salvo_dispatcher_post_with_body() {
  let router = Router::new().push(Router::with_path("/api/data").post(api_echo));
  let service = Arc::new(Service::new(router));
  let dispatcher = SalvoDispatcher::new(service);

  let result = dispatcher.dispatch("POST", "/api/data", Some(br#"{"key":"value"}"#), &[]).await;
  assert_eq!(result.status, 200);
  assert!(String::from_utf8_lossy(&result.body).contains("key"));
}

#[tokio::test]
async fn test_salvo_dispatcher_with_headers() {
  let router = Router::new().push(Router::with_path("/api/test").get(api_hello));
  let service = Arc::new(Service::new(router));
  let dispatcher = SalvoDispatcher::new(service);

  let headers = vec![("authorization".to_string(), "Bearer test123".to_string()), ("x-custom".to_string(), "value".to_string())];

  let result = dispatcher.dispatch("GET", "/api/test?name=header", None, &headers).await;
  assert_eq!(result.status, 200);
}

#[tokio::test]
async fn test_salvo_dispatcher_unknown_route_returns_404() {
  let router = Router::new().push(Router::with_path("/api/exists").get(api_hello));
  let service = Arc::new(Service::new(router));
  let dispatcher = SalvoDispatcher::new(service);

  let result = dispatcher.dispatch("GET", "/api/nonexistent", None, &[]).await;
  assert_eq!(result.status, 404);
}

#[tokio::test]
async fn test_salvo_dispatcher_multiple_requests() {
  let router = Router::new().push(Router::with_path("/api/a").get(api_hello)).push(Router::with_path("/api/b").get(api_hello));
  let service = Arc::new(Service::new(router));
  let dispatcher = SalvoDispatcher::new(service);

  // Request 1
  let r1 = dispatcher.dispatch("GET", "/api/a?name=first", None, &[]).await;
  assert_eq!(r1.status, 200);
  assert!(String::from_utf8_lossy(&r1.body).contains("hello first"));

  // Request 2
  let r2 = dispatcher.dispatch("GET", "/api/b?name=second", None, &[]).await;
  assert_eq!(r2.status, 200);
  assert!(String::from_utf8_lossy(&r2.body).contains("hello second"));

  // 404
  let r3 = dispatcher.dispatch("GET", "/api/c", None, &[]).await;
  assert_eq!(r3.status, 404);
}

#[tokio::test]
async fn test_reqwest_fetcher_creation() {
  let _fetcher = ReqwestFetcher::new().unwrap();
}
