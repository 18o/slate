// performance.now() — wraps the Rust __rust_performance_now function.
if (typeof performance === 'undefined') {
    globalThis.performance = { now: __rust_performance_now };
}

// Browser API stubs — QuickJS lacks these, but SSR code (especially third-party
// libraries like analytics SDKs) may access them. Provide empty stubs so SSR
// doesn't crash with ReferenceError.
//
// IMPORTANT: Do NOT define `window`, `document`, or `location`.
// Frameworks (SvelteKit, Vue, React) use `typeof window !== 'undefined'`
// as a browser-detection guard. Setting them would trick SSR into running
// browser-only code paths — causing hydration mismatches.
//
// `self` is safe — it's defined in both browsers (as `window`) and web workers.
if (typeof self === 'undefined') {
    globalThis.self = globalThis;
}
if (typeof navigator === 'undefined') {
    globalThis.navigator = {
        userAgent: 'slate-ssr/1.0',
        platform: 'linux',
        language: 'en-US',
        onLine: false,
    };
}
// `global` for Node.js compat (some polyfills check this)
if (typeof global === 'undefined') {
    globalThis.global = globalThis;
}

// URL / URLSearchParams polyfill (QuickJS doesn't have these built-in).
// SvelteKit internals require URL for route matching and path resolution.
// Minimal implementation sufficient for SSR — not a full WHATWG URL spec.
if (typeof URL === 'undefined') {
    var _reAbs = new RegExp('^[a-zA-Z]+:');
    globalThis.URL = function URL(url, base) {
        if (base && !_reAbs.test(url)) {
            if (!_reAbs.test(base)) {
                base = 'http://localhost' + (base.startsWith('/') ? '' : '/') + base;
            }
            if (url.startsWith('/')) {
                var m = base.match(new RegExp('^[a-zA-Z]+:[^/]*//[^/]+'));
                url = m[0] + url;
            } else {
                url = base.replace(new RegExp('[^/]*$'), '') + url;
            }
        }
        if (!_reAbs.test(url)) {
            url = 'http://localhost' + (url.startsWith('/') ? '' : '/') + url;
        }
        this._url = url;

        var parsed = this._parse(url);
        this.protocol = parsed.protocol;
        this.hostname = parsed.hostname;
        this.port = parsed.port;
        this.host = parsed.host;
        this.origin = parsed.origin;
        this.pathname = parsed.pathname || '/';
        this.search = parsed.search || '';
        this.hash = parsed.hash || '';
        this.href = url;
        this.searchParams = new URLSearchParams(this.search);
    };
    URL.prototype._parse = function(url) {
        var r = new RegExp('^([a-zA-Z]+)://([^/:?#]*)(?::(\\d+))?([^?#]*)(\\?[^#]*)?(#.*)?$').exec(url);
        if (!r) return { protocol: 'http:', hostname: 'localhost', port: '', host: 'localhost', origin: 'http://localhost', pathname: '/' };
        var port = r[3] || '';
        var host = r[2] + (port ? ':' + port : '');
        return {
            protocol: r[1] + ':',
            hostname: r[2],
            port: port,
            host: host,
            origin: r[1] + '://' + host,
            pathname: r[4] || '/',
            search: r[5] || '',
            hash: r[6] || ''
        };
    };
    URL.prototype.toString = function() { return this.href; };
    URL.prototype.toJSON = function() { return this.href; };
}

