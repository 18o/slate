use std::collections::HashMap;
use std::marker::PhantomData;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rquickjs::prelude::{Async, Func};
use rquickjs::{AsyncContext, AsyncRuntime, Ctx, Function, Object, Promise, async_with};
use rust_embed::RustEmbed;
use tokio::sync::{mpsc, oneshot};

use crate::polyfills;
use crate::traits::{DispatchResult, ExternalFetcher, InternalDispatcher};

/// Default timeout for a single render call (30 seconds).
const RENDER_TIMEOUT: Duration = Duration::from_secs(30);

/// Request data passed from Salvo handler into QuickJS `__render()`.
#[derive(Debug, Clone)]
pub struct SsrRequest {
  pub method: String,
  pub url: String,
  pub headers: HashMap<String, String>,
  pub body: Option<String>,
  pub remote_addr: String,
}

/// Response data returned from QuickJS `__render()`.
#[derive(Debug, Clone)]
pub struct SsrResponse {
  pub status: u16,
  pub headers: HashMap<String, String>,
  pub body: String,
  /// Whether any fetch (internal dispatch or external HTTP) was called during this render.
  /// Pages that fetch dynamic data should not be cached.
  pub fetched: bool,
}

type WorkerMsg = (SsrRequest, oneshot::Sender<anyhow::Result<SsrResponse>>);

/// In-process SSR engine powered by QuickJS.
///
/// On `new()`, a dedicated worker thread is spawned. The thread creates a
/// QuickJS runtime + context, injects polyfills and fetch functions, then
/// evaluates the IIFE bundle **once**. The initialized context (with the
/// SvelteKit `Server` object and `__render` function) lives for the entire
/// lifetime of the engine — exactly like Node.js/bun.
///
/// Each `render()` call sends a request to the worker via a channel and
/// awaits the result. The worker calls `__render(request)` on the existing
/// context, no re-initialization.
///
/// The engine is `Send + Sync` because the QuickJS runtime stays on the
/// worker thread. Communication is via async channels.
pub struct SsrEngine<D, F>
where
  D: InternalDispatcher,
  F: ExternalFetcher,
{
  request_tx: mpsc::Sender<WorkerMsg>,
  worker_alive: Arc<AtomicBool>,
  _worker_handle: Option<std::thread::JoinHandle<()>>,
  _phantom: PhantomData<(D, F)>,
}

impl<D, F> SsrEngine<D, F>
where
  D: InternalDispatcher,
  F: ExternalFetcher,
{
  /// Create a new SSR engine.
  ///
  /// Spawns a worker thread that:
  /// 1. Creates QuickJS `AsyncRuntime` + `AsyncContext`
  /// 2. Injects polyfills and native fetch functions
  /// 3. Evaluates the IIFE bundle (once)
  /// 4. Enters an event loop, calling `__render()` for each request
  ///
  /// Blocks until initialization completes (or fails).
  pub async fn new<T: RustEmbed>(dispatcher: D, fetcher: F) -> anyhow::Result<Self> {
    let file =
      T::get("entry.js").ok_or_else(|| anyhow::anyhow!("'entry.js' not found in embedded assets. Did you build with adapter-quickjs?"))?;
    let bundle_source = Arc::new(String::from_utf8(file.data.to_vec()).map_err(|e| anyhow::anyhow!("entry.js is not valid UTF-8: {e}"))?);

    tracing::info!("SsrEngine starting (bundle: {} bytes)", bundle_source.len());

    let bundle_size = bundle_source.len();

    let (init_tx, init_rx) = oneshot::channel();
    let (req_tx, req_rx) = mpsc::channel::<WorkerMsg>(64);

    let worker_alive = Arc::new(AtomicBool::new(true));
    let alive_flag = worker_alive.clone();

    let dispatcher = Arc::new(dispatcher);
    let fetcher = Arc::new(fetcher);
    let tokio_handle = tokio::runtime::Handle::current();

    let worker_handle = std::thread::spawn(move || {
      worker_entry(req_rx, init_tx, dispatcher, fetcher, bundle_source, tokio_handle, alive_flag);
    });

    // Wait for worker to finish initialization
    init_rx.await.map_err(|_| anyhow::anyhow!("SSR worker thread panicked during init"))??;

    tracing::info!("SsrEngine ready (bundle: {bundle_size} bytes)");

    Ok(Self { request_tx: req_tx, worker_alive, _worker_handle: Some(worker_handle), _phantom: PhantomData })
  }

  /// Render a page by calling `__render(request)` on the persistent context.
  ///
  /// Sends the request to the worker thread via channel and awaits the result.
  /// Times out after 30 seconds if the JS function does not return.
  ///
  /// Note: renders are processed serially on a single QuickJS context.
  /// For high concurrency, consider creating multiple engine instances.
  pub async fn render(&self, req: SsrRequest) -> anyhow::Result<SsrResponse> {
    if !self.worker_alive.load(Ordering::Relaxed) {
      return Err(anyhow::anyhow!("SSR worker has terminated — engine is unusable, recreate it"));
    }
    let (reply_tx, reply_rx) = oneshot::channel();
    self.request_tx.send((req, reply_tx)).await.map_err(|_| {
      self.worker_alive.store(false, Ordering::Relaxed);
      anyhow::anyhow!("SSR worker exited")
    })?;
    match tokio::time::timeout(RENDER_TIMEOUT, reply_rx).await {
      Ok(result) => result.map_err(|_| anyhow::anyhow!("SSR worker dropped"))?,
      Err(_) => Err(anyhow::anyhow!("SSR render timed out after {}s", RENDER_TIMEOUT.as_secs())),
    }
  }
}

