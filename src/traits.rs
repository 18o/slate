use std::collections::HashMap;

/// Result of an internal dispatch (zero-HTTP call to a Rust handler)
/// or an external HTTP fetch.
#[derive(Debug, Clone)]
pub struct DispatchResult {
  pub status: u16,
  pub headers: HashMap<String, String>,
  pub body: String,
}

/// Handles relative-path fetch requests by dispatching directly
/// to the Rust service layer without going through HTTP.
///
/// Implemented by `SalvoDispatcher` when the `salvo` feature is enabled.
pub trait InternalDispatcher: Send + Sync + 'static {
  fn dispatch(
    &self,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    headers: &[(String, String)],
  ) -> impl std::future::Future<Output = DispatchResult> + Send;
}

/// Handles absolute-URL fetch requests via real HTTP.
///
/// Implemented by `ReqwestFetcher` when the `salvo` feature is enabled.
pub trait ExternalFetcher: Send + Sync + 'static {
  fn fetch(
    &self,
    url: &str,
    method: &str,
    body: Option<&[u8]>,
    headers: &[(String, String)],
  ) -> impl std::future::Future<Output = DispatchResult> + Send;
}
