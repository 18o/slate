use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use rquickjs::prelude::Func;
use rquickjs::{Class, Ctx, JsLifetime, TypedArray};

/// Monotonic origin time for performance.now(), set once at first inject.
static PERF_ORIGIN: AtomicU64 = AtomicU64::new(0);

/// Monotonic start instant for performance.now() relative measurements.
static PERF_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

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

  // performance.now() — uses monotonic Instant for accurate timing.
  // Returns milliseconds since epoch, based on monotonic clock to avoid NTP issues.
  PERF_START.get_or_init(Instant::now);
  PERF_ORIGIN
    .store(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64, Ordering::Relaxed);
  globals.set(
    "__rust_performance_now",
    Func::from(|| {
      let start = PERF_START.get().unwrap();
      let origin_ms = PERF_ORIGIN.load(Ordering::Relaxed) as f64;
      origin_ms + start.elapsed().as_secs_f64() * 1000.0
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

/// Minimal SHA-256 digest for crypto.subtle.digest polyfill.
/// Only used for SvelteKit CSP hash generation — not a general-purpose crypto library.
fn sha256_digest(data: &[u8]) -> Vec<u8> {
  let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  let k: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  // Padding
  let bit_len = (data.len() as u64) * 8;
  let mut padded = data.to_vec();
  padded.push(0x80);
  while padded.len() % 64 != 56 {
    padded.push(0);
  }
  padded.extend_from_slice(&bit_len.to_be_bytes());

  // Process 64-byte blocks
  for chunk in padded.chunks(64) {
    let mut w = [0u32; 64];
    for i in 0..16 {
      w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
    }
    for i in 16..64 {
      let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
      let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
    }

    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;

    for i in 0..64 {
      let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
      let ch = (e & f) ^ (!e & g);
      let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(k[i]).wrapping_add(w[i]);
      let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
      let maj = (a & b) ^ (a & c) ^ (b & c);
      let temp2 = s0.wrapping_add(maj);

      hh = g;
      g = f;
      f = e;
      e = d.wrapping_add(temp1);
      d = c;
      c = b;
      b = a;
      a = temp1.wrapping_add(temp2);
    }

    h[0] = h[0].wrapping_add(a);
    h[1] = h[1].wrapping_add(b);
    h[2] = h[2].wrapping_add(c);
    h[3] = h[3].wrapping_add(d);
    h[4] = h[4].wrapping_add(e);
    h[5] = h[5].wrapping_add(f);
    h[6] = h[6].wrapping_add(g);
    h[7] = h[7].wrapping_add(hh);
  }

  let mut result = Vec::with_capacity(32);
  for hi in &h {
    result.extend_from_slice(&hi.to_be_bytes());
  }
  result
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