impl<D, F> Drop for SsrEngine<D, F>
where
  D: InternalDispatcher,
  F: ExternalFetcher,
{
  fn drop(&mut self) {
    // Drop the sender first — this causes the worker's recv() to return None,
    // ending the event loop. The worker thread will then exit and the
    // AliveGuard will mark it as dead.
    drop(std::mem::replace(&mut self.request_tx, {
      // Create a dummy closed channel to satisfy the type system.
      // The worker will exit because the real sender was dropped.
      let (tx, _rx) = mpsc::channel::<WorkerMsg>(1);
      // Drop the receiver immediately — channel is closed.
      drop(_rx);
      tx
    }));
    tracing::debug!("SsrEngine dropped, worker channel closed");
  }
}

/// RAII guard that marks the worker as dead when dropped (normal exit or panic).
struct AliveGuard(Arc<AtomicBool>);
impl Drop for AliveGuard {
  fn drop(&mut self) {
    self.0.store(false, Ordering::Relaxed);
    tracing::warn!("SSR worker thread exiting — engine is no longer usable");
  }
}

/// Worker thread entry point.
///
/// Creates the QuickJS world once, then enters a request loop.
fn worker_entry<D, F>(
  mut req_rx: mpsc::Receiver<WorkerMsg>,
  init_tx: oneshot::Sender<anyhow::Result<()>>,
  dispatcher: Arc<D>,
  fetcher: Arc<F>,
  bundle_source: Arc<String>,
  tokio_handle: tokio::runtime::Handle,
  alive: Arc<AtomicBool>,
) where
  D: InternalDispatcher,
  F: ExternalFetcher,
{
  let local_rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
    Ok(rt) => rt,
    Err(e) => {
      let msg = format!("local runtime: {e}");
      tracing::error!("SSR init failed: {msg}");
      let _ = init_tx.send(Err(anyhow::anyhow!("{msg}")));
      return;
    }
  };

  // Enter main tokio runtime so Handle::current() inside async closures
  // returns the main runtime — dispatcher/fetcher futures run there.
  let _main_enter = tokio_handle.enter();

  // RAII: marks alive=false whether we exit normally or panic
  let _guard = AliveGuard(alive);

  local_rt.block_on(async move {
    // ── Init (once) ──────────────────────────────
    let rt = match AsyncRuntime::new() {
      Ok(rt) => rt,
      Err(e) => {
        let msg = format!("QuickJS runtime: {e}");
        tracing::error!("SSR init failed: {msg}");
        let _ = init_tx.send(Err(anyhow::anyhow!("{msg}")));
        return;
      }
    };
    rt.set_memory_limit(10 * 1024 * 1024).await;
    rt.set_max_stack_size(512 * 1024).await;

    let fetched = Arc::new(AtomicBool::new(false));
    let rendering = Arc::new(AtomicBool::new(false));

    let ctx = match init_context(&rt, &dispatcher, &fetcher, &bundle_source, fetched.clone(), rendering.clone()).await {
      Ok(ctx) => ctx,
      Err(e) => {
        let _ = init_tx.send(Err(e));
        return;
      }
    };

    // Signal init success back to caller
    if init_tx.send(Ok(())).is_err() {
      return; // Caller gone, exit
    }

    // ── Event loop (reuse context) ───────────────
    while let Some((req, reply)) = req_rx.recv().await {
      // Set interrupt handler to prevent JS infinite loops from blocking forever.
      // The handler checks if RENDER_TIMEOUT has elapsed since the request started.
      let deadline = std::time::Instant::now() + RENDER_TIMEOUT;
      rt.set_interrupt_handler(Some(Box::new(move || std::time::Instant::now() > deadline))).await;

      // Reset fetched flag before each render
      fetched.store(false, Ordering::Relaxed);
      // Mark as rendering — prevents recursive internal dispatch (deadlock guard)
      rendering.store(true, Ordering::Relaxed);

      let result = do_render(&ctx, req, &fetched).await;

      // Clear rendering flag and interrupt handler after each render
      rendering.store(false, Ordering::Relaxed);
      rt.set_interrupt_handler(None).await;

      if reply.send(result).is_err() {
        tracing::debug!("SSR reply dropped (caller gone)");
      }
    }
  });
}

