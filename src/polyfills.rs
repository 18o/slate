use std::sync::OnceLock;
use std::time::Instant;

use rquickjs::prelude::Func;
use rquickjs::{Array, Class, Ctx, JsLifetime, TypedArray};

/// Monotonic start instant for performance.now() relative measurements.
/// Set once at first inject — all engine instances share the same time origin.
static PERF_START: OnceLock<Instant> = OnceLock::new();

/// Inject native polyfills into the QuickJS context.
///
/// MUST be called BEFORE `bundler::eval_bundle()` so that the IIFE bundle's
/// `typeof TextEncoder === 'undefined'` checks detect the native
/// versions and skip JS fallbacks.
pub fn inject(ctx: &Ctx<'_>) -> Result<(), rquickjs::Error> {
  let globals = ctx.globals();

  // ── TextEncoder / TextDecoder (native) ──────────────────────
  Class::<JsTextEncoder>::define(&globals)?;
  Class::<JsTextDecoder>::define(&globals)?;

  // ── btoa / atob ─────────────────────────────────────────────
  globals.set("btoa", Func::from(|input: String| -> Result<String, rquickjs::Error> { btoa_encode(&input) }))?;
  globals.set("atob", Func::from(|input: String| -> Result<String, rquickjs::Error> { atob_decode(&input) }))?;

  // ── Headers (native) ────────────────────────────────────────
  Class::<JsHeaders>::define(&globals)?;

  // ── URL / URLSearchParams (native) ──────────────────────────
  Class::<JsUrl>::define(&globals)?;
  Class::<JsUrlSearchParams>::define(&globals)?;

  // ── performance.now ─────────────────────────────────────────
  PERF_START.get_or_init(Instant::now);
  globals.set(
    "__rust_performance_now",
    Func::from(move || {
      let start = PERF_START.get_or_init(Instant::now);
      start.elapsed().as_secs_f64() * 1000.0
    }),
  )?;

  // ── crypto ──────────────────────────────────────────────────
  globals.set(
    "__rust_crypto_random_hex",
    Func::from(|len: usize| -> String {
      use rand::Rng;
      let mut bytes = vec![0u8; len];
      rand::rng().fill_bytes(&mut bytes);
      bytes_to_hex(&bytes)
    }),
  )?;

  globals.set(
    "__rust_crypto_random_uuid",
    Func::from(|| -> String {
      use rand::RngExt;
      let mut rng = rand::rng();
      let mut bytes = [0u8; 16];
      rng.fill(&mut bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
      )
    }),
  )?;

  globals.set(
    "__rust_crypto_subtle_digest_hex",
    Func::from(|_algo: String, data_hex: String| -> String {
      let bytes: Vec<u8> = data_hex
        .as_bytes()
        .chunks_exact(2)
        .filter_map(|chunk| {
          let s = std::str::from_utf8(chunk).ok()?;
          u8::from_str_radix(s, 16).ok()
        })
        .collect();
      let hash = sha256_digest(&bytes);
      bytes_to_hex(&hash)
    }),
  )?;

  // ── console forwarding ──────────────────────────────────────
  globals.set(
    "__rust_console_log",
    Func::from(|level: String, msg: String| match level.as_str() {
      "[ERR]" => tracing::error!("[JS] {msg}"),
      "[WARN]" => tracing::warn!("[JS] {msg}"),
      "[INFO]" => tracing::info!("[JS] {msg}"),
      _ => tracing::debug!("[JS] {msg}"),
    }),
  )?;

  // ── JS patches ──────────────────────────────────────────────
  // These tiny snippets connect Rust Classes with JS semantics that
  // rquickjs Class cannot express directly (Symbol.iterator, copy
  // construction, property getters that return other Class instances).
  ctx.eval::<(), _>(JS_PATCHES)?;

  // ── remaining JS polyfills ──────────────────────────────────
  ctx.eval::<(), _>(include_str!("polyfills.js"))?;

  Ok(())
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JS patches — evaluated once during inject()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const JS_PATCHES: &str = r#"
// ── Headers copy-construction wrapper ──
// The Rust JsHeaders constructor handles arrays and plain objects but
// cannot inspect another JsHeaders instance's internal Vec. This wrapper
// detects the copy case and uses forEach to extract entries.
var _JsHeaders = Headers;
globalThis.Headers = function(init) {
  if (init instanceof _JsHeaders) {
    var entries = [];
    init.forEach(function(v, k) { entries.push([k, v]); });
    return new _JsHeaders(entries);
  }
  return new _JsHeaders(init || undefined);
};
Headers.prototype = _JsHeaders.prototype;

// ── Headers Symbol.iterator ──
Headers.prototype[Symbol.iterator] = Headers.prototype.entries;

// ── console ──
// Registered from Rust so that polyfills.js doesn't need to carry it.
if (typeof console === 'undefined') {
  var _console_fn = (typeof __rust_console_log !== 'undefined') ? __rust_console_log : function() {};
  var _ansiRe = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  function _joinArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      try {
        var v = args[i];
        var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        parts.push(s.replace(_ansiRe, ''));
      } catch(e) {
        parts.push(String(args[i]).replace(_ansiRe, ''));
      }
    }
    return parts.join(' ');
  }
  globalThis.console = {
    log:   function() { _console_fn('[LOG]',  _joinArgs(arguments)); },
    error: function() { _console_fn('[ERR]',  _joinArgs(arguments)); },
    warn:  function() { _console_fn('[WARN]', _joinArgs(arguments)); },
    info:  function() { _console_fn('[INFO]', _joinArgs(arguments)); },
  };
}

