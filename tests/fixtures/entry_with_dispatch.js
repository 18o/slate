// Test IIFE bundle that exercises native fetch functions
(function() {
  // Test that TextEncoder was injected by Rust
  var encoderWorks = false;
  try {
    var enc = new TextEncoder();
    var bytes = enc.encode("hello");
    encoderWorks = bytes.length === 5 && bytes[0] === 104;
  } catch(e) {}

  // Test that TextDecoder was injected by Rust
  var decoderWorks = false;
  try {
    var dec = new TextDecoder();
    var str = dec.decode(new Uint8Array([104, 101, 108, 108, 111]));
    decoderWorks = str === "hello";
  } catch(e) {}

  globalThis.__render = async function(request) {
    // Test internal dispatch
    var dispatchResult = null;
    try {
      dispatchResult = await __rust_internal_dispatch(
        "GET",
        "/api/test",
        null,
        {}
      );
    } catch(e) {
      dispatchResult = { status: 0, body: e.message || String(e) };
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: request.method,
        url: request.url,
        textEncoderWorks: encoderWorks,
        textDecoderWorks: decoderWorks,
        dispatchStatus: dispatchResult ? dispatchResult.status : null,
        dispatchBody: dispatchResult ? dispatchResult.body : null,
      })
    };
  };
})();
