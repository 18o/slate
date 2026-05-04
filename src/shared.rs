//! Shared types between web framework integrations.
//!
//! `ReqwestFetcher`, `SsrCache` — used by both Salvo and Axum integrations.
//! Only compiled when at least one integration feature is enabled.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;

use crate::traits::{DispatchResult, ExternalFetcher};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ReqwestFetcher: external HTTP requests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Maximum response body size for external fetches (10 MB).
const MAX_EXTERNAL_BODY_SIZE: usize = 10 * 1024 * 1024;

/// Fetches absolute-URL requests via reqwest.
pub struct ReqwestFetcher {
  client: reqwest::Client,
}

impl ReqwestFetcher {
  pub fn new() -> anyhow::Result<Self> {
    let client = reqwest::Client::builder()
      .timeout(std::time::Duration::from_secs(10))
      .build()
      .map_err(|e| anyhow::anyhow!("failed to create reqwest client: {e}"))?;
    Ok(Self { client })
  }
}

/// Check if a URL is safe to fetch (SSRF protection).
///
/// Blocks:
/// - Loopback addresses (127.0.0.1, ::1, localhost)
/// - Link-local addresses (169.254.x.x, fe80::)
/// - Cloud metadata endpoint (169.254.169.254)
/// - Private/RFC 1918 addresses (10.x, 172.16-31, 192.168.x)
fn is_url_allowed(url: &str) -> bool {
  let parsed = match url::Url::parse(url) {
    Ok(u) => u,
    Err(_) => return false,
  };

  let host = match parsed.host_str() {
    Some(h) => h,
    None => return false,
  };

  // Block well-known metadata endpoint
  if host == "169.254.169.254" {
    return false;
  }

  // Block localhost
  if host == "localhost" {
    return false;
  }

  // Check if host is an IP address
  if let Ok(ip) = host.parse::<IpAddr>() {
    // Handle IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 → 127.0.0.1)
    let check_ip = match ip {
      IpAddr::V6(ref v6) if let Some(v4) = v6.to_ipv4() => IpAddr::V4(v4),
      other => other,
    };
    if check_ip.is_loopback() || check_ip.is_unspecified() || is_link_local(&check_ip) || is_private(&check_ip) {
      return false;
    }
    // Also block non-mapped IPv6 unique local (fc00::/7)
    if let IpAddr::V6(v6) = ip
      && is_ipv6_unique_local(&v6)
    {
      return false;
    }
  }

  true
}

/// Check if an IP is link-local (169.254.0.0/16 for IPv4, fe80::/10 for IPv6).
fn is_link_local(ip: &IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => v4.is_link_local(),
    IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
  }
}

/// Check if an IP is in private ranges.
fn is_private(ip: &IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => {
      let octets = v4.octets();
      // 10.0.0.0/8
      octets[0] == 10
        // 172.16.0.0/12
        || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
        // 192.168.0.0/16
        || (octets[0] == 192 && octets[1] == 168)
    }
    IpAddr::V6(_) => false, // IPv6 handled separately by is_ipv6_unique_local
  }
}

/// Check if an IPv6 address is unique local (fc00::/7).
fn is_ipv6_unique_local(v6: &std::net::Ipv6Addr) -> bool {
  (v6.segments()[0] & 0xfe00) == 0xfc00
}

