// Minimal SSR mock — validates the full engine pipeline without real SvelteKit runtime.
// Tests: IIFE eval, __render call, header/body/status passthrough, request fields.
(function () {
  "use strict";

  // ── Polyfills needed by __render ──
  if (typeof Headers === "undefined") {
    globalThis.Headers = class Headers {
      constructor(init) {
        this._list = [];
        if (init && typeof init === "object" && !Array.isArray(init)) {
          var keys = Object.keys(init);
          for (var i = 0; i < keys.length; i++) {
            this._list.push([keys[i].toLowerCase(), String(init[keys[i]])]);
          }
        }
      }
      getSetCookie() { return []; }
    };
  }

  if (typeof Request === "undefined") {
    globalThis.Request = class Request {
      constructor(url, init) {
        this.url = url;
        this.method = (init && init.method) || "GET";
        this.headers = new Headers((init && init.headers) || {});
        this._body = (init && init.body) || null;
      }
    };
  }

  globalThis.__render = async function (request) {
    var body = "<html><head><title>Test</title></head>" +
      "<body><h1>Welcome to SvelteKit</h1>" +
      "<p>method: " + request.method + "</p>" +
      "<p>url: " + request.url + "</p>" +
      "</body></html>";

    return {
      status: 200,
      headers: [
        ["content-type", "text/html; charset=utf-8"],
        ["x-server", "slate-mock"],
      ],
      body: body,
    };
  };
})();
