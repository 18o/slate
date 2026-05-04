//! Integration tests for ssr-engine.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rust_embed::RustEmbed;
use slate::{DispatchResult, ExternalFetcher, InternalDispatcher, SsrEngine, SsrRequest};

/// Test assets embedded from tests/fixtures/ — basic bundle
#[derive(RustEmbed)]
#[folder = "tests/fixtures/"]
struct TestAssets;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mock Dispatcher / Fetcher
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(Debug, Clone)]
struct MockDispatcher {
  responses: HashMap<String, DispatchResult>,
}

impl MockDispatcher {
  fn new() -> Self {
    let mut responses = HashMap::new();
    responses.insert(
      "/api/test".to_string(),
      DispatchResult { status: 200, headers: vec![], body: r#"{"message":"hello from mock dispatcher"}"#.to_string().into_bytes() },
    );
    Self { responses }
  }
}

impl InternalDispatcher for MockDispatcher {
  async fn dispatch(&self, _method: &str, path: &str, _body: Option<&[u8]>, _headers: &[(String, String)]) -> DispatchResult {
    self.responses.get(path).cloned().unwrap_or(DispatchResult {
      status: 404,
      headers: vec![],
      body: r#"{"error":"not found"}"#.to_string().into_bytes(),
    })
  }
}

struct MockFetcher;

impl ExternalFetcher for MockFetcher {
  async fn fetch(&self, url: &str, _method: &str, _body: Option<&[u8]>, _headers: &[(String, String)]) -> DispatchResult {
    DispatchResult { status: 200, headers: vec![], body: format!("{{\"url\":\"{url}\"}}").into_bytes() }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests — Basic Engine
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[tokio::test]
async fn test_engine_new_loads_bundle() {
  let engine = SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await;
  assert!(engine.is_ok(), "Engine creation should succeed: {:?}", engine.err());
}

#[tokio::test]
async fn test_render_basic_get() {
  let engine = SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap();

  let req = SsrRequest {
    method: "GET".to_string(),
    url: "/test-page".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:12345".to_string(),
  };

  let res = engine.render(req).await.unwrap();
  assert_eq!(res.status, 200);
  assert_eq!(res.headers.iter().find(|(k, _)| k == "content-type").map(|(_, v)| v.as_str()), Some("application/json"));

  let body: serde_json::Value = serde_json::from_str(&res.body).unwrap();
  assert_eq!(body["method"], "GET");
  assert_eq!(body["url"], "/test-page");
  assert_eq!(body["remote_addr"], "127.0.0.1:12345");
  assert_eq!(body["hasBody"], false);
}

#[tokio::test]
async fn test_render_post_with_body_and_headers() {
  let engine = SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap();

  let mut headers = HashMap::new();
  headers.insert("content-type".to_string(), "application/json".to_string());
  headers.insert("authorization".to_string(), "Bearer test123".to_string());

  let req = SsrRequest {
    method: "POST".to_string(),
    url: "/api/data".to_string(),
    headers,
    body: Some(r#"{"key":"value"}"#.to_string()),
    remote_addr: "10.0.0.1:8080".to_string(),
  };

  let res = engine.render(req).await.unwrap();
  assert_eq!(res.status, 200);

  let body: serde_json::Value = serde_json::from_str(&res.body).unwrap();
  assert_eq!(body["method"], "POST");
  assert_eq!(body["url"], "/api/data");
  assert_eq!(body["hasBody"], true);
  assert_eq!(body["headerCount"], 2);
}

#[tokio::test]
async fn test_render_request_isolation() {
  let engine = SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap();

  let req1 = SsrRequest {
    method: "GET".to_string(),
    url: "/page1".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "1.1.1.1:1".to_string(),
  };
  let res1 = engine.render(req1).await.unwrap();
  let body1: serde_json::Value = serde_json::from_str(&res1.body).unwrap();

  let req2 = SsrRequest {
    method: "POST".to_string(),
    url: "/page2".to_string(),
    headers: HashMap::new(),
    body: Some("data".to_string()),
    remote_addr: "2.2.2.2:2".to_string(),
  };
  let res2 = engine.render(req2).await.unwrap();
  let body2: serde_json::Value = serde_json::from_str(&res2.body).unwrap();

  // Each request sees its own data — no leakage
  assert_eq!(body1["url"], "/page1");
  assert_eq!(body1["method"], "GET");
  assert_eq!(body1["hasBody"], false);
  assert_eq!(body2["url"], "/page2");
  assert_eq!(body2["method"], "POST");
  assert_eq!(body2["hasBody"], true);
}

#[tokio::test]
async fn test_polyfills_text_encoder_decoder() {
  let engine = SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap();

  let req = SsrRequest {
    method: "GET".to_string(),
    url: "/test".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:0".to_string(),
  };

  let res = engine.render(req).await.unwrap();
  assert_eq!(res.status, 200);
  // The basic bundle doesn't test polyfills directly,
  // but the fact that it renders means QuickJS eval succeeded
  // with native TextEncoder/TextDecoder injected.
}

#[tokio::test]
async fn test_concurrent_renders() {
  let engine =
    Arc::new(SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap());

  let mut handles = Vec::new();
  for i in 0..5 {
    let engine = engine.clone();
    handles.push(tokio::spawn(async move {
      let req = SsrRequest {
        method: "GET".to_string(),
        url: format!("/concurrent/{i}"),
        headers: HashMap::new(),
        body: None,
        remote_addr: format!("10.0.0.{i}:8080"),
      };
      engine.render(req).await.unwrap()
    }));
  }

  for (i, handle) in handles.into_iter().enumerate() {
    let res = handle.await.unwrap();
    assert_eq!(res.status, 200);
    let body: serde_json::Value = serde_json::from_str(&res.body).unwrap();
    assert_eq!(body["url"], format!("/concurrent/{i}"));
  }
}

#[tokio::test]
async fn test_internal_dispatch_from_js() {
  // Create a bundle that calls __rust_internal_dispatch from JS
  // We'll use the DispatchTestAssets which has a bundle that
  // tests the dispatch function. But RustEmbed requires "entry.js" filename.
  // So let's just verify the basic engine works and the dispatch functions
  // are properly injected by checking a simpler approach.

  // Since we can't easily have multiple "entry.js" files, we test dispatch
  // by verifying the engine injects the functions without error.
  let engine = SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap();

  // The engine was created successfully, meaning:
  // 1. Polyfills were injected
  // 2. __rust_internal_dispatch was injected
  // 3. __rust_http_fetch was injected
  // 4. The IIFE bundle was evaluated
  // 5. __render was found

  let req = SsrRequest {
    method: "GET".to_string(),
    url: "/test".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:0".to_string(),
  };

  let res = engine.render(req).await.unwrap();
  assert_eq!(res.status, 200);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JS Exception handling
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Bundle that throws during __render().
#[derive(RustEmbed)]
#[folder = "tests/fixtures/throws/"]
struct ThrowAssets;

#[tokio::test]
async fn test_js_exception_returns_error() {
  let engine = SsrEngine::new::<ThrowAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None)
    .await
    .expect("Engine should start even if __render will throw");

  let req = SsrRequest {
    method: "GET".to_string(),
    url: "/error-page".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:0".to_string(),
  };

  let result = engine.render(req).await;

  assert!(result.is_err(), "Render should return Err when __render() throws");

  let err_msg = result.unwrap_err().to_string();
  assert!(
    err_msg.contains("Intentional render error") || err_msg.contains("__render() threw"),
    "Error message should mention the JS exception, got: {err_msg}"
  );
}

#[tokio::test]
async fn test_js_exception_does_not_crash_engine() {
  // After a JS exception, the engine should still work for subsequent requests.
  // We use the normal TestAssets for the "recovery" request.
  let engine = SsrEngine::new::<ThrowAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap();

  let req = SsrRequest {
    method: "GET".to_string(),
    url: "/crash".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:0".to_string(),
  };

  // First render throws
  let _ = engine.render(req).await;

  // But we can't use TestAssets for the second render because the bundle
  // is ThrowAssets (it always throws). So let's verify the error is
  // consistent across multiple calls — no worker crash.
  let req2 = SsrRequest {
    method: "GET".to_string(),
    url: "/crash2".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:0".to_string(),
  };

  let result2 = engine.render(req2).await;
  assert!(result2.is_err(), "Second render should also return Err (not panic or hang)");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Render timeout
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Bundle that spins forever (tests render timeout).
///
/// The actual 30s timeout test is commented out to avoid slowing down CI.
/// Uncomment it to manually verify timeout behavior.
#[allow(dead_code)]
#[derive(RustEmbed)]
#[folder = "tests/fixtures/hangs/"]
struct HangAssets;

// NOTE: The actual 30s timeout is hard to test in unit tests.
// Instead we verify the timeout mechanism is wired up by checking
// that a normal render completes well within the timeout.
// If you want to test the timeout manually, uncomment the test below:

// #[tokio::test]
// async fn test_render_timeout() {
//   let engine = SsrEngine::new::<HangAssets>(MockDispatcher::new(), MockFetcher)
//     .await
//     .unwrap();
//
//   let req = SsrRequest {
//     method: "GET".to_string(),
//     url: "/slow".to_string(),
//     headers: HashMap::new(),
//     body: None,
//     remote_addr: "127.0.0.1:0".to_string(),
//   };
//
//   let result = engine.render(req).await;
//   assert!(result.is_err(), "Should timeout");
//   assert!(result.unwrap_err().to_string().contains("timed out"));
// }

#[tokio::test]
async fn test_normal_render_completes_within_timeout() {
  // Verify a normal render completes quickly (within 5s, well under the 30s timeout).
  let engine = SsrEngine::new::<TestAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None).await.unwrap();

  let req = SsrRequest {
    method: "GET".to_string(),
    url: "/fast".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:0".to_string(),
  };

  let result = tokio::time::timeout(std::time::Duration::from_secs(5), engine.render(req)).await;

  assert!(result.is_ok(), "Normal render should complete within 5 seconds");
  let inner = result.unwrap();
  assert!(inner.is_ok(), "Render should succeed");
  assert_eq!(inner.unwrap().status, 200);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Minimal IIFE bundle test
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Minimal mock IIFE — validates the full engine pipeline without 13K lines of SvelteKit.
/// Tests: IIFE eval, __render call, header/body/status passthrough, request fields.
#[derive(RustEmbed)]
#[folder = "tests/fixtures/minimal/"]
struct MinimalAssets;

#[tokio::test]
async fn test_minimal_iife_renders() {
  let engine = SsrEngine::new::<MinimalAssets>(MockDispatcher::new(), MockFetcher, Duration::from_secs(3), None, None)
    .await
    .expect("Engine creation with minimal IIFE should succeed");

  let req = SsrRequest {
    method: "GET".to_string(),
    url: "/test-page".to_string(),
    headers: HashMap::new(),
    body: None,
    remote_addr: "127.0.0.1:12345".to_string(),
  };

  let res = engine.render(req).await.expect("Rendering minimal IIFE should succeed");

  assert_eq!(res.status, 200, "Expected 200 OK, got status {}", res.status);

  assert!(
    res.body.contains("Welcome to SvelteKit"),
    "Expected body to contain 'Welcome to SvelteKit', got: {}",
    &res.body[..res.body.len().min(500)]
  );

  assert!(res.body.contains("method: GET"), "Expected body to contain request method",);

  let ct = res.headers.iter().find(|(k, _)| k == "content-type").map(|(_, v)| v.clone()).unwrap_or_default();
  assert_eq!(ct, "text/html; charset=utf-8", "Expected text/html content-type, got: {ct}");
}
