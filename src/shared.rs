//! Shared types between web framework integrations.
//!
//! `ReqwestFetcher`, `SsrCache` — used by both Salvo and Axum integrations.
//! Only compiled when at least one integration feature is enabled.

use std::collections::HashMap;
use std::time::Instant;

use parking_lot::Mutex;

use crate::traits::{DispatchResult, ExternalFetcher};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ReqwestFetcher: external HTTP requests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Fetches absolute-URL requests via reqwest.
pub struct ReqwestFetcher {
  client: reqwest::Client,
}

impl ReqwestFetcher {
  pub fn new() -> Self {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().expect("failed to create reqwest client");
    Self { client }
  }
}

impl Default for ReqwestFetcher {
  fn default() -> Self {
    Self::new()
  }
}

impl ExternalFetcher for ReqwestFetcher {
  async fn fetch(&self, url: &str, method: &str, body: Option<&[u8]>, headers: &[(String, String)]) -> DispatchResult {
    tracing::debug!("SSR external fetch: {method} {url}");

    let http_method = method.parse::<reqwest::Method>().unwrap_or(reqwest::Method::GET);

    let mut req = self.client.request(http_method, url);

    let mut header_map = reqwest::header::HeaderMap::new();
    for (key, value) in headers {
      if let (Ok(name), Ok(val)) = (key.parse::<reqwest::header::HeaderName>(), value.parse::<reqwest::header::HeaderValue>()) {
        header_map.insert(name, val);
      }
    }
    req = req.headers(header_map);

    if let Some(body) = body {
      req = req.body(body.to_vec());
    }

    match req.send().await {
      Ok(resp) => {
        let status = resp.status().as_u16();
        let hdrs: HashMap<String, String> =
          resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
        let body = resp.text().await.unwrap_or_default();
        DispatchResult { status, headers: hdrs, body }
      }
      Err(e) => {
        tracing::error!("SSR external fetch failed: {method} {url} — {e}");
        DispatchResult { status: 502, headers: HashMap::new(), body: r#"{"error":"external fetch failed"}"#.to_string() }
      }
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SsrCache: in-memory HTML cache with bounded size
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Maximum number of cached entries before eviction.
const MAX_CACHE_ENTRIES: usize = 1024;

/// Simple in-memory HTML cache for SSR responses.
///
/// Uses `parking_lot::Mutex` (not `std::sync::Mutex`) to avoid poison panics.
/// Bounded to [`MAX_CACHE_ENTRIES`] — when full, the entire cache is cleared
/// rather than letting it grow without bound.
///
/// Cache is invalidated on process restart (no TTL needed for
/// static content — the HTML is baked into the binary via rust-embed).
pub struct SsrCache {
  entries: Mutex<HashMap<String, CachedEntry>>,
}

#[derive(Clone)]
pub struct CachedEntry {
  pub status: u16,
  pub headers: HashMap<String, String>,
  pub body: String,
  pub _cached_at: Instant,
}

impl SsrCache {
  /// Create a new empty cache.
  pub fn new() -> Self {
    Self { entries: Mutex::new(HashMap::new()) }
  }

  /// Look up a cached response by key.
  pub fn get(&self, key: &str) -> Option<CachedEntry> {
    let entries = self.entries.lock();
    entries.get(key).cloned()
  }

  /// Store a response in the cache.
  ///
  /// If the cache has reached [`MAX_CACHE_ENTRIES`], it is cleared entirely
  /// before inserting the new entry. This is a simple bulk eviction strategy
  /// suitable for SSR caches where all entries have similar value.
  pub fn set(&self, key: String, entry: CachedEntry) {
    let mut entries = self.entries.lock();
    if entries.len() >= MAX_CACHE_ENTRIES {
      tracing::debug!("SSR cache full ({MAX_CACHE_ENTRIES}), clearing");
      entries.clear();
    }
    entries.insert(key, entry);
  }
}

impl Default for SsrCache {
  fn default() -> Self {
    Self::new()
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Cache policy (shared between Salvo and Axum)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Determines if an SSR response is eligible for caching.
///
/// Only caches GET requests with 200 status that have no `set-cookie` header
/// and no query string. This is appropriate for static SSR content where
/// the HTML varies solely by URL path.
///
/// Note: The `Vary` header is not respected — responses that vary by
/// `Accept-Language` etc. should not be served through this cache.
pub fn is_cacheable(method: &str, status: u16, headers: &HashMap<String, String>, has_query: bool) -> bool {
  let has_cookie = headers.keys().any(|k| k.eq_ignore_ascii_case("set-cookie"));
  method == "GET" && status == 200 && !has_cookie && !has_query
}
