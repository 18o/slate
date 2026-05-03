//! # slate
//!
//! In-process SSR engine: embeds QuickJS to render JS framework pages
//! without spawning external Node.js/bun processes.
//!
//! ## Architecture
//!
//! ```text
//! Browser → Web Framework → ProductionHandler
//!                              ↓
//!                       static file? ──yes──→ RustEmbed (memory)
//!                              │
//!                             no
//!                              ↓
//!                       SsrHandler → [cache check]
//!                                      ↓ miss
//!                                  Worker Thread (persistent)
//!                                      ↓
//!                                  QuickJS (reused context)
//!                                      ↓
//!                                  __render(request)
//!                                      ↓ (fetch in JS)
//!                                  InternalDispatcher or ExternalFetcher
//!                                      ↓
//!                                  SsrResponse → HTML → Browser
//! ```
//!
//! ## Framework adapters
//!
//! JS framework adapters live in `adapters/`:
//! - `adapter-sveltekit` — SvelteKit → IIFE bundle (rolldown)
//! - `adapter-vue` — Vue 3 → IIFE bundle (rolldown)
//! - `adapter-react` — React → IIFE bundle (rolldown)
//!
//! Each adapter outputs an `entry.js` IIFE that exposes
//! `globalThis.__render(request) → { status, headers, body }`.
//!
//! ## Web framework integrations
//!
//! Enable via feature flags:
//! - `salvo` — `slate::salvo::*`
//! - `axum`  — `slate::axum::*`

mod engine;
mod polyfills;
mod traits;

pub use engine::{SsrEngine, SsrRequest, SsrResponse};
pub use traits::{DispatchResult, ExternalFetcher, InternalDispatcher};

// Shared types between web framework integrations
#[cfg(any(feature = "salvo", feature = "axum"))]
mod shared;

// Shared handler logic between web framework integrations
#[cfg(any(feature = "salvo", feature = "axum"))]
mod handler_common;

#[cfg(feature = "salvo")]
mod salvo_integration;

#[cfg(feature = "salvo")]
pub mod salvo {
  //! Salvo integration — re-exports for `slate::salvo::*`.
  pub use crate::salvo_integration::{InternalDispatchMarker, ProductionHandler, SalvoDispatcher, SsrHandler, init_ssr};
  pub use crate::shared::{CachedEntry, ReqwestFetcher, SsrCache};
}

#[cfg(feature = "axum")]
mod axum_integration;

#[cfg(feature = "axum")]
pub mod axum {
  //! Axum integration — re-exports for `slate::axum::*`.
  pub use crate::axum_integration::{AxumDispatcher, ProductionHandler, SsrHandler, init_ssr};
  pub use crate::shared::{CachedEntry, ReqwestFetcher, SsrCache};
}