/// Initialize QuickJS context: polyfills + fetch functions + eval bundle.
async fn init_context<D, F>(
  runtime: &AsyncRuntime,
  dispatcher: &Arc<D>,
  fetcher: &Arc<F>,
  bundle_source: &Arc<String>,
  fetched: Arc<AtomicBool>,
  rendering: Arc<AtomicBool>,
) -> anyhow::Result<AsyncContext>
where
  D: InternalDispatcher,
  F: ExternalFetcher,
{
  let ctx = AsyncContext::full(runtime).await?;

  let disp = dispatcher.clone();
  let fetch = fetcher.clone();
  let source = bundle_source.clone();

  async_with!(&ctx => |ctx| {
    polyfills::inject(&ctx)
      .map_err(|e| anyhow::anyhow!("Failed to inject polyfills: {e}"))?;

    inject_fetch_functions(&ctx, &disp, &fetch, fetched, rendering)
      .map_err(|e| anyhow::anyhow!("Failed to inject fetch functions: {e}"))?;

    ctx.eval::<(), _>(source.as_str())
      .map_err(|_| {
        let err_msg = extract_js_error(&ctx);
        anyhow::anyhow!("Failed to eval bundle: {err_msg}")
      })?;

    Ok::<_, anyhow::Error>(())
  })
  .await?;

  Ok(ctx)
}

/// Call `__render(request)` on the persistent context.
async fn do_render(ctx: &AsyncContext, req: SsrRequest, fetched: &AtomicBool) -> anyhow::Result<SsrResponse> {
  async_with!(ctx => |ctx| {
    let render_fn: Function = ctx
      .globals()
      .get("__render")
      .map_err(|e| anyhow::anyhow!("__render not found: {e}"))?;

    let req_obj = Object::new(ctx.clone())?;
    req_obj.set("method", req.method.as_str())?;
    req_obj.set("url", req.url.as_str())?;
    req_obj.set("remote_addr", req.remote_addr.as_str())?;
    if let Some(body) = &req.body {
      req_obj.set("body", body.as_str())?;
    }

    let headers_obj = Object::new(ctx.clone())?;
    for (k, v) in &req.headers {
      headers_obj.set(k.as_str(), v.as_str())?;
    }
    req_obj.set("headers", headers_obj)?;

    let promise: Promise = render_fn.call((req_obj,))?;
    let result: Object = promise.into_future().await.map_err(|_| {
      let err_msg = extract_js_error(&ctx);
      anyhow::anyhow!("__render() threw: {err_msg}")
    })?;

    let status: u16 = result.get("status")?;
    let body: String = result.get("body")?;

    let headers: HashMap<String, String> = result
      .get::<_, Object>("headers")
      .ok()
      .and_then(|h| rquickjs_serde::from_value(h.into()).ok())
      .unwrap_or_default();

    let did_fetch = fetched.load(Ordering::Relaxed);

    Ok(SsrResponse {
      status,
      headers,
      body,
      fetched: did_fetch,
    })
  })
  .await
}