if (typeof URLSearchParams === 'undefined') {
    // Safe decodeURIComponent — returns original string on malformed input instead of throwing URIError
    var _safeDecode = function(s) {
        try { return decodeURIComponent(s.replace(/\+/g, ' ')); }
        catch(e) { return s.replace(/\+/g, ' '); }
    };

    globalThis.URLSearchParams = function URLSearchParams(init) {
        this._params = [];
        if (typeof init === 'string') {
            init = init.replace(/^\?/, '');
            if (init) {
                var pairs = init.split('&');
                for (var i = 0; i < pairs.length; i++) {
                    var p = pairs[i].split('=');
                    this._params.push([
                        _safeDecode(p[0]),
                        _safeDecode(p[1] || '')
                    ]);
                }
            }
        }
    };
    URLSearchParams.prototype.get = function(name) {
        for (var i = 0; i < this._params.length; i++) {
            if (this._params[i][0] === name) return this._params[i][1];
        }
        return null;
    };
    URLSearchParams.prototype.getAll = function(name) {
        var result = [];
        for (var i = 0; i < this._params.length; i++) {
            if (this._params[i][0] === name) result.push(this._params[i][1]);
        }
        return result;
    };
    URLSearchParams.prototype.has = function(name) {
        for (var i = 0; i < this._params.length; i++) {
            if (this._params[i][0] === name) return true;
        }
        return false;
    };
    URLSearchParams.prototype.set = function(name, value) {
        var found = false;
        for (var i = 0; i < this._params.length; i++) {
            if (this._params[i][0] === name) {
                if (!found) {
                    this._params[i][1] = String(value);
                    found = true;
                } else {
                    this._params.splice(i, 1);
                    i--;
                }
            }
        }
        if (!found) this._params.push([name, String(value)]);
    };
    URLSearchParams.prototype.append = function(name, value) {
        this._params.push([name, String(value)]);
    };
    URLSearchParams.prototype['delete'] = function(name) {
        for (var i = this._params.length - 1; i >= 0; i--) {
            if (this._params[i][0] === name) this._params.splice(i, 1);
        }
    };
    URLSearchParams.prototype.toString = function() {
        return this._params.map(function(p) {
            return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
        }).join('&');
    };
    URLSearchParams.prototype.keys = function() {
        return this._params.map(function(p) { return p[0]; })[Symbol.iterator]();
    };
    URLSearchParams.prototype.values = function() {
        return this._params.map(function(p) { return p[1]; })[Symbol.iterator]();
    };
    URLSearchParams.prototype.entries = function() {
        return this._params[Symbol.iterator]();
    };
    URLSearchParams.prototype.forEach = function(cb) {
        for (var i = 0; i < this._params.length; i++) {
            cb(this._params[i][1], this._params[i][0], this);
        }
    };
    Object.defineProperty(URLSearchParams.prototype, 'size', {
        get: function() { return this._params.length; }
    });
}

// crypto — cryptographically secure random from Rust (not Math.random).
// Includes crypto.subtle.digest (SHA-256) for SvelteKit CSP hash generation.
// Uses hex string encoding to avoid rquickjs Func::from TypedArray lifetime issues.
// NOTE: Do NOT `delete globalThis.__rust_*` — QuickJS has edge cases with
// delete on global properties that can break downstream code.
if (typeof crypto === 'undefined') {
    var _hexToBytes = function(hex) {
        var arr = new Uint8Array(hex.length / 2);
        for (var i = 0; i < hex.length; i += 2) {
            arr[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return arr;
    };
    globalThis.crypto = {
        getRandomValues: function(arr) {
            var hex = __rust_crypto_random_hex(arr.length);
            for (var i = 0; i < arr.length; i++) {
                arr[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            return arr;
        },
        randomUUID: __rust_crypto_random_uuid,
                subtle: {
                        digest: function(algo, data) {
                                // Extract algo name — supports both string and { name: 'SHA-256' } forms
                                var algoName = (typeof algo === 'object' && algo !== null) ? algo.name : algo;
                                var algoUpper = (algoName || '').toString().toUpperCase().replace('-', '');
                                if (algoUpper !== 'SHA256') {
                                        return Promise.reject(new Error("crypto.subtle.digest: only SHA-256 is supported, got '" + algo + "'"));
                                }
                                // Convert data (Uint8Array or Array) to hex for Rust
                                var hexInput = '';
                                var src = data instanceof Uint8Array ? data : (data && data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
                                for (var i = 0; i < src.length; i++) {
                                    var b = src[i] & 0xff;
                                    hexInput += (b < 16 ? '0' : '') + b.toString(16);
                                }
                                var result = __rust_crypto_subtle_digest_hex(algo, hexInput);
                                return Promise.resolve(_hexToBytes(result).buffer);
                            }
        }
    };
}

// btoa / atob — needed by SvelteKit CSP nonce generation (btoa) and general use.
if (typeof btoa === 'undefined' || typeof atob === 'undefined') {
    var _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
}
if (typeof btoa === 'undefined') {
    globalThis.btoa = function(str) {
        for (var i = 0; i < str.length; i++) {
            if (str.charCodeAt(i) > 255) throw new Error("btoa: character outside Latin1 range");
        }
        var output = '';
        for (var i = 0; i < str.length; i += 3) {
            var a = str.charCodeAt(i);
            var b = str.charCodeAt(i + 1);
            var c = str.charCodeAt(i + 2);
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
    globalThis.atob = function(str) {
        str = String(str).replace(/=+$/, '');
        if (!/^[A-Za-z0-9+/]*$/.test(str)) throw new Error("atob: invalid character");
        var output = '';
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

// String.prototype.startsWith / endsWith / includes / repeat — QuickJS should have these
// but add safety checks for older builds
if (!String.prototype.startsWith) {
    String.prototype.startsWith = function(s) { return this.slice(0, s.length) === s; };
}
if (!String.prototype.endsWith) {
    String.prototype.endsWith = function(s) { return this.slice(-s.length) === s; };
}
if (!String.prototype.repeat) {
    String.prototype.repeat = function(n) { return new Array(n + 1).join(this); };
}
