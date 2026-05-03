// IIFE bundle that blocks forever to test render timeout
(function() {
  globalThis.__render = async function(_request) {
    // Spin forever — the Rust side will timeout after 30s.
    // We use a busy loop instead of while(true) to avoid QuickJS optimization.
    var start = Date.now();
    while (Date.now() - start < 600000) {
      // 10 minutes of spinning
    }
    return {
      status: 200,
      headers: {},
      body: "should never reach here"
    };
  };
})();
