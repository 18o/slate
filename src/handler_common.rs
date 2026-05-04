//! SSR render pipeline — shared by all web framework integrations.
//!
//! [`SsrHandlerCore`] encapsulates the cache-lookup → render → cache-store
//! flow. Each web framework (Salvo, Axum, Actix) wraps this core with
//! framework-specific request extraction and response building.

use std::time::Duration;

#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use std::time::Instant;

use crate::engine::SsrRequest;
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use crate::engine::{SsrEngine, SsrResponse};
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use crate::shared::{CachedEntry, SsrCache, is_cacheable};
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use crate::traits::{ExternalFetcher, InternalDispatcher};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SsrConfig: user-facing configuration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Maximum body size for request payloads (10 MB).
#[cfg(any(feature = "salvo", feature = "axum"))]
pub const MAX_BODY_SIZE: usize = 10 * 1024 * 1024;

/// Default 500 error page HTML returned when SSR rendering fails.
pub const ERROR_PAGE_500: &str = "<html><body><h1>500 Internal Server Error</h1><p>SSR render failed</p></body></html>";

/// Configuration for the SSR engine and handler.
///
/// All fields have sensible defaults — you only need to set what differs.
///
/// ```
/// use slate::handler_common::SsrConfig;
///
/// let config = SsrConfig {
///     render_timeout: std::time::Duration::from_secs(10),
///     ..Default::default()
/// };
/// ```
pub struct SsrConfig {
  /// Custom 500 error page HTML. When `None`, a built-in page is used.
  pub error_html: Option<String>,
  /// Maximum time for a single `__render()` call. Default: 30 seconds.
  pub render_timeout: Duration,
  /// Number of parallel QuickJS worker threads. Default: 1.
  /// Set to 2–8 for high-concurrency deployments. Each worker runs an
  /// independent QuickJS context — memory cost is ~2 MB per worker.
  pub pool_size: usize,
}