/// Inject `__rust_internal_dispatch` and `__rust_http_fetch` into the context.
///
/// Both functions set the shared `fetched` flag to `true` when called,
/// so that `do_render` can detect whether the page performed dynamic data fetching.
/// The flag is shared via `Arc<AtomicBool>` — safe because renders are serial
/// (single worker thread, single context).
///
/// The `rendering` flag prevents recursive internal dispatch that would deadlock
/// the single-worker event loop (e.g., page `/foo` internally fetches `/foo`).
fn inject_fetch_functions<D, F>(
  ctx: &Ctx<'_>,
  dispatcher: &Arc<D>,
  fetcher: &Arc<F>,
  fetched: Arc<AtomicBool>,
  rendering: Arc<AtomicBool>,
) -> Result<(), rquickjs::Error>
where
  D: InternalDispatcher,
  F: ExternalFetcher,
{
  let globals = ctx.globals();

  let disp = dispatcher.clone();
  let f1 = fetched.clone();
  let ren = rendering.clone();
  globals.set(
    "__rust_internal_dispatch",
    Func::from(Async(move |method: String, path: String, body: Option<String>, headers: Object| {
      f1.store(true, Ordering::Relaxed);
      let hdrs = extract_headers(headers);
      let body_bytes = body.as_deref().map(|b| b.as_bytes()).map(|b| b.to_vec());
      let disp = disp.clone();
      let is_recursive = ren.load(Ordering::Relaxed);
      async move {
        // Deadlock guard: if we're already rendering, a recursive internal
        // dispatch would send to the channel and wait forever (single worker).
        if is_recursive {
          return DispatchResultJs(DispatchResult::error(503, "recursive internal dispatch detected"));
        }
        let result = disp.dispatch(&method, &path, body_bytes.as_deref(), &hdrs).await;
        DispatchResultJs(result)
      }
    })),
  )?;

  let fetch = fetcher.clone();
  let f2 = fetched.clone();
  globals.set(
    "__rust_http_fetch",
    Func::from(Async(move |url: String, method: String, body: Option<String>, headers: Object| {
      f2.store(true, Ordering::Relaxed);
      let hdrs = extract_headers(headers);
      let body_bytes = body.as_deref().map(|b| b.as_bytes()).map(|b| b.to_vec());
      let fetcher = fetch.clone();
      async move {
        let result = fetcher.fetch(&url, &method, body_bytes.as_deref(), &hdrs).await;
        DispatchResultJs(result)
      }
    })),
  )?;

  Ok(())
}

fn extract_headers(obj: Object) -> Vec<(String, String)> {
  rquickjs_serde::from_value::<HashMap<String, String>>(obj.into()).map(|m| m.into_iter().collect()).unwrap_or_default()
}

struct DispatchResultJs(DispatchResult);

impl<'js> rquickjs::IntoJs<'js> for DispatchResultJs {
  fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> rquickjs::Result<rquickjs::Value<'js>> {
    let obj = Object::new(ctx.clone())?;
    obj.set("status", self.0.status)?;
    // Convert binary body to string at the JS boundary — lossy for non-UTF-8
    let body_str = String::from_utf8_lossy(&self.0.body);
    obj.set("body", body_str.into_owned())?;

    let headers_obj = Object::new(ctx.clone())?;
    for (k, v) in &self.0.headers {
      headers_obj.set(k.as_str(), v.as_str())?;
    }
    obj.set("headers", headers_obj)?;

    Ok(obj.into_value())
  }
}

/// Extract a human-readable error message from a QuickJS thrown value.
///
/// Tries: string → Error.message property → debug representation.
fn extract_js_error(ctx: &Ctx<'_>) -> String {
  let val = ctx.catch();
  val
    .as_string()
    .and_then(|s| s.to_string().ok())
    .or_else(|| {
      let obj = val.as_object()?;
      obj.get::<_, String>("message").ok()
    })
    .unwrap_or_else(|| format!("{val:?}"))
}