// ── URL constructor wrapper ──
// rquickjs counts Option<T> as a required parameter, so new URL(url)
// with 1 arg fails. This wrapper always forwards 2 args to the Rust
// constructor; when JS omits the base arg, undefined → None on the
// Rust side.
// Also coerces both url and base to string — SvelteKit sometimes passes
// existing URL objects: new URL(string, urlObject) or new URL(urlObject).
var _Url = URL;
globalThis.URL = function(url, base) {
  var urlStr = (url instanceof _Url) ? url.href : String(url);
  var baseStr = (base instanceof _Url) ? base.href : base;
  return new _Url(urlStr, baseStr);
};
URL.prototype = _Url.prototype;

// ── URL property getters ──
// Defined as JS getters because rquickjs #[qjs(get)] doesn't handle
// String return types well. The Rust class stores data in internal fields
// and exposes _get_* methods for the getters to call.
Object.defineProperties(URL.prototype, {
  protocol:  { get: function() { return this._get_protocol(); } },
  hostname:  { get: function() { return this._get_hostname(); } },
  port:      { get: function() { return this._get_port(); } },
  host:      { get: function() { return this._get_host(); } },
  origin:    { get: function() { return this._get_origin(); } },
  pathname:  { get: function() { return this._get_pathname(); } },
  search:    { get: function() { return this._get_search(); } },
  hash:      { get: function() { return this._get_hash(); } },
  href:      { get: function() { return this._get_href(); } },
  // NOTE: Returns a fresh instance each access — mutations to the returned
  // URLSearchParams do NOT propagate back to the URL. This is acceptable for
  // SSR (read-only query parsing) but differs from WHATWG spec.
  searchParams: {
    get: function() { return new URLSearchParams(this._get_search()); },
    configurable: true,
  },
});

// ── URLSearchParams Symbol.iterator ──
URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
"#;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Headers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(rquickjs::class::Trace, JsLifetime)]
#[rquickjs::class(rename = "Headers")]
struct JsHeaders {
  list: Vec<(String, String)>,
}

#[rquickjs::methods]
#[allow(non_snake_case)]
impl JsHeaders {
  #[qjs(constructor)]
  fn new(init: Option<rquickjs::Value<'_>>) -> Result<Self, rquickjs::Error> {
    let mut list = Vec::new();
    if let Some(val) = init {
      if let Some(arr) = val.as_array() {
        for i in 0..arr.len() {
          if let Ok(pair) = arr.get::<Array>(i) {
            let k: String = pair.get(0).unwrap_or_default();
            let v: String = pair.get(1).unwrap_or_default();
            list.push((k.to_lowercase(), v));
          }
        }
      } else if val.is_object()
        && let Ok(map) = rquickjs_serde::from_value::<std::collections::HashMap<String, String>>(val.clone())
      {
        for (k, v) in map {
          list.push((k.to_lowercase(), v));
        }
      }
    }
    Ok(Self { list })
  }

