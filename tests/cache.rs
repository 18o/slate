//! SsrCache unit tests — hit/miss/eviction behavior.
//!
//! SsrCache is behind cfg(any(salvo, axum)), so this test requires one of those features.

#![cfg(any(feature = "salvo", feature = "axum"))]

use std::time::Instant;

use slate::salvo::SsrCache;

/// Helper to create a cache entry.
fn make_entry(status: u16, body: &str) -> slate::salvo::CachedEntry {
  slate::salvo::CachedEntry { status, headers: vec![], body: body.to_string(), cached_at: Instant::now() }
}

#[test]
fn test_cache_miss_on_empty() {
  let cache = SsrCache::new();
  assert!(cache.get("nonexistent").is_none(), "Empty cache should return None");
}

#[test]
fn test_cache_hit_after_set() {
  let cache = SsrCache::new();
  let entry = make_entry(200, "<html>hello</html>");

  cache.set("/index".to_string(), entry);
  let cached = cache.get("/index").expect("Should find entry after set()");

  assert_eq!(cached.status, 200);
  assert_eq!(cached.body, "<html>hello</html>");
}

#[test]
fn test_cache_miss_different_key() {
  let cache = SsrCache::new();
  cache.set("/a".to_string(), make_entry(200, "A"));

  assert!(cache.get("/a").is_some(), "/a should be cached");
  assert!(cache.get("/b").is_none(), "/b should be a miss");
}

#[test]
fn test_cache_overwrite() {
  let cache = SsrCache::new();

  cache.set("/page".to_string(), make_entry(200, "v1"));
  cache.set("/page".to_string(), make_entry(200, "v2"));

  let cached = cache.get("/page").unwrap();
  assert_eq!(cached.body, "v2", "Second set() should overwrite the first");
}

#[test]
fn test_cache_multiple_entries() {
  let cache = SsrCache::new();

  for i in 0..50 {
    cache.set(format!("/page/{i}"), make_entry(200, &format!("body-{i}")));
  }

  // All should be present
  for i in 0..50 {
    let cached = cache.get(&format!("/page/{i}")).unwrap();
    assert_eq!(cached.body, format!("body-{i}"));
  }
}

#[test]
fn test_cache_bulk_eviction_at_capacity() {
  let cache = SsrCache::new();

  // Fill to MAX_CACHE_ENTRIES (1024)
  for i in 0..1024 {
    cache.set(format!("/p/{i}"), make_entry(200, &format!("v-{i}")));
  }

  // All should be present
  assert!(cache.get("/p/0").is_some(), "Entry 0 should exist before eviction");
  assert!(cache.get("/p/511").is_some(), "Entry 511 should exist before eviction");
  assert!(cache.get("/p/1023").is_some(), "Entry 1023 should exist before eviction");

  // Insert one more — triggers partial eviction (oldest half evicted, newer half kept)
  cache.set("/p/overflow".to_string(), make_entry(200, "overflow"));

  // Oldest entries (0-511) should be evicted
  assert!(cache.get("/p/0").is_none(), "Oldest entries should be evicted");
  assert!(cache.get("/p/511").is_none(), "Oldest entries should be evicted");

  // Newer entries (512-1023) should still be present
  assert!(cache.get("/p/512").is_some(), "Newer entries should survive eviction");
  assert!(cache.get("/p/1023").is_some(), "Newer entries should survive eviction");

  // The overflow entry should be present
  let overflow = cache.get("/p/overflow").unwrap();
  assert_eq!(overflow.body, "overflow");
}

#[test]
fn test_cache_preserves_headers() {
  let cache = SsrCache::new();

  let mut headers: Vec<(String, String)> = vec![];
  headers.push(("content-type".to_string(), "text/html".to_string()));
  headers.push(("x-custom".to_string(), "value".to_string()));

  let entry = slate::salvo::CachedEntry { status: 200, headers, body: "ok".to_string(), cached_at: std::time::Instant::now() };

  cache.set("/hdr".to_string(), entry);

  let cached = cache.get("/hdr").unwrap();
  assert_eq!(cached.headers.iter().find(|(k, _)| k == "content-type").unwrap().1, "text/html");
  assert_eq!(cached.headers.iter().find(|(k, _)| k == "x-custom").unwrap().1, "value");
}

#[test]
fn test_cache_default_trait() {
  let cache = SsrCache::default();
  assert!(cache.get("anything").is_none(), "Default cache should be empty");
}
