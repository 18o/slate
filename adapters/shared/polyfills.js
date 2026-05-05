// Shared polyfills for all Slate adapters.
// This file is imported by adapter-sveltekit, adapter-vue, and adapter-react.
//
// Exported as a template literal string because it gets injected into the
// generated server entry before rolldown bundling.
//
// NOTE: Headers, URL, URLSearchParams, btoa/atob, console, TextEncoder,
// TextDecoder are implemented natively in Rust (polyfills.rs) and registered
// before this code runs. The typeof guards below are kept as safety nets.

export const POLYFILLS = `
// ━━ Headers ━━
// Implemented natively in Rust (polyfills.rs :: JsHeaders).
// The typeof guard ensures a fallback exists if running outside QuickJS.

// ━━ Request ━━
if (typeof Request === 'undefined') {
  globalThis.Request = class Request {
    constructor(input, init = {}) {
      if (input instanceof Request) {
        this.url = input.url;
        this.method = init.method || input.method;
        this.headers = new Headers(init.headers || input.headers);
        this._body = init.body !== undefined ? init.body : input._body;
      } else {
        this.url = typeof input === 'string' ? input : String(input);
        this.method = init.method || 'GET';
        this.headers = new Headers(init.headers || {});
        this._body = init.body || null;
      }
    }
    async json() { return JSON.parse(typeof this._body === 'string' ? this._body : ''); }
    async text() { return typeof this._body === 'string' ? this._body : ''; }
    async arrayBuffer() {
      const str = typeof this._body === 'string' ? this._body : '';
      const buf = new ArrayBuffer(str.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
      return buf;
    }
    clone() {
      return new Request(this.url, { method: this.method, headers: this.headers, body: this._body });
    }
  };
}

// ━━ Response ━━
if (typeof Response === 'undefined') {
  globalThis.Response = class Response {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status || 200;
      this.headers = new Headers(init.headers || {});
      this.ok = this.status >= 200 && this.status < 300;
      this.type = 'default';
      this.redirected = false;
      this.url = '';
    }
    async json() { return JSON.parse(typeof this.body === 'string' ? this.body : ''); }
    async text() {
      if (typeof this.body === 'string') return this.body;
      if (this.body instanceof Uint8Array) return new TextDecoder().decode(this.body);
      if (this.body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(this.body));
      return '';
    }
    async arrayBuffer() {
      if (this.body instanceof ArrayBuffer) return this.body;
      const str = typeof this.body === 'string' ? this.body : '';
      const buf = new ArrayBuffer(str.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
      return buf;
    }
    clone() { return new Response(this.body, { status: this.status, headers: this.headers }); }
    static json(data, init = {}) {
      var hdrs = { 'content-type': 'application/json' };
      if (init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach(function(v, k) { hdrs[k] = v; });
        } else if (Array.isArray(init.headers)) {
          for (var i = 0; i < init.headers.length; i++) { hdrs[String(init.headers[i][0]).toLowerCase()] = String(init.headers[i][1]); }
        } else {
          var keys = Object.keys(init.headers);
          for (var i = 0; i < keys.length; i++) { hdrs[keys[i].toLowerCase()] = String(init.headers[keys[i]]); }
        }
      }
      return new Response(JSON.stringify(data), { status: init.status || 200, headers: hdrs });
    }
    static redirect(url, status = 302) {
      const res = new Response(null, { status });
      res.headers.set('location', url);
      return res;
    }
  };
}

// ━━ TextEncoder / TextDecoder ━━
// Implemented natively in Rust (polyfills.rs :: JsTextEncoder / JsTextDecoder).
// JS fallbacks kept only as safety net.

// ━━ URL / URLSearchParams ━━
// Implemented natively in Rust (polyfills.rs :: JsUrl / JsUrlSearchParams).

// ━━ Object.hasOwn / AbortController ━━
if (typeof Object.hasOwn === 'undefined') {
  Object.hasOwn = function(obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); };
}
if (typeof AbortController === 'undefined') {
  globalThis.AbortController = function AbortController() {
    this.signal = { aborted: false, reason: undefined };
    this.abort = function(reason) { this.signal.aborted = true; this.signal.reason = reason; };
  };
}

// ━━ btoa / atob ━━
// Implemented natively in Rust (polyfills.rs :: btoa_encode / atob_decode).

// ━━ console ━━
// Implemented natively in Rust (polyfills.rs :: __rust_console_log + JS_PATCHES).
`;

export const FETCH_OVERRIDE = `
// ━━ globalThis.fetch Override ━━
globalThis.fetch = async function(input, init) {
  var req = input instanceof Request ? input : null;
  var url = typeof input === 'string' ? input : (req ? req.url : String(input));
  var method = (init && init.method) || (req && req.method) || 'GET';
  var body = (init && init.body !== undefined) ? init.body : (req && req._body) || null;
  var rawHeaders = (init && init.headers) || (req && req.headers) || {};
  var headers;
  if (rawHeaders instanceof Headers) {
    headers = {};
    rawHeaders.forEach(function(v, k) { headers[k] = v; });
  } else if (Array.isArray(rawHeaders)) {
    headers = {};
    for (var hi = 0; hi < rawHeaders.length; hi++) {
      headers[String(rawHeaders[hi][0]).toLowerCase()] = String(rawHeaders[hi][1]);
    }
  } else {
    headers = rawHeaders;
  }

  if (url.startsWith('https://') || url.startsWith('http://')) {
    const result = await __rust_http_fetch(url, method, body, headers);
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }

  const result = await __rust_internal_dispatch(method, url, body, headers);
  return new Response(result.body, {
    status: result.status,
    headers: new Headers(result.headers),
  });
};
`;