  fn get(&self, name: String) -> Option<String> {
    let name = name.to_lowercase();
    // WHATWG: get() joins all values with ", " for ALL headers.
    // Use getSetCookie() for individual set-cookie values.
    let values: Vec<&str> = self.list.iter().filter(|(k, _)| k == &name).map(|(_, v)| v.as_str()).collect();
    if values.is_empty() { None } else { Some(values.join(", ")) }
  }

  fn set(&mut self, name: String, value: String) {
    let name = name.to_lowercase();
    self.list.retain(|(k, _)| k != &name);
    self.list.push((name, value));
  }

  fn has(&self, name: String) -> bool {
    let name = name.to_lowercase();
    self.list.iter().any(|(k, _)| k == &name)
  }

  #[qjs(rename = "delete")]
  fn delete_header(&mut self, name: String) {
    let name = name.to_lowercase();
    self.list.retain(|(k, _)| k != &name);
  }

  fn append(&mut self, name: String, value: String) {
    self.list.push((name.to_lowercase(), value));
  }

  fn forEach<'js>(&self, cb: rquickjs::Function<'js>) -> Result<(), rquickjs::Error> {
    for (k, v) in &self.list {
      let _: () = cb.call((v.as_str(), k.as_str()))?;
    }
    Ok(())
  }

  fn entries<'js>(&self, ctx: Ctx<'js>) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    for (i, (k, v)) in self.list.iter().enumerate() {
      let pair = Array::new(ctx.clone())?;
      pair.set(0, k.as_str())?;
      pair.set(1, v.as_str())?;
      arr.set(i, pair)?;
    }
    Ok(arr)
  }

  fn keys<'js>(&self, ctx: Ctx<'js>) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    let mut seen = std::collections::HashSet::new();
    let mut idx = 0usize;
    for (k, _) in &self.list {
      if seen.insert(k.clone()) {
        arr.set(idx, k.as_str())?;
        idx += 1;
      }
    }
    Ok(arr)
  }

  fn values<'js>(&self, ctx: Ctx<'js>) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    for (i, (_, v)) in self.list.iter().enumerate() {
      arr.set(i, v.as_str())?;
    }
    Ok(arr)
  }

  #[qjs(rename = "getSetCookie")]
  fn get_set_cookie<'js>(&self, ctx: Ctx<'js>) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    let mut idx = 0usize;
    for (k, v) in &self.list {
      if k == "set-cookie" {
        arr.set(idx, v.as_str())?;
        idx += 1;
      }
    }
    Ok(arr)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// URL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(rquickjs::class::Trace, JsLifetime)]
#[rquickjs::class(rename = "URL")]
struct JsUrl {
  protocol: String,
  hostname: String,
  port: String,
  host: String,
  origin: String,
  pathname: String,
  search: String,
  hash: String,
  href: String,
}

impl JsUrl {
  fn parse_flexible(input: &str) -> Option<url::Url> {
    url::Url::parse(input).ok().or_else(|| {
      let default = if input.starts_with('/') { format!("http://localhost{input}") } else { format!("http://localhost/{input}") };
      url::Url::parse(&default).ok()
    })
  }

  fn from_url(url: url::Url) -> Self {
    let scheme = url.scheme().to_string();
    let hostname = url.host_str().unwrap_or("").to_string();
    let port = url.port().map_or_else(String::new, |p| p.to_string());
    let host = if port.is_empty() { hostname.clone() } else { format!("{hostname}:{port}") };
    let origin = format!("{scheme}://{host}");
    let pathname = url.path().to_string();
    let search = url.query().map_or_else(String::new, |q| format!("?{q}"));
    let hash = url.fragment().map_or_else(String::new, |f| format!("#{f}"));
    let href = url.to_string();

    Self { protocol: format!("{scheme}:"), hostname, port, host, origin, pathname, search, hash, href }
  }
}

