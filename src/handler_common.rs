//! Shared integration logic between web framework handlers.
//!
//! Both Salvo and Axum integrations follow the same pattern:
//! 1. Check cache by `method:path` key
//! 2. On miss, extract request data and render via QuickJS
//! 3. If cacheable, store in cache
//! 4. Build framework-specific response
//!
//! This module extracts the common rendering + caching logic so that
//! adding a new web framework (actix, warp, etc.) only requires writing
//! the dispatcher and response-building glue.

use std::sync::Arc;
use std::time::Instant;

use crate::engine::{SsrEngine, SsrRequest, SsrResponse};
use crate::shared::{CachedEntry, ReqwestFetcher, SsrCache, is_cacheable};
use crate::traits::InternalDispatcher;

/// Maximum body size for request payloads (10 MB).
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

/// Framework-agnostic SSR handler core.
///
/// Holds the engine and cache. Framework-specific wrappers (Salvo's `Handler`,
/// Axum's `Handler`) delegate to [`SsrHandlerCore::handle`] for the actual
/// rendering logic, then convert the [`RenderOutcome`] into their own response type.
pub struct SsrHandlerCore<D: InternalDispatcher> {
  engine: Arc<SsrEngine<D, ReqwestFetcher>>,
  cache: Arc<SsrCache>,
}

impl<D: InternalDispatcher> SsrHandlerCore<D> {
  /// Create a new handler wrapping the given engine.
  pub fn new(engine: Arc<SsrEngine<D, ReqwestFetcher>>) -> Self {
    Self { engine, cache: Arc::new(SsrCache::new()) }
  }

  /// Create from pre-existing engine and cache (for Clone implementations).
  pub fn new_from_parts(engine: Arc<SsrEngine<D, ReqwestFetcher>>, cache: Arc<SsrCache>) -> Self {
    Self { engine, cache }
  }

  /// Get a reference to the cache (for framework-specific Clone impls).
  pub fn cache(&self) -> &Arc<SsrCache> {
    &self.cache
  }

  /// Get a reference to the engine (for framework-specific Clone impls).
  pub fn engine(&self) -> &Arc<SsrEngine<D, ReqwestFetcher>> {
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

    // 1. Try cache first
    if let Some(cached) = self.cache.get(&cache_key) {
      return RenderOutcome::CacheHit(cached);
    }

    // 2. Cache miss — render via QuickJS
    match self.engine.render(incoming.ssr_request).await {
      Ok(ssr_res) => {
        let cacheable = is_cacheable(&method, ssr_res.status, &ssr_res.headers, has_query);

        if cacheable {
          self.cache.set(
            cache_key,
            CachedEntry {
              status: ssr_res.status,
              headers: ssr_res.headers.clone(),
              body: ssr_res.body.clone(),
              _cached_at: Instant::now(),
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RenderOutcome: result of the render pipeline
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Result of the SSR render pipeline, before conversion to a framework response.
pub enum RenderOutcome {
  /// Cache hit — return the cached entry with `x-ssr-cache: HIT`.
  CacheHit(CachedEntry),
  /// Fresh render — return with `x-ssr-cache: MISS`.
  Rendered(SsrResponse),
  /// Render failed — return 500 error page.
  Error,
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Static file serving helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Result of looking up a static asset from RustEmbed.
pub struct StaticAsset {
  /// MIME type string (e.g. "text/html", "application/javascript").
  pub mime: String,
  /// File content bytes.
  pub data: Vec<u8>,
  /// Whether the asset path contains "/immutable/" (long cache).
  pub immutable: bool,
}

/// Look up a static asset from a RustEmbed bundle.
///
/// Searches for `client{path}` in the embedded assets.
/// Returns `Some(StaticAsset)` if found, `None` otherwise.
pub fn lookup_static_asset<T: rust_embed::RustEmbed>(path: &str) -> Option<StaticAsset> {
  let asset_path = format!("client{path}");
  let file = T::get(&asset_path)?;
  let mime = mime_guess::from_path(&asset_path).first_or_octet_stream();
  Some(StaticAsset { mime: mime.as_ref().to_string(), data: file.data.to_vec(), immutable: asset_path.contains("/immutable/") })
}