impl ExternalFetcher for ReqwestFetcher {
  async fn fetch(&self, url: &str, method: &str, body: Option<&[u8]>, headers: &[(String, String)]) -> DispatchResult {
    // SSRF protection — block internal/metadata addresses
    if !is_url_allowed(url) {
      tracing::warn!("SSR external fetch blocked (SSRF): {method} {url}");
      return DispatchResult::error(403, "SSRF: target address not allowed");
    }

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

        // Enforce body size limit
        if let Some(content_length) = resp.content_length()
          && content_length as usize > MAX_EXTERNAL_BODY_SIZE
        {
          tracing::warn!("SSR external fetch: response too large ({content_length} bytes) — {method} {url}");
          return DispatchResult::error(502, "response body exceeds size limit");
        }

        let hdrs: Vec<(String, String)> =
          resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
        let body_bytes = match resp.bytes().await {
          Ok(bytes) => bytes,
          Err(e) => {
            tracing::warn!("SSR external fetch: failed to read response body ({method} {url}): {e}");
            return DispatchResult { status, headers: hdrs, body: Vec::new() };
          }
        };

        // Final size check for chunked responses
        if body_bytes.len() > MAX_EXTERNAL_BODY_SIZE {
          tracing::warn!("SSR external fetch: chunked response too large ({} bytes) — {method} {url}", body_bytes.len());
          return DispatchResult::error(502, "response body exceeds size limit");
        }

        DispatchResult { status, headers: hdrs, body: body_bytes.to_vec() }
      }
      Err(e) => {
        tracing::error!("SSR external fetch failed: {method} {url} — {e}");
        DispatchResult::error(502, "external fetch failed")
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
/// Bounded to [`MAX_CACHE_ENTRIES`] — when full, the oldest half of entries
/// (by insertion order) are evicted to avoid a thundering-herd re-render scenario.
///
/// Entries are stored as `Arc<CachedEntry>` so that cache hits only clone
/// the Arc pointer (not the entire body string).
///
/// Cache is invalidated on process restart (no TTL needed for
/// static content — the HTML is baked into the binary via rust-embed).
pub struct SsrCache {
  /// Ordered map: insertion order is tracked for FIFO eviction.
  entries: Mutex<Vec<(String, Arc<CachedEntry>)>>,
}

#[derive(Clone)]
pub struct CachedEntry {
  pub status: u16,
  pub headers: Vec<(String, String)>,
  pub body: String,
  pub cached_at: Instant,
}

impl SsrCache {
  /// Create a new empty cache.
  pub fn new() -> Self {
    Self { entries: Mutex::new(Vec::new()) }
  }

  /// Look up a cached response by key.
  ///
  /// Returns a clone of the `Arc<CachedEntry>` — O(1) pointer copy,
  /// no string cloning regardless of body size.
  pub fn get(&self, key: &str) -> Option<Arc<CachedEntry>> {
    let entries = self.entries.lock();
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
  }

  /// Store a response in the cache.
  ///
  /// If the cache has reached [`MAX_CACHE_ENTRIES`], the oldest half of the
  /// entries (first half of the Vec) are evicted in O(n/2) instead of sorting.
  /// This avoids a thundering-herd scenario where all cached pages
  /// need re-rendering simultaneously.
  pub fn set(&self, key: String, entry: CachedEntry) {
    let mut entries = self.entries.lock();

    // If key already exists, update in place
    if let Some(pos) = entries.iter().position(|(k, _)| k == &key) {
      entries[pos].1 = Arc::new(entry);
      return;
    }

    if entries.len() >= MAX_CACHE_ENTRIES {
      let evict_count = entries.len() / 2;
      tracing::debug!("SSR cache full ({MAX_CACHE_ENTRIES}), evicting oldest {evict_count} entries");
      // Drain oldest entries — they're at the front of the Vec (insertion order)
      entries.drain(0..evict_count);
    }
    entries.push((key, Arc::new(entry)));
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
/// Only caches GET requests with 200 status that have no `set-cookie` header,
/// no query string, and did not perform dynamic data fetching during render.
///
/// The `fetched` flag is set by the engine when any `__rust_internal_dispatch`
/// or `__rust_http_fetch` call was made during `__render()`. Pages that fetch
/// dynamic data (e.g. from `/api/*` or third-party APIs) should not be cached
/// because their content varies per request.
///
/// Note: The `Vary` header is not respected — responses that vary by
/// `Accept-Language` etc. should not be served through this cache.
pub fn is_cacheable(method: &str, status: u16, headers: &[(String, String)], has_query: bool, fetched: bool) -> bool {
  let has_cookie = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("set-cookie"));
  method == "GET" && status == 200 && !has_cookie && !has_query && !fetched
}