#[rquickjs::methods]
impl JsUrl {
  #[qjs(constructor)]
  fn new(url_str: String, base: Option<String>) -> Result<Self, rquickjs::Error> {
    let parsed = match base {
      Some(ref base_str) => {
        let base_url = Self::parse_flexible(base_str).ok_or_else(|| rquickjs::Error::new_loading("Invalid base URL"))?;
        base_url.join(&url_str).map_err(|_| rquickjs::Error::new_loading("Invalid URL with base"))?
      }
      None => Self::parse_flexible(&url_str).ok_or_else(|| rquickjs::Error::new_loading("Invalid URL"))?,
    };
    Ok(Self::from_url(parsed))
  }

  // Property accessors — called from JS getters defined in JS_PATCHES.
  // Named _get_* to avoid conflicting with struct field names.
  #[qjs(rename = "_get_protocol")]
  fn get_protocol(&self) -> String {
    self.protocol.clone()
  }

  #[qjs(rename = "_get_hostname")]
  fn get_hostname(&self) -> String {
    self.hostname.clone()
  }

  #[qjs(rename = "_get_port")]
  fn get_port(&self) -> String {
    self.port.clone()
  }

  #[qjs(rename = "_get_host")]
  fn get_host(&self) -> String {
    self.host.clone()
  }

  #[qjs(rename = "_get_origin")]
  fn get_origin(&self) -> String {
    self.origin.clone()
  }

  #[qjs(rename = "_get_pathname")]
  fn get_pathname(&self) -> String {
    self.pathname.clone()
  }

  #[qjs(rename = "_get_search")]
  fn get_search(&self) -> String {
    self.search.clone()
  }

  #[qjs(rename = "_get_hash")]
  fn get_hash(&self) -> String {
    self.hash.clone()
  }

  #[qjs(rename = "_get_href")]
  fn get_href(&self) -> String {
    self.href.clone()
  }

  #[qjs(rename = "toString")]
  fn js_to_string(&self) -> String {
    self.href.clone()
  }

  #[qjs(rename = "toJSON")]
  fn js_to_json(&self) -> String {
    self.href.clone()
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// URLSearchParams
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(rquickjs::class::Trace, JsLifetime)]
#[rquickjs::class(rename = "URLSearchParams")]
struct JsUrlSearchParams {
  params: Vec<(String, String)>,
}

impl JsUrlSearchParams {
  fn from_query_string(query: &str) -> Self {
    let mut params = Vec::new();
    let query = query.trim_start_matches('?');
    if !query.is_empty() {
      for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = safe_decode(parts.next().unwrap_or(""));
        let value = safe_decode(parts.next().unwrap_or(""));
        params.push((key, value));
      }
    }
    Self { params }
  }
}

#[rquickjs::methods]
#[allow(non_snake_case)]
impl JsUrlSearchParams {
  #[qjs(constructor)]
  fn new(init: Option<rquickjs::Value<'_>>) -> Result<Self, rquickjs::Error> {
    let params = match init {
      None => Vec::new(),
      Some(val) => {
        if let Some(s) = val.as_string() {
          let query = s.to_string().unwrap_or_default();
          Self::from_query_string(&query).params
        } else if let Some(arr) = val.as_array() {
          let mut params = Vec::new();
          for i in 0..arr.len() {
            if let Ok(pair) = arr.get::<Array>(i) {
              let k: String = pair.get(0).unwrap_or_default();
              let v: String = pair.get(1).unwrap_or_default();
              params.push((k, v));
            }
          }
          params
        } else if val.is_object()
          && let Ok(map) = rquickjs_serde::from_value::<std::collections::HashMap<String, String>>(val.clone())
        {
          map.into_iter().collect()
        } else {
          Vec::new()
        }
      }
    };
    Ok(Self { params })
  }

  fn get(&self, name: String) -> Option<String> {
    for (k, v) in &self.params {
      if k == &name {
        return Some(v.clone());
      }
    }
    None
  }

