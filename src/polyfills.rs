use std::sync::OnceLock;
use std::time::Instant;

use rquickjs::prelude::Func;
use rquickjs::{Class, Ctx, JsLifetime, TypedArray};

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

  // TextEncoder (native) — registered as "TextEncoder" in JS via rename attribute
  Class::<JsTextEncoder>::define(&globals)?;

  // TextDecoder (native) — registered as "TextDecoder" in JS via rename attribute
  Class::<JsTextDecoder>::define(&globals)?;

  // performance.now() — returns milliseconds since time origin (context creation).
  // Per WHATWG High Resolution Time spec, starts at 0.0 and is monotonically increasing.
  PERF_START.get_or_init(Instant::now);
  // SAFETY: get_or_init above guarantees PERF_START is populated.
  // Using get_or_init (not get) avoids a separate unwrap — returns the
  // existing value without re-calling the init closure.
  globals.set(
    "__rust_performance_now",
    Func::from(move || {
      let start = PERF_START.get_or_init(Instant::now);
      start.elapsed().as_secs_f64() * 1000.0
    }),
  )?;

  // crypto — inject Rust functions for cryptographically secure random.
  // Hex string approach avoids rquickjs Func::from lifetime issues with TypedArray.
  globals.set(
    "__rust_crypto_random_hex",
    Func::from(|len: usize| -> String {
      use rand::Rng; // RngCore in 0.9, renamed to Rng in 0.10
      let mut bytes = vec![0u8; len];
      rand::rng().fill_bytes(&mut bytes);
      bytes_to_hex(&bytes)
    }),
  )?;

  // crypto.randomUUID — RFC 4122 version 4 UUID via Rust's rand crate
  globals.set(
    "__rust_crypto_random_uuid",
    Func::from(|| -> String {
      use rand::RngExt; // Rng in 0.9, renamed to RngExt in 0.10
      let mut rng = rand::rng();
      let mut bytes = [0u8; 16];
      rng.fill(&mut bytes);
      // Set version 4
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      // Set variant 1
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

  // crypto.subtle.digest — accepts algo name + hex-encoded data, returns hex-encoded hash
  // JS wrapper handles Uint8Array ↔ hex conversion (avoids rquickjs TypedArray lifetime issues)
  // Only SHA-256 is implemented — JS wrapper validates algo before calling this.
  globals.set(
    "__rust_crypto_subtle_digest_hex",
    Func::from(|_algo: String, data_hex: String| -> String {
      // _algo: kept for JS→Rust signature compatibility (validation done in JS)
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

  ctx.eval::<(), _>(include_str!("polyfills.js"))?;

  Ok(())
}

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
    // WHATWG spec: replace invalid bytes with U+FFFD, don't throw
    Ok(String::from_utf8_lossy(bytes).into_owned())
  }
}

/// SHA-256 digest using the audited `sha2` crate.
/// Used for `crypto.subtle.digest` polyfill — only SHA-256 is supported.
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
