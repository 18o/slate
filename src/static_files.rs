//! Static file serving — shared by all web framework integrations.
//!
//! Provides [`lookup_static_asset`] for serving files from `RustEmbed` memory
//! with optional brotli compression support.

/// Result of looking up a static asset from RustEmbed.
pub struct StaticAsset {
  /// MIME type string (e.g. "text/html", "application/javascript").
  pub mime: String,
  /// File content bytes (may be brotli-compressed if content_encoding == "br").
  pub data: Vec<u8>,
  /// Whether the asset path contains "/immutable/" (long cache).
  pub immutable: bool,
  /// Content-Encoding header value (e.g. Some("br")), None if uncompressed.
  pub content_encoding: Option<String>,
}

/// Look up a static asset from a RustEmbed bundle.
///
/// Searches for `client{path}` in the embedded assets. If `accepts_br` is true,
/// tries `client{path}.br` first (smaller, faster to transfer) and falls back
/// to the uncompressed original.
///
/// URL-decodes the path first so that `%20` (space) and other
/// percent-encoded characters match the original filenames.
/// Returns `Some(StaticAsset)` if found, `None` otherwise.
pub fn lookup_static_asset<T: rust_embed::RustEmbed>(path: &str, accepts_br: bool) -> Option<StaticAsset> {
  let decoded = percent_decode(path);

  // Try brotli-compressed variant first
  if accepts_br {
    let br_path = format!("client{decoded}.br");
    if let Some(file) = T::get(&br_path) {
      let mime = mime_guess::from_path(format!("client{decoded}")).first_or_octet_stream();
      return Some(StaticAsset {
        mime: mime.as_ref().to_string(),
        data: file.data.to_vec(),
        immutable: br_path.contains("/immutable/"),
        content_encoding: Some("br".to_string()),
      });
    }
  }

  // Fall back to uncompressed
  let asset_path = format!("client{decoded}");
  let file = T::get(&asset_path)?;
  let mime = mime_guess::from_path(&asset_path).first_or_octet_stream();
  Some(StaticAsset {
    mime: mime.as_ref().to_string(),
    data: file.data.to_vec(),
    immutable: asset_path.contains("/immutable/"),
    content_encoding: None,
  })
}

/// Simple percent-decode for static file paths.
fn percent_decode(input: &str) -> String {
  let bytes = input.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%'
      && i + 2 < bytes.len()
      && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
    {
      out.push(hi << 4 | lo);
      i += 3;
      continue;
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8(out).unwrap_or_default()
}

fn hex_val(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b - b'0'),
    b'a'..=b'f' => Some(b - b'a' + 10),
    b'A'..=b'F' => Some(b - b'A' + 10),
    _ => None,
  }
}