  fn getAll<'js>(&self, ctx: Ctx<'js>, name: String) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    let mut idx = 0usize;
    for (k, v) in &self.params {
      if k == &name {
        arr.set(idx, v.as_str())?;
        idx += 1;
      }
    }
    Ok(arr)
  }

  fn has(&self, name: String) -> bool {
    self.params.iter().any(|(k, _)| k == &name)
  }

  fn set(&mut self, name: String, value: String) {
    let mut found = false;
    let mut i = 0;
    while i < self.params.len() {
      if self.params[i].0 == name {
        if !found {
          self.params[i].1 = value.clone();
          found = true;
        } else {
          self.params.remove(i);
          continue;
        }
      }
      i += 1;
    }
    if !found {
      self.params.push((name, value));
    }
  }

  fn append(&mut self, name: String, value: String) {
    self.params.push((name, value));
  }

  #[qjs(rename = "delete")]
  fn delete_param(&mut self, name: String) {
    self.params.retain(|(k, _)| k != &name);
  }

  fn toString(&self) -> String {
    self.params.iter().map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v))).collect::<Vec<_>>().join("&")
  }

  fn keys<'js>(&self, ctx: Ctx<'js>) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    for (i, (k, _)) in self.params.iter().enumerate() {
      arr.set(i, k.as_str())?;
    }
    Ok(arr)
  }

  fn values<'js>(&self, ctx: Ctx<'js>) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    for (i, (_, v)) in self.params.iter().enumerate() {
      arr.set(i, v.as_str())?;
    }
    Ok(arr)
  }

  fn entries<'js>(&self, ctx: Ctx<'js>) -> Result<Array<'js>, rquickjs::Error> {
    let arr = Array::new(ctx.clone())?;
    for (i, (k, v)) in self.params.iter().enumerate() {
      let pair = Array::new(ctx.clone())?;
      pair.set(0, k.as_str())?;
      pair.set(1, v.as_str())?;
      arr.set(i, pair)?;
    }
    Ok(arr)
  }

  fn forEach<'js>(&self, cb: rquickjs::Function<'js>) -> Result<(), rquickjs::Error> {
    for (k, v) in &self.params {
      let _: () = cb.call((v.as_str(), k.as_str()))?;
    }
    Ok(())
  }

  #[qjs(get)]
  fn size(&self) -> u32 {
    self.params.len() as u32
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TextEncoder (native)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(rquickjs::class::Trace, JsLifetime)]
#[rquickjs::class(rename = "TextEncoder")]
struct JsTextEncoder {}

#[rquickjs::methods]
impl JsTextEncoder {
  #[qjs(constructor)]
  fn new() -> Self {
    Self {}
  }

  /// Returns a `Uint8Array` (via rquickjs TypedArray) so that `.byteLength` works.
  fn encode<'js>(&self, ctx: Ctx<'js>, input: String) -> rquickjs::Result<rquickjs::TypedArray<'js, u8>> {
    let bytes = input.into_bytes();
    rquickjs::TypedArray::new(ctx, bytes)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TextDecoder (native)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[derive(rquickjs::class::Trace, JsLifetime)]
#[rquickjs::class(rename = "TextDecoder")]
struct JsTextDecoder {}

#[rquickjs::methods]
impl JsTextDecoder {
  #[qjs(constructor)]
  fn new() -> Self {
    Self {}
  }

