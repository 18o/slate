// Minimal IIFE bundle for testing SsrEngine
(function() {
  // Simple __render that returns request info as JSON
  globalThis.__render = async function(request) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: request.method,
        url: request.url,
        remote_addr: request.remote_addr,
        hasBody: !!request.body,
        headerCount: Object.keys(request.headers || {}).length,
      })
    };
  };
})();
