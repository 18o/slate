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