  fn decode(&self, input: TypedArray<'_, u8>) -> Result<String, rquickjs::Error> {
    let bytes = input.as_bytes().ok_or_else(|| rquickjs::Error::new_loading("TextDecoder: invalid typed array"))?;
    Ok(String::from_utf8_lossy(bytes).into_owned())
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// SHA-256 digest using the audited `sha2` crate.
fn sha256_digest(data: &[u8]) -> Vec<u8> {
  use sha2::{Digest, Sha256};
  let mut hasher = Sha256::new();
  hasher.update(data);
  hasher.finalize().to_vec()
}

/// Convert a byte slice to lowercase hex string.
fn bytes_to_hex(bytes: &[u8]) -> String {
  const HEX_TABLE: &[u8; 16] = b"0123456789abcdef";
  let mut hex = String::with_capacity(bytes.len() * 2);
  for b in bytes {
    hex.push(HEX_TABLE[(*b >> 4) as usize] as char);
    hex.push(HEX_TABLE[(*b & 0x0f) as usize] as char);
  }
  hex
}

/// btoa — encode a Latin1 string to Base64.
fn btoa_encode(input: &str) -> Result<String, rquickjs::Error> {
  const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  for ch in input.chars() {
    if ch as u32 > 255 {
      return Err(rquickjs::Error::new_loading("btoa: character outside Latin1 range"));
    }
  }

  let bytes: Vec<u8> = input.chars().map(|c| c as u8).collect();
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let a = chunk[0] as u32;
    let b = chunk.get(1).copied().unwrap_or(0) as u32;
    let c = chunk.get(2).copied().unwrap_or(0) as u32;
    let triplet = (a << 16) | (b << 8) | c;
    out.push(CHARS[((triplet >> 18) & 0x3F) as usize] as char);
    out.push(CHARS[((triplet >> 12) & 0x3F) as usize] as char);
    out.push(if chunk.len() > 1 { CHARS[((triplet >> 6) & 0x3F) as usize] as char } else { '=' });
    out.push(if chunk.len() > 2 { CHARS[(triplet & 0x3F) as usize] as char } else { '=' });
  }
  Ok(out)
}

/// atob — decode a Base64 string to a Latin1 string.
/// Implements WHATWG forgiving-base64-decode algorithm (Infra Standard §7).
fn atob_decode(input: &str) -> Result<String, rquickjs::Error> {
  const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Step 1: remove all ASCII whitespace
  let mut input: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();

  // Step 2: if length is a multiple of 4, strip 1–2 trailing '=' (padding)
  if input.len().is_multiple_of(4) {
    let stripped = input.trim_end_matches('=');
    let diff = input.len() - stripped.len();
    if diff <= 2 {
      input = stripped.to_string();
    }
    // if diff > 2, leave input as-is — validation below will reject the extra '='
  }

  // Step 3: only fail on remainder of 1 (e.g. "Y" → truncated base64)
  if input.len() % 4 == 1 {
    return Err(rquickjs::Error::new_loading("atob: string to decode is not correctly encoded"));
  }

  // Step 4: validate all remaining characters are in base64 alphabet
  if !input.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
    return Err(rquickjs::Error::new_loading("atob: invalid character"));
  }

  let mut out = Vec::with_capacity(input.len() * 3 / 4);
  for chunk in input.as_bytes().chunks(4) {
    let a = lookup_b64(CHARS, chunk[0]) as u32;
    let b = lookup_b64(CHARS, chunk.get(1).copied().unwrap_or(b'A')) as u32;
    let c = chunk.get(2).and_then(|&x| if x == b'=' { None } else { Some(lookup_b64(CHARS, x) as u32) }).unwrap_or(0);
    let d = chunk.get(3).and_then(|&x| if x == b'=' { None } else { Some(lookup_b64(CHARS, x) as u32) }).unwrap_or(0);

    out.push(((a << 2) | (b >> 4)) as u8);
    if chunk.len() > 2 && chunk[2] != b'=' {
      out.push((((b & 0xF) << 4) | (c >> 2)) as u8);
    }
    if chunk.len() > 3 && chunk[3] != b'=' {
      out.push((((c & 0x3) << 6) | d) as u8);
    }
  }

  Ok(out.into_iter().map(|b| b as char).collect())
}

#[inline]
fn lookup_b64(table: &[u8; 64], byte: u8) -> usize {
  table.iter().position(|&c| c == byte).unwrap_or(0)
}

/// Safe decodeURIComponent — returns original string on malformed input.
/// Collects decoded bytes first, then converts to UTF-8 in one pass
/// to correctly handle multi-byte sequences (e.g., "%C3%A9" → "é").
fn safe_decode(s: &str) -> String {
  let mut bytes = Vec::new();
  let mut chars = s.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '%' {
      let hex: String = chars.by_ref().take(2).collect();
      if let Ok(byte) = u8::from_str_radix(&hex, 16) {
        bytes.push(byte);
        continue;
      }
      bytes.extend_from_slice(b"%");
      bytes.extend(hex.bytes());
    } else if c == '+' {
      bytes.push(b' ');
    } else {
      bytes.extend(c.to_string().as_bytes());
    }
  }
  String::from_utf8_lossy(&bytes).into_owned()
}

/// Percent-encode a string for application/x-www-form-urlencoded.
/// Uses `+` for spaces (WHATWG form-urlencoded spec).
fn percent_encode(s: &str) -> String {
  let mut out = String::new();
  for byte in s.bytes() {
    match byte {
      b' ' => out.push('+'),
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
        out.push(byte as char);
      }
      _ => {
        out.push_str(&format!("%{byte:02X}"));
      }
    }
  }
  out
}
