// Simulated SvelteKit IIFE bundle (close to real adapter-quickjs output)
// This simulates what adapter-quickjs would produce from a SvelteKit project.
(function() {
  // ━━ Simulated SvelteKit Server ━━
  var routes = {
    '/': { component: 'Home', load: null },
    '/about': { component: 'About', load: null },
    '/api/users': { type: 'endpoint', method: 'GET' },
  };

  function matchRoute(url) {
    var path = new URL(url, 'http://localhost').pathname;
    // Strip trailing slash except for root
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
    return routes[path] || null;
  }

  // Simulated Server.respond()
  globalThis.__render = async function(request) {
    var route = matchRoute(request.url);

    // If it's an API endpoint, use internal dispatch
    if (route && route.type === 'endpoint') {
      var dispatchResult;
      try {
        dispatchResult = await __rust_internal_dispatch(
          request.method,
          request.url,
          request.body || null,
          request.headers || {}
        );
      } catch(e) {
        dispatchResult = { status: 500, body: '{"error":"' + e.message + '"}', headers: {} };
      }
      return {
        status: dispatchResult.status,
        headers: dispatchResult.headers,
        body: dispatchResult.body,
      };
    }

    // Regular page — render HTML
    var routeData = route || { component: 'NotFound' };
    var pageName = route ? route.component : 'NotFound';

    // Call internal dispatch for any data loading
    var dataResult = null;
    if (route && route.load) {
      dataResult = await __rust_internal_dispatch(
        'GET',
        '/api' + request.url,
        null,
        request.headers || {}
      );
    }

    var html = '<!DOCTYPE html><html><head><title>' + pageName +
      '</title></head><body><h1>' + pageName + '</h1>' +
      '<p>URL: ' + request.url + '</p>' +
      '<p>Method: ' + request.method + '</p>' +
      '<p>Remote: ' + (request.remote_addr || 'unknown') + '</p>' +
      (dataResult ? '<p>Data: ' + dataResult.body + '</p>' : '') +
      '</body></html>';

    return {
      status: route ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: html,
    };
  };
})();
