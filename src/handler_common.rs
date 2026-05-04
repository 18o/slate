//! SSR render pipeline — shared by all web framework integrations.
//!
//! [`SsrHandlerCore`] encapsulates the cache-lookup → render → cache-store
//! flow. Each web framework (Salvo, Axum, Actix) wraps this core with
//! framework-specific request extraction and response building.

#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use std::sync::Arc;
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use std::time::Instant;

use crate::engine::SsrRequest;
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use crate::engine::{SsrEngine, SsrResponse};
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use crate::shared::{CachedEntry, SsrCache, is_cacheable};
#[cfg(any(feature = "salvo", feature = "axum", feature = "actix"))]
use crate::traits::{ExternalFetcher, InternalDispatcher};

/// Maximum body size for request payloads (10 MB).
#[cfg(any(feature = "salvo", feature = "axum"))]
pub const MAX_BODY_SIZE: usize = 10 * 1024 * 1024;

/// 500 error page HTML returned when SSR rendering fails.
pub const ERROR_PAGE_500: &str = "<html><body><h1>500 Internal Server Error</h1><p>SSR render failed</p></body></html>";

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

  /// Framework-agnostic SSR handler core.
  ///
  /// Holds the engine and cache. Framework-specific wrappers (Salvo's `Handler`,
  /// Axum's `Handler`, Actix's `SsrHandler`) delegate to [`SsrHandlerCore::handle`]
  /// for the actual rendering logic, then convert the [`RenderOutcome`] into
  /// their own response type.
  pub struct SsrHandlerCore<D: InternalDispatcher, F: ExternalFetcher> {
    engine: Arc<SsrEngine<D, F>>,
    cache: Arc<SsrCache>,
  }

  impl<D: InternalDispatcher, F: ExternalFetcher> SsrHandlerCore<D, F> {
    /// Create a new handler wrapping the given engine.
    pub fn new(engine: Arc<SsrEngine<D, F>>) -> Self {
      Self { engine, cache: Arc::new(SsrCache::new()) }
    }

    /// Create from pre-existing engine and cache (for Clone implementations).
    #[cfg(feature = "axum")]
    pub fn new_from_parts(engine: Arc<SsrEngine<D, F>>, cache: Arc<SsrCache>) -> Self {
      Self { engine, cache }
    }

    /// Get a reference to the cache (for framework-specific Clone impls).
    #[cfg(feature = "axum")]
    pub fn cache(&self) -> &Arc<SsrCache> {
      &self.cache
    }

    /// Get a reference to the engine (for framework-specific Clone impls).
    #[cfg(any(feature = "axum", feature = "actix"))]
    pub fn engine(&self) -> &Arc<SsrEngine<D, F>> {
      &self.engine
    }

    /// Execute the SSR render pipeline.
    ///
    /// Returns a [`RenderOutcome`] that the caller converts into a
    /// framework-specific response. This method handles caching and rendering.
    pub async fn handle(&self, incoming: IncomingRequest) -> RenderOutcome {
      let cache_key = format!("{}:{}", incoming.ssr_request.method, incoming.path);
      let method = incoming.ssr_request.method.clone();
      let has_query = incoming.has_query;

      // 1. Try cache first — skip lookup for query-string requests to prevent stale hits
      if !has_query && let Some(cached) = self.cache.get(&cache_key) {
        return RenderOutcome::CacheHit(cached);
      }

      // 2. Cache miss — render via QuickJS
      match self.engine.render(incoming.ssr_request).await {
        Ok(ssr_res) => {
          let cacheable = is_cacheable(&method, ssr_res.status, &ssr_res.headers, has_query, ssr_res.fetched);

          if cacheable {
            self.cache.set(
              cache_key,
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
