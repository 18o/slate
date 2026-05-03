// Shared polyfills for all Slate adapters.
// This file is imported by adapter-sveltekit, adapter-vue, and adapter-react.
//
// Exported as a template literal string because it gets injected into the
// generated server entry before rolldown bundling.

export const POLYFILLS = `
// ━━ Headers ━━
if (typeof Headers === 'undefined') {
  globalThis.Headers = class Headers {
    constructor(init) {
      this._map = new Map();
      if (init) {
        if (init instanceof Headers) {
          init.forEach((v, k) => this._map.set(k, v));
        } else if (Array.isArray(init)) {
          for (const [key, value] of init) {
            this._map.set(key.toLowerCase(), String(value));
          }
        } else if (typeof init === 'object') {
          for (const [key, value] of Object.entries(init)) {
            this._map.set(key.toLowerCase(), String(value));
          }
        }
      }
    }
    get(name) { return this._map.get(name.toLowerCase()) || null; }
    set(name, value) { this._map.set(name.toLowerCase(), String(value)); }
    has(name) { return this._map.has(name.toLowerCase()); }
    delete(name) { this._map.delete(name.toLowerCase()); }
    entries() { return this._map.entries(); }
    keys() { return this._map.keys(); }
    values() { return this._map.values(); }
    [Symbol.iterator]() { return this._map.entries(); }
    forEach(cb) { this._map.forEach((v, k) => cb(v, k, this)); }
    getSetCookie() {
      var result = [];
      this._map.forEach(function(v, k) {
        if (k === 'set-cookie') result.push(v);
      });
      return result;
    }
  };
}

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
    async text() { return typeof this.body === 'string' ? this.body : ''; }
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
      return new Response(JSON.stringify(data), {
        status: init.status || 200,
        headers: { 'content-type': 'application/json', ...init.headers },
      });
    }
    static redirect(url, status = 302) {
      const res = new Response(null, { status });
      res.headers.set('location', url);
      return res;
    }
  };
}

// ━━ TextEncoder / TextDecoder ━━
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(str) {
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else if (code >= 0xD800 && code <= 0xDBFF) {
          // Surrogate pair (4-byte UTF-8 for characters above U+FFFF)
          const hi = code;
          const lo = str.charCodeAt(++i);
          const cp = ((hi - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
          bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
      return new Uint8Array(bytes);
    }
  };
}
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(bytes) {
      if (!bytes) return '';
      const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let str = '';
      for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
      return decodeURIComponent(escape(str));
    }
  };
}

// ━━ URL / URLSearchParams ━━
if (typeof URL === 'undefined') {
  var _reAbsolute = new RegExp('^[a-zA-Z]+:');
  globalThis.URL = function URL(url, base) {
    if (base && !_reAbsolute.test(url)) {
      if (!_reAbsolute.test(base)) base = 'http://localhost' + (base.startsWith('/') ? '' : '/') + base;
      if (url.startsWith('/')) {
        var m = base.match(new RegExp('^[a-zA-Z]+:[^/]*//[^/]+'));
        url = (m ? m[0] : base) + url;
      } else {
        url = base.replace(new RegExp('[^/]*$'), '') + url;
      }
    }
    if (!_reAbsolute.test(url)) url = 'http://localhost' + (url.startsWith('/') ? '' : '/') + url;
    this._url = url;
    var r = new RegExp('^([a-zA-Z]+)://([^/:?#]*)(?::(\\\\d+))?([^?#]*)(\\\\?[^#]*)?(#.*)?$').exec(url);
    if (!r) { r = ['', 'http', 'localhost', '', '/', '', '']; }
    this.protocol = r[1] + ':';
    this.hostname = r[2];
    this.port = r[3] || '';
    this.host = this.hostname + (this.port ? ':' + this.port : '');
    this.origin = this.protocol + '//' + this.host;
    this.pathname = r[4] || '/';
    this.search = r[5] || '';
    this.hash = r[6] || '';
    this.href = url;
    this.searchParams = new URLSearchParams(this.search);
  };
  URL.prototype.toString = function() { return this.href; };
  URL.prototype.toJSON = function() { return this.href; };
}
if (typeof URLSearchParams === 'undefined') {
  globalThis.URLSearchParams = function URLSearchParams(init) {
    this._params = [];
    if (typeof init === 'string') {
      init = init.replace(new RegExp('^\\\\?'), '');
      if (init) init.split('&').forEach(function(p) {
        var kv = p.split('=');
        this._params.push([
          decodeURIComponent(kv[0].replace(/\\+/g, ' ')),
          decodeURIComponent((kv[1] || '').replace(/\\+/g, ' '))
        ]);
      }.bind(this));
    }
  };
  URLSearchParams.prototype.get = function(n) { for (var i = 0; i < this._params.length; i++) if (this._params[i][0] === n) return this._params[i][1]; return null; };
  URLSearchParams.prototype.has = function(n) { return this._params.some(function(p) { return p[0] === n; }); };
  URLSearchParams.prototype.toString = function() { return this._params.map(function(p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&'); };
  URLSearchParams.prototype.keys = function() { return this._params.map(function(p) { return p[0]; })[Symbol.iterator](); };
  URLSearchParams.prototype.values = function() { return this._params.map(function(p) { return p[1]; })[Symbol.iterator](); };
  URLSearchParams.prototype.entries = function() { return this._params[Symbol.iterator](); };
  URLSearchParams.prototype.forEach = function(cb) { for (var i = 0; i < this._params.length; i++) cb(this._params[i][1], this._params[i][0], this); };
}

// ━━ Object.hasOwn / AbortController ━━
// Required by SvelteKit internals — older QuickJS builds may lack these.
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
if (typeof btoa === 'undefined') {
  var _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  globalThis.btoa = function(str) {
    for (var i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 255) throw new Error("btoa: character outside Latin1 range");
    }
    var output = '';
    for (var i = 0; i < str.length; i += 3) {
      var a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
      var triplet = (a << 16) | ((b || 0) << 8) | (c || 0);
      output += _b64chars[(triplet >> 18) & 0x3F];
      output += _b64chars[(triplet >> 12) & 0x3F];
      output += isNaN(b) ? '=' : _b64chars[(triplet >> 6) & 0x3F];
      output += isNaN(c) ? '=' : _b64chars[triplet & 0x3F];
    }
    return output;
  };
}
if (typeof atob === 'undefined') {
  var _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  globalThis.atob = function(str) {
    var output = '';
    str = str.replace(/=+$/, '');
    for (var i = 0; i < str.length; i += 4) {
      var a = _b64chars.indexOf(str.charAt(i));
      var b = _b64chars.indexOf(str.charAt(i + 1));
      var c = _b64chars.indexOf(str.charAt(i + 2));
      var d = _b64chars.indexOf(str.charAt(i + 3));
      output += String.fromCharCode((a << 2) | (b >> 4));
      if (c !== -1) output += String.fromCharCode(((b & 0xF) << 4) | (c >> 2));
      if (d !== -1) output += String.fromCharCode(((c & 0x3) << 6) | d);
    }
    return output;
  };
}

// ━━ console ━━
if (typeof console === 'undefined') {
  var _console_fn = (typeof __rust_console_log !== 'undefined') ? __rust_console_log : function() {};
  globalThis.console = {
    log: function() { _console_fn.apply(null, ['[LOG]'].concat([].slice.call(arguments))); },
    error: function() { _console_fn.apply(null, ['[ERR]'].concat([].slice.call(arguments))); },
    warn: function() { _console_fn.apply(null, ['[WARN]'].concat([].slice.call(arguments))); },
  };
}
`;

export const FETCH_OVERRIDE = `
// ━━ globalThis.fetch Override ━━
globalThis.fetch = async function(input, init) {
  var req = input instanceof Request ? input : null;
  var url = typeof input === 'string' ? input : (req ? req.url : String(input));
  var method = (init && init.method) || (req && req.method) || 'GET';
  var body = (init && init.body !== undefined) ? init.body : (req && req._body) || null;
  var headers = (init && init.headers) || (req && req.headers) || {};

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