impl Default for SsrConfig {
  fn default() -> Self {
    Self { error_html: None, render_timeout: Duration::from_secs(30), pool_size: 1 }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IncomingRequest: framework-extracted request data
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Fields extracted from a framework-specific request, ready for SSR rendering.
///
/// Framework handlers extract these from their request types, then pass
/// the struct to [`SsrHandlerCore::handle`]. This avoids per-framework
/// argument unpacking in the shared render pipeline.
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
#[derive(Debug)]
pub struct IncomingRequest {
  /// URL path component (used for cache key).
  pub path: String,
  /// Whether the URL has a query string (affects cache eligibility).
  pub has_query: bool,
  /// Full SSR request data (method, url, headers, body, remote_addr).
  pub ssr_request: SsrRequest,
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SsrHandlerCore: framework-agnostic render pipeline
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
pub use self::ssr_core::*;

#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
mod ssr_core {
  use super::*;
  use parking_lot::Mutex;
  use std::collections::HashMap;
  use std::collections::hash_map::Entry;
  use std::sync::Arc;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use tokio::sync::watch;

  /// Framework-agnostic SSR handler core.
  ///
  /// Holds one or more engines, a shared cache, and a pending-render map
  /// for request coalescing. When `pool_size > 1` (configured via
  /// [`SsrConfig`]), requests are distributed across engines in round-robin
  /// order. The cache and pending map are shared — cache hits and in-flight
  /// renders from any engine are visible to all.
  pub struct SsrHandlerCore<D: InternalDispatcher, F: ExternalFetcher> {
    engines: Vec<Arc<SsrEngine<D, F>>>,
    next: AtomicUsize,
    cache: Arc<SsrCache>,
    error_html: String,
    /// Tracks in-flight renders by cache key. Uses `watch::Sender<bool>` so
    /// waiters can atomically check the current state — no lost notifications.
    pending: Arc<Mutex<HashMap<String, Arc<watch::Sender<bool>>>>>,
  }

  impl<D: InternalDispatcher, F: ExternalFetcher> SsrHandlerCore<D, F> {
    pub fn new(engine: Arc<SsrEngine<D, F>>, config: &SsrConfig) -> Self {
      let error_html = config.error_html.clone().unwrap_or_else(|| ERROR_PAGE_500.to_string());
      Self {
        engines: vec![engine],
        next: AtomicUsize::new(0),
        cache: Arc::new(SsrCache::new()),
        error_html,
        pending: Arc::new(Mutex::new(HashMap::new())),
      }
    }

    pub fn pooled(engines: Vec<Arc<SsrEngine<D, F>>>, config: &SsrConfig) -> Self {
      assert!(!engines.is_empty(), "pooled engines must not be empty");
      let error_html = config.error_html.clone().unwrap_or_else(|| ERROR_PAGE_500.to_string());
      Self {
        engines,
        next: AtomicUsize::new(0),
        cache: Arc::new(SsrCache::new()),
        error_html,
        pending: Arc::new(Mutex::new(HashMap::new())),
      }
    }

    #[cfg(feature = "axum")]
    pub fn new_from_parts(engine: Arc<SsrEngine<D, F>>, cache: Arc<SsrCache>) -> Self {
      Self {
        engines: vec![engine],
        next: AtomicUsize::new(0),
        cache,
        error_html: ERROR_PAGE_500.to_string(),
        pending: Arc::new(Mutex::new(HashMap::new())),
      }
    }

    #[cfg(feature = "axum")]
    pub fn cache(&self) -> &Arc<SsrCache> {
      &self.cache
    }

    #[cfg(any(feature = "axum", feature = "actix"))]
    pub fn engine(&self) -> &Arc<SsrEngine<D, F>> {
      &self.engines[0]
    }

    pub fn error_html(&self) -> String {
      self.error_html.clone()
    }

    /// Execute the SSR render pipeline with request coalescing.
    ///
    /// 1. Cache hit → return immediately.
    /// 2. Another engine rendering this key → wait for it (with timeout).
    /// 3. No one rendering → claim and render.
    pub async fn handle(&self, incoming: IncomingRequest) -> RenderOutcome {
      let cache_key = format!("{}:{}", incoming.ssr_request.method, incoming.path);
      let method = incoming.ssr_request.method.clone();
      let has_query = incoming.has_query;

      // 1. Cache hit — return immediately
      if !has_query && let Some(cached) = self.cache.get(&cache_key) {
        return RenderOutcome::CacheHit(cached);
      }

      // 2. Request coalescing: atomically claim or subscribe, with retry loop
      loop {
        // Atomically check if someone is rendering, or claim the slot
        let maybe_rx = {
          let mut pending = self.pending.lock();
          match pending.entry(cache_key.clone()) {
            Entry::Occupied(e) => {
              // Another engine is rendering — subscribe to its completion signal
              Some(e.get().subscribe())
            }
            Entry::Vacant(e) => {
              // Claim: we're the renderer
              let (tx, _rx) = watch::channel(false);
              e.insert(Arc::new(tx));
              None
            }
          }
        };

        if let Some(mut rx) = maybe_rx {
          // Another engine is rendering — wait for completion
          if !*rx.borrow_and_update() {
            // Still rendering — wait with timeout (defense in depth)
            let wait_result = tokio::time::timeout(std::time::Duration::from_secs(60), rx.changed()).await;

            if wait_result.is_err() {
              // Waiter timeout — stale pending entry, clean up and break to error
              self.pending.lock().remove(&cache_key);
              tracing::warn!("coalescing wait timed out for {cache_key}");
              break RenderOutcome::Error;
            }
          }
          // Render completed — check cache
          if let Some(cached) = self.cache.get(&cache_key) {
            break RenderOutcome::CacheHit(cached);
          }
          // No cache entry — renderer failed. Loop back to re-claim.
          continue;
        }

        // 3. We claimed — pick an engine and render
        let engine = if self.engines.len() == 1 {
          &self.engines[0]
        } else {
          let idx = self.next.fetch_add(1, Ordering::Relaxed) % self.engines.len();
          &self.engines[idx]
        };

        let result = match engine.render(incoming.ssr_request).await {
          Ok(ssr_res) => {
            let cacheable = is_cacheable(&method, ssr_res.status, &ssr_res.headers, has_query, ssr_res.fetched);
            if cacheable {
              self.cache.set(
                cache_key.clone(),
                CachedEntry {
                  status: ssr_res.status,
                  headers: ssr_res.headers.clone(),
                  body: ssr_res.body.clone(),
                  cached_at: Instant::now(),
                },
              );
            }
            RenderOutcome::Rendered(ssr_res)
          }
          Err(e) => {
            tracing::error!("SSR render failed: {e}");
            RenderOutcome::Error
          }
        };

        // 4. Notify waiters — send completion signal, then remove entry
        {
          let mut pending = self.pending.lock();
          if let Some(tx) = pending.remove(&cache_key) {
            let _ = tx.send(true);
          }
        }

        break result;
      }
    }
  }

  /// Result of the SSR render pipeline, before conversion to a framework response.
  pub enum RenderOutcome {
    /// Cache hit — return the cached entry with `x-ssr-cache: HIT`.
    CacheHit(Arc<CachedEntry>),
    /// Fresh render — return with `x-ssr-cache: MISS`.
    Rendered(SsrResponse),
    /// Render failed — return 500 error page.
    Error,
  }
} // mod ssr_core
