// @ts-nocheck — bundled IIFE (SvelteKit + polyfills), not intended for editing
(function () {
  "use strict";

  /** @type {Record<string, string>} */
  const escaped = {
    "<": "\\u003C",
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };

  class DevalueError extends Error {
    /**
     * @param {string} message
     * @param {string[]} keys
     * @param {any} [value] - The value that failed to be serialized
     * @param {any} [root] - The root value being serialized
     */
    constructor(message, keys, value, root) {
      super(message);
      this.name = "DevalueError";
      this.path = keys.join("");
      this.value = value;
      this.root = root;
    }
  }

  /** @param {any} thing */
  function is_primitive(thing) {
    return (
      thing === null ||
      (typeof thing !== "object" && typeof thing !== "function")
    );
  }

  const object_proto_names = /* @__PURE__ */ Object.getOwnPropertyNames(
    Object.prototype,
  )
    .sort()
    .join("\0");

  /** @param {any} thing */
  function is_plain_object(thing) {
    const proto = Object.getPrototypeOf(thing);

    return (
      proto === Object.prototype ||
      proto === null ||
      Object.getPrototypeOf(proto) === null ||
      Object.getOwnPropertyNames(proto).sort().join("\0") === object_proto_names
    );
  }

  /** @param {any} thing */
  function get_type(thing) {
    return Object.prototype.toString.call(thing).slice(8, -1);
  }

  /** @param {string} char */
  function get_escaped_char(char) {
    switch (char) {
      case '"':
        return '\\"';
      case "<":
        return "\\u003C";
      case "\\":
        return "\\\\";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char < " "
          ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
          : "";
    }
  }

  /** @param {string} str */
  function stringify_string(str) {
    let result = "";
    let last_pos = 0;
    const len = str.length;

    for (let i = 0; i < len; i += 1) {
      const char = str[i];
      const replacement = get_escaped_char(char);
      if (replacement) {
        result += str.slice(last_pos, i) + replacement;
        last_pos = i + 1;
      }
    }

    return `"${last_pos === 0 ? str : result + str.slice(last_pos)}"`;
  }

  /** @param {Record<string | symbol, any>} object */
  function enumerable_symbols(object) {
    return Object.getOwnPropertySymbols(object).filter(
      (symbol) => Object.getOwnPropertyDescriptor(object, symbol).enumerable,
    );
  }

  const is_identifier = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/;

  /** @param {string} key */
  function stringify_key(key) {
    return is_identifier.test(key)
      ? "." + key
      : "[" + JSON.stringify(key) + "]";
  }

  /** @param {string} s */
  function is_valid_array_index(s) {
    if (s.length === 0) return false;
    if (s.length > 1 && s.charCodeAt(0) === 48) return false; // leading zero
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    // by this point we know it's a string of digits, but it has to be within the range of valid array indices
    const n = +s;
    if (n >= 2 ** 32 - 1) return false;
    if (n < 0) return false;
    return true;
  }

  /**
   * Finds the populated indices of an array.
   * @param {unknown[]} array
   */
  function valid_array_indices(array) {
    const keys = Object.keys(array);
    for (var i = keys.length - 1; i >= 0; i--) {
      if (is_valid_array_index(keys[i])) {
        break;
      }
    }
    keys.length = i + 1;
    return keys;
  }

  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$";
  const unsafe_chars = /[<\b\f\n\r\t\0\u2028\u2029]/g;
  const reserved =
    /^(?:do|if|in|for|int|let|new|try|var|byte|case|char|else|enum|goto|long|this|void|with|await|break|catch|class|const|final|float|short|super|throw|while|yield|delete|double|export|import|native|return|switch|throws|typeof|boolean|default|extends|finally|package|private|abstract|continue|debugger|function|volatile|interface|protected|transient|implements|instanceof|synchronized)$/;

  /**
   * Turn a value into the JavaScript that creates an equivalent value
   * @param {any} value
   * @param {(value: any, uneval: (value: any) => string) => string | void} [replacer]
   */
  function uneval(value, replacer) {
    const counts = new Map();

    /** @type {string[]} */
    const keys = [];

    const custom = new Map();

    /** @param {any} thing */
    function walk(thing) {
      if (!is_primitive(thing)) {
        if (counts.has(thing)) {
          counts.set(thing, counts.get(thing) + 1);
          return;
        }

        counts.set(thing, 1);

        if (replacer) {
          const str = replacer(thing, (value) => uneval(value, replacer));

          if (typeof str === "string") {
            custom.set(thing, str);
            return;
          }
        }

        if (typeof thing === "function") {
          throw new DevalueError(
            `Cannot stringify a function`,
            keys,
            thing,
            value,
          );
        }

        const type = get_type(thing);

        switch (type) {
          case "Number":
          case "BigInt":
          case "String":
          case "Boolean":
          case "Date":
          case "RegExp":
          case "URL":
          case "URLSearchParams":
            return;

          case "Array":
            /** @type {any[]} */ (thing).forEach((value, i) => {
              keys.push(`[${i}]`);
              walk(value);
              keys.pop();
            });
            break;

          case "Set":
            Array.from(thing).forEach(walk);
            break;

          case "Map":
            for (const [key, value] of thing) {
              keys.push(
                `.get(${is_primitive(key) ? stringify_primitive$1(key) : "..."})`,
              );
              walk(value);
              keys.pop();
            }
            break;

          case "Int8Array":
          case "Uint8Array":
          case "Uint8ClampedArray":
          case "Int16Array":
          case "Uint16Array":
          case "Float16Array":
          case "Int32Array":
          case "Uint32Array":
          case "Float32Array":
          case "Float64Array":
          case "BigInt64Array":
          case "BigUint64Array":
          case "DataView":
            walk(thing.buffer);
            return;

          case "ArrayBuffer":
            return;

          case "Temporal.Duration":
          case "Temporal.Instant":
          case "Temporal.PlainDate":
          case "Temporal.PlainTime":
          case "Temporal.PlainDateTime":
          case "Temporal.PlainMonthDay":
          case "Temporal.PlainYearMonth":
          case "Temporal.ZonedDateTime":
            return;

          default:
            if (!is_plain_object(thing)) {
              throw new DevalueError(
                `Cannot stringify arbitrary non-POJOs`,
                keys,
                thing,
                value,
              );
            }

            if (enumerable_symbols(thing).length > 0) {
              throw new DevalueError(
                `Cannot stringify POJOs with symbolic keys`,
                keys,
                thing,
                value,
              );
            }

            for (const key of Object.keys(thing)) {
              if (key === "__proto__") {
                throw new DevalueError(
                  `Cannot stringify objects with __proto__ keys`,
                  keys,
                  thing,
                  value,
                );
              }

              keys.push(stringify_key(key));
              walk(thing[key]);
              keys.pop();
            }
        }
      } else if (typeof thing === "symbol") {
        throw new DevalueError(
          `Cannot stringify a Symbol primitive`,
          keys,
          thing,
          value,
        );
      }
    }

    walk(value);

    const names = new Map();

    Array.from(counts)
      .filter((entry) => entry[1] > 1)
      .sort((a, b) => b[1] - a[1])
      .forEach((entry, i) => {
        names.set(entry[0], get_name(i));
      });

    /**
     * @param {any} thing
     * @returns {string}
     */
    function stringify(thing) {
      if (names.has(thing)) {
        return names.get(thing);
      }

      if (is_primitive(thing)) {
        return stringify_primitive$1(thing);
      }

      if (custom.has(thing)) {
        return custom.get(thing);
      }

      const type = get_type(thing);

      switch (type) {
        case "Number":
        case "String":
        case "Boolean":
        case "BigInt":
          return `Object(${stringify(thing.valueOf())})`;

        case "RegExp":
          const { source, flags } = thing;
          return flags
            ? `new RegExp(${stringify_string(source)},"${flags}")`
            : `new RegExp(${stringify_string(source)})`;

        case "Date":
          return `new Date(${thing.getTime()})`;

        case "URL":
          return `new URL(${stringify_string(thing.toString())})`;

        case "URLSearchParams":
          return `new URLSearchParams(${stringify_string(thing.toString())})`;

        case "Array": {
          // For dense arrays (no holes), we iterate normally.
          // When we encounter the first hole, we call Object.keys
          // to determine the sparseness, then decide between:
          //   - Array literal with holes: [,"a",,] (default)
          //   - Object.assign: Object.assign(Array(n),{...}) (for very sparse arrays)
          // Only the Object.assign path avoids iterating every slot, which
          // is what protects against the DoS of e.g. `arr[1000000] = 1`.
          let has_holes = false;

          let result = "[";

          for (let i = 0; i < thing.length; i += 1) {
            if (i > 0) result += ",";

            if (Object.hasOwn(thing, i)) {
              result += stringify(thing[i]);
            } else if (!has_holes) {
              // Decide between array literal and Object.assign.
              //
              // Array literal: holes are consecutive commas.
              // For example, [, "a", ,] is written as [,"a",,].
              // Each hole costs 1 char (a comma).
              //
              // Object.assign: populated indices are listed explicitly.
              // For example, [, "a", ,] would be written as
              // Object.assign(Array(3),{1:"a"}). This avoids paying
              // per-hole, but has a large fixed overhead for the
              // "Object.assign(Array(n),{...})" wrapper, and each
              // element costs extra chars for its index and colon.
              //
              // The serialized values are the same size either way, so
              // the choice comes down to the structural overhead:
              //
              //   Array literal overhead:
              //     1 char per element or hole (comma separators)
              //     + 2 chars for "[" and "]"
              //     = L + 2
              //
              //   Object.assign overhead:
              //     "Object.assign(Array(" — 20 chars
              //     + length              — d chars
              //     + "),{"               — 3 chars
              //     + for each populated element:
              //       index + ":" + ","   — (d + 2) chars
              //     + "})"                — 2 chars
              //     = (25 + d) + P * (d + 2)
              //
              // where L is the array length, P is the number of
              // populated elements, and d is the number of digits
              // in L (an upper bound on the digits in any index).
              //
              // Object.assign is cheaper when:
              //   (25 + d) + P * (d + 2) < L + 2
              const populated_keys = valid_array_indices(
                /** @type {any[]} */ (thing),
              );
              const population = populated_keys.length;
              const d = String(thing.length).length;

              const hole_cost = thing.length + 2;
              const sparse_cost = 25 + d + population * (d + 2);

              if (hole_cost > sparse_cost) {
                const entries = populated_keys
                  .map((k) => `${k}:${stringify(thing[k])}`)
                  .join(",");
                return `Object.assign(Array(${thing.length}),{${entries}})`;
              }

              // Re-process this index as a hole in the array literal
              has_holes = true;
              i -= 1;
            }
            // else: already decided on array literal, hole is just an empty slot
            // (the comma separator is all we need — no content for this position)
          }

          const tail =
            thing.length === 0 || thing.length - 1 in thing ? "" : ",";
          return result + tail + "]";
        }

        case "Set":
        case "Map":
          return `new ${type}([${Array.from(thing).map(stringify).join(",")}])`;

        case "Int8Array":
        case "Uint8Array":
        case "Uint8ClampedArray":
        case "Int16Array":
        case "Uint16Array":
        case "Float16Array":
        case "Int32Array":
        case "Uint32Array":
        case "Float32Array":
        case "Float64Array":
        case "BigInt64Array":
        case "BigUint64Array": {
          let str = `new ${type}`;

          if (!names.has(thing.buffer)) {
            const array = new thing.constructor(thing.buffer);
            str += `([${array}])`;
          } else {
            str += `(${stringify(thing.buffer)})`;
          }

          // handle subarrays
          if (thing.byteLength !== thing.buffer.byteLength) {
            const start = thing.byteOffset / thing.BYTES_PER_ELEMENT;
            const end = start + thing.length;
            str += `.subarray(${start},${end})`;
          }

          return str;
        }

        case "DataView": {
          let str = `new DataView`;

          if (!names.has(thing.buffer)) {
            str += `(new Uint8Array([${new Uint8Array(thing.buffer)}]).buffer`;
          } else {
            str += `(${stringify(thing.buffer)}`;
          }

          // handle subviews
          if (thing.byteLength !== thing.buffer.byteLength) {
            str += `,${thing.startOffset},${thing.byteLength}`;
          }

          return str + ")";
        }

        case "ArrayBuffer": {
          const ui8 = new Uint8Array(thing);
          return `new Uint8Array([${ui8.toString()}]).buffer`;
        }

        case "Temporal.Duration":
        case "Temporal.Instant":
        case "Temporal.PlainDate":
        case "Temporal.PlainTime":
        case "Temporal.PlainDateTime":
        case "Temporal.PlainMonthDay":
        case "Temporal.PlainYearMonth":
        case "Temporal.ZonedDateTime":
          return `${type}.from(${stringify_string(thing.toString())})`;

        default:
          const keys = Object.keys(thing);
          const obj = keys
            .map((key) => `${safe_key(key)}:${stringify(thing[key])}`)
            .join(",");
          const proto = Object.getPrototypeOf(thing);
          if (proto === null) {
            return keys.length > 0
              ? `{${obj},__proto__:null}`
              : `{__proto__:null}`;
          }

          return `{${obj}}`;
      }
    }

    const str = stringify(value);

    if (names.size) {
      /** @type {string[]} */
      const params = [];

      /** @type {string[]} */
      const statements = [];

      /** @type {string[]} */
      const values = [];

      names.forEach((name, thing) => {
        params.push(name);

        if (custom.has(thing)) {
          values.push(/** @type {string} */ (custom.get(thing)));
          return;
        }

        if (is_primitive(thing)) {
          values.push(stringify_primitive$1(thing));
          return;
        }

        const type = get_type(thing);

        switch (type) {
          case "Number":
          case "String":
          case "Boolean":
          case "BigInt":
            values.push(`Object(${stringify(thing.valueOf())})`);
            break;

          case "RegExp":
            const { source, flags } = thing;
            const regexp = flags
              ? `new RegExp(${stringify_string(source)},"${flags}")`
              : `new RegExp(${stringify_string(source)})`;
            values.push(regexp);
            break;

          case "Date":
            values.push(`new Date(${thing.getTime()})`);
            break;

          case "URL":
            values.push(`new URL(${stringify_string(thing.toString())})`);
            break;

          case "URLSearchParams":
            values.push(
              `new URLSearchParams(${stringify_string(thing.toString())})`,
            );
            break;

          case "Array":
            values.push(`Array(${thing.length})`);
            /** @type {any[]} */ (thing).forEach((v, i) => {
              statements.push(`${name}[${i}]=${stringify(v)}`);
            });
            break;

          case "Set":
            values.push(`new Set`);
            statements.push(
              `${name}.${Array.from(thing)
                .map((v) => `add(${stringify(v)})`)
                .join(".")}`,
            );
            break;

          case "Map":
            values.push(`new Map`);
            statements.push(
              `${name}.${Array.from(thing)
                .map(([k, v]) => `set(${stringify(k)}, ${stringify(v)})`)
                .join(".")}`,
            );
            break;

          case "Int8Array":
          case "Uint8Array":
          case "Uint8ClampedArray":
          case "Int16Array":
          case "Uint16Array":
          case "Float16Array":
          case "Int32Array":
          case "Uint32Array":
          case "Float32Array":
          case "Float64Array":
          case "BigInt64Array":
          case "BigUint64Array": {
            let str = `new ${type}`;

            if (!names.has(thing.buffer)) {
              const array = new thing.constructor(thing.buffer);
              str += `([${array}])`;
            } else {
              str += `(${stringify(thing.buffer)})`;
            }

            // handle subarrays
            if (thing.byteLength !== thing.buffer.byteLength) {
              const start = thing.byteOffset / thing.BYTES_PER_ELEMENT;
              const end = start + thing.length;
              str += `.subarray(${start},${end})`;
            }

            values.push(`{}`);
            statements.push(`${name}=${str}`);
            break;
          }

          case "DataView": {
            let str = `new DataView`;

            if (!names.has(thing.buffer)) {
              str += `(new Uint8Array([${new Uint8Array(thing.buffer)}]).buffer`;
            } else {
              str += `(${stringify(thing.buffer)}`;
            }

            // handle subviews
            if (thing.byteLength !== thing.buffer.byteLength) {
              str += `,${thing.byteOffset},${thing.byteLength}`;
            }

            str += ")";

            values.push(`{}`);
            statements.push(`${name}=${str}`);
            break;
          }

          case "ArrayBuffer":
            values.push(`new Uint8Array([${new Uint8Array(thing)}]).buffer`);
            break;

          default:
            values.push(
              Object.getPrototypeOf(thing) === null
                ? "Object.create(null)"
                : "{}",
            );
            Object.keys(thing).forEach((key) => {
              statements.push(
                `${name}${safe_prop(key)}=${stringify(thing[key])}`,
              );
            });
        }
      });

      statements.push(`return ${str}`);

      return `(function(${params.join(",")}){${statements.join(";")}}(${values.join(",")}))`;
    } else {
      return str;
    }
  }

  /** @param {number} num */
  function get_name(num) {
    let name = "";

    do {
      name = chars[num % chars.length] + name;
      num = ~~(num / chars.length) - 1;
    } while (num >= 0);

    return reserved.test(name) ? `${name}0` : name;
  }

  /** @param {string} c */
  function escape_unsafe_char(c) {
    return escaped[c] || c;
  }

  /** @param {string} str */
  function escape_unsafe_chars(str) {
    return str.replace(unsafe_chars, escape_unsafe_char);
  }

  /** @param {string} key */
  function safe_key(key) {
    return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key)
      ? key
      : escape_unsafe_chars(JSON.stringify(key));
  }

  /** @param {string} key */
  function safe_prop(key) {
    return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key)
      ? `.${key}`
      : `[${escape_unsafe_chars(JSON.stringify(key))}]`;
  }

  /** @param {any} thing */
  function stringify_primitive$1(thing) {
    const type = typeof thing;
    if (type === "string") return stringify_string(thing);
    if (thing === void 0) return "void 0";
    if (thing === 0 && 1 / thing < 0) return "-0";
    const str = String(thing);
    if (type === "number") return str.replace(/^(-)?0\./, "$1.");
    if (type === "bigint") return thing + "n";
    return str;
  }

  /* Baseline 2025 runtimes */

  /**	@type {(array_buffer: ArrayBuffer) => string} */
  function encode_native(array_buffer) {
    return new Uint8Array(array_buffer).toBase64();
  }

  /**	@type {(base64: string) => ArrayBuffer} */
  function decode_native(base64) {
    return Uint8Array.fromBase64(base64).buffer;
  }

  /* Node-compatible runtimes */

  /** @type {(array_buffer: ArrayBuffer) => string} */
  function encode_buffer(array_buffer) {
    return Buffer.from(array_buffer).toString("base64");
  }

  /**	@type {(base64: string) => ArrayBuffer} */
  function decode_buffer(base64) {
    return Uint8Array.from(Buffer.from(base64, "base64")).buffer;
  }

  /* Legacy runtimes */

  /** @type {(array_buffer: ArrayBuffer) => string} */
  function encode_legacy(array_buffer) {
    const array = new Uint8Array(array_buffer);
    let binary = "";

    // the maximum number of arguments to String.fromCharCode.apply
    // should be around 0xFFFF in modern engines
    const chunk_size = 0x8000;
    for (let i = 0; i < array.length; i += chunk_size) {
      const chunk = array.subarray(i, i + chunk_size);
      binary += String.fromCharCode.apply(null, chunk);
    }

    return btoa(binary);
  }

  /**	@type {(base64: string) => ArrayBuffer} */
  function decode_legacy(base64) {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const array = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
      array[i] = binary_string.charCodeAt(i);
    }

    return array.buffer;
  }

  const native = typeof Uint8Array.fromBase64 === "function";
  const buffer =
    typeof process === "object" && process.versions?.node !== undefined;

  const encode64 = native
    ? encode_native
    : buffer
      ? encode_buffer
      : encode_legacy;
  const decode64 = native
    ? decode_native
    : buffer
      ? decode_buffer
      : decode_legacy;

  const UNDEFINED = -1;
  const HOLE = -2;
  const NAN = -3;
  const POSITIVE_INFINITY = -4;
  const NEGATIVE_INFINITY = -5;
  const NEGATIVE_ZERO = -6;
  const SPARSE = -7;

  /**
   * Revive a value serialized with `devalue.stringify`
   * @param {string} serialized
   * @param {Record<string, (value: any) => any>} [revivers]
   */
  function parse(serialized, revivers) {
    return unflatten(JSON.parse(serialized), revivers);
  }

  /**
   * Revive a value flattened with `devalue.stringify`
   * @param {number | any[]} parsed
   * @param {Record<string, (value: any) => any>} [revivers]
   */
  function unflatten(parsed, revivers) {
    if (typeof parsed === "number") return hydrate(parsed, true);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Invalid input");
    }

    const values = /** @type {any[]} */ (parsed);

    const hydrated = Array(values.length);

    /**
     * A set of values currently being hydrated with custom revivers,
     * used to detect invalid cyclical dependencies
     * @type {Set<number> | null}
     */
    let hydrating = null;

    /**
     * @param {number} index
     * @returns {any}
     */
    function hydrate(index, standalone = false) {
      if (index === UNDEFINED) return undefined;
      if (index === NAN) return NaN;
      if (index === POSITIVE_INFINITY) return Infinity;
      if (index === NEGATIVE_INFINITY) return -Infinity;
      if (index === NEGATIVE_ZERO) return -0;

      if (standalone || typeof index !== "number") {
        throw new Error(`Invalid input`);
      }

      if (index in hydrated) return hydrated[index];

      const value = values[index];

      if (!value || typeof value !== "object") {
        hydrated[index] = value;
      } else if (Array.isArray(value)) {
        if (typeof value[0] === "string") {
          const type = value[0];

          const reviver =
            revivers && Object.hasOwn(revivers, type)
              ? revivers[type]
              : undefined;

          if (reviver) {
            let i = value[1];
            if (typeof i !== "number") {
              // if it's not a number, it was serialized by a builtin reviver
              // so we need to munge it into the format expected by a custom reviver
              i = values.push(value[1]) - 1;
            }

            hydrating ??= new Set();

            if (hydrating.has(i)) {
              throw new Error("Invalid circular reference");
            }

            hydrating.add(i);
            hydrated[index] = reviver(hydrate(i));
            hydrating.delete(i);

            return hydrated[index];
          }

          switch (type) {
            case "Date":
              hydrated[index] = new Date(value[1]);
              break;

            case "Set":
              const set = new Set();
              hydrated[index] = set;
              for (let i = 1; i < value.length; i += 1) {
                set.add(hydrate(value[i]));
              }
              break;

            case "Map":
              const map = new Map();
              hydrated[index] = map;
              for (let i = 1; i < value.length; i += 2) {
                map.set(hydrate(value[i]), hydrate(value[i + 1]));
              }
              break;

            case "RegExp":
              hydrated[index] = new RegExp(value[1], value[2]);
              break;

            case "Object": {
              const wrapped_index = value[1];

              if (
                typeof values[wrapped_index] === "object" &&
                values[wrapped_index][0] !== "BigInt"
              ) {
                // avoid infinite recusion in case of malformed input
                throw new Error("Invalid input");
              }

              hydrated[index] = Object(hydrate(wrapped_index));
              break;
            }

            case "BigInt":
              hydrated[index] = BigInt(value[1]);
              break;

            case "null":
              const obj = Object.create(null);
              hydrated[index] = obj;
              for (let i = 1; i < value.length; i += 2) {
                if (value[i] === "__proto__") {
                  throw new Error(
                    "Cannot parse an object with a `__proto__` property",
                  );
                }

                obj[value[i]] = hydrate(value[i + 1]);
              }
              break;

            case "Int8Array":
            case "Uint8Array":
            case "Uint8ClampedArray":
            case "Int16Array":
            case "Uint16Array":
            case "Float16Array":
            case "Int32Array":
            case "Uint32Array":
            case "Float32Array":
            case "Float64Array":
            case "BigInt64Array":
            case "BigUint64Array":
            case "DataView": {
              if (values[value[1]][0] !== "ArrayBuffer") {
                // without this, if we receive malformed input we could
                // end up trying to hydrate in a circle or allocate
                // huge amounts of memory when we call `new TypedArrayConstructor(buffer)`
                throw new Error("Invalid data");
              }

              const TypedArrayConstructor = globalThis[type];
              const buffer = hydrate(value[1]);

              hydrated[index] =
                value[2] !== undefined
                  ? new TypedArrayConstructor(buffer, value[2], value[3])
                  : new TypedArrayConstructor(buffer);

              break;
            }

            case "ArrayBuffer": {
              const base64 = value[1];
              if (typeof base64 !== "string") {
                throw new Error("Invalid ArrayBuffer encoding");
              }
              const arraybuffer = decode64(base64);
              hydrated[index] = arraybuffer;
              break;
            }

            case "Temporal.Duration":
            case "Temporal.Instant":
            case "Temporal.PlainDate":
            case "Temporal.PlainTime":
            case "Temporal.PlainDateTime":
            case "Temporal.PlainMonthDay":
            case "Temporal.PlainYearMonth":
            case "Temporal.ZonedDateTime": {
              const temporalName = type.slice(9);
              // @ts-expect-error TS doesn't know about Temporal yet
              hydrated[index] = Temporal[temporalName].from(value[1]);
              break;
            }

            case "URL": {
              const url = new URL(value[1]);
              hydrated[index] = url;
              break;
            }

            case "URLSearchParams": {
              const url = new URLSearchParams(value[1]);
              hydrated[index] = url;
              break;
            }

            default:
              throw new Error(`Unknown type ${type}`);
          }
        } else if (value[0] === SPARSE) {
          // Sparse array encoding: [SPARSE, length, idx, val, idx, val, ...]
          const len = value[1];

          if (!Number.isInteger(len) || len < 0) {
            throw new Error("Invalid input");
          }

          const array = new Array(len);
          hydrated[index] = array;

          for (let i = 2; i < value.length; i += 2) {
            const idx = value[i];

            if (!Number.isInteger(idx) || idx < 0 || idx >= len) {
              throw new Error("Invalid input");
            }

            array[idx] = hydrate(value[i + 1]);
          }
        } else {
          const array = new Array(value.length);
          hydrated[index] = array;

          for (let i = 0; i < value.length; i += 1) {
            const n = value[i];
            if (n === HOLE) continue;

            array[i] = hydrate(n);
          }
        }
      } else {
        /** @type {Record<string, any>} */
        const object = {};
        hydrated[index] = object;

        for (const key of Object.keys(value)) {
          if (key === "__proto__") {
            throw new Error(
              "Cannot parse an object with a `__proto__` property",
            );
          }

          const n = value[key];
          object[key] = hydrate(n);
        }
      }

      return hydrated[index];
    }

    return hydrate(0);
  }

  /**
   * Turn a value into a JSON string that can be parsed with `devalue.parse`
   * @param {any} value
   * @param {Record<string, (value: any) => any>} [reducers]
   */
  function stringify$1(value, reducers) {
    const stringified = run$1(false, value, reducers);
    return typeof stringified === "string"
      ? stringified
      : `[${stringified.join(",")}]`;
  }

  /**
   * @param {boolean} async
   * @param {any} value
   * @param {Record<string, (value: any) => any>} [reducers]
   */
  function run$1(async, value, reducers) {
    /** @type {any[]} */
    const stringified = [];

    /** @type {Map<any, number>} */
    const indexes = new Map();

    /** @type {Array<{ key: string, fn: (value: any) => any }>} */
    const custom = [];
    if (reducers) {
      for (const key of Object.getOwnPropertyNames(reducers)) {
        custom.push({ key, fn: reducers[key] });
      }
    }

    /** @type {string[]} */
    const keys = [];

    let p = 0;

    /**
     * @param {any} thing
     * @param {number} [index]
     */
    function flatten(thing, index) {
      if (thing === undefined) return UNDEFINED;
      if (Number.isNaN(thing)) return NAN;
      if (thing === Infinity) return POSITIVE_INFINITY;
      if (thing === -Infinity) return NEGATIVE_INFINITY;
      if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO;

      if (indexes.has(thing)) return /** @type {number} */ (indexes.get(thing));

      index ??= p++;
      indexes.set(thing, index);

      for (const { key, fn } of custom) {
        const value = fn(thing);
        if (value) {
          stringified[index] = `["${key}",${flatten(value)}]`;
          return index;
        }
      }

      if (typeof thing === "function") {
        throw new DevalueError(
          `Cannot stringify a function`,
          keys,
          thing,
          value,
        );
      } else if (typeof thing === "symbol") {
        throw new DevalueError(
          `Cannot stringify a Symbol primitive`,
          keys,
          thing,
          value,
        );
      }

      /** @type {string | Promise<any>} */
      let str = "";

      if (is_primitive(thing)) {
        str = stringify_primitive(thing);
      } else if (typeof thing.then === "function") {
        {
          throw new DevalueError(
            `Cannot stringify a Promise or thenable — use stringifyAsync instead`,
            keys,
            thing,
            value,
          );
        }
      } else {
        const type = get_type(thing);

        switch (type) {
          case "Number":
          case "String":
          case "Boolean":
          case "BigInt":
            str = `["Object",${flatten(thing.valueOf())}]`;
            break;

          case "Date":
            const valid = !isNaN(thing.getDate());
            str = `["Date","${valid ? thing.toISOString() : ""}"]`;
            break;

          case "URL":
            str = `["URL",${stringify_string(thing.toString())}]`;
            break;

          case "URLSearchParams":
            str = `["URLSearchParams",${stringify_string(thing.toString())}]`;
            break;

          case "RegExp":
            const { source, flags } = thing;
            str = flags
              ? `["RegExp",${stringify_string(source)},"${flags}"]`
              : `["RegExp",${stringify_string(source)}]`;
            break;

          case "Array": {
            // For dense arrays (no holes), we iterate normally.
            // When we encounter the first hole, we call Object.keys
            // to determine the sparseness, then decide between:
            //   - HOLE encoding: [-2, val, -2, ...] (default)
            //   - Sparse encoding: [-7, length, idx, val, ...] (for very sparse arrays)
            // Only the sparse path avoids iterating every slot, which
            // is what protects against the DoS of e.g. `arr[1000000] = 1`.
            let mostly_dense = false;

            str = "[";

            for (let i = 0; i < thing.length; i += 1) {
              if (i > 0) str += ",";

              if (Object.hasOwn(thing, i)) {
                keys.push(`[${i}]`);
                str += flatten(thing[i]);
                keys.pop();
              } else if (mostly_dense) {
                // Use dense encoding. The heuristic guarantees the
                // array is only mildly sparse, so iterating over every
                // slot is fine.
                str += HOLE;
              } else {
                // Decide between HOLE encoding and sparse encoding.
                //
                // HOLE encoding: each hole is serialized as the HOLE
                // sentinel (-2). For example, [, "a", ,] becomes
                // [-2, 0, -2]. Each hole costs 3 chars ("-2" + comma).
                //
                // Sparse encoding: lists only populated indices.
                // For example, [, "a", ,] becomes [-7, 3, 1, 0] — the
                // -7 sentinel, the array length (3), then index-value
                // pairs. This avoids paying per-hole, but each element
                // costs extra chars to write its index.
                //
                // The values are the same size either way, so the
                // choice comes down to structural overhead:
                //
                //   HOLE overhead:
                //     3 chars per hole ("-2" + comma)
                //     = (L - P) * 3
                //
                //   Sparse overhead:
                //     "-7,"          — 3 chars (sparse sentinel + comma)
                //     + length + "," — (d + 1) chars (array length + comma)
                //     + per element: index + "," — (d + 1) chars
                //     = (4 + d) + P * (d + 1)
                //
                // where L is the array length, P is the number of
                // populated elements, and d is the number of digits
                // in L (an upper bound on the digits in any index).
                //
                // Sparse encoding is cheaper when:
                //   (4 + d) + P * (d + 1) < (L - P) * 3
                const populated_keys = valid_array_indices(
                  /** @type {any[]} */ (thing),
                );
                const population = populated_keys.length;
                const d = String(thing.length).length;

                const hole_cost = (thing.length - population) * 3;
                const sparse_cost = 4 + d + population * (d + 1);

                if (hole_cost > sparse_cost) {
                  str = "[" + SPARSE + "," + thing.length;
                  for (let j = 0; j < populated_keys.length; j++) {
                    const key = populated_keys[j];
                    keys.push(`[${key}]`);
                    str += "," + key + "," + flatten(thing[key]);
                    keys.pop();
                  }
                  break;
                } else {
                  mostly_dense = true;
                  str += HOLE;
                }
              }
            }

            str += "]";

            break;
          }

          case "Set":
            str = '["Set"';

            for (const value of thing) {
              str += `,${flatten(value)}`;
            }

            str += "]";
            break;

          case "Map":
            str = '["Map"';

            for (const [key, value] of thing) {
              keys.push(
                `.get(${is_primitive(key) ? stringify_primitive(key) : "..."})`,
              );
              str += `,${flatten(key)},${flatten(value)}`;
              keys.pop();
            }

            str += "]";
            break;

          case "Int8Array":
          case "Uint8Array":
          case "Uint8ClampedArray":
          case "Int16Array":
          case "Uint16Array":
          case "Float16Array":
          case "Int32Array":
          case "Uint32Array":
          case "Float32Array":
          case "Float64Array":
          case "BigInt64Array":
          case "BigUint64Array":
          case "DataView": {
            /** @type {import("./types.js").TypedArray} */
            const typedArray = thing;
            str = '["' + type + '",' + flatten(typedArray.buffer);

            // handle subarrays
            if (typedArray.byteLength !== typedArray.buffer.byteLength) {
              // to be used with `new TypedArray(buffer, byteOffset, length)`
              str += `,${typedArray.byteOffset},${typedArray.length}`;
            }

            str += "]";
            break;
          }

          case "ArrayBuffer": {
            /** @type {ArrayBuffer} */
            const arraybuffer = thing;
            const base64 = encode64(arraybuffer);

            str = `["ArrayBuffer","${base64}"]`;
            break;
          }

          case "Temporal.Duration":
          case "Temporal.Instant":
          case "Temporal.PlainDate":
          case "Temporal.PlainTime":
          case "Temporal.PlainDateTime":
          case "Temporal.PlainMonthDay":
          case "Temporal.PlainYearMonth":
          case "Temporal.ZonedDateTime":
            str = `["${type}",${stringify_string(thing.toString())}]`;
            break;

          default:
            if (!is_plain_object(thing)) {
              throw new DevalueError(
                `Cannot stringify arbitrary non-POJOs`,
                keys,
                thing,
                value,
              );
            }

            if (enumerable_symbols(thing).length > 0) {
              throw new DevalueError(
                `Cannot stringify POJOs with symbolic keys`,
                keys,
                thing,
                value,
              );
            }

            if (Object.getPrototypeOf(thing) === null) {
              str = '["null"';
              for (const key of Object.keys(thing)) {
                if (key === "__proto__") {
                  throw new DevalueError(
                    `Cannot stringify objects with __proto__ keys`,
                    keys,
                    thing,
                    value,
                  );
                }

                keys.push(stringify_key(key));
                str += `,${stringify_string(key)},${flatten(thing[key])}`;
                keys.pop();
              }
              str += "]";
            } else {
              str = "{";
              let started = false;
              for (const key of Object.keys(thing)) {
                if (key === "__proto__") {
                  throw new DevalueError(
                    `Cannot stringify objects with __proto__ keys`,
                    keys,
                    thing,
                    value,
                  );
                }

                if (started) str += ",";
                started = true;
                keys.push(stringify_key(key));
                str += `${stringify_string(key)}:${flatten(thing[key])}`;
                keys.pop();
              }
              str += "}";
            }
        }
      }

      stringified[index] = str;
      return index;
    }

    const index = flatten(value);

    // special case — value is represented as a negative index
    if (index < 0) return `${index}`;

    return stringified;
  }

  /**
   * @param {any} thing
   * @returns {string}
   */
  function stringify_primitive(thing) {
    const type = typeof thing;
    if (type === "string") return stringify_string(thing);
    if (thing === void 0) return UNDEFINED.toString();
    if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO.toString();
    if (type === "bigint") return `["BigInt","${thing}"]`;
    return String(thing);
  }

  function r(e) {
    var t,
      f,
      n = "";
    if ("string" == typeof e || "number" == typeof e) n += e;
    else if ("object" == typeof e)
      if (Array.isArray(e)) {
        var o = e.length;
        for (t = 0; t < o; t++)
          e[t] && (f = r(e[t])) && (n && (n += " "), (n += f));
      } else for (f in e) e[f] && (n && (n += " "), (n += f));
    return n;
  }
  function clsx() {
    for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++)
      (e = arguments[f]) && (t = r(e)) && (n && (n += " "), (n += t));
    return n;
  }

  //#region node_modules/svelte/src/internal/shared/errors.js
  /**
   * Cannot use `%name%(...)` unless the `experimental.async` compiler option is `true`
   * @param {string} name
   * @returns {never}
   */
  function experimental_async_required(name) {
    throw new Error(`https://svelte.dev/e/experimental_async_required`);
  }
  /**
   * `%name%(...)` can only be used during component initialisation
   * @param {string} name
   * @returns {never}
   */
  function lifecycle_outside_component(name) {
    throw new Error(`https://svelte.dev/e/lifecycle_outside_component`);
  }
  /**
   * Context was not set in a parent component
   * @returns {never}
   */
  function missing_context() {
    throw new Error(`https://svelte.dev/e/missing_context`);
  }
  /**
   * Encountered asynchronous work while rendering synchronously.
   * @returns {never}
   */
  function await_invalid() {
    const error = /* @__PURE__ */ new Error(
      `await_invalid\nEncountered asynchronous work while rendering synchronously.\nhttps://svelte.dev/e/await_invalid`,
    );
    error.name = "Svelte error";
    throw error;
  }
  /**
   * Failed to serialize `hydratable` data for key `%key%`.
   *
   * `hydratable` can serialize anything [`uneval` from `devalue`](https://npmjs.com/package/uneval) can, plus Promises.
   *
   * Cause:
   * %stack%
   * @param {string} key
   * @param {string} stack
   * @returns {never}
   */
  function hydratable_serialization_failed(key, stack) {
    const error =
      /* @__PURE__ */ new Error(`hydratable_serialization_failed\nFailed to serialize \`hydratable\` data for key \`${key}\`.

\`hydratable\` can serialize anything [\`uneval\` from \`devalue\`](https://npmjs.com/package/uneval) can, plus Promises.

Cause:
${stack}\nhttps://svelte.dev/e/hydratable_serialization_failed`);
    error.name = "Svelte error";
    throw error;
  }
  /**
   * `csp.nonce` was set while `csp.hash` was `true`. These options cannot be used simultaneously.
   * @returns {never}
   */
  function invalid_csp() {
    const error = /* @__PURE__ */ new Error(
      `invalid_csp\n\`csp.nonce\` was set while \`csp.hash\` was \`true\`. These options cannot be used simultaneously.\nhttps://svelte.dev/e/invalid_csp`,
    );
    error.name = "Svelte error";
    throw error;
  }
  /**
   * The `idPrefix` option cannot include `--`.
   * @returns {never}
   */
  function invalid_id_prefix() {
    const error = /* @__PURE__ */ new Error(
      `invalid_id_prefix\nThe \`idPrefix\` option cannot include \`--\`.\nhttps://svelte.dev/e/invalid_id_prefix`,
    );
    error.name = "Svelte error";
    throw error;
  }
  /**
   * `%name%(...)` is not available on the server
   * @param {string} name
   * @returns {never}
   */
  function lifecycle_function_unavailable(name) {
    const error = /* @__PURE__ */ new Error(
      `lifecycle_function_unavailable\n\`${name}(...)\` is not available on the server\nhttps://svelte.dev/e/lifecycle_function_unavailable`,
    );
    error.name = "Svelte error";
    throw error;
  }
  /**
   * Could not resolve `render` context.
   * @returns {never}
   */
  function server_context_required() {
    const error = /* @__PURE__ */ new Error(
      `server_context_required\nCould not resolve \`render\` context.\nhttps://svelte.dev/e/server_context_required`,
    );
    error.name = "Svelte error";
    throw error;
  }
  //#endregion
  //#region node_modules/svelte/src/internal/server/context.js
  /** @import { SSRContext } from '#server' */
  /** @type {SSRContext | null} */
  var ssr_context = null;
  /** @param {SSRContext | null} v */
  function set_ssr_context(v) {
    ssr_context = v;
  }
  /**
   * @template T
   * @returns {[() => T, (context: T) => T]}
   * @since 5.40.0
   */
  function createContext() {
    const key = {};
    return [
      () => {
        if (!hasContext(key)) missing_context();
        return getContext(key);
      },
      (context) => setContext(key, context),
    ];
  }
  /**
   * @template T
   * @param {any} key
   * @returns {T}
   */
  function getContext(key) {
    return get_or_init_context_map().get(key);
  }
  /**
   * @template T
   * @param {any} key
   * @param {T} context
   * @returns {T}
   */
  function setContext(key, context) {
    get_or_init_context_map().set(key, context);
    return context;
  }
  /**
   * @param {any} key
   * @returns {boolean}
   */
  function hasContext(key) {
    return get_or_init_context_map().has(key);
  }
  /** @returns {Map<any, any>} */
  function getAllContexts() {
    return get_or_init_context_map();
  }
  /**
   * @param {string} name
   * @returns {Map<unknown, unknown>}
   */
  function get_or_init_context_map(name) {
    if (ssr_context === null) lifecycle_outside_component();
    return (ssr_context.c ??= new Map(
      get_parent_context(ssr_context) || void 0,
    ));
  }
  /**
   * @param {Function} [fn]
   */
  function push$1(fn) {
    ssr_context = {
      p: ssr_context,
      c: null,
      r: null,
    };
  }
  function pop$1() {
    ssr_context = ssr_context.p;
  }
  /**
   * @param {SSRContext} ssr_context
   * @returns {Map<unknown, unknown> | null}
   */
  function get_parent_context(ssr_context) {
    let parent = ssr_context.p;
    while (parent !== null) {
      const context_map = parent.c;
      if (context_map !== null) return context_map;
      parent = parent.p;
    }
    return null;
  }
  //#endregion
  //#region node_modules/svelte/src/internal/shared/utils.js
  var is_array = Array.isArray;
  var index_of = Array.prototype.indexOf;
  var includes = Array.prototype.includes;
  var array_from = Array.from;
  var define_property = Object.defineProperty;
  var get_descriptor = Object.getOwnPropertyDescriptor;
  var object_prototype = Object.prototype;
  var array_prototype = Array.prototype;
  var get_prototype_of = Object.getPrototypeOf;
  var is_extensible = Object.isExtensible;
  var has_own_property = Object.prototype.hasOwnProperty;
  var noop$1 = () => {};
  /** @param {Function} fn */
  function run(fn) {
    return fn();
  }
  /** @param {Array<() => void>} arr */
  function run_all(arr) {
    for (var i = 0; i < arr.length; i++) arr[i]();
  }
  /**
   * TODO replace with Promise.withResolvers once supported widely enough
   * @template [T=void]
   */
  function deferred() {
    /** @type {(value: T) => void} */
    var resolve;
    /** @type {(reason: any) => void} */
    var reject;
    return {
      promise: new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
      resolve,
      reject,
    };
  }
  var CLEAN = 1024;
  var DIRTY = 2048;
  var MAYBE_DIRTY = 4096;
  var INERT = 8192;
  var DESTROYED = 16384;
  /** Set once a reaction has run for the first time */
  var REACTION_RAN = 32768;
  /** Effect is in the process of getting destroyed. Can be observed in child teardown functions */
  var DESTROYING = 1 << 25;
  /**
   * 'Transparent' effects do not create a transition boundary.
   * This is on a block effect 99% of the time but may also be on a branch effect if its parent block effect was pruned
   */
  var EFFECT_TRANSPARENT = 65536;
  var EFFECT_PRESERVED = 1 << 19;
  var USER_EFFECT = 1 << 20;
  /**
   * Tells that we marked this derived and its reactions as visited during the "mark as (maybe) dirty"-phase.
   * Will be lifted during execution of the derived and during checking its dirty state (both are necessary
   * because a derived might be checked but not executed). This is a pure performance optimization flag and
   * should not be used for any other purpose!
   */
  var WAS_MARKED = 65536;
  var REACTION_IS_UPDATING = 1 << 21;
  var ERROR_VALUE = 1 << 23;
  var STATE_SYMBOL = Symbol("$state");
  var LEGACY_PROPS = Symbol("legacy props");
  /** allow users to ignore aborted signal errors if `reason.name === 'StaleReactionError` */
  var STALE_REACTION = new (class StaleReactionError extends Error {
    name = "StaleReactionError";
    message =
      "The reaction that called `getAbortSignal()` was re-run or destroyed";
  })();
  //#endregion
  //#region node_modules/svelte/src/internal/server/abort-signal.js
  /** @type {AbortController | null} */
  var controller = null;
  function abort() {
    controller?.abort(STALE_REACTION);
    controller = null;
  }
  function getAbortSignal() {
    return (controller ??= new AbortController()).signal;
  }
  /** @returns {RenderContext} */
  function get_render_context() {
    const store = als$1?.getStore();
    server_context_required();
    return store;
  }
  /** @type {AsyncLocalStorage<RenderContext | null> | null} */
  var als$1 = null;
  //#endregion
  //#region node_modules/svelte/src/constants.js
  var HYDRATION_ERROR = {};
  var UNINITIALIZED = Symbol();
  /**
   * A `hydratable` value with key `%key%` was created, but at least part of it was not used during the render.
   *
   * The `hydratable` was initialized in:
   * %stack%
   * @param {string} key
   * @param {string} stack
   */
  function unresolved_hydratable(key, stack) {
    console.warn(`https://svelte.dev/e/unresolved_hydratable`);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/server/hydration.js
  var BLOCK_OPEN = `<!--[-->`;
  var BLOCK_CLOSE = `<!--]-->`;
  var EMPTY_COMMENT = `<!---->`;
  //#endregion
  //#region node_modules/svelte/src/escaping.js
  var ATTR_REGEX = /[&"<]/g;
  var CONTENT_REGEX = /[&<]/g;
  /**
   * @template V
   * @param {V} value
   * @param {boolean} [is_attr]
   */
  function escape_html$1(value, is_attr) {
    const str = String(value ?? "");
    const pattern = is_attr ? ATTR_REGEX : CONTENT_REGEX;
    pattern.lastIndex = 0;
    let escaped = "";
    let last = 0;
    while (pattern.test(str)) {
      const i = pattern.lastIndex - 1;
      const ch = str[i];
      escaped +=
        str.substring(last, i) +
        (ch === "&" ? "&amp;" : ch === '"' ? "&quot;" : "&lt;");
      last = i + 1;
    }
    return escaped + str.substring(last);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/shared/attributes.js
  /**
   * `<div translate={false}>` should be rendered as `<div translate="no">` and _not_
   * `<div translate="false">`, which is equivalent to `<div translate="yes">`. There
   * may be other odd cases that need to be added to this list in future
   * @type {Record<string, Map<any, string>>}
   */
  var replacements$1 = {
    translate: new Map([
      [true, "yes"],
      [false, "no"],
    ]),
  };
  /**
   * @template V
   * @param {string} name
   * @param {V} value
   * @param {boolean} [is_boolean]
   * @returns {string}
   */
  function attr(name, value, is_boolean = false) {
    if (name === "hidden" && value !== "until-found") is_boolean = true;
    if (value == null || (!value && is_boolean)) return "";
    const normalized =
      (has_own_property.call(replacements$1, name) &&
        replacements$1[name].get(value)) ||
      value;
    return ` ${name}${is_boolean ? `=""` : `="${escape_html$1(normalized, true)}"`}`;
  }
  /**
   * Small wrapper around clsx to preserve Svelte's (weird) handling of falsy values.
   * TODO Svelte 6 revisit this, and likely turn all falsy values into the empty string (what clsx also does)
   * @param  {any} value
   */
  function clsx$1(value) {
    if (typeof value === "object") return clsx(value);
    else return value ?? "";
  }
  var whitespace = [..." 	\n\r\f\xA0\v﻿"];
  /**
   * @param {any} value
   * @param {string | null} [hash]
   * @param {Record<string, boolean>} [directives]
   * @returns {string | null}
   */
  function to_class(value, hash, directives) {
    var classname = value == null ? "" : "" + value;
    if (hash) classname = classname ? classname + " " + hash : hash;
    if (directives) {
      for (var key of Object.keys(directives))
        if (directives[key])
          classname = classname ? classname + " " + key : key;
        else if (classname.length) {
          var len = key.length;
          var a = 0;
          while ((a = classname.indexOf(key, a)) >= 0) {
            var b = a + len;
            if (
              (a === 0 || whitespace.includes(classname[a - 1])) &&
              (b === classname.length || whitespace.includes(classname[b]))
            )
              classname =
                (a === 0 ? "" : classname.substring(0, a)) +
                classname.substring(b + 1);
            else a = b;
          }
        }
    }
    return classname === "" ? null : classname;
  }
  /**
   *
   * @param {Record<string,any>} styles
   * @param {boolean} important
   */
  function append_styles(styles, important = false) {
    var separator = important ? " !important;" : ";";
    var css = "";
    for (var key of Object.keys(styles)) {
      var value = styles[key];
      if (value != null && value !== "")
        css += " " + key + ": " + value + separator;
    }
    return css;
  }
  /**
   * @param {string} name
   * @returns {string}
   */
  function to_css_name(name) {
    if (name[0] !== "-" || name[1] !== "-") return name.toLowerCase();
    return name;
  }
  /**
   * @param {any} value
   * @param {Record<string, any> | [Record<string, any>, Record<string, any>]} [styles]
   * @returns {string | null}
   */
  function to_style(value, styles) {
    if (styles) {
      var new_style = "";
      /** @type {Record<string,any> | undefined} */
      var normal_styles;
      /** @type {Record<string,any> | undefined} */
      var important_styles;
      if (Array.isArray(styles)) {
        normal_styles = styles[0];
        important_styles = styles[1];
      } else normal_styles = styles;
      if (value) {
        value = String(value)
          .replaceAll(/\s*\/\*.*?\*\/\s*/g, "")
          .trim();
        /** @type {boolean | '"' | "'"} */
        var in_str = false;
        var in_apo = 0;
        var in_comment = false;
        var reserved_names = [];
        if (normal_styles)
          reserved_names.push(...Object.keys(normal_styles).map(to_css_name));
        if (important_styles)
          reserved_names.push(
            ...Object.keys(important_styles).map(to_css_name),
          );
        var start_index = 0;
        var name_index = -1;
        const len = value.length;
        for (var i = 0; i < len; i++) {
          var c = value[i];
          if (in_comment) {
            if (c === "/" && value[i - 1] === "*") in_comment = false;
          } else if (in_str) {
            if (in_str === c) in_str = false;
          } else if (c === "/" && value[i + 1] === "*") in_comment = true;
          else if (c === '"' || c === "'") in_str = c;
          else if (c === "(") in_apo++;
          else if (c === ")") in_apo--;
          if (!in_comment && in_str === false && in_apo === 0) {
            if (c === ":" && name_index === -1) name_index = i;
            else if (c === ";" || i === len - 1) {
              if (name_index !== -1) {
                var name = to_css_name(
                  value.substring(start_index, name_index).trim(),
                );
                if (!reserved_names.includes(name)) {
                  if (c !== ";") i++;
                  var property = value.substring(start_index, i).trim();
                  new_style += " " + property + ";";
                }
              }
              start_index = i + 1;
              name_index = -1;
            }
          }
        }
      }
      if (normal_styles) new_style += append_styles(normal_styles);
      if (important_styles) new_style += append_styles(important_styles, true);
      new_style = new_style.trim();
      return new_style === "" ? null : new_style;
    }
    return value == null ? null : String(value);
  }
  /**
   * Maximum update depth exceeded. This typically indicates that an effect reads and writes the same piece of state
   * @returns {never}
   */
  function effect_update_depth_exceeded() {
    throw new Error(`https://svelte.dev/e/effect_update_depth_exceeded`);
  }
  /**
   * Failed to hydrate the application
   * @returns {never}
   */
  function hydration_failed() {
    throw new Error(`https://svelte.dev/e/hydration_failed`);
  }
  /**
   * Property descriptors defined on `$state` objects must contain `value` and always be `enumerable`, `configurable` and `writable`.
   * @returns {never}
   */
  function state_descriptors_fixed() {
    throw new Error(`https://svelte.dev/e/state_descriptors_fixed`);
  }
  /**
   * Cannot set prototype of `$state` object
   * @returns {never}
   */
  function state_prototype_fixed() {
    throw new Error(`https://svelte.dev/e/state_prototype_fixed`);
  }
  /**
   * Updating state inside `$derived(...)`, `$inspect(...)` or a template expression is forbidden. If the value should not be reactive, declare it without `$state`
   * @returns {never}
   */
  function state_unsafe_mutation() {
    throw new Error(`https://svelte.dev/e/state_unsafe_mutation`);
  }
  /**
   * A `<svelte:boundary>` `reset` function cannot be called while an error is still being handled
   * @returns {never}
   */
  function svelte_boundary_reset_onerror() {
    throw new Error(`https://svelte.dev/e/svelte_boundary_reset_onerror`);
  }
  /**
   * Reading a derived belonging to a now-destroyed effect may result in stale values
   */
  function derived_inert() {
    console.warn(`https://svelte.dev/e/derived_inert`);
  }
  /**
   * Hydration failed because the initial UI does not match what was rendered on the server. The error occurred near %location%
   * @param {string | undefined | null} [location]
   */
  function hydration_mismatch(location) {
    console.warn(`https://svelte.dev/e/hydration_mismatch`);
  }
  /**
   * A `<svelte:boundary>` `reset` function only resets the boundary the first time it is called
   */
  function svelte_boundary_reset_noop() {
    console.warn(`https://svelte.dev/e/svelte_boundary_reset_noop`);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/dom/hydration.js
  /** @import { TemplateNode } from '#client' */
  /**
   * Use this variable to guard everything related to hydration code so it can be treeshaken out
   * if the user doesn't use the `hydrate` method and these code paths are therefore not needed.
   */
  var hydrating = false;
  /** @param {boolean} value */
  function set_hydrating(value) {
    hydrating = value;
  }
  /**
   * The node that is currently being hydrated. This starts out as the first node inside the opening
   * <!--[--> comment, and updates each time a component calls `$.child(...)` or `$.sibling(...)`.
   * When entering a block (e.g. `{#if ...}`), `hydrate_node` is the block opening comment; by the
   * time we leave the block it is the closing comment, which serves as the block's anchor.
   * @type {TemplateNode}
   */
  var hydrate_node;
  /** @param {TemplateNode | null} node */
  function set_hydrate_node(node) {
    if (node === null) {
      hydration_mismatch();
      throw HYDRATION_ERROR;
    }
    return (hydrate_node = node);
  }
  function hydrate_next() {
    return set_hydrate_node(/* @__PURE__ */ get_next_sibling(hydrate_node));
  }
  function next(count = 1) {
    if (hydrating) {
      var i = count;
      var node = hydrate_node;
      while (i--) node = /* @__PURE__ */ get_next_sibling(node);
      hydrate_node = node;
    }
  }
  /**
   * Skips or removes (depending on {@link remove}) all nodes starting at `hydrate_node` up until the next hydration end comment
   * @param {boolean} remove
   */
  function skip_nodes(remove = true) {
    var depth = 0;
    var node = hydrate_node;
    while (true) {
      if (node.nodeType === 8) {
        var data = node.data;
        if (data === "]") {
          if (depth === 0) return node;
          depth -= 1;
        } else if (
          data === "[" ||
          data === "[!" ||
          (data[0] === "[" && !isNaN(Number(data.slice(1))))
        )
          depth += 1;
      }
      var next = /* @__PURE__ */ get_next_sibling(node);
      if (remove) node.remove();
      node = next;
    }
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/reactivity/equality.js
  /** @import { Equals } from '#client' */
  /** @type {Equals} */
  function equals(value) {
    return value === this.v;
  }
  /**
   * @param {unknown} a
   * @param {unknown} b
   * @returns {boolean}
   */
  function safe_not_equal(a, b) {
    return a != a
      ? b == b
      : a !== b ||
          (a !== null && typeof a === "object") ||
          typeof a === "function";
  }
  /** @type {Equals} */
  function safe_equals(value) {
    return !safe_not_equal(value, this.v);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/context.js
  /** @import { ComponentContext, DevStackEntry, Effect } from '#client' */
  /** @type {ComponentContext | null} */
  var component_context = null;
  /** @param {ComponentContext | null} context */
  function set_component_context(context) {
    component_context = context;
  }
  /**
   * @param {Record<string, unknown>} props
   * @param {any} runes
   * @param {Function} [fn]
   * @returns {void}
   */
  function push(props, runes = false, fn) {
    component_context = {
      p: component_context,
      i: false,
      c: null,
      e: null,
      s: props,
      x: null,
      r: active_effect,
      l: null,
    };
  }
  /**
   * @template {Record<string, any>} T
   * @param {T} [component]
   * @returns {T}
   */
  function pop(component) {
    var context = component_context;
    var effects = context.e;
    if (effects !== null) {
      context.e = null;
      for (var fn of effects) create_user_effect(fn);
    }
    context.i = true;
    component_context = context.p;
    return {};
  }
  /** @returns {boolean} */
  function is_runes() {
    return true;
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/dom/task.js
  /** @type {Array<() => void>} */
  var micro_tasks = [];
  function run_micro_tasks() {
    var tasks = micro_tasks;
    micro_tasks = [];
    run_all(tasks);
  }
  /**
   * @param {() => void} fn
   */
  function queue_micro_task(fn) {
    if (micro_tasks.length === 0 && !is_flushing_sync) {
      var tasks = micro_tasks;
      queueMicrotask(() => {
        if (tasks === micro_tasks) run_micro_tasks();
      });
    }
    micro_tasks.push(fn);
  }
  /**
   * Synchronously run any queued tasks.
   */
  function flush_tasks() {
    while (micro_tasks.length > 0) run_micro_tasks();
  }
  /**
   * @param {unknown} error
   */
  function handle_error(error) {
    var effect = active_effect;
    if (effect === null) {
      /** @type {Derived} */ active_reaction.f |= ERROR_VALUE;
      return error;
    }
    if ((effect.f & 32768) === 0 && (effect.f & 4) === 0) throw error;
    invoke_error_boundary(error, effect);
  }
  /**
   * @param {unknown} error
   * @param {Effect | null} effect
   */
  function invoke_error_boundary(error, effect) {
    while (effect !== null) {
      if ((effect.f & 128) !== 0) {
        if ((effect.f & 32768) === 0) throw error;
        try {
          /** @type {Boundary} */ effect.b.error(error);
          return;
        } catch (e) {
          error = e;
        }
      }
      effect = effect.parent;
    }
    throw error;
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/reactivity/status.js
  /** @import { Derived, Signal } from '#client' */
  var STATUS_MASK = -7169;
  /**
   * @param {Signal} signal
   * @param {number} status
   */
  function set_signal_status(signal, status) {
    signal.f = (signal.f & STATUS_MASK) | status;
  }
  /**
   * Set a derived's status to CLEAN or MAYBE_DIRTY based on its connection state.
   * @param {Derived} derived
   */
  function update_derived_status(derived) {
    if ((derived.f & 512) !== 0 || derived.deps === null)
      set_signal_status(derived, CLEAN);
    else set_signal_status(derived, MAYBE_DIRTY);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/reactivity/utils.js
  /** @import { Derived, Effect, Value } from '#client' */
  /**
   * @param {Value[] | null} deps
   */
  function clear_marked(deps) {
    if (deps === null) return;
    for (const dep of deps) {
      if ((dep.f & 2) === 0 || (dep.f & 65536) === 0) continue;
      dep.f ^= WAS_MARKED;
      clear_marked(
        /** @type {Derived} */
        dep.deps,
      );
    }
  }
  /**
   * @param {Effect} effect
   * @param {Set<Effect>} dirty_effects
   * @param {Set<Effect>} maybe_dirty_effects
   */
  function defer_effect(effect, dirty_effects, maybe_dirty_effects) {
    if ((effect.f & 2048) !== 0) dirty_effects.add(effect);
    else if ((effect.f & 4096) !== 0) maybe_dirty_effects.add(effect);
    clear_marked(effect.deps);
    set_signal_status(effect, CLEAN);
  }
  //#endregion
  //#region node_modules/svelte/src/store/shared/index.js
  /** @import { Readable, StartStopNotifier, Subscriber, Unsubscriber, Updater, Writable } from '../public.js' */
  /** @import { Stores, StoresValues, SubscribeInvalidateTuple } from '../private.js' */
  /**
   * @type {Array<SubscribeInvalidateTuple<any> | any>}
   */
  var subscriber_queue = [];
  /**
   * Creates a `Readable` store that allows reading by subscription.
   *
   * @template T
   * @param {T} [value] initial value
   * @param {StartStopNotifier<T>} [start]
   * @returns {Readable<T>}
   */
  function readable(value, start) {
    return { subscribe: writable(value, start).subscribe };
  }
  /**
   * Create a `Writable` store that allows both updating and reading by subscription.
   *
   * @template T
   * @param {T} [value] initial value
   * @param {StartStopNotifier<T>} [start]
   * @returns {Writable<T>}
   */
  function writable(value, start = noop$1) {
    /** @type {Unsubscriber | null} */
    let stop = null;
    /** @type {Set<SubscribeInvalidateTuple<T>>} */
    const subscribers = /* @__PURE__ */ new Set();
    /**
     * @param {T} new_value
     * @returns {void}
     */
    function set(new_value) {
      if (safe_not_equal(value, new_value)) {
        value = new_value;
        if (stop) {
          const run_queue = !subscriber_queue.length;
          for (const subscriber of subscribers) {
            subscriber[1]();
            subscriber_queue.push(subscriber, value);
          }
          if (run_queue) {
            for (let i = 0; i < subscriber_queue.length; i += 2)
              subscriber_queue[i][0](subscriber_queue[i + 1]);
            subscriber_queue.length = 0;
          }
        }
      }
    }
    /**
     * @param {Updater<T>} fn
     * @returns {void}
     */
    function update(fn) {
      set(fn(value));
    }
    /**
     * @param {Subscriber<T>} run
     * @param {() => void} [invalidate]
     * @returns {Unsubscriber}
     */
    function subscribe(run, invalidate = noop$1) {
      /** @type {SubscribeInvalidateTuple<T>} */
      const subscriber = [run, invalidate];
      subscribers.add(subscriber);
      if (subscribers.size === 1) stop = start(set, update) || noop$1;
      run(value);
      return () => {
        subscribers.delete(subscriber);
        if (subscribers.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    }
    return {
      set,
      update,
      subscribe,
    };
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/reactivity/batch.js
  /** @import { Fork } from 'svelte' */
  /** @import { Derived, Effect, Reaction, Source, Value } from '#client' */
  /** @type {Set<Batch>} */
  var batches = /* @__PURE__ */ new Set();
  /** @type {Batch | null} */
  var current_batch = null;
  /**
   * When time travelling (i.e. working in one batch, while other batches
   * still have ongoing work), we ignore the real values of affected
   * signals in favour of their values within the batch
   * @type {Map<Value, any> | null}
   */
  var batch_values = null;
  /** @type {Effect | null} */
  var last_scheduled_effect = null;
  var is_flushing_sync = false;
  var is_processing = false;
  /**
   * During traversal, this is an array. Newly created effects are (if not immediately
   * executed) pushed to this array, rather than going through the scheduling
   * rigamarole that would cause another turn of the flush loop.
   * @type {Effect[] | null}
   */
  var collected_effects = null;
  /**
   * An array of effects that are marked during traversal as a result of a `set`
   * (not `internal_set`) call. These will be added to the next batch and
   * trigger another `batch.process()`
   * @type {Effect[] | null}
   * @deprecated when we get rid of legacy mode and stores, we can get rid of this
   */
  var legacy_updates = null;
  var flush_count = 0;
  var uid = 1;
  var Batch = class Batch {
    id = uid++;
    /**
     * The current values of any signals that are updated in this batch.
     * Tuple format: [value, is_derived] (note: is_derived is false for deriveds, too, if they were overridden via assignment)
     * They keys of this map are identical to `this.#previous`
     * @type {Map<Value, [any, boolean]>}
     */
    current = /* @__PURE__ */ new Map();
    /**
     * The values of any signals (sources and deriveds) that are updated in this batch _before_ those updates took place.
     * They keys of this map are identical to `this.#current`
     * @type {Map<Value, any>}
     */
    previous = /* @__PURE__ */ new Map();
    /**
     * When the batch is committed (and the DOM is updated), we need to remove old branches
     * and append new ones by calling the functions added inside (if/each/key/etc) blocks
     * @type {Set<(batch: Batch) => void>}
     */
    #commit_callbacks = /* @__PURE__ */ new Set();
    /**
     * If a fork is discarded, we need to destroy any effects that are no longer needed
     * @type {Set<(batch: Batch) => void>}
     */
    #discard_callbacks = /* @__PURE__ */ new Set();
    /**
     * Callbacks that should run only when a fork is committed.
     * @type {Set<(batch: Batch) => void>}
     */
    #fork_commit_callbacks = /* @__PURE__ */ new Set();
    /**
     * Async effects that are currently in flight
     * @type {Map<Effect, number>}
     */
    #pending = /* @__PURE__ */ new Map();
    /**
     * Async effects that are currently in flight, _not_ inside a pending boundary
     * @type {Map<Effect, number>}
     */
    #blocking_pending = /* @__PURE__ */ new Map();
    /**
     * A deferred that resolves when the batch is committed, used with `settled()`
     * TODO replace with Promise.withResolvers once supported widely enough
     * @type {{ promise: Promise<void>, resolve: (value?: any) => void, reject: (reason: unknown) => void } | null}
     */
    #deferred = null;
    /**
     * The root effects that need to be flushed
     * @type {Effect[]}
     */
    #roots = [];
    /**
     * Effects created while this batch was active.
     * @type {Effect[]}
     */
    #new_effects = [];
    /**
     * Deferred effects (which run after async work has completed) that are DIRTY
     * @type {Set<Effect>}
     */
    #dirty_effects = /* @__PURE__ */ new Set();
    /**
     * Deferred effects that are MAYBE_DIRTY
     * @type {Set<Effect>}
     */
    #maybe_dirty_effects = /* @__PURE__ */ new Set();
    /**
     * A map of branches that still exist, but will be destroyed when this batch
     * is committed — we skip over these during `process`.
     * The value contains child effects that were dirty/maybe_dirty before being reset,
     * so they can be rescheduled if the branch survives.
     * @type {Map<Effect, { d: Effect[], m: Effect[] }>}
     */
    #skipped_branches = /* @__PURE__ */ new Map();
    /**
     * Inverse of #skipped_branches which we need to tell prior batches to unskip them when committing
     * @type {Set<Effect>}
     */
    #unskipped_branches = /* @__PURE__ */ new Set();
    is_fork = false;
    #decrement_queued = false;
    /** @type {Set<Batch>} */
    #blockers = /* @__PURE__ */ new Set();
    #is_deferred() {
      return this.is_fork || this.#blocking_pending.size > 0;
    }
    #is_blocked() {
      for (const batch of this.#blockers)
        for (const effect of batch.#blocking_pending.keys()) {
          var skipped = false;
          var e = effect;
          while (e.parent !== null) {
            if (this.#skipped_branches.has(e)) {
              skipped = true;
              break;
            }
            e = e.parent;
          }
          if (!skipped) return true;
        }
      return false;
    }
    /**
     * Add an effect to the #skipped_branches map and reset its children
     * @param {Effect} effect
     */
    skip_effect(effect) {
      if (!this.#skipped_branches.has(effect))
        this.#skipped_branches.set(effect, {
          d: [],
          m: [],
        });
      this.#unskipped_branches.delete(effect);
    }
    /**
     * Remove an effect from the #skipped_branches map and reschedule
     * any tracked dirty/maybe_dirty child effects
     * @param {Effect} effect
     * @param {(e: Effect) => void} callback
     */
    unskip_effect(effect, callback = (e) => this.schedule(e)) {
      var tracked = this.#skipped_branches.get(effect);
      if (tracked) {
        this.#skipped_branches.delete(effect);
        for (var e of tracked.d) {
          set_signal_status(e, DIRTY);
          callback(e);
        }
        for (e of tracked.m) {
          set_signal_status(e, MAYBE_DIRTY);
          callback(e);
        }
      }
      this.#unskipped_branches.add(effect);
    }
    #process() {
      if (flush_count++ > 1e3) {
        batches.delete(this);
        infinite_loop_guard();
      }
      if (!this.#is_deferred()) {
        for (const e of this.#dirty_effects) {
          this.#maybe_dirty_effects.delete(e);
          set_signal_status(e, DIRTY);
          this.schedule(e);
        }
        for (const e of this.#maybe_dirty_effects) {
          set_signal_status(e, MAYBE_DIRTY);
          this.schedule(e);
        }
      }
      const roots = this.#roots;
      this.#roots = [];
      this.apply();
      /** @type {Effect[]} */
      var effects = (collected_effects = []);
      /** @type {Effect[]} */
      var render_effects = [];
      /**
       * @type {Effect[]}
       * @deprecated when we get rid of legacy mode and stores, we can get rid of this
       */
      var updates = (legacy_updates = []);
      for (const root of roots)
        try {
          this.#traverse(root, effects, render_effects);
        } catch (e) {
          reset_all(root);
          throw e;
        }
      current_batch = null;
      if (updates.length > 0) {
        var batch = Batch.ensure();
        for (const e of updates) batch.schedule(e);
      }
      collected_effects = null;
      legacy_updates = null;
      if (this.#is_deferred() || this.#is_blocked()) {
        this.#defer_effects(render_effects);
        this.#defer_effects(effects);
        for (const [e, t] of this.#skipped_branches) reset_branch(e, t);
      } else {
        if (this.#pending.size === 0) batches.delete(this);
        this.#dirty_effects.clear();
        this.#maybe_dirty_effects.clear();
        for (const fn of this.#commit_callbacks) fn(this);
        this.#commit_callbacks.clear();
        flush_queued_effects(render_effects);
        flush_queued_effects(effects);
        this.#deferred?.resolve();
      }
      var next_batch = current_batch;
      if (this.#roots.length > 0) {
        const batch = (next_batch ??= this);
        batch.#roots.push(
          ...this.#roots.filter((r) => !batch.#roots.includes(r)),
        );
      }
      if (next_batch !== null) {
        batches.add(next_batch);
        next_batch.#process();
      }
    }
    /**
     * Traverse the effect tree, executing effects or stashing
     * them for later execution as appropriate
     * @param {Effect} root
     * @param {Effect[]} effects
     * @param {Effect[]} render_effects
     */
    #traverse(root, effects, render_effects) {
      root.f ^= CLEAN;
      var effect = root.first;
      while (effect !== null) {
        var flags = effect.f;
        var is_branch = (flags & 96) !== 0;
        if (
          !(
            (is_branch && (flags & 1024) !== 0) ||
            (flags & 8192) !== 0 ||
            this.#skipped_branches.has(effect)
          ) &&
          effect.fn !== null
        ) {
          if (is_branch) effect.f ^= CLEAN;
          else if ((flags & 4) !== 0) effects.push(effect);
          else if (is_dirty(effect)) {
            if ((flags & 16) !== 0) this.#maybe_dirty_effects.add(effect);
            update_effect(effect);
          }
          var child = effect.first;
          if (child !== null) {
            effect = child;
            continue;
          }
        }
        while (effect !== null) {
          var next = effect.next;
          if (next !== null) {
            effect = next;
            break;
          }
          effect = effect.parent;
        }
      }
    }
    /**
     * @param {Effect[]} effects
     */
    #defer_effects(effects) {
      for (var i = 0; i < effects.length; i += 1)
        defer_effect(
          effects[i],
          this.#dirty_effects,
          this.#maybe_dirty_effects,
        );
    }
    /**
     * Associate a change to a given source with the current
     * batch, noting its previous and current values
     * @param {Value} source
     * @param {any} value
     * @param {boolean} [is_derived]
     */
    capture(source, value, is_derived = false) {
      if (source.v !== UNINITIALIZED && !this.previous.has(source))
        this.previous.set(source, source.v);
      if ((source.f & 8388608) === 0) {
        this.current.set(source, [value, is_derived]);
        batch_values?.set(source, value);
      }
      if (!this.is_fork) source.v = value;
    }
    activate() {
      current_batch = this;
    }
    deactivate() {
      current_batch = null;
      batch_values = null;
    }
    flush() {
      try {
        is_processing = true;
        current_batch = this;
        this.#process();
      } finally {
        flush_count = 0;
        last_scheduled_effect = null;
        collected_effects = null;
        legacy_updates = null;
        is_processing = false;
        current_batch = null;
        batch_values = null;
        old_values.clear();
      }
    }
    discard() {
      for (const fn of this.#discard_callbacks) fn(this);
      this.#discard_callbacks.clear();
      this.#fork_commit_callbacks.clear();
      batches.delete(this);
    }
    /**
     * @param {Effect} effect
     */
    register_created_effect(effect) {
      this.#new_effects.push(effect);
    }
    #commit() {
      for (const batch of batches) {
        var is_earlier = batch.id < this.id;
        /** @type {Source[]} */
        var sources = [];
        for (const [source, [value, is_derived]] of this.current) {
          if (batch.current.has(source)) {
            var batch_value = batch.current.get(source)[0];
            if (is_earlier && value !== batch_value)
              batch.current.set(source, [value, is_derived]);
            else continue;
          }
          sources.push(source);
        }
        var others = [...batch.current.keys()].filter(
          (s) => !this.current.has(s),
        );
        if (others.length === 0) {
          if (is_earlier) batch.discard();
        } else if (sources.length > 0) {
          if (is_earlier)
            for (const unskipped of this.#unskipped_branches)
              batch.unskip_effect(unskipped, (e) => {
                if ((e.f & 4194320) !== 0) batch.schedule(e);
                else batch.#defer_effects([e]);
              });
          batch.activate();
          /** @type {Set<Value>} */
          var marked = /* @__PURE__ */ new Set();
          /** @type {Map<Reaction, boolean>} */
          var checked = /* @__PURE__ */ new Map();
          for (var source of sources)
            mark_effects(source, others, marked, checked);
          checked = /* @__PURE__ */ new Map();
          var current_unequal = [...batch.current.keys()].filter((c) =>
            this.current.has(c) ? this.current.get(c)[0] !== c : true,
          );
          for (const effect of this.#new_effects)
            if (
              (effect.f & 155648) === 0 &&
              depends_on(effect, current_unequal, checked)
            )
              if ((effect.f & 4194320) !== 0) {
                set_signal_status(effect, DIRTY);
                batch.schedule(effect);
              } else batch.#dirty_effects.add(effect);
          if (batch.#roots.length > 0) {
            batch.apply();
            for (var root of batch.#roots) batch.#traverse(root, [], []);
            batch.#roots = [];
          }
          batch.deactivate();
        }
      }
      for (const batch of batches)
        if (batch.#blockers.has(this)) {
          batch.#blockers.delete(this);
          if (batch.#blockers.size === 0 && !batch.#is_deferred()) {
            batch.activate();
            batch.#process();
          }
        }
    }
    /**
     * @param {boolean} blocking
     * @param {Effect} effect
     */
    increment(blocking, effect) {
      let pending_count = this.#pending.get(effect) ?? 0;
      this.#pending.set(effect, pending_count + 1);
      if (blocking) {
        let blocking_pending_count = this.#blocking_pending.get(effect) ?? 0;
        this.#blocking_pending.set(effect, blocking_pending_count + 1);
      }
    }
    /**
     * @param {boolean} blocking
     * @param {Effect} effect
     * @param {boolean} skip - whether to skip updates (because this is triggered by a stale reaction)
     */
    decrement(blocking, effect, skip) {
      let pending_count = this.#pending.get(effect) ?? 0;
      if (pending_count === 1) this.#pending.delete(effect);
      else this.#pending.set(effect, pending_count - 1);
      if (blocking) {
        let blocking_pending_count = this.#blocking_pending.get(effect) ?? 0;
        if (blocking_pending_count === 1) this.#blocking_pending.delete(effect);
        else this.#blocking_pending.set(effect, blocking_pending_count - 1);
      }
      if (this.#decrement_queued || skip) return;
      this.#decrement_queued = true;
      queue_micro_task(() => {
        this.#decrement_queued = false;
        this.flush();
      });
    }
    /**
     * @param {Set<Effect>} dirty_effects
     * @param {Set<Effect>} maybe_dirty_effects
     */
    transfer_effects(dirty_effects, maybe_dirty_effects) {
      for (const e of dirty_effects) this.#dirty_effects.add(e);
      for (const e of maybe_dirty_effects) this.#maybe_dirty_effects.add(e);
      dirty_effects.clear();
      maybe_dirty_effects.clear();
    }
    /** @param {(batch: Batch) => void} fn */
    oncommit(fn) {
      this.#commit_callbacks.add(fn);
    }
    /** @param {(batch: Batch) => void} fn */
    ondiscard(fn) {
      this.#discard_callbacks.add(fn);
    }
    /** @param {(batch: Batch) => void} fn */
    on_fork_commit(fn) {
      this.#fork_commit_callbacks.add(fn);
    }
    run_fork_commit_callbacks() {
      for (const fn of this.#fork_commit_callbacks) fn(this);
      this.#fork_commit_callbacks.clear();
    }
    settled() {
      return (this.#deferred ??= deferred()).promise;
    }
    static ensure() {
      if (current_batch === null) {
        const batch = (current_batch = new Batch());
        if (!is_processing) {
          batches.add(current_batch);
          if (!is_flushing_sync)
            queue_micro_task(() => {
              if (current_batch !== batch) return;
              batch.flush();
            });
        }
      }
      return current_batch;
    }
    apply() {
      {
        batch_values = null;
        return;
      }
    }
    /**
     *
     * @param {Effect} effect
     */
    schedule(effect) {
      last_scheduled_effect = effect;
      if (
        effect.b?.is_pending &&
        (effect.f & 16777228) !== 0 &&
        (effect.f & 32768) === 0
      ) {
        effect.b.defer_effect(effect);
        return;
      }
      var e = effect;
      while (e.parent !== null) {
        e = e.parent;
        var flags = e.f;
        if (collected_effects !== null && e === active_effect) {
          if (
            (active_reaction === null || (active_reaction.f & 2) === 0) &&
            true
          )
            return;
        }
        if ((flags & 96) !== 0) {
          if ((flags & 1024) === 0) return;
          e.f ^= CLEAN;
        }
      }
      this.#roots.push(e);
    }
  };
  /**
   * Synchronously flush any pending updates.
   * Returns void if no callback is provided, otherwise returns the result of calling the callback.
   * @template [T=void]
   * @param {(() => T) | undefined} [fn]
   * @returns {T}
   */
  function flushSync(fn) {
    var was_flushing_sync = is_flushing_sync;
    is_flushing_sync = true;
    try {
      var result;
      if (fn);
      while (true) {
        flush_tasks();
        if (current_batch === null) return result;
        current_batch.flush();
      }
    } finally {
      is_flushing_sync = was_flushing_sync;
    }
  }
  function infinite_loop_guard() {
    try {
      effect_update_depth_exceeded();
    } catch (error) {
      invoke_error_boundary(error, last_scheduled_effect);
    }
  }
  /** @type {Set<Effect> | null} */
  var eager_block_effects = null;
  /**
   * @param {Array<Effect>} effects
   * @returns {void}
   */
  function flush_queued_effects(effects) {
    var length = effects.length;
    if (length === 0) return;
    var i = 0;
    while (i < length) {
      var effect = effects[i++];
      if ((effect.f & 24576) === 0 && is_dirty(effect)) {
        eager_block_effects = /* @__PURE__ */ new Set();
        update_effect(effect);
        if (
          effect.deps === null &&
          effect.first === null &&
          effect.nodes === null &&
          effect.teardown === null &&
          effect.ac === null
        )
          unlink_effect(effect);
        if (eager_block_effects?.size > 0) {
          old_values.clear();
          for (const e of eager_block_effects) {
            if ((e.f & 24576) !== 0) continue;
            /** @type {Effect[]} */
            const ordered_effects = [e];
            let ancestor = e.parent;
            while (ancestor !== null) {
              if (eager_block_effects.has(ancestor)) {
                eager_block_effects.delete(ancestor);
                ordered_effects.push(ancestor);
              }
              ancestor = ancestor.parent;
            }
            for (let j = ordered_effects.length - 1; j >= 0; j--) {
              const e = ordered_effects[j];
              if ((e.f & 24576) !== 0) continue;
              update_effect(e);
            }
          }
          eager_block_effects.clear();
        }
      }
    }
    eager_block_effects = null;
  }
  /**
   * This is similar to `mark_reactions`, but it only marks async/block effects
   * depending on `value` and at least one of the other `sources`, so that
   * these effects can re-run after another batch has been committed
   * @param {Value} value
   * @param {Source[]} sources
   * @param {Set<Value>} marked
   * @param {Map<Reaction, boolean>} checked
   */
  function mark_effects(value, sources, marked, checked) {
    if (marked.has(value)) return;
    marked.add(value);
    if (value.reactions !== null)
      for (const reaction of value.reactions) {
        const flags = reaction.f;
        if ((flags & 2) !== 0) mark_effects(reaction, sources, marked, checked);
        else if (
          (flags & 4194320) !== 0 &&
          (flags & 2048) === 0 &&
          depends_on(reaction, sources, checked)
        ) {
          set_signal_status(reaction, DIRTY);
          schedule_effect(reaction);
        }
      }
  }
  /**
   * @param {Reaction} reaction
   * @param {Source[]} sources
   * @param {Map<Reaction, boolean>} checked
   */
  function depends_on(reaction, sources, checked) {
    const depends = checked.get(reaction);
    if (depends !== void 0) return depends;
    if (reaction.deps !== null)
      for (const dep of reaction.deps) {
        if (includes.call(sources, dep)) return true;
        if ((dep.f & 2) !== 0 && depends_on(dep, sources, checked)) {
          checked.set(dep, true);
          return true;
        }
      }
    checked.set(reaction, false);
    return false;
  }
  /**
   * @param {Effect} effect
   * @returns {void}
   */
  function schedule_effect(effect) {
    /** @type {Batch} */ current_batch.schedule(effect);
  }
  /**
   * Mark all the effects inside a skipped branch CLEAN, so that
   * they can be correctly rescheduled later. Tracks dirty and maybe_dirty
   * effects so they can be rescheduled if the branch survives.
   * @param {Effect} effect
   * @param {{ d: Effect[], m: Effect[] }} tracked
   */
  function reset_branch(effect, tracked) {
    if ((effect.f & 32) !== 0 && (effect.f & 1024) !== 0) return;
    if ((effect.f & 2048) !== 0) tracked.d.push(effect);
    else if ((effect.f & 4096) !== 0) tracked.m.push(effect);
    set_signal_status(effect, CLEAN);
    var e = effect.first;
    while (e !== null) {
      reset_branch(e, tracked);
      e = e.next;
    }
  }
  /**
   * Mark an entire effect tree clean following an error
   * @param {Effect} effect
   */
  function reset_all(effect) {
    set_signal_status(effect, CLEAN);
    var e = effect.first;
    while (e !== null) {
      reset_all(e);
      e = e.next;
    }
  }
  //#endregion
  //#region node_modules/svelte/src/reactivity/create-subscriber.js
  /**
   * Returns a `subscribe` function that integrates external event-based systems with Svelte's reactivity.
   * It's particularly useful for integrating with web APIs like `MediaQuery`, `IntersectionObserver`, or `WebSocket`.
   *
   * If `subscribe` is called inside an effect (including indirectly, for example inside a getter),
   * the `start` callback will be called with an `update` function. Whenever `update` is called, the effect re-runs.
   *
   * If `start` returns a cleanup function, it will be called when the effect is destroyed.
   *
   * If `subscribe` is called in multiple effects, `start` will only be called once as long as the effects
   * are active, and the returned teardown function will only be called when all effects are destroyed.
   *
   * It's best understood with an example. Here's an implementation of [`MediaQuery`](https://svelte.dev/docs/svelte/svelte-reactivity#MediaQuery):
   *
   * ```js
   * import { createSubscriber } from 'svelte/reactivity';
   * import { on } from 'svelte/events';
   *
   * export class MediaQuery {
   * 	#query;
   * 	#subscribe;
   *
   * 	constructor(query) {
   * 		this.#query = window.matchMedia(`(${query})`);
   *
   * 		this.#subscribe = createSubscriber((update) => {
   * 			// when the `change` event occurs, re-run any effects that read `this.current`
   * 			const off = on(this.#query, 'change', update);
   *
   * 			// stop listening when all the effects are destroyed
   * 			return () => off();
   * 		});
   * 	}
   *
   * 	get current() {
   * 		// This makes the getter reactive, if read in an effect
   * 		this.#subscribe();
   *
   * 		// Return the current state of the query, whether or not we're in an effect
   * 		return this.#query.matches;
   * 	}
   * }
   * ```
   * @param {(update: () => void) => (() => void) | void} start
   * @since 5.7.0
   */
  function createSubscriber(start) {
    let subscribers = 0;
    let version = source(0);
    /** @type {(() => void) | void} */
    let stop;
    return () => {
      if (effect_tracking()) {
        get(version);
        render_effect(() => {
          if (subscribers === 0)
            stop = untrack(() => start(() => increment(version)));
          subscribers += 1;
          return () => {
            queue_micro_task(() => {
              subscribers -= 1;
              if (subscribers === 0) {
                stop?.();
                stop = void 0;
                increment(version);
              }
            });
          };
        });
      }
    };
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/dom/blocks/boundary.js
  /** @import { Effect, Source, TemplateNode, } from '#client' */
  /**
   * @typedef {{
   * 	 onerror?: (error: unknown, reset: () => void) => void;
   *   failed?: (anchor: Node, error: () => unknown, reset: () => () => void) => void;
   *   pending?: (anchor: Node) => void;
   * }} BoundaryProps
   */
  var flags = EFFECT_TRANSPARENT | EFFECT_PRESERVED;
  /**
   * @param {TemplateNode} node
   * @param {BoundaryProps} props
   * @param {((anchor: Node) => void)} children
   * @param {((error: unknown) => unknown) | undefined} [transform_error]
   * @returns {void}
   */
  function boundary(node, props, children, transform_error) {
    new Boundary(node, props, children, transform_error);
  }
  var Boundary = class {
    /** @type {Boundary | null} */
    parent;
    is_pending = false;
    /**
     * API-level transformError transform function. Transforms errors before they reach the `failed` snippet.
     * Inherited from parent boundary, or defaults to identity.
     * @type {(error: unknown) => unknown}
     */
    transform_error;
    /** @type {TemplateNode} */
    #anchor;
    /** @type {TemplateNode | null} */
    #hydrate_open = hydrating ? hydrate_node : null;
    /** @type {BoundaryProps} */
    #props;
    /** @type {((anchor: Node) => void)} */
    #children;
    /** @type {Effect} */
    #effect;
    /** @type {Effect | null} */
    #main_effect = null;
    /** @type {Effect | null} */
    #pending_effect = null;
    /** @type {Effect | null} */
    #failed_effect = null;
    /** @type {DocumentFragment | null} */
    #offscreen_fragment = null;
    #local_pending_count = 0;
    #pending_count = 0;
    #pending_count_update_queued = false;
    /** @type {Set<Effect>} */
    #dirty_effects = /* @__PURE__ */ new Set();
    /** @type {Set<Effect>} */
    #maybe_dirty_effects = /* @__PURE__ */ new Set();
    /**
     * A source containing the number of pending async deriveds/expressions.
     * Only created if `$effect.pending()` is used inside the boundary,
     * otherwise updating the source results in needless `Batch.ensure()`
     * calls followed by no-op flushes
     * @type {Source<number> | null}
     */
    #effect_pending = null;
    #effect_pending_subscriber = createSubscriber(() => {
      this.#effect_pending = source(this.#local_pending_count);
      return () => {
        this.#effect_pending = null;
      };
    });
    /**
     * @param {TemplateNode} node
     * @param {BoundaryProps} props
     * @param {((anchor: Node) => void)} children
     * @param {((error: unknown) => unknown) | undefined} [transform_error]
     */
    constructor(node, props, children, transform_error) {
      this.#anchor = node;
      this.#props = props;
      this.#children = (anchor) => {
        var effect = active_effect;
        effect.b = this;
        effect.f |= 128;
        children(anchor);
      };
      this.parent = active_effect.b;
      this.transform_error =
        transform_error ?? this.parent?.transform_error ?? ((e) => e);
      this.#effect = block(() => {
        if (hydrating) {
          const comment = this.#hydrate_open;
          hydrate_next();
          const server_rendered_pending = comment.data === "[!";
          if (comment.data.startsWith("[?")) {
            const serialized_error = JSON.parse(comment.data.slice(2));
            this.#hydrate_failed_content(serialized_error);
          } else if (server_rendered_pending) this.#hydrate_pending_content();
          else this.#hydrate_resolved_content();
        } else this.#render();
      }, flags);
      if (hydrating) this.#anchor = hydrate_node;
    }
    #hydrate_resolved_content() {
      try {
        this.#main_effect = branch(() => this.#children(this.#anchor));
      } catch (error) {
        this.error(error);
      }
    }
    /**
     * @param {unknown} error The deserialized error from the server's hydration comment
     */
    #hydrate_failed_content(error) {
      const failed = this.#props.failed;
      if (!failed) return;
      this.#failed_effect = branch(() => {
        failed(
          this.#anchor,
          () => error,
          () => () => {},
        );
      });
    }
    #hydrate_pending_content() {
      const pending = this.#props.pending;
      if (!pending) return;
      this.is_pending = true;
      this.#pending_effect = branch(() => pending(this.#anchor));
      queue_micro_task(() => {
        var fragment = (this.#offscreen_fragment =
          document.createDocumentFragment());
        var anchor = create_text();
        fragment.append(anchor);
        this.#main_effect = this.#run(() => {
          return branch(() => this.#children(anchor));
        });
        if (this.#pending_count === 0) {
          this.#anchor.before(fragment);
          this.#offscreen_fragment = null;
          pause_effect(this.#pending_effect, () => {
            this.#pending_effect = null;
          });
          this.#resolve(current_batch);
        }
      });
    }
    #render() {
      try {
        this.is_pending = this.has_pending_snippet();
        this.#pending_count = 0;
        this.#local_pending_count = 0;
        this.#main_effect = branch(() => {
          this.#children(this.#anchor);
        });
        if (this.#pending_count > 0) {
          var fragment = (this.#offscreen_fragment =
            document.createDocumentFragment());
          move_effect(this.#main_effect, fragment);
          const pending = this.#props.pending;
          this.#pending_effect = branch(() => pending(this.#anchor));
        } else this.#resolve(current_batch);
      } catch (error) {
        this.error(error);
      }
    }
    /**
     * @param {Batch} batch
     */
    #resolve(batch) {
      this.is_pending = false;
      batch.transfer_effects(this.#dirty_effects, this.#maybe_dirty_effects);
    }
    /**
     * Defer an effect inside a pending boundary until the boundary resolves
     * @param {Effect} effect
     */
    defer_effect(effect) {
      defer_effect(effect, this.#dirty_effects, this.#maybe_dirty_effects);
    }
    /**
     * Returns `false` if the effect exists inside a boundary whose pending snippet is shown
     * @returns {boolean}
     */
    is_rendered() {
      return !this.is_pending && (!this.parent || this.parent.is_rendered());
    }
    has_pending_snippet() {
      return !!this.#props.pending;
    }
    /**
     * @template T
     * @param {() => T} fn
     */
    #run(fn) {
      var previous_effect = active_effect;
      var previous_reaction = active_reaction;
      var previous_ctx = component_context;
      set_active_effect(this.#effect);
      set_active_reaction(this.#effect);
      set_component_context(this.#effect.ctx);
      try {
        Batch.ensure();
        return fn();
      } catch (e) {
        handle_error(e);
        return null;
      } finally {
        set_active_effect(previous_effect);
        set_active_reaction(previous_reaction);
        set_component_context(previous_ctx);
      }
    }
    /**
     * Updates the pending count associated with the currently visible pending snippet,
     * if any, such that we can replace the snippet with content once work is done
     * @param {1 | -1} d
     * @param {Batch} batch
     */
    #update_pending_count(d, batch) {
      if (!this.has_pending_snippet()) {
        if (this.parent) this.parent.#update_pending_count(d, batch);
        return;
      }
      this.#pending_count += d;
      if (this.#pending_count === 0) {
        this.#resolve(batch);
        if (this.#pending_effect)
          pause_effect(this.#pending_effect, () => {
            this.#pending_effect = null;
          });
        if (this.#offscreen_fragment) {
          this.#anchor.before(this.#offscreen_fragment);
          this.#offscreen_fragment = null;
        }
      }
    }
    /**
     * Update the source that powers `$effect.pending()` inside this boundary,
     * and controls when the current `pending` snippet (if any) is removed.
     * Do not call from inside the class
     * @param {1 | -1} d
     * @param {Batch} batch
     */
    update_pending_count(d, batch) {
      this.#update_pending_count(d, batch);
      this.#local_pending_count += d;
      if (!this.#effect_pending || this.#pending_count_update_queued) return;
      this.#pending_count_update_queued = true;
      queue_micro_task(() => {
        this.#pending_count_update_queued = false;
        if (this.#effect_pending)
          internal_set(this.#effect_pending, this.#local_pending_count);
      });
    }
    get_effect_pending() {
      this.#effect_pending_subscriber();
      return get(this.#effect_pending);
    }
    /** @param {unknown} error */
    error(error) {
      if (!this.#props.onerror && !this.#props.failed) throw error;
      if (current_batch?.is_fork) {
        if (this.#main_effect) current_batch.skip_effect(this.#main_effect);
        if (this.#pending_effect)
          current_batch.skip_effect(this.#pending_effect);
        if (this.#failed_effect) current_batch.skip_effect(this.#failed_effect);
        current_batch.on_fork_commit(() => {
          this.#handle_error(error);
        });
      } else this.#handle_error(error);
    }
    /**
     * @param {unknown} error
     */
    #handle_error(error) {
      if (this.#main_effect) {
        destroy_effect(this.#main_effect);
        this.#main_effect = null;
      }
      if (this.#pending_effect) {
        destroy_effect(this.#pending_effect);
        this.#pending_effect = null;
      }
      if (this.#failed_effect) {
        destroy_effect(this.#failed_effect);
        this.#failed_effect = null;
      }
      if (hydrating) {
        set_hydrate_node(this.#hydrate_open);
        next();
        set_hydrate_node(skip_nodes());
      }
      var onerror = this.#props.onerror;
      let failed = this.#props.failed;
      var did_reset = false;
      var calling_on_error = false;
      const reset = () => {
        if (did_reset) {
          svelte_boundary_reset_noop();
          return;
        }
        did_reset = true;
        if (calling_on_error) svelte_boundary_reset_onerror();
        if (this.#failed_effect !== null)
          pause_effect(this.#failed_effect, () => {
            this.#failed_effect = null;
          });
        this.#run(() => {
          this.#render();
        });
      };
      /** @param {unknown} transformed_error */
      const handle_error_result = (transformed_error) => {
        try {
          calling_on_error = true;
          onerror?.(transformed_error, reset);
          calling_on_error = false;
        } catch (error) {
          invoke_error_boundary(error, this.#effect && this.#effect.parent);
        }
        if (failed)
          this.#failed_effect = this.#run(() => {
            try {
              return branch(() => {
                var effect = active_effect;
                effect.b = this;
                effect.f |= 128;
                failed(
                  this.#anchor,
                  () => transformed_error,
                  () => reset,
                );
              });
            } catch (error) {
              invoke_error_boundary(error, this.#effect.parent);
              return null;
            }
          });
      };
      queue_micro_task(() => {
        /** @type {unknown} */
        var result;
        try {
          result = this.transform_error(error);
        } catch (e) {
          invoke_error_boundary(e, this.#effect && this.#effect.parent);
          return;
        }
        if (
          result !== null &&
          typeof result === "object" &&
          typeof result.then === "function"
        )
          /** @type {any} */ result.then(
            handle_error_result,
            /** @param {unknown} e */
            (e) =>
              invoke_error_boundary(e, this.#effect && this.#effect.parent),
          );
        else handle_error_result(result);
      });
    }
  };
  /**
   * @param {Derived} derived
   * @returns {void}
   */
  function destroy_derived_effects(derived) {
    var effects = derived.effects;
    if (effects !== null) {
      derived.effects = null;
      for (var i = 0; i < effects.length; i += 1) destroy_effect(effects[i]);
    }
  }
  /**
   * @template T
   * @param {Derived} derived
   * @returns {T}
   */
  function execute_derived(derived) {
    var value;
    var prev_active_effect = active_effect;
    var parent = derived.parent;
    if (!is_destroying_effect && parent !== null && (parent.f & 24576) !== 0) {
      derived_inert();
      return derived.v;
    }
    set_active_effect(parent);
    try {
      derived.f &= ~WAS_MARKED;
      destroy_derived_effects(derived);
      value = update_reaction(derived);
    } finally {
      set_active_effect(prev_active_effect);
    }
    return value;
  }
  /**
   * @param {Derived} derived
   * @returns {void}
   */
  function update_derived(derived) {
    var value = execute_derived(derived);
    if (!derived.equals(value)) {
      derived.wv = increment_write_version();
      if (!current_batch?.is_fork || derived.deps === null) {
        if (current_batch !== null) current_batch.capture(derived, value, true);
        else derived.v = value;
        if (derived.deps === null) {
          set_signal_status(derived, CLEAN);
          return;
        }
      }
    }
    if (is_destroying_effect) return;
    if (batch_values !== null) {
      if (effect_tracking() || current_batch?.is_fork)
        batch_values.set(derived, value);
    } else update_derived_status(derived);
  }
  /**
   * @param {Derived} derived
   */
  function freeze_derived_effects(derived) {
    if (derived.effects === null) return;
    for (const e of derived.effects)
      if (e.teardown || e.ac) {
        e.teardown?.();
        e.ac?.abort(STALE_REACTION);
        e.teardown = noop$1;
        e.ac = null;
        remove_reactions(e, 0);
        destroy_effect_children(e);
      }
  }
  /**
   * @param {Derived} derived
   */
  function unfreeze_derived_effects(derived) {
    if (derived.effects === null) return;
    for (const e of derived.effects) if (e.teardown) update_effect(e);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/reactivity/sources.js
  /** @import { Derived, Effect, Source, Value } from '#client' */
  /** @type {Set<any>} */
  var eager_effects = /* @__PURE__ */ new Set();
  /** @type {Map<Source, any>} */
  var old_values = /* @__PURE__ */ new Map();
  var eager_effects_deferred = false;
  /**
   * @template V
   * @param {V} v
   * @param {Error | null} [stack]
   * @returns {Source<V>}
   */
  function source(v, stack) {
    return {
      f: 0,
      v,
      reactions: null,
      equals,
      rv: 0,
      wv: 0,
    };
  }
  /**
   * @template V
   * @param {V} v
   * @param {Error | null} [stack]
   */
  /* @__NO_SIDE_EFFECTS__ */
  function state(v, stack) {
    const s = source(v);
    push_reaction_value(s);
    return s;
  }
  /**
   * @template V
   * @param {V} initial_value
   * @param {boolean} [immutable]
   * @returns {Source<V>}
   */
  /* @__NO_SIDE_EFFECTS__ */
  function mutable_source(initial_value, immutable = false, trackable = true) {
    const s = source(initial_value);
    if (!immutable) s.equals = safe_equals;
    return s;
  }
  /**
   * @template V
   * @param {Source<V>} source
   * @param {V} value
   * @param {boolean} [should_proxy]
   * @returns {V}
   */
  function set(source, value, should_proxy = false) {
    if (
      active_reaction !== null &&
      (!untracking || (active_reaction.f & 131072) !== 0) &&
      is_runes() &&
      (active_reaction.f & 4325394) !== 0 &&
      (current_sources === null || !includes.call(current_sources, source))
    )
      state_unsafe_mutation();
    return internal_set(
      source,
      should_proxy ? proxy(value) : value,
      legacy_updates,
    );
  }
  /**
   * @template V
   * @param {Source<V>} source
   * @param {V} value
   * @param {Effect[] | null} [updated_during_traversal]
   * @returns {V}
   */
  function internal_set(source, value, updated_during_traversal = null) {
    if (!source.equals(value)) {
      old_values.set(source, is_destroying_effect ? value : source.v);
      var batch = Batch.ensure();
      batch.capture(source, value);
      if ((source.f & 2) !== 0) {
        const derived = source;
        if ((source.f & 2048) !== 0) execute_derived(derived);
        if (batch_values === null) update_derived_status(derived);
      }
      source.wv = increment_write_version();
      mark_reactions(source, DIRTY, updated_during_traversal);
      if (
        active_effect !== null &&
        (active_effect.f & 1024) !== 0 &&
        (active_effect.f & 96) === 0
      )
        if (untracked_writes === null) set_untracked_writes([source]);
        else untracked_writes.push(source);
      if (!batch.is_fork && eager_effects.size > 0 && !eager_effects_deferred)
        flush_eager_effects();
    }
    return value;
  }
  function flush_eager_effects() {
    eager_effects_deferred = false;
    for (const effect of eager_effects) {
      if ((effect.f & 1024) !== 0) set_signal_status(effect, MAYBE_DIRTY);
      if (is_dirty(effect)) update_effect(effect);
    }
    eager_effects.clear();
  }
  /**
   * Silently (without using `get`) increment a source
   * @param {Source<number>} source
   */
  function increment(source) {
    set(source, source.v + 1);
  }
  /**
   * @param {Value} signal
   * @param {number} status should be DIRTY or MAYBE_DIRTY
   * @param {Effect[] | null} updated_during_traversal
   * @returns {void}
   */
  function mark_reactions(signal, status, updated_during_traversal) {
    var reactions = signal.reactions;
    if (reactions === null) return;
    var length = reactions.length;
    for (var i = 0; i < length; i++) {
      var reaction = reactions[i];
      var flags = reaction.f;
      var not_dirty = (flags & DIRTY) === 0;
      if (not_dirty) set_signal_status(reaction, status);
      if ((flags & 2) !== 0) {
        var derived = reaction;
        batch_values?.delete(derived);
        if ((flags & 65536) === 0) {
          if (
            flags & 512 &&
            (active_effect === null || (active_effect.f & 2097152) === 0)
          )
            reaction.f |= WAS_MARKED;
          mark_reactions(derived, MAYBE_DIRTY, updated_during_traversal);
        }
      } else if (not_dirty) {
        var effect = reaction;
        if ((flags & 16) !== 0 && eager_block_effects !== null)
          eager_block_effects.add(effect);
        if (updated_during_traversal !== null)
          updated_during_traversal.push(effect);
        else schedule_effect(effect);
      }
    }
  }
  /**
   * @template T
   * @param {T} value
   * @returns {T}
   */
  function proxy(value) {
    if (typeof value !== "object" || value === null || STATE_SYMBOL in value)
      return value;
    const prototype = get_prototype_of(value);
    if (prototype !== object_prototype && prototype !== array_prototype)
      return value;
    /** @type {Map<any, Source<any>>} */
    var sources = /* @__PURE__ */ new Map();
    var is_proxied_array = is_array(value);
    var version = /* @__PURE__ */ state(0);
    var parent_version = update_version;
    /**
     * Executes the proxy in the context of the reaction it was originally created in, if any
     * @template T
     * @param {() => T} fn
     */
    var with_parent = (fn) => {
      if (update_version === parent_version) return fn();
      var reaction = active_reaction;
      var version = update_version;
      set_active_reaction(null);
      set_update_version(parent_version);
      var result = fn();
      set_active_reaction(reaction);
      set_update_version(version);
      return result;
    };
    if (is_proxied_array)
      sources.set(
        "length",
        /* @__PURE__ */ state(
          /** @type {any[]} */
          value.length,
        ),
      );
    return new Proxy(value, {
      defineProperty(_, prop, descriptor) {
        if (
          !("value" in descriptor) ||
          descriptor.configurable === false ||
          descriptor.enumerable === false ||
          descriptor.writable === false
        )
          state_descriptors_fixed();
        var s = sources.get(prop);
        if (s === void 0)
          with_parent(() => {
            var s = /* @__PURE__ */ state(descriptor.value);
            sources.set(prop, s);
            return s;
          });
        else set(s, descriptor.value, true);
        return true;
      },
      deleteProperty(target, prop) {
        var s = sources.get(prop);
        if (s === void 0) {
          if (prop in target) {
            const s = with_parent(() => /* @__PURE__ */ state(UNINITIALIZED));
            sources.set(prop, s);
            increment(version);
          }
        } else {
          set(s, UNINITIALIZED);
          increment(version);
        }
        return true;
      },
      get(target, prop, receiver) {
        if (prop === STATE_SYMBOL) return value;
        var s = sources.get(prop);
        var exists = prop in target;
        if (
          s === void 0 &&
          (!exists || get_descriptor(target, prop)?.writable)
        ) {
          s = with_parent(() => {
            return /* @__PURE__ */ state(
              proxy(exists ? target[prop] : UNINITIALIZED),
            );
          });
          sources.set(prop, s);
        }
        if (s !== void 0) {
          var v = get(s);
          return v === UNINITIALIZED ? void 0 : v;
        }
        return Reflect.get(target, prop, receiver);
      },
      getOwnPropertyDescriptor(target, prop) {
        var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (descriptor && "value" in descriptor) {
          var s = sources.get(prop);
          if (s) descriptor.value = get(s);
        } else if (descriptor === void 0) {
          var source = sources.get(prop);
          var value = source?.v;
          if (source !== void 0 && value !== UNINITIALIZED)
            return {
              enumerable: true,
              configurable: true,
              value,
              writable: true,
            };
        }
        return descriptor;
      },
      has(target, prop) {
        if (prop === STATE_SYMBOL) return true;
        var s = sources.get(prop);
        var has =
          (s !== void 0 && s.v !== UNINITIALIZED) || Reflect.has(target, prop);
        if (
          s !== void 0 ||
          (active_effect !== null &&
            (!has || get_descriptor(target, prop)?.writable))
        ) {
          if (s === void 0) {
            s = with_parent(() => {
              return /* @__PURE__ */ state(
                has ? proxy(target[prop]) : UNINITIALIZED,
              );
            });
            sources.set(prop, s);
          }
          if (get(s) === UNINITIALIZED) return false;
        }
        return has;
      },
      set(target, prop, value, receiver) {
        var s = sources.get(prop);
        var has = prop in target;
        if (is_proxied_array && prop === "length")
          for (var i = value; i < s.v; i += 1) {
            var other_s = sources.get(i + "");
            if (other_s !== void 0) set(other_s, UNINITIALIZED);
            else if (i in target) {
              other_s = with_parent(() => /* @__PURE__ */ state(UNINITIALIZED));
              sources.set(i + "", other_s);
            }
          }
        if (s === void 0) {
          if (!has || get_descriptor(target, prop)?.writable) {
            s = with_parent(() => /* @__PURE__ */ state(void 0));
            set(s, proxy(value));
            sources.set(prop, s);
          }
        } else {
          has = s.v !== UNINITIALIZED;
          var p = with_parent(() => proxy(value));
          set(s, p);
        }
        var descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (descriptor?.set) descriptor.set.call(receiver, value);
        if (!has) {
          if (is_proxied_array && typeof prop === "string") {
            var ls = sources.get("length");
            var n = Number(prop);
            if (Number.isInteger(n) && n >= ls.v) set(ls, n + 1);
          }
          increment(version);
        }
        return true;
      },
      ownKeys(target) {
        get(version);
        var own_keys = Reflect.ownKeys(target).filter((key) => {
          var source = sources.get(key);
          return source === void 0 || source.v !== UNINITIALIZED;
        });
        for (var [key, source] of sources)
          if (source.v !== UNINITIALIZED && !(key in target))
            own_keys.push(key);
        return own_keys;
      },
      setPrototypeOf() {
        state_prototype_fixed();
      },
    });
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/dom/operations.js
  /** @type {Window} */
  var $window;
  /** @type {() => Node | null} */
  var first_child_getter;
  /** @type {() => Node | null} */
  var next_sibling_getter;
  /**
   * Initialize these lazily to avoid issues when using the runtime in a server context
   * where these globals are not available while avoiding a separate server entry point
   */
  function init_operations() {
    if ($window !== void 0) return;
    $window = window;
    var element_prototype = Element.prototype;
    var node_prototype = Node.prototype;
    var text_prototype = Text.prototype;
    first_child_getter = get_descriptor(node_prototype, "firstChild").get;
    next_sibling_getter = get_descriptor(node_prototype, "nextSibling").get;
    if (is_extensible(element_prototype)) {
      element_prototype.__click = void 0;
      element_prototype.__className = void 0;
      element_prototype.__attributes = null;
      element_prototype.__style = void 0;
      element_prototype.__e = void 0;
    }
    if (is_extensible(text_prototype)) text_prototype.__t = void 0;
  }
  /**
   * @param {string} value
   * @returns {Text}
   */
  function create_text(value = "") {
    return document.createTextNode(value);
  }
  /**
   * @template {Node} N
   * @param {N} node
   */
  /* @__NO_SIDE_EFFECTS__ */
  function get_first_child(node) {
    return first_child_getter.call(node);
  }
  /**
   * @template {Node} N
   * @param {N} node
   */
  /* @__NO_SIDE_EFFECTS__ */
  function get_next_sibling(node) {
    return next_sibling_getter.call(node);
  }
  /**
   * @template {Node} N
   * @param {N} node
   * @returns {void}
   */
  function clear_text_content(node) {
    node.textContent = "";
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/dom/elements/bindings/shared.js
  /**
   * @template T
   * @param {() => T} fn
   */
  function without_reactive_context(fn) {
    var previous_reaction = active_reaction;
    var previous_effect = active_effect;
    set_active_reaction(null);
    set_active_effect(null);
    try {
      return fn();
    } finally {
      set_active_reaction(previous_reaction);
      set_active_effect(previous_effect);
    }
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/reactivity/effects.js
  /** @import { Blocker, ComponentContext, ComponentContextLegacy, Derived, Effect, TemplateNode, TransitionManager } from '#client' */
  /**
   * @param {Effect} effect
   * @param {Effect} parent_effect
   */
  function push_effect(effect, parent_effect) {
    var parent_last = parent_effect.last;
    if (parent_last === null) parent_effect.last = parent_effect.first = effect;
    else {
      parent_last.next = effect;
      effect.prev = parent_last;
      parent_effect.last = effect;
    }
  }
  /**
   * @param {number} type
   * @param {null | (() => void | (() => void))} fn
   * @returns {Effect}
   */
  function create_effect(type, fn) {
    var parent = active_effect;
    if (parent !== null && (parent.f & 8192) !== 0) type |= INERT;
    /** @type {Effect} */
    var effect = {
      ctx: component_context,
      deps: null,
      nodes: null,
      f: type | DIRTY | 512,
      first: null,
      fn,
      last: null,
      next: null,
      parent,
      b: parent && parent.b,
      prev: null,
      teardown: null,
      wv: 0,
      ac: null,
    };
    current_batch?.register_created_effect(effect);
    /** @type {Effect | null} */
    var e = effect;
    if ((type & 4) !== 0)
      if (collected_effects !== null) collected_effects.push(effect);
      else Batch.ensure().schedule(effect);
    else if (fn !== null) {
      try {
        update_effect(effect);
      } catch (e) {
        destroy_effect(effect);
        throw e;
      }
      if (
        e.deps === null &&
        e.teardown === null &&
        e.nodes === null &&
        e.first === e.last &&
        (e.f & 524288) === 0
      ) {
        e = e.first;
        if ((type & 16) !== 0 && (type & 65536) !== 0 && e !== null)
          e.f |= EFFECT_TRANSPARENT;
      }
    }
    if (e !== null) {
      e.parent = parent;
      if (parent !== null) push_effect(e, parent);
      if (
        active_reaction !== null &&
        (active_reaction.f & 2) !== 0 &&
        (type & 64) === 0
      ) {
        var derived = active_reaction;
        (derived.effects ??= []).push(e);
      }
    }
    return effect;
  }
  /**
   * Internal representation of `$effect.tracking()`
   * @returns {boolean}
   */
  function effect_tracking() {
    return active_reaction !== null && !untracking;
  }
  /**
   * @param {() => void | (() => void)} fn
   */
  function create_user_effect(fn) {
    return create_effect(4 | USER_EFFECT, fn);
  }
  /**
   * An effect root whose children can transition out
   * @param {() => void} fn
   * @returns {(options?: { outro?: boolean }) => Promise<void>}
   */
  function component_root(fn) {
    Batch.ensure();
    const effect = create_effect(64 | EFFECT_PRESERVED, fn);
    return (options = {}) => {
      return new Promise((fulfil) => {
        if (options.outro)
          pause_effect(effect, () => {
            destroy_effect(effect);
            fulfil(void 0);
          });
        else {
          destroy_effect(effect);
          fulfil(void 0);
        }
      });
    };
  }
  /**
   * @param {() => void | (() => void)} fn
   * @returns {Effect}
   */
  function render_effect(fn, flags = 0) {
    return create_effect(8 | flags, fn);
  }
  /**
   * @param {(() => void)} fn
   * @param {number} flags
   */
  function block(fn, flags = 0) {
    return create_effect(16 | flags, fn);
  }
  /**
   * @param {(() => void)} fn
   */
  function branch(fn) {
    return create_effect(32 | EFFECT_PRESERVED, fn);
  }
  /**
   * @param {Effect} effect
   */
  function execute_effect_teardown(effect) {
    var teardown = effect.teardown;
    if (teardown !== null) {
      const previously_destroying_effect = is_destroying_effect;
      const previous_reaction = active_reaction;
      set_is_destroying_effect(true);
      set_active_reaction(null);
      try {
        teardown.call(null);
      } finally {
        set_is_destroying_effect(previously_destroying_effect);
        set_active_reaction(previous_reaction);
      }
    }
  }
  /**
   * @param {Effect} signal
   * @param {boolean} remove_dom
   * @returns {void}
   */
  function destroy_effect_children(signal, remove_dom = false) {
    var effect = signal.first;
    signal.first = signal.last = null;
    while (effect !== null) {
      const controller = effect.ac;
      if (controller !== null)
        without_reactive_context(() => {
          controller.abort(STALE_REACTION);
        });
      var next = effect.next;
      if ((effect.f & 64) !== 0) effect.parent = null;
      else destroy_effect(effect, remove_dom);
      effect = next;
    }
  }
  /**
   * @param {Effect} signal
   * @returns {void}
   */
  function destroy_block_effect_children(signal) {
    var effect = signal.first;
    while (effect !== null) {
      var next = effect.next;
      if ((effect.f & 32) === 0) destroy_effect(effect);
      effect = next;
    }
  }
  /**
   * @param {Effect} effect
   * @param {boolean} [remove_dom]
   * @returns {void}
   */
  function destroy_effect(effect, remove_dom = true) {
    var removed = false;
    if (
      (remove_dom || (effect.f & 262144) !== 0) &&
      effect.nodes !== null &&
      effect.nodes.end !== null
    ) {
      remove_effect_dom(effect.nodes.start, effect.nodes.end);
      removed = true;
    }
    set_signal_status(effect, DESTROYING);
    destroy_effect_children(effect, remove_dom && !removed);
    remove_reactions(effect, 0);
    var transitions = effect.nodes && effect.nodes.t;
    if (transitions !== null)
      for (const transition of transitions) transition.stop();
    execute_effect_teardown(effect);
    effect.f ^= DESTROYING;
    effect.f |= DESTROYED;
    var parent = effect.parent;
    if (parent !== null && parent.first !== null) unlink_effect(effect);
    effect.next =
      effect.prev =
      effect.teardown =
      effect.ctx =
      effect.deps =
      effect.fn =
      effect.nodes =
      effect.ac =
      effect.b =
        null;
  }
  /**
   *
   * @param {TemplateNode | null} node
   * @param {TemplateNode} end
   */
  function remove_effect_dom(node, end) {
    while (node !== null) {
      /** @type {TemplateNode | null} */
      var next = node === end ? null : /* @__PURE__ */ get_next_sibling(node);
      node.remove();
      node = next;
    }
  }
  /**
   * Detach an effect from the effect tree, freeing up memory and
   * reducing the amount of work that happens on subsequent traversals
   * @param {Effect} effect
   */
  function unlink_effect(effect) {
    var parent = effect.parent;
    var prev = effect.prev;
    var next = effect.next;
    if (prev !== null) prev.next = next;
    if (next !== null) next.prev = prev;
    if (parent !== null) {
      if (parent.first === effect) parent.first = next;
      if (parent.last === effect) parent.last = prev;
    }
  }
  /**
   * When a block effect is removed, we don't immediately destroy it or yank it
   * out of the DOM, because it might have transitions. Instead, we 'pause' it.
   * It stays around (in memory, and in the DOM) until outro transitions have
   * completed, and if the state change is reversed then we _resume_ it.
   * A paused effect does not update, and the DOM subtree becomes inert.
   * @param {Effect} effect
   * @param {() => void} [callback]
   * @param {boolean} [destroy]
   */
  function pause_effect(effect, callback, destroy = true) {
    /** @type {TransitionManager[]} */
    var transitions = [];
    pause_children(effect, transitions, true);
    var fn = () => {
      if (destroy) destroy_effect(effect);
      if (callback) callback();
    };
    var remaining = transitions.length;
    if (remaining > 0) {
      var check = () => --remaining || fn();
      for (var transition of transitions) transition.out(check);
    } else fn();
  }
  /**
   * @param {Effect} effect
   * @param {TransitionManager[]} transitions
   * @param {boolean} local
   */
  function pause_children(effect, transitions, local) {
    if ((effect.f & 8192) !== 0) return;
    effect.f ^= INERT;
    var t = effect.nodes && effect.nodes.t;
    if (t !== null) {
      for (const transition of t)
        if (transition.is_global || local) transitions.push(transition);
    }
    var child = effect.first;
    while (child !== null) {
      var sibling = child.next;
      if ((child.f & 64) === 0) {
        var transparent =
          (child.f & 65536) !== 0 ||
          ((child.f & 32) !== 0 && (effect.f & 16) !== 0);
        pause_children(child, transitions, transparent ? local : false);
      }
      child = sibling;
    }
  }
  /**
   * @param {Effect} effect
   * @param {DocumentFragment} fragment
   */
  function move_effect(effect, fragment) {
    if (!effect.nodes) return;
    /** @type {TemplateNode | null} */
    var node = effect.nodes.start;
    var end = effect.nodes.end;
    while (node !== null) {
      /** @type {TemplateNode | null} */
      var next = node === end ? null : /* @__PURE__ */ get_next_sibling(node);
      fragment.append(node);
      node = next;
    }
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/runtime.js
  /** @import { Derived, Effect, Reaction, Source, Value } from '#client' */
  var is_updating_effect = false;
  var is_destroying_effect = false;
  /** @param {boolean} value */
  function set_is_destroying_effect(value) {
    is_destroying_effect = value;
  }
  /** @type {null | Reaction} */
  var active_reaction = null;
  var untracking = false;
  /** @param {null | Reaction} reaction */
  function set_active_reaction(reaction) {
    active_reaction = reaction;
  }
  /** @type {null | Effect} */
  var active_effect = null;
  /** @param {null | Effect} effect */
  function set_active_effect(effect) {
    active_effect = effect;
  }
  /**
   * When sources are created within a reaction, reading and writing
   * them within that reaction should not cause a re-run
   * @type {null | Source[]}
   */
  var current_sources = null;
  /** @param {Value} value */
  function push_reaction_value(value) {
    if (active_reaction !== null && true)
      if (current_sources === null) current_sources = [value];
      else current_sources.push(value);
  }
  /**
   * The dependencies of the reaction that is currently being executed. In many cases,
   * the dependencies are unchanged between runs, and so this will be `null` unless
   * and until a new dependency is accessed — we track this via `skipped_deps`
   * @type {null | Value[]}
   */
  var new_deps = null;
  var skipped_deps = 0;
  /**
   * Tracks writes that the effect it's executed in doesn't listen to yet,
   * so that the dependency can be added to the effect later on if it then reads it
   * @type {null | Source[]}
   */
  var untracked_writes = null;
  /** @param {null | Source[]} value */
  function set_untracked_writes(value) {
    untracked_writes = value;
  }
  /**
   * @type {number} Used by sources and deriveds for handling updates.
   * Version starts from 1 so that unowned deriveds differentiate between a created effect and a run one for tracing
   **/
  var write_version = 1;
  /** @type {number} Used to version each read of a source of derived to avoid duplicating depedencies inside a reaction */
  var read_version = 0;
  var update_version = read_version;
  /** @param {number} value */
  function set_update_version(value) {
    update_version = value;
  }
  function increment_write_version() {
    return ++write_version;
  }
  /**
   * Determines whether a derived or effect is dirty.
   * If it is MAYBE_DIRTY, will set the status to CLEAN
   * @param {Reaction} reaction
   * @returns {boolean}
   */
  function is_dirty(reaction) {
    var flags = reaction.f;
    if ((flags & 2048) !== 0) return true;
    if (flags & 2) reaction.f &= ~WAS_MARKED;
    if ((flags & 4096) !== 0) {
      var dependencies = reaction.deps;
      var length = dependencies.length;
      for (var i = 0; i < length; i++) {
        var dependency = dependencies[i];
        if (is_dirty(dependency)) update_derived(dependency);
        if (dependency.wv > reaction.wv) return true;
      }
      if ((flags & 512) !== 0 && batch_values === null)
        set_signal_status(reaction, CLEAN);
    }
    return false;
  }
  /**
   * @param {Value} signal
   * @param {Effect} effect
   * @param {boolean} [root]
   */
  function schedule_possible_effect_self_invalidation(
    signal,
    effect,
    root = true,
  ) {
    var reactions = signal.reactions;
    if (reactions === null) return;
    if (current_sources !== null && includes.call(current_sources, signal))
      return;
    for (var i = 0; i < reactions.length; i++) {
      var reaction = reactions[i];
      if ((reaction.f & 2) !== 0)
        schedule_possible_effect_self_invalidation(reaction, effect, false);
      else if (effect === reaction) {
        if (root) set_signal_status(reaction, DIRTY);
        else if ((reaction.f & 1024) !== 0)
          set_signal_status(reaction, MAYBE_DIRTY);
        schedule_effect(reaction);
      }
    }
  }
  /** @param {Reaction} reaction */
  function update_reaction(reaction) {
    var previous_deps = new_deps;
    var previous_skipped_deps = skipped_deps;
    var previous_untracked_writes = untracked_writes;
    var previous_reaction = active_reaction;
    var previous_sources = current_sources;
    var previous_component_context = component_context;
    var previous_untracking = untracking;
    var previous_update_version = update_version;
    var flags = reaction.f;
    new_deps = null;
    skipped_deps = 0;
    untracked_writes = null;
    active_reaction = (flags & 96) === 0 ? reaction : null;
    current_sources = null;
    set_component_context(reaction.ctx);
    untracking = false;
    update_version = ++read_version;
    if (reaction.ac !== null) {
      without_reactive_context(() => {
        /** @type {AbortController} */ reaction.ac.abort(STALE_REACTION);
      });
      reaction.ac = null;
    }
    try {
      reaction.f |= REACTION_IS_UPDATING;
      var fn = reaction.fn;
      var result = fn();
      reaction.f |= REACTION_RAN;
      var deps = reaction.deps;
      var is_fork = current_batch?.is_fork;
      if (new_deps !== null) {
        var i;
        if (!is_fork) remove_reactions(reaction, skipped_deps);
        if (deps !== null && skipped_deps > 0) {
          deps.length = skipped_deps + new_deps.length;
          for (i = 0; i < new_deps.length; i++)
            deps[skipped_deps + i] = new_deps[i];
        } else reaction.deps = deps = new_deps;
        if (effect_tracking() && (reaction.f & 512) !== 0)
          for (i = skipped_deps; i < deps.length; i++)
            (deps[i].reactions ??= []).push(reaction);
      } else if (!is_fork && deps !== null && skipped_deps < deps.length) {
        remove_reactions(reaction, skipped_deps);
        deps.length = skipped_deps;
      }
      if (
        is_runes() &&
        untracked_writes !== null &&
        !untracking &&
        deps !== null &&
        (reaction.f & 6146) === 0
      )
        for (i = 0; i < untracked_writes.length; i++)
          schedule_possible_effect_self_invalidation(
            untracked_writes[i],
            reaction,
          );
      if (previous_reaction !== null && previous_reaction !== reaction) {
        read_version++;
        if (previous_reaction.deps !== null)
          for (let i = 0; i < previous_skipped_deps; i += 1)
            previous_reaction.deps[i].rv = read_version;
        if (previous_deps !== null)
          for (const dep of previous_deps) dep.rv = read_version;
        if (untracked_writes !== null)
          if (previous_untracked_writes === null)
            previous_untracked_writes = untracked_writes;
          else previous_untracked_writes.push(...untracked_writes);
      }
      if ((reaction.f & 8388608) !== 0) reaction.f ^= ERROR_VALUE;
      return result;
    } catch (error) {
      return handle_error(error);
    } finally {
      reaction.f ^= REACTION_IS_UPDATING;
      new_deps = previous_deps;
      skipped_deps = previous_skipped_deps;
      untracked_writes = previous_untracked_writes;
      active_reaction = previous_reaction;
      current_sources = previous_sources;
      set_component_context(previous_component_context);
      untracking = previous_untracking;
      update_version = previous_update_version;
    }
  }
  /**
   * @template V
   * @param {Reaction} signal
   * @param {Value<V>} dependency
   * @returns {void}
   */
  function remove_reaction(signal, dependency) {
    let reactions = dependency.reactions;
    if (reactions !== null) {
      var index = index_of.call(reactions, signal);
      if (index !== -1) {
        var new_length = reactions.length - 1;
        if (new_length === 0) reactions = dependency.reactions = null;
        else {
          reactions[index] = reactions[new_length];
          reactions.pop();
        }
      }
    }
    if (
      reactions === null &&
      (dependency.f & 2) !== 0 &&
      (new_deps === null || !includes.call(new_deps, dependency))
    ) {
      var derived = dependency;
      if ((derived.f & 512) !== 0) {
        derived.f ^= 512;
        derived.f &= ~WAS_MARKED;
      }
      if (derived.v !== UNINITIALIZED) update_derived_status(derived);
      freeze_derived_effects(derived);
      remove_reactions(derived, 0);
    }
  }
  /**
   * @param {Reaction} signal
   * @param {number} start_index
   * @returns {void}
   */
  function remove_reactions(signal, start_index) {
    var dependencies = signal.deps;
    if (dependencies === null) return;
    for (var i = start_index; i < dependencies.length; i++)
      remove_reaction(signal, dependencies[i]);
  }
  /**
   * @param {Effect} effect
   * @returns {void}
   */
  function update_effect(effect) {
    var flags = effect.f;
    if ((flags & 16384) !== 0) return;
    set_signal_status(effect, CLEAN);
    var previous_effect = active_effect;
    var was_updating_effect = is_updating_effect;
    active_effect = effect;
    is_updating_effect = true;
    try {
      if ((flags & 16777232) !== 0) destroy_block_effect_children(effect);
      else destroy_effect_children(effect);
      execute_effect_teardown(effect);
      var teardown = update_reaction(effect);
      effect.teardown = typeof teardown === "function" ? teardown : null;
      effect.wv = write_version;
    } finally {
      is_updating_effect = was_updating_effect;
      active_effect = previous_effect;
    }
  }
  /**
   * @template V
   * @param {Value<V>} signal
   * @returns {V}
   */
  function get(signal) {
    var is_derived = (signal.f & 2) !== 0;
    if (active_reaction !== null && !untracking) {
      if (
        !(active_effect !== null && (active_effect.f & 16384) !== 0) &&
        (current_sources === null || !includes.call(current_sources, signal))
      ) {
        var deps = active_reaction.deps;
        if ((active_reaction.f & 2097152) !== 0) {
          if (signal.rv < read_version) {
            signal.rv = read_version;
            if (
              new_deps === null &&
              deps !== null &&
              deps[skipped_deps] === signal
            )
              skipped_deps++;
            else if (new_deps === null) new_deps = [signal];
            else new_deps.push(signal);
          }
        } else {
          (active_reaction.deps ??= []).push(signal);
          var reactions = signal.reactions;
          if (reactions === null) signal.reactions = [active_reaction];
          else if (!includes.call(reactions, active_reaction))
            reactions.push(active_reaction);
        }
      }
    }
    if (is_destroying_effect && old_values.has(signal))
      return old_values.get(signal);
    if (is_derived) {
      var derived = signal;
      if (is_destroying_effect) {
        var value = derived.v;
        if (
          ((derived.f & 1024) === 0 && derived.reactions !== null) ||
          depends_on_old_values(derived)
        )
          value = execute_derived(derived);
        old_values.set(derived, value);
        return value;
      }
      var should_connect =
        (derived.f & 512) === 0 &&
        !untracking &&
        active_reaction !== null &&
        (is_updating_effect || (active_reaction.f & 512) !== 0);
      var is_new = (derived.f & REACTION_RAN) === 0;
      if (is_dirty(derived)) {
        if (should_connect) derived.f |= 512;
        update_derived(derived);
      }
      if (should_connect && !is_new) {
        unfreeze_derived_effects(derived);
        reconnect(derived);
      }
    }
    if (batch_values?.has(signal)) return batch_values.get(signal);
    if ((signal.f & 8388608) !== 0) throw signal.v;
    return signal.v;
  }
  /**
   * (Re)connect a disconnected derived, so that it is notified
   * of changes in `mark_reactions`
   * @param {Derived} derived
   */
  function reconnect(derived) {
    derived.f |= 512;
    if (derived.deps === null) return;
    for (const dep of derived.deps) {
      (dep.reactions ??= []).push(derived);
      if ((dep.f & 2) !== 0 && (dep.f & 512) === 0) {
        unfreeze_derived_effects(dep);
        reconnect(dep);
      }
    }
  }
  /** @param {Derived} derived */
  function depends_on_old_values(derived) {
    if (derived.v === UNINITIALIZED) return true;
    if (derived.deps === null) return false;
    for (const dep of derived.deps) {
      if (old_values.has(dep)) return true;
      if ((dep.f & 2) !== 0 && depends_on_old_values(dep)) return true;
    }
    return false;
  }
  /**
   * When used inside a [`$derived`](https://svelte.dev/docs/svelte/$derived) or [`$effect`](https://svelte.dev/docs/svelte/$effect),
   * any state read inside `fn` will not be treated as a dependency.
   *
   * ```ts
   * $effect(() => {
   *   // this will run when `data` changes, but not when `time` changes
   *   save(data, {
   *     timestamp: untrack(() => time)
   *   });
   * });
   * ```
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function untrack(fn) {
    var previous_untracking = untracking;
    try {
      untracking = true;
      return fn();
    } finally {
      untracking = previous_untracking;
    }
  }
  //#endregion
  //#region node_modules/svelte/src/utils.js
  /**
   * Attributes that are boolean, i.e. they are present or not present.
   */
  var DOM_BOOLEAN_ATTRIBUTES = [
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "default",
    "disabled",
    "formnovalidate",
    "indeterminate",
    "inert",
    "ismap",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "seamless",
    "selected",
    "webkitdirectory",
    "defer",
    "disablepictureinpicture",
    "disableremoteplayback",
  ];
  /**
   * Returns `true` if `name` is a boolean attribute
   * @param {string} name
   */
  function is_boolean_attribute(name) {
    return DOM_BOOLEAN_ATTRIBUTES.includes(name);
  }
  /**
   * Subset of delegated events which should be passive by default.
   * These two are already passive via browser defaults on window, document and body.
   * But since
   * - we're delegating them
   * - they happen often
   * - they apply to mobile which is generally less performant
   * we're marking them as passive by default for other elements, too.
   */
  var PASSIVE_EVENTS = ["touchstart", "touchmove"];
  /**
   * Returns `true` if `name` is a passive event
   * @param {string} name
   */
  function is_passive_event(name) {
    return PASSIVE_EVENTS.includes(name);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/server/index.js
  var INVALID_ATTR_NAME_CHAR_REGEX =
    /[\s'">/=\u{FDD0}-\u{FDEF}\u{FFFE}\u{FFFF}\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;
  /**
   * Only available on the server and when compiling with the `server` option.
   * Takes a component and returns an object with `body` and `head` properties on it, which you can use to populate the HTML when server-rendering your app.
   * @template {Record<string, any>} Props
   * @param {Component<Props> | ComponentType<SvelteComponent<Props>>} component
   * @param {{ props?: Omit<Props, '$$slots' | '$$events'>; context?: Map<any, any>; idPrefix?: string; csp?: Csp; transformError?: (error: unknown) => unknown }} [options]
   * @returns {RenderOutput}
   */
  function render(component, options = {}) {
    if (options.csp?.hash && options.csp.nonce) invalid_csp();
    return Renderer.render(component, options);
  }
  /**
   * @param {string} hash
   * @param {Renderer} renderer
   * @param {(renderer: Renderer) => Promise<void> | void} fn
   * @returns {void}
   */
  function head(hash, renderer, fn) {
    renderer.head((renderer) => {
      renderer.push(`<!--${hash}-->`);
      renderer.child(fn);
      renderer.push(EMPTY_COMMENT);
    });
  }
  /**
   * @param {Record<string, unknown>} attrs
   * @param {string} [css_hash]
   * @param {Record<string, boolean>} [classes]
   * @param {Record<string, string>} [styles]
   * @param {number} [flags]
   * @returns {string}
   */
  function attributes(attrs, css_hash, classes, styles, flags = 0) {
    if (styles) attrs.style = to_style(attrs.style, styles);
    if (attrs.class) attrs.class = clsx$1(attrs.class);
    if (css_hash || classes)
      attrs.class = to_class(attrs.class, css_hash, classes);
    let attr_str = "";
    let name;
    const is_html = (flags & 1) === 0;
    const lowercase = (flags & 2) === 0;
    const is_input = (flags & 4) !== 0;
    for (name of Object.keys(attrs)) {
      if (typeof attrs[name] === "function") continue;
      if (name[0] === "$" && name[1] === "$") continue;
      if (INVALID_ATTR_NAME_CHAR_REGEX.test(name)) continue;
      var value = attrs[name];
      var lower = name.toLowerCase();
      if (lowercase) name = lower;
      if (lower.length > 2 && lower.startsWith("on")) continue;
      if (is_input) {
        if (name === "defaultvalue" || name === "defaultchecked") {
          name = name === "defaultvalue" ? "value" : "checked";
          if (attrs[name]) continue;
        }
      }
      attr_str += attr(name, value, is_html && is_boolean_attribute(name));
    }
    return attr_str;
  }
  /**
   * @template V
   * @param {() => V} get_value
   */
  function once$1(get_value) {
    let value = UNINITIALIZED;
    return () => {
      if (value === UNINITIALIZED) value = get_value();
      return value;
    };
  }
  /**
   * @template T
   * @param {()=>T} fn
   * @returns {(new_value?: T) => (T | void)}
   */
  function derived(fn) {
    const get_value = ssr_context === null ? fn : once$1(fn);
    /** @type {T | undefined} */
    let updated_value;
    return function (new_value) {
      if (arguments.length === 0) return updated_value ?? get_value();
      updated_value = new_value;
      return updated_value;
    };
  }
  //#endregion
  //#region node_modules/svelte/src/internal/server/crypto.js
  var text_encoder$2;
  var crypto$1;
  /** @param {string} module_name */
  var obfuscated_import = (module_name) =>
    import(
      /* @vite-ignore */
      module_name
    );
  /** @param {string} data */
  async function sha256$1(data) {
    text_encoder$2 ??= new TextEncoder();
    crypto$1 ??= globalThis.crypto?.subtle?.digest
      ? globalThis.crypto
      : (await obfuscated_import("node:crypto")).webcrypto;
    return base64_encode$1(
      await crypto$1.subtle.digest("SHA-256", text_encoder$2.encode(data)),
    );
  }
  /**
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function base64_encode$1(bytes) {
    if (globalThis.Buffer)
      return globalThis.Buffer.from(bytes).toString("base64");
    let binary = "";
    for (let i = 0; i < bytes.length; i++)
      binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  //#endregion
  //#region node_modules/svelte/src/internal/server/renderer.js
  /** @import { Component } from 'svelte' */
  /** @import { Csp, HydratableContext, RenderOutput, SSRContext, SyncRenderOutput, Sha256Source } from './types.js' */
  /** @import { MaybePromise } from '#shared' */
  /** @typedef {'head' | 'body'} RendererType */
  /** @typedef {{ [key in RendererType]: string }} AccumulatedContent */
  /**
   * @typedef {string | Renderer} RendererItem
   */
  /**
   * Renderers are basically a tree of `string | Renderer`s, where each `Renderer` in the tree represents
   * work that may or may not have completed. A renderer can be {@link collect}ed to aggregate the
   * content from itself and all of its children, but this will throw if any of the children are
   * performing asynchronous work. To asynchronously collect a renderer, just `await` it.
   *
   * The `string` values within a renderer are always associated with the {@link type} of that renderer. To switch types,
   * call {@link child} with a different `type` argument.
   */
  var Renderer = class Renderer {
    /**
     * The contents of the renderer.
     * @type {RendererItem[]}
     */
    #out = [];
    /**
     * Any `onDestroy` callbacks registered during execution of this renderer.
     * @type {(() => void)[] | undefined}
     */
    #on_destroy = void 0;
    /**
     * Whether this renderer is a component body.
     * @type {boolean}
     */
    #is_component_body = false;
    /**
     * If set, this renderer is an error boundary. When async collection
     * of the children fails, the failed snippet is rendered instead.
     * @type {{
     * 	failed: (renderer: Renderer, error: unknown, reset: () => void) => void;
     * 	transformError: (error: unknown) => unknown;
     * 	context: SSRContext | null;
     * } | null}
     */
    #boundary = null;
    /**
     * The type of string content that this renderer is accumulating.
     * @type {RendererType}
     */
    type;
    /** @type {Renderer | undefined} */
    #parent;
    /**
     * Asynchronous work associated with this renderer
     * @type {Promise<void> | undefined}
     */
    promise = void 0;
    /**
     * State which is associated with the content tree as a whole.
     * It will be re-exposed, uncopied, on all children.
     * @type {SSRState}
     * @readonly
     */
    global;
    /**
     * State that is local to the branch it is declared in.
     * It will be shallow-copied to all children.
     *
     * @type {{ select_value: string | undefined }}
     */
    local;
    /**
     * @param {SSRState} global
     * @param {Renderer | undefined} [parent]
     */
    constructor(global, parent) {
      this.#parent = parent;
      this.global = global;
      this.local = parent ? { ...parent.local } : { select_value: void 0 };
      this.type = parent ? parent.type : "body";
    }
    /**
     * @param {(renderer: Renderer) => void} fn
     */
    head(fn) {
      const head = new Renderer(this.global, this);
      head.type = "head";
      this.#out.push(head);
      head.child(fn);
    }
    /**
     * @param {Array<Promise<void>>} blockers
     * @param {(renderer: Renderer) => void} fn
     */
    async_block(blockers, fn) {
      this.#out.push(BLOCK_OPEN);
      this.async(blockers, fn);
      this.#out.push(BLOCK_CLOSE);
    }
    /**
     * @param {Array<Promise<void>>} blockers
     * @param {(renderer: Renderer) => void} fn
     */
    async(blockers, fn) {
      let callback = fn;
      if (blockers.length > 0) {
        const context = ssr_context;
        callback = (renderer) => {
          return Promise.all(blockers).then(() => {
            const previous_context = ssr_context;
            try {
              set_ssr_context(context);
              return fn(renderer);
            } finally {
              set_ssr_context(previous_context);
            }
          });
        };
      }
      this.child(callback);
    }
    /**
     * @param {Array<() => void>} thunks
     */
    run(thunks) {
      const context = ssr_context;
      let promise = Promise.resolve(thunks[0]());
      const promises = [promise];
      for (const fn of thunks.slice(1)) {
        promise = promise.then(() => {
          const previous_context = ssr_context;
          set_ssr_context(context);
          try {
            return fn();
          } finally {
            set_ssr_context(previous_context);
          }
        });
        promises.push(promise);
      }
      promise.catch(noop$1);
      this.promise = promise;
      return promises;
    }
    /**
     * @param {(renderer: Renderer) => MaybePromise<void>} fn
     */
    child_block(fn) {
      this.#out.push(BLOCK_OPEN);
      this.child(fn);
      this.#out.push(BLOCK_CLOSE);
    }
    /**
     * Create a child renderer. The child renderer inherits the state from the parent,
     * but has its own content.
     * @param {(renderer: Renderer) => MaybePromise<void>} fn
     */
    child(fn) {
      const child = new Renderer(this.global, this);
      this.#out.push(child);
      const parent = ssr_context;
      set_ssr_context({
        ...ssr_context,
        p: parent,
        c: null,
        r: child,
      });
      const result = fn(child);
      set_ssr_context(parent);
      if (result instanceof Promise) {
        result.catch(noop$1);
        result.finally(() => set_ssr_context(null)).catch(noop$1);
        if (child.global.mode === "sync") await_invalid();
        child.promise = result;
      }
      return child;
    }
    /**
     * Render children inside an error boundary. If the children throw and the API-level
     * `transformError` transform handles the error (doesn't re-throw), the `failed` snippet is
     * rendered instead. Otherwise the error propagates.
     *
     * @param {{ failed?: (renderer: Renderer, error: unknown, reset: () => void) => void }} props
     * @param {(renderer: Renderer) => MaybePromise<void>} children_fn
     */
    boundary(props, children_fn) {
      const child = new Renderer(this.global, this);
      this.#out.push(child);
      const parent_context = ssr_context;
      if (props.failed)
        child.#boundary = {
          failed: props.failed,
          transformError: this.global.transformError,
          context: parent_context,
        };
      set_ssr_context({
        ...ssr_context,
        p: parent_context,
        c: null,
        r: child,
      });
      try {
        const result = children_fn(child);
        set_ssr_context(parent_context);
        if (result instanceof Promise) {
          if (child.global.mode === "sync") await_invalid();
          result.catch(noop$1);
          child.promise = result;
        }
      } catch (error) {
        set_ssr_context(parent_context);
        const failed_snippet = props.failed;
        if (!failed_snippet) throw error;
        const result = this.global.transformError(error);
        child.#out.length = 0;
        child.#boundary = null;
        if (result instanceof Promise) {
          if (this.global.mode === "sync") await_invalid();
          child.promise = result.then((transformed) => {
            set_ssr_context(parent_context);
            child.#out.push(Renderer.#serialize_failed_boundary(transformed));
            failed_snippet(child, transformed, noop$1);
            child.#out.push(BLOCK_CLOSE);
          });
          child.promise.catch(noop$1);
        } else {
          child.#out.push(Renderer.#serialize_failed_boundary(result));
          failed_snippet(child, result, noop$1);
          child.#out.push(BLOCK_CLOSE);
        }
      }
    }
    /**
     * Create a component renderer. The component renderer inherits the state from the parent,
     * but has its own content. It is treated as an ordering boundary for ondestroy callbacks.
     * @param {(renderer: Renderer) => MaybePromise<void>} fn
     * @param {Function} [component_fn]
     * @returns {void}
     */
    component(fn, component_fn) {
      push$1();
      const child = this.child(fn);
      child.#is_component_body = true;
      pop$1();
    }
    /**
     * @param {Record<string, any>} attrs
     * @param {(renderer: Renderer) => void} fn
     * @param {string | undefined} [css_hash]
     * @param {Record<string, boolean> | undefined} [classes]
     * @param {Record<string, string> | undefined} [styles]
     * @param {number | undefined} [flags]
     * @param {boolean | undefined} [is_rich]
     * @returns {void}
     */
    select(attrs, fn, css_hash, classes, styles, flags, is_rich) {
      const { value, ...select_attrs } = attrs;
      this.push(
        `<select${attributes(select_attrs, css_hash, classes, styles, flags)}>`,
      );
      this.child((renderer) => {
        renderer.local.select_value = value;
        fn(renderer);
      });
      this.push(`${is_rich ? "<!>" : ""}</select>`);
    }
    /**
     * @param {Record<string, any>} attrs
     * @param {string | number | boolean | ((renderer: Renderer) => void)} body
     * @param {string | undefined} [css_hash]
     * @param {Record<string, boolean> | undefined} [classes]
     * @param {Record<string, string> | undefined} [styles]
     * @param {number | undefined} [flags]
     * @param {boolean | undefined} [is_rich]
     */
    option(attrs, body, css_hash, classes, styles, flags, is_rich) {
      this.#out.push(
        `<option${attributes(attrs, css_hash, classes, styles, flags)}`,
      );
      /**
       * @param {Renderer} renderer
       * @param {any} value
       * @param {{ head?: string, body: any }} content
       */
      const close = (renderer, value, { head, body }) => {
        if (has_own_property.call(attrs, "value")) value = attrs.value;
        if (value === this.local.select_value)
          renderer.#out.push(' selected=""');
        renderer.#out.push(`>${body}${is_rich ? "<!>" : ""}</option>`);
        if (head) renderer.head((child) => child.push(head));
      };
      if (typeof body === "function")
        this.child((renderer) => {
          const r = new Renderer(this.global, this);
          body(r);
          if (this.global.mode === "async")
            return r.#collect_content_async().then((content) => {
              close(renderer, content.body.replaceAll("<!---->", ""), content);
            });
          else {
            const content = r.#collect_content();
            close(renderer, content.body.replaceAll("<!---->", ""), content);
          }
        });
      else close(this, body, { body: escape_html$1(body) });
    }
    /**
     * @param {(renderer: Renderer) => void} fn
     */
    title(fn) {
      const path = this.get_path();
      /** @param {string} head */
      const close = (head) => {
        this.global.set_title(head, path);
      };
      this.child((renderer) => {
        const r = new Renderer(renderer.global, renderer);
        fn(r);
        if (renderer.global.mode === "async")
          return r.#collect_content_async().then((content) => {
            close(content.head);
          });
        else close(r.#collect_content().head);
      });
    }
    /**
     * @param {string | (() => Promise<string>)} content
     */
    push(content) {
      if (typeof content === "function")
        this.child(async (renderer) => renderer.push(await content()));
      else this.#out.push(content);
    }
    /**
     * @param {() => void} fn
     */
    on_destroy(fn) {
      (this.#on_destroy ??= []).push(fn);
    }
    /**
     * @returns {number[]}
     */
    get_path() {
      return this.#parent
        ? [...this.#parent.get_path(), this.#parent.#out.indexOf(this)]
        : [];
    }
    /**
     * @deprecated this is needed for legacy component bindings
     */
    copy() {
      const copy = new Renderer(this.global, this.#parent);
      copy.#out = this.#out.map((item) =>
        item instanceof Renderer ? item.copy() : item,
      );
      copy.promise = this.promise;
      return copy;
    }
    /**
     * @param {Renderer} other
     * @deprecated this is needed for legacy component bindings
     */
    subsume(other) {
      if (this.global.mode !== other.global.mode)
        throw new Error(
          "invariant: A renderer cannot switch modes. If you're seeing this, there's a compiler bug. File an issue!",
        );
      this.local = other.local;
      this.#out = other.#out.map((item, i) => {
        const current = this.#out[i];
        if (current instanceof Renderer && item instanceof Renderer) {
          current.subsume(item);
          return current;
        }
        return item;
      });
      this.promise = other.promise;
      this.type = other.type;
    }
    get length() {
      return this.#out.length;
    }
    /**
     * Creates the hydration comment that marks the start of a failed boundary.
     * The error is JSON-serialized and embedded inside an HTML comment for the client
     * to parse during hydration. The JSON is escaped to prevent `-->` or `<!--` sequences
     * from breaking out of the comment (XSS). Uses unicode escapes which `JSON.parse()`
     * handles transparently.
     * @param {unknown} error
     * @returns {string}
     */
    static #serialize_failed_boundary(error) {
      return `<!--[?${JSON.stringify(error).replace(/>/g, "\\u003e").replace(/</g, "\\u003c")}-->`;
    }
    /**
     * Only available on the server and when compiling with the `server` option.
     * Takes a component and returns an object with `body` and `head` properties on it, which you can use to populate the HTML when server-rendering your app.
     * @template {Record<string, any>} Props
     * @param {Component<Props>} component
     * @param {{ props?: Omit<Props, '$$slots' | '$$events'>; context?: Map<any, any>; idPrefix?: string; csp?: Csp }} [options]
     * @returns {RenderOutput}
     */
    static render(component, options = {}) {
      /** @type {AccumulatedContent | undefined} */
      let sync;
      const result = {};
      Object.defineProperties(result, {
        html: {
          get: () => {
            return (sync ??= Renderer.#render(component, options)).body;
          },
        },
        head: {
          get: () => {
            return (sync ??= Renderer.#render(component, options)).head;
          },
        },
        body: {
          get: () => {
            return (sync ??= Renderer.#render(component, options)).body;
          },
        },
        hashes: { value: { script: "" } },
        then: {
          value: (onfulfilled, onrejected) => {
            {
              const result = (sync ??= Renderer.#render(component, options));
              const user_result = onfulfilled({
                head: result.head,
                body: result.body,
                html: result.body,
                hashes: { script: [] },
              });
              return Promise.resolve(user_result);
            }
          },
        },
      });
      return result;
    }
    /**
     * Collect all of the `onDestroy` callbacks registered during rendering. In an async context, this is only safe to call
     * after awaiting `collect_async`.
     *
     * Child renderers are "porous" and don't affect execution order, but component body renderers
     * create ordering boundaries. Within a renderer, callbacks run in order until hitting a component boundary.
     * @returns {Iterable<() => void>}
     */
    *#collect_on_destroy() {
      for (const component of this.#traverse_components())
        yield* component.#collect_ondestroy();
    }
    /**
     * Performs a depth-first search of renderers, yielding the deepest components first, then additional components as we backtrack up the tree.
     * @returns {Iterable<Renderer>}
     */
    *#traverse_components() {
      for (const child of this.#out)
        if (typeof child !== "string") yield* child.#traverse_components();
      if (this.#is_component_body) yield this;
    }
    /**
     * @returns {Iterable<() => void>}
     */
    *#collect_ondestroy() {
      if (this.#on_destroy) for (const fn of this.#on_destroy) yield fn;
      for (const child of this.#out)
        if (child instanceof Renderer && !child.#is_component_body)
          yield* child.#collect_ondestroy();
    }
    /**
     * Render a component. Throws if any of the children are performing asynchronous work.
     *
     * @template {Record<string, any>} Props
     * @param {Component<Props>} component
     * @param {{ props?: Omit<Props, '$$slots' | '$$events'>; context?: Map<any, any>; idPrefix?: string }} options
     * @returns {AccumulatedContent}
     */
    static #render(component, options) {
      var previous_context = ssr_context;
      try {
        const renderer = Renderer.#open_render("sync", component, options);
        const content = renderer.#collect_content();
        return Renderer.#close_render(content, renderer);
      } finally {
        abort();
        set_ssr_context(previous_context);
      }
    }
    /**
     * Render a component.
     *
     * @template {Record<string, any>} Props
     * @param {Component<Props>} component
     * @param {{ props?: Omit<Props, '$$slots' | '$$events'>; context?: Map<any, any>; idPrefix?: string; csp?: Csp }} options
     * @returns {Promise<AccumulatedContent & { hashes: { script: Sha256Source[] } }>}
     */
    static async #render_async(component, options) {
      const previous_context = ssr_context;
      try {
        const renderer = Renderer.#open_render("async", component, options);
        const content = await renderer.#collect_content_async();
        const hydratables = await renderer.#collect_hydratables();
        if (hydratables !== null) content.head = hydratables + content.head;
        return Renderer.#close_render(content, renderer);
      } finally {
        set_ssr_context(previous_context);
        abort();
      }
    }
    /**
     * Collect all of the code from the `out` array and return it as a string, or a promise resolving to a string.
     * @param {AccumulatedContent} content
     * @returns {AccumulatedContent}
     */
    #collect_content(
      content = {
        head: "",
        body: "",
      },
    ) {
      for (const item of this.#out)
        if (typeof item === "string") content[this.type] += item;
        else if (item instanceof Renderer) item.#collect_content(content);
      return content;
    }
    /**
     * Collect all of the code from the `out` array and return it as a string.
     * @param {AccumulatedContent} content
     * @returns {Promise<AccumulatedContent>}
     */
    async #collect_content_async(
      content = {
        head: "",
        body: "",
      },
    ) {
      await this.promise;
      for (const item of this.#out)
        if (typeof item === "string") content[this.type] += item;
        else if (item instanceof Renderer)
          if (item.#boundary) {
            /** @type {AccumulatedContent} */
            const boundary_content = {
              head: "",
              body: "",
            };
            try {
              await item.#collect_content_async(boundary_content);
              content.head += boundary_content.head;
              content.body += boundary_content.body;
            } catch (error) {
              const { context, failed, transformError } = item.#boundary;
              set_ssr_context(context);
              let transformed = await transformError(error);
              const failed_renderer = new Renderer(item.global, item);
              failed_renderer.type = item.type;
              failed_renderer.#out.push(
                Renderer.#serialize_failed_boundary(transformed),
              );
              failed(failed_renderer, transformed, noop$1);
              failed_renderer.#out.push(BLOCK_CLOSE);
              await failed_renderer.#collect_content_async(content);
            }
          } else await item.#collect_content_async(content);
      return content;
    }
    async #collect_hydratables() {
      const ctx = get_render_context().hydratable;
      for (const [_, key] of ctx.unresolved_promises)
        unresolved_hydratable(
          key,
          ctx.lookup.get(key)?.stack ?? "<missing stack trace>",
        );
      for (const comparison of ctx.comparisons) await comparison;
      return await this.#hydratable_block(ctx);
    }
    /**
     * @template {Record<string, any>} Props
     * @param {'sync' | 'async'} mode
     * @param {import('svelte').Component<Props>} component
     * @param {{ props?: Omit<Props, '$$slots' | '$$events'>; context?: Map<any, any>; idPrefix?: string; csp?: Csp; transformError?: (error: unknown) => unknown }} options
     * @returns {Renderer}
     */
    static #open_render(mode, component, options) {
      if (options.idPrefix?.includes("--")) invalid_id_prefix();
      var previous_context = ssr_context;
      try {
        const renderer = new Renderer(
          new SSRState(
            mode,
            options.idPrefix ? options.idPrefix + "-" : "",
            options.csp,
            options.transformError,
          ),
        );
        set_ssr_context({
          p: null,
          c: options.context ?? null,
          r: renderer,
        });
        renderer.push(BLOCK_OPEN);
        component(renderer, options.props ?? {});
        renderer.push(BLOCK_CLOSE);
        return renderer;
      } finally {
        set_ssr_context(previous_context);
      }
    }
    /**
     * @param {AccumulatedContent} content
     * @param {Renderer} renderer
     * @returns {AccumulatedContent & { hashes: { script: Sha256Source[] } }}
     */
    static #close_render(content, renderer) {
      for (const cleanup of renderer.#collect_on_destroy()) cleanup();
      let head = content.head + renderer.global.get_title();
      let body = content.body;
      for (const { hash, code } of renderer.global.css)
        head += `<style id="${hash}">${code}</style>`;
      return {
        head,
        body,
        hashes: { script: renderer.global.csp.script_hashes },
      };
    }
    /**
     * @param {HydratableContext} ctx
     */
    async #hydratable_block(ctx) {
      if (ctx.lookup.size === 0) return null;
      let entries = [];
      let has_promises = false;
      for (const [k, v] of ctx.lookup) {
        if (v.promises) {
          has_promises = true;
          for (const p of v.promises) await p;
        }
        entries.push(`[${uneval(k)},${v.serialized}]`);
      }
      let prelude = `const h = (window.__svelte ??= {}).h ??= new Map();`;
      if (has_promises)
        prelude = `const r = (v) => Promise.resolve(v);
				${prelude}`;
      const body = `
			{
				${prelude}

				for (const [k, v] of [
					${entries.join(",\n					")}
				]) {
					h.set(k, v);
				}
			}
		`;
      let csp_attr = "";
      if (this.global.csp.nonce) csp_attr = ` nonce="${this.global.csp.nonce}"`;
      else if (this.global.csp.hash) {
        const hash = await sha256$1(body);
        this.global.csp.script_hashes.push(`sha256-${hash}`);
      }
      return `\n\t\t<script${csp_attr}>${body}<\/script>`;
    }
  };
  var SSRState = class {
    /** @readonly @type {Csp & { script_hashes: Sha256Source[] }} */
    csp;
    /** @readonly @type {'sync' | 'async'} */
    mode;
    /** @readonly @type {() => string} */
    uid;
    /** @readonly @type {Set<{ hash: string; code: string }>} */
    css = /* @__PURE__ */ new Set();
    /**
     * `transformError` passed to `render`. Called when an error boundary catches an error.
     * Throws by default if unset in `render`.
     * @type {(error: unknown) => unknown}
     */
    transformError;
    /** @type {{ path: number[], value: string }} */
    #title = {
      path: [],
      value: "",
    };
    /**
     * @param {'sync' | 'async'} mode
     * @param {string} id_prefix
     * @param {Csp} csp
     * @param {((error: unknown) => unknown) | undefined} [transformError]
     */
    constructor(mode, id_prefix = "", csp = { hash: false }, transformError) {
      this.mode = mode;
      this.csp = {
        ...csp,
        script_hashes: [],
      };
      this.transformError =
        transformError ??
        ((error) => {
          throw error;
        });
      let uid = 1;
      this.uid = () => `${id_prefix}s${uid++}`;
    }
    get_title() {
      return this.#title.value;
    }
    /**
     * Performs a depth-first (lexicographic) comparison using the path. Rejects sets
     * from earlier than or equal to the current value.
     * @param {string} value
     * @param {number[]} path
     */
    set_title(value, path) {
      const current = this.#title.path;
      let i = 0;
      let l = Math.min(path.length, current.length);
      while (i < l && path[i] === current[i]) i += 1;
      if (path[i] === void 0) return;
      if (current[i] === void 0 || path[i] > current[i]) {
        this.#title.path = path;
        this.#title.value = value;
      }
    }
  };

  //#region \0rolldown/runtime.js
  var __defProp = Object.defineProperty;
  var __exportAll = (all, no_symbols) => {
    let target = {};
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
      });
    __defProp(target, Symbol.toStringTag, { value: "Module" });
    return target;
  };
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/app/paths/internal/server.js
  var base = "";
  var assets = base;
  var app_dir = "_app";
  var initial = {
    base,
    assets,
  };
  /**
   * @param {{ base: string, assets: string }} paths
   */
  function override(paths) {
    base = paths.base;
    assets = paths.assets;
  }
  function reset() {
    base = initial.base;
    assets = initial.assets;
  }
  /**
   * `$env/dynamic/public`
   * @type {Record<string, string>}
   */
  var public_env = {};
  /** @type {(environment: Record<string, string>) => void} */
  function set_private_env(environment) {}
  /** @type {(environment: Record<string, string>) => void} */
  function set_public_env(environment) {
    public_env = environment;
  }
  //#endregion
  //#region node_modules/svelte/src/internal/server/hydratable.js
  /** @import { HydratableLookupEntry } from '#server' */
  /**
   * @template T
   * @param {string} key
   * @param {() => T} fn
   * @returns {T}
   */
  function hydratable(key, fn) {
    experimental_async_required();
    const { hydratable } = get_render_context();
    let entry = hydratable.lookup.get(key);
    if (entry !== void 0) return entry.value;
    const value = fn();
    entry = encode$1(key, value, hydratable.unresolved_promises);
    hydratable.lookup.set(key, entry);
    return value;
  }
  /**
   * @param {string} key
   * @param {any} value
   * @param {Map<Promise<any>, string>} [unresolved]
   */
  function encode$1(key, value, unresolved) {
    /** @type {HydratableLookupEntry} */
    const entry = {
      value,
      serialized: "",
    };
    let uid = 1;
    entry.serialized = uneval(entry.value, (value, uneval) => {
      if (is_promise(value)) {
        const placeholder = `"${uid++}"`;
        const p = value
          .then((v) => {
            entry.serialized = entry.serialized.replace(
              placeholder,
              `r(${uneval(v)})`,
            );
          })
          .catch((devalue_error) =>
            hydratable_serialization_failed(
              key,
              serialization_stack(entry.stack, devalue_error?.stack),
            ),
          );
        p.catch(() => {}).finally(() => unresolved?.delete(p));
        (entry.promises ??= []).push(p);
        return placeholder;
      }
    });
    return entry;
  }
  /**
   * @param {any} value
   * @returns {value is Promise<any>}
   */
  function is_promise(value) {
    return Object.prototype.toString.call(value) === "[object Promise]";
  }
  /**
   * @param {string | undefined} root_stack
   * @param {string | undefined} uneval_stack
   */
  function serialization_stack(root_stack, uneval_stack) {
    let out = "";
    if (root_stack) out += root_stack + "\n";
    if (uneval_stack) out += "Caused by:\n" + uneval_stack + "\n";
    return out || "<missing stack trace>";
  }
  //#endregion
  //#region node_modules/svelte/src/internal/server/blocks/snippet.js
  /** @import { Snippet } from 'svelte' */
  /** @import { Renderer } from '../renderer' */
  /** @import { Getters } from '#shared' */
  /**
   * Create a snippet programmatically
   * @template {unknown[]} Params
   * @param {(...params: Getters<Params>) => {
   *   render: () => string
   *   setup?: (element: Element) => void | (() => void)
   * }} fn
   * @returns {Snippet<Params>}
   */
  function createRawSnippet(fn) {
    return (renderer, ...args) => {
      var getters = args.map((value) => () => value);
      renderer.push(
        fn(...getters)
          .render()
          .trim(),
      );
    };
  }
  //#endregion
  //#region node_modules/svelte/src/index-server.js
  /** @import { SSRContext } from '#server' */
  /** @import { Renderer } from './internal/server/renderer.js' */
  var index_server_exports = /* @__PURE__ */ __exportAll({
    afterUpdate: () => noop$1,
    beforeUpdate: () => noop$1,
    createContext: () => createContext,
    createEventDispatcher: () => createEventDispatcher,
    createRawSnippet: () => createRawSnippet,
    flushSync: () => noop$1,
    fork: () => fork,
    getAbortSignal: () => getAbortSignal,
    getAllContexts: () => getAllContexts,
    getContext: () => getContext,
    hasContext: () => hasContext,
    hydratable: () => hydratable,
    hydrate: () => hydrate$1,
    mount: () => mount$1,
    onDestroy: () => onDestroy,
    onMount: () => noop$1,
    setContext: () => setContext,
    settled: () => settled,
    tick: () => tick$1,
    unmount: () => unmount$1,
    untrack: () => run,
  });
  /** @param {() => void} fn */
  function onDestroy(fn) {
    /** @type {Renderer} */ ssr_context.r.on_destroy(fn);
  }
  function createEventDispatcher() {
    return noop$1;
  }
  function mount$1() {
    lifecycle_function_unavailable("mount");
  }
  function hydrate$1() {
    lifecycle_function_unavailable("hydrate");
  }
  function unmount$1() {
    lifecycle_function_unavailable("unmount");
  }
  function fork() {
    lifecycle_function_unavailable("fork");
  }
  async function tick$1() {}
  async function settled() {}

  /** @import { StandardSchemaV1 } from '@standard-schema/spec' */

  class HttpError {
    /**
     * @param {number} status
     * @param {{message: string} extends App.Error ? (App.Error | string | undefined) : App.Error} body
     */
    constructor(status, body) {
      this.status = status;
      if (typeof body === "string") {
        this.body = { message: body };
      } else if (body) {
        this.body = body;
      } else {
        this.body = { message: `Error: ${status}` };
      }
    }

    toString() {
      return JSON.stringify(this.body);
    }
  }

  class Redirect {
    /**
     * @param {300 | 301 | 302 | 303 | 304 | 305 | 306 | 307 | 308} status
     * @param {string} location
     */
    constructor(status, location) {
      try {
        new Headers({ location });
      } catch {
        throw new Error(
          `Invalid redirect location ${JSON.stringify(location)}: ` +
            "this string contains characters that cannot be used in HTTP headers",
        );
      }

      this.status = status;
      this.location = location;
    }
  }

  /**
   * An error that was thrown from within the SvelteKit runtime that is not fatal and doesn't result in a 500, such as a 404.
   * `SvelteKitError` goes through `handleError`.
   * @extends Error
   */
  class SvelteKitError extends Error {
    /**
     * @param {number} status
     * @param {string} text
     * @param {string} message
     */
    constructor(status, text, message) {
      super(message);
      this.status = status;
      this.text = text;
    }
  }

  /**
   * @template [T=undefined]
   */
  class ActionFailure {
    /**
     * @param {number} status
     * @param {T} data
     */
    constructor(status, data) {
      this.status = status;
      this.data = data;
    }
  }

  //#region node_modules/@sveltejs/kit/src/utils/functions.js
  function noop() {}
  /**
   * @template T
   * @param {() => T} fn
   */
  function once(fn) {
    let done = false;
    /** @type T */
    let result;
    return () => {
      if (done) return result;
      done = true;
      return (result = fn());
    };
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/utils.js
  var text_encoder$1 = new TextEncoder();
  /**
   * Like node's path.relative, but without using node
   * @param {string} from
   * @param {string} to
   */
  function get_relative_path(from, to) {
    const from_parts = from.split(/[/\\]/);
    const to_parts = to.split(/[/\\]/);
    from_parts.pop();
    while (from_parts[0] === to_parts[0]) {
      from_parts.shift();
      to_parts.shift();
    }
    let i = from_parts.length;
    while (i--) from_parts[i] = "..";
    return from_parts.concat(to_parts).join("/");
  }
  /**
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function base64_encode(bytes) {
    if (globalThis.Buffer)
      return globalThis.Buffer.from(bytes).toString("base64");
    let binary = "";
    for (let i = 0; i < bytes.length; i++)
      binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  /**
   * @param {string} encoded
   * @returns {Uint8Array}
   */
  function base64_decode(encoded) {
    if (globalThis.Buffer) {
      const buffer = globalThis.Buffer.from(encoded, "base64");
      return new Uint8Array(buffer);
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/error.js
  /**
   * @param {unknown} err
   * @return {Error}
   */
  function coalesce_to_error(err) {
    return err instanceof Error || (err && err.name && err.message)
      ? err
      : new Error(JSON.stringify(err));
  }
  /**
   * This is an identity function that exists to make TypeScript less
   * paranoid about people throwing things that aren't errors, which
   * frankly is not something we should care about
   * @param {unknown} error
   */
  function normalize_error(error) {
    return error;
  }
  /**
   * @param {unknown} error
   */
  function get_status(error) {
    return error instanceof HttpError || error instanceof SvelteKitError
      ? error.status
      : 500;
  }
  /**
   * @param {unknown} error
   */
  function get_message(error) {
    return error instanceof SvelteKitError ? error.text : "Internal Error";
  }
  var INVALIDATED_PARAM = "x-sveltekit-invalidated";
  var TRAILING_SLASH_PARAM = "x-sveltekit-trailing-slash";
  /**
   * Try to `devalue.stringify` the data object using the provided transport encoders.
   * @param {any} data
   * @param {Transport} transport
   */
  function stringify(data, transport) {
    const encoders = Object.fromEntries(
      Object.entries(transport).map(([k, v]) => [k, v.encode]),
    );
    return stringify$1(data, encoders);
  }
  var remote_object = "__skrao";
  var remote_map = "__skram";
  var remote_set = "__skras";
  /** @param {Transport} transport */
  function create_remote_arg_revivers(transport) {
    const remote_fns_revivers = {
      /** @type {(value: unknown) => unknown} */
      [remote_object]: (value) => value,
      /** @type {(value: unknown) => Map<unknown, unknown>} */
      [remote_map]: (value) => {
        if (!Array.isArray(value))
          throw new Error("Invalid data for Map reviver");
        const map = /* @__PURE__ */ new Map();
        for (const item of value) {
          if (
            !Array.isArray(item) ||
            item.length !== 2 ||
            typeof item[0] !== "string" ||
            typeof item[1] !== "string"
          )
            throw new Error("Invalid data for Map reviver");
          const [key, val] = item;
          map.set(parse$1(key), parse$1(val));
        }
        return map;
      },
      /** @type {(value: unknown) => Set<unknown>} */
      [remote_set]: (value) => {
        if (!Array.isArray(value))
          throw new Error("Invalid data for Set reviver");
        const set = /* @__PURE__ */ new Set();
        for (const item of value) {
          if (typeof item !== "string")
            throw new Error("Invalid data for Set reviver");
          set.add(parse$1(item));
        }
        return set;
      },
    };
    const all_revivers = {
      ...Object.fromEntries(
        Object.entries(transport).map(([k, v]) => [k, v.decode]),
      ),
      ...remote_fns_revivers,
    };
    /** @type {(data: string) => unknown} */
    const parse$1 = (data) => parse(data, all_revivers);
    return all_revivers;
  }
  /**
   * Parses the argument (if any) for a remote function
   * @param {string} string
   * @param {Transport} transport
   */
  function parse_remote_arg(string, transport) {
    if (!string) return void 0;
    const json_string = new TextDecoder().decode(
      base64_decode(string.replaceAll("-", "+").replaceAll("_", "/")),
    );
    return parse(json_string, create_remote_arg_revivers(transport));
  }
  /**
   * @param {string} id
   * @param {string} payload
   */
  function create_remote_key(id, payload) {
    return id + "/" + payload;
  }
  /**
   * @param {string} key
   * @returns {{ id: string; payload: string }}
   */
  function split_remote_key(key) {
    const i = key.lastIndexOf("/");
    if (i === -1) throw new Error(`Invalid remote key: ${key}`);
    return {
      id: key.slice(0, i),
      payload: key.slice(i + 1),
    };
  }

  const text_encoder = new TextEncoder();

  /** @import { StandardSchemaV1 } from '@standard-schema/spec' */

  // TODO 3.0: remove these types as they are not used anymore (we can't remove them yet because that would be a breaking change)
  /**
   * @template {number} TNumber
   * @template {any[]} [TArray=[]]
   * @typedef {TNumber extends TArray['length'] ? TArray[number] : LessThan<TNumber, [...TArray, TArray['length']]>} LessThan
   */

  /**
   * @template {number} TStart
   * @template {number} TEnd
   * @typedef {Exclude<TEnd | LessThan<TEnd>, LessThan<TStart>>} NumericRange
   */

  // Keep the status codes as `number` because restricting to certain numbers makes it unnecessarily hard to use compared to the benefits
  // (we have runtime errors already to check for invalid codes). Also see https://github.com/sveltejs/kit/issues/11780

  // we have to repeat the JSDoc because the display for function overloads is broken
  // see https://github.com/microsoft/TypeScript/issues/55056

  /**
   * Throws an error with a HTTP status code and an optional message.
   * When called during request handling, this will cause SvelteKit to
   * return an error response without invoking `handleError`.
   * Make sure you're not catching the thrown error, which would prevent SvelteKit from handling it.
   * @param {number} status The [HTTP status code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#client_error_responses). Must be in the range 400-599.
   * @param {App.Error} body An object that conforms to the App.Error type. If a string is passed, it will be used as the message property.
   * @overload
   * @param {number} status
   * @param {App.Error} body
   * @return {never}
   * @throws {HttpError} This error instructs SvelteKit to initiate HTTP error handling.
   * @throws {Error} If the provided status is invalid (not between 400 and 599).
   */
  /**
   * Throws an error with a HTTP status code and an optional message.
   * When called during request handling, this will cause SvelteKit to
   * return an error response without invoking `handleError`.
   * Make sure you're not catching the thrown error, which would prevent SvelteKit from handling it.
   * @param {number} status The [HTTP status code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#client_error_responses). Must be in the range 400-599.
   * @param {{ message: string } extends App.Error ? App.Error | string | undefined : never} [body] An object that conforms to the App.Error type. If a string is passed, it will be used as the message property.
   * @overload
   * @param {number} status
   * @param {{ message: string } extends App.Error ? App.Error | string | undefined : never} [body]
   * @return {never}
   * @throws {HttpError} This error instructs SvelteKit to initiate HTTP error handling.
   * @throws {Error} If the provided status is invalid (not between 400 and 599).
   */
  /**
   * Throws an error with a HTTP status code and an optional message.
   * When called during request handling, this will cause SvelteKit to
   * return an error response without invoking `handleError`.
   * Make sure you're not catching the thrown error, which would prevent SvelteKit from handling it.
   * @param {number} status The [HTTP status code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#client_error_responses). Must be in the range 400-599.
   * @param {{ message: string } extends App.Error ? App.Error | string | undefined : never} body An object that conforms to the App.Error type. If a string is passed, it will be used as the message property.
   * @return {never}
   * @throws {HttpError} This error instructs SvelteKit to initiate HTTP error handling.
   * @throws {Error} If the provided status is invalid (not between 400 and 599).
   */
  function error(status, body) {
    if (isNaN(status) || status < 400 || status > 599) {
      throw new Error(
        `HTTP error status codes must be between 400 and 599 — ${status} is invalid`,
      );
    }

    throw new HttpError(status, body);
  }

  /**
   * Checks whether this is a redirect thrown by {@link redirect}.
   * @param {unknown} e The object to check.
   * @return {e is Redirect}
   */
  function isRedirect(e) {
    return e instanceof Redirect;
  }

  /**
   * Create a JSON `Response` object from the supplied data.
   * @param {any} data The value that will be serialized as JSON.
   * @param {ResponseInit} [init] Options such as `status` and `headers` that will be added to the response. `Content-Type: application/json` and `Content-Length` headers will be added automatically.
   */
  function json(data, init) {
    // TODO deprecate this in favour of `Response.json` when it's
    // more widely supported
    const body = JSON.stringify(data);

    // we can't just do `text(JSON.stringify(data), init)` because
    // it will set a default `content-type` header. duplicated code
    // means less duplicated work
    const headers = new Headers(init?.headers);
    if (!headers.has("content-length")) {
      headers.set(
        "content-length",
        text_encoder.encode(body).byteLength.toString(),
      );
    }

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return new Response(body, {
      ...init,
      headers,
    });
  }

  /**
   * Create a `Response` object from the supplied body.
   * @param {string} body The value that will be used as-is.
   * @param {ResponseInit} [init] Options such as `status` and `headers` that will be added to the response. A `Content-Length` header will be added automatically.
   */
  function text(body, init) {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-length")) {
      const encoded = text_encoder.encode(body);
      headers.set("content-length", encoded.byteLength.toString());
      return new Response(encoded, {
        ...init,
        headers,
      });
    }

    return new Response(body, {
      ...init,
      headers,
    });
  }

  // eslint-disable-next-line n/prefer-global/process
  const IN_WEBCONTAINER$1 = !!globalThis.process?.versions?.webcontainer;

  /** @import { RequestEvent } from '@sveltejs/kit' */
  /** @import { RequestStore } from 'types' */
  /** @import { AsyncLocalStorage } from 'node:async_hooks' */

  /** @type {RequestStore | null} */
  let sync_store = null;

  /** @type {AsyncLocalStorage<RequestStore | null> | null} */
  let als;

  import("node:async_hooks")
    .then((hooks) => (als = new hooks.AsyncLocalStorage()))
    .catch(() => {
      // can't use AsyncLocalStorage, but can still call getRequestEvent synchronously.
      // this isn't behind `supports` because it's basically just StackBlitz (i.e.
      // in-browser usage) that doesn't support it AFAICT
    });

  /**
   * @template T
   * @param {RequestStore | null} store
   * @param {() => T} fn
   */
  function with_request_store(store, fn) {
    try {
      sync_store = store;
      return als ? als.run(store, fn) : fn();
    } finally {
      // Since AsyncLocalStorage is not working in webcontainers, we don't reset `sync_store`
      // and handle only one request at a time in `src/runtime/server/index.js`.
      if (!IN_WEBCONTAINER$1) {
        sync_store = null;
      }
    }
  }

  /**
   * @template {{ tracing: { enabled: boolean, root: import('@opentelemetry/api').Span, current: import('@opentelemetry/api').Span } }} T
   * @param {T} event_like
   * @param {import('@opentelemetry/api').Span} current
   * @returns {T}
   */
  function merge_tracing(event_like, current) {
    return {
      ...event_like,
      tracing: {
        ...event_like.tracing,
        current,
      },
    };
  }

  var ENDPOINT_METHODS = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "HEAD",
  ];
  var PAGE_METHODS = ["GET", "POST", "HEAD"];
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/form-utils.js
  /** @import { RemoteForm } from '@sveltejs/kit' */
  /** @import { BinaryFormMeta, InternalRemoteFormIssue } from 'types' */
  /** @import { StandardSchemaV1 } from '@standard-schema/spec' */
  var decoder = new TextDecoder();
  /**
   * Sets a value in a nested object using a path string, mutating the original object
   * @param {Record<string, any>} object
   * @param {string} path_string
   * @param {any} value
   */
  function set_nested_value(object, path_string, value) {
    if (path_string.startsWith("n:")) {
      path_string = path_string.slice(2);
      value = value === "" ? void 0 : parseFloat(value);
    } else if (path_string.startsWith("b:")) {
      path_string = path_string.slice(2);
      value = value === "on";
    }
    deep_set(object, split_path(path_string), value);
  }
  /**
   * Convert `FormData` into a POJO
   * @param {FormData} data
   */
  function convert_formdata(data) {
    /** @type {Record<string, any>} */
    const result = {};
    for (let key of data.keys()) {
      const is_array = key.endsWith("[]");
      /** @type {any[]} */
      let values = data.getAll(key);
      if (is_array) key = key.slice(0, -2);
      if (values.length > 1 && !is_array)
        throw new Error(
          `Form cannot contain duplicated keys — "${key}" has ${values.length} values`,
        );
      values = values.filter(
        (entry) =>
          typeof entry === "string" || entry.name !== "" || entry.size > 0,
      );
      if (key.startsWith("n:")) {
        key = key.slice(2);
        values = values.map((v) => (v === "" ? void 0 : parseFloat(v)));
      } else if (key.startsWith("b:")) {
        key = key.slice(2);
        values = values.map((v) => v === "on");
      }
      set_nested_value(result, key, is_array ? values : values[0]);
    }
    return result;
  }
  var BINARY_FORM_CONTENT_TYPE = "application/x-sveltekit-formdata";
  var BINARY_FORM_VERSION = 0;
  var HEADER_BYTES = 7;
  /**
   * @param {Request} request
   * @returns {Promise<{ data: Record<string, any>; meta: BinaryFormMeta; form_data: FormData | null }>}
   */
  async function deserialize_binary_form(request) {
    if (
      request.headers.get("content-type") !== "application/x-sveltekit-formdata"
    ) {
      const form_data = await request.formData();
      return {
        data: convert_formdata(form_data),
        meta: {},
        form_data,
      };
    }
    if (!request.body) throw deserialize_error("no body");
    const content_length = parseInt(
      request.headers.get("content-length") ?? "",
    );
    if (Number.isNaN(content_length))
      throw deserialize_error("invalid Content-Length header");
    const reader = request.body.getReader();
    /** @type {Array<Promise<Uint8Array<ArrayBuffer> | undefined>>} */
    const chunks = [];
    /**
     * @param {number} index
     * @returns {Promise<Uint8Array<ArrayBuffer> | undefined>}
     */
    function get_chunk(index) {
      if (index in chunks) return chunks[index];
      let i = chunks.length;
      while (i <= index) {
        chunks[i] = reader.read().then((chunk) => chunk.value);
        i++;
      }
      return chunks[index];
    }
    /**
     * @param {number} offset
     * @param {number} length
     * @returns {Promise<Uint8Array | null>}
     */
    async function get_buffer(offset, length) {
      /** @type {Uint8Array} */
      let start_chunk;
      let chunk_start = 0;
      /** @type {number} */
      let chunk_index;
      for (chunk_index = 0; ; chunk_index++) {
        const chunk = await get_chunk(chunk_index);
        if (!chunk) return null;
        const chunk_end = chunk_start + chunk.byteLength;
        if (offset >= chunk_start && offset < chunk_end) {
          start_chunk = chunk;
          break;
        }
        chunk_start = chunk_end;
      }
      if (offset + length <= chunk_start + start_chunk.byteLength)
        return start_chunk.subarray(
          offset - chunk_start,
          offset + length - chunk_start,
        );
      const chunks = [start_chunk.subarray(offset - chunk_start)];
      let cursor = start_chunk.byteLength - offset + chunk_start;
      while (cursor < length) {
        chunk_index++;
        let chunk = await get_chunk(chunk_index);
        if (!chunk) return null;
        if (chunk.byteLength > length - cursor)
          chunk = chunk.subarray(0, length - cursor);
        chunks.push(chunk);
        cursor += chunk.byteLength;
      }
      const buffer = new Uint8Array(length);
      cursor = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      return buffer;
    }
    const header = await get_buffer(0, HEADER_BYTES);
    if (!header) throw deserialize_error("too short");
    if (header[0] !== BINARY_FORM_VERSION)
      throw deserialize_error(
        `got version ${header[0]}, expected version ${BINARY_FORM_VERSION}`,
      );
    const header_view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const data_length = header_view.getUint32(1, true);
    if (HEADER_BYTES + data_length > content_length)
      throw deserialize_error("data overflow");
    const file_offsets_length = header_view.getUint16(5, true);
    if (HEADER_BYTES + data_length + file_offsets_length > content_length)
      throw deserialize_error("file offset table overflow");
    const data_buffer = await get_buffer(HEADER_BYTES, data_length);
    if (!data_buffer) throw deserialize_error("data too short");
    /** @type {Array<number | undefined>} */
    let file_offsets;
    /** @type {number} */
    let files_start_offset;
    if (file_offsets_length > 0) {
      const file_offsets_buffer = await get_buffer(
        HEADER_BYTES + data_length,
        file_offsets_length,
      );
      if (!file_offsets_buffer)
        throw deserialize_error("file offset table too short");
      const parsed_offsets = JSON.parse(decoder.decode(file_offsets_buffer));
      if (
        !Array.isArray(parsed_offsets) ||
        parsed_offsets.some(
          (n) => typeof n !== "number" || !Number.isInteger(n) || n < 0,
        )
      )
        throw deserialize_error("invalid file offset table");
      file_offsets = parsed_offsets;
      files_start_offset = HEADER_BYTES + data_length + file_offsets_length;
    }
    /** @type {Array<{ offset: number, size: number }>} */
    const file_spans = [];
    const [data, meta] = parse(decoder.decode(data_buffer), {
      File: ([name, type, size, last_modified, index]) => {
        if (
          typeof name !== "string" ||
          typeof type !== "string" ||
          typeof size !== "number" ||
          typeof last_modified !== "number" ||
          typeof index !== "number"
        )
          throw deserialize_error("invalid file metadata");
        let offset = file_offsets[index];
        if (offset === void 0)
          throw deserialize_error("duplicate file offset table index");
        file_offsets[index] = void 0;
        offset += files_start_offset;
        if (offset + size > content_length)
          throw deserialize_error("file data overflow");
        file_spans.push({
          offset,
          size,
        });
        return new Proxy(
          new LazyFile(name, type, size, last_modified, get_chunk, offset),
          {
            getPrototypeOf() {
              return File.prototype;
            },
          },
        );
      },
    });
    file_spans.sort((a, b) => a.offset - b.offset || a.size - b.size);
    for (let i = 1; i < file_spans.length; i++) {
      const previous = file_spans[i - 1];
      const current = file_spans[i];
      const previous_end = previous.offset + previous.size;
      if (previous_end < current.offset)
        throw deserialize_error("gaps in file data");
      if (previous_end > current.offset)
        throw deserialize_error("overlapping file data");
    }
    (async () => {
      let has_more = true;
      while (has_more) has_more = !!(await get_chunk(chunks.length));
    })();
    return {
      data,
      meta,
      form_data: null,
    };
  }
  /**
   * @param {string} message
   */
  function deserialize_error(message) {
    return new SvelteKitError(
      400,
      "Bad Request",
      `Could not deserialize binary form: ${message}`,
    );
  }
  /** @implements {File} */
  var LazyFile = class LazyFile {
    /** @type {(index: number) => Promise<Uint8Array<ArrayBuffer> | undefined>} */
    #get_chunk;
    /** @type {number} */
    #offset;
    /**
     * @param {string} name
     * @param {string} type
     * @param {number} size
     * @param {number} last_modified
     * @param {(index: number) => Promise<Uint8Array<ArrayBuffer> | undefined>} get_chunk
     * @param {number} offset
     */
    constructor(name, type, size, last_modified, get_chunk, offset) {
      this.name = name;
      this.type = type;
      this.size = size;
      this.lastModified = last_modified;
      this.webkitRelativePath = "";
      this.#get_chunk = get_chunk;
      this.#offset = offset;
      this.arrayBuffer = this.arrayBuffer.bind(this);
      this.bytes = this.bytes.bind(this);
      this.slice = this.slice.bind(this);
      this.stream = this.stream.bind(this);
      this.text = this.text.bind(this);
    }
    /** @type {ArrayBuffer | undefined} */
    #buffer;
    async arrayBuffer() {
      this.#buffer ??= await new Response(this.stream()).arrayBuffer();
      return this.#buffer;
    }
    async bytes() {
      return new Uint8Array(await this.arrayBuffer());
    }
    /**
     * @param {number=} start
     * @param {number=} end
     * @param {string=} contentType
     */
    slice(start = 0, end = this.size, contentType = this.type) {
      if (start < 0) start = Math.max(this.size + start, 0);
      else start = Math.min(start, this.size);
      if (end < 0) end = Math.max(this.size + end, 0);
      else end = Math.min(end, this.size);
      const size = Math.max(end - start, 0);
      return new LazyFile(
        this.name,
        contentType,
        size,
        this.lastModified,
        this.#get_chunk,
        this.#offset + start,
      );
    }
    stream() {
      let cursor = 0;
      let chunk_index = 0;
      return new ReadableStream({
        start: async (controller) => {
          let chunk_start = 0;
          /** @type {Uint8Array} */
          let start_chunk;
          for (chunk_index = 0; ; chunk_index++) {
            const chunk = await this.#get_chunk(chunk_index);
            if (!chunk) return null;
            const chunk_end = chunk_start + chunk.byteLength;
            if (this.#offset >= chunk_start && this.#offset < chunk_end) {
              start_chunk = chunk;
              break;
            }
            chunk_start = chunk_end;
          }
          if (
            this.#offset + this.size <=
            chunk_start + start_chunk.byteLength
          ) {
            controller.enqueue(
              start_chunk.subarray(
                this.#offset - chunk_start,
                this.#offset + this.size - chunk_start,
              ),
            );
            controller.close();
          } else {
            controller.enqueue(
              start_chunk.subarray(this.#offset - chunk_start),
            );
            cursor = start_chunk.byteLength - this.#offset + chunk_start;
          }
        },
        pull: async (controller) => {
          chunk_index++;
          let chunk = await this.#get_chunk(chunk_index);
          if (!chunk) {
            controller.error("incomplete file data");
            controller.close();
            return;
          }
          if (chunk.byteLength > this.size - cursor)
            chunk = chunk.subarray(0, this.size - cursor);
          controller.enqueue(chunk);
          cursor += chunk.byteLength;
          if (cursor >= this.size) controller.close();
        },
      });
    }
    async text() {
      return decoder.decode(await this.arrayBuffer());
    }
  };
  var path_regex = /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*|\[\d+\])*$/;
  /**
   * @param {string} path
   */
  function split_path(path) {
    if (!path_regex.test(path)) throw new Error(`Invalid path ${path}`);
    return path.split(/\.|\[|\]/).filter(Boolean);
  }
  /**
   * Check if a property key is dangerous and could lead to prototype pollution
   * @param {string} key
   */
  function check_prototype_pollution(key) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      throw new Error(`Invalid key "${key}"`);
  }
  /**
   * Sets a value in a nested object using an array of keys, mutating the original object.
   * @param {Record<string, any>} object
   * @param {string[]} keys
   * @param {any} value
   */
  function deep_set(object, keys, value) {
    let current = object;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const key = keys[i];
      check_prototype_pollution(key);
      const is_array = /^\d+$/.test(keys[i + 1]);
      const inner = Object.hasOwn(current, key) ? current[key] : void 0;
      const exists = inner != null;
      if (exists && is_array !== Array.isArray(inner))
        throw new Error(`Invalid array key ${keys[i + 1]}`);
      if (!exists) current[key] = is_array ? [] : {};
      current = current[key];
    }
    const final_key = keys[keys.length - 1];
    check_prototype_pollution(final_key);
    current[final_key] = value;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/http.js
  /**
   * Given an Accept header and a list of possible content types, pick
   * the most suitable one to respond with
   * @param {string} accept
   * @param {string[]} types
   */
  function negotiate(accept, types) {
    /** @type {Array<{ type: string, subtype: string, q: number, i: number }>} */
    const parts = [];
    accept.split(",").forEach((str, i) => {
      const match = /([^/ \t]+)\/([^; \t]+)[ \t]*(?:;[ \t]*q=([0-9.]+))?/.exec(
        str,
      );
      if (match) {
        const [, type, subtype, q = "1"] = match;
        parts.push({
          type,
          subtype,
          q: +q,
          i,
        });
      }
    });
    parts.sort((a, b) => {
      if (a.q !== b.q) return b.q - a.q;
      if ((a.subtype === "*") !== (b.subtype === "*"))
        return a.subtype === "*" ? 1 : -1;
      if ((a.type === "*") !== (b.type === "*")) return a.type === "*" ? 1 : -1;
      return a.i - b.i;
    });
    let accepted;
    let min_priority = Infinity;
    for (const mimetype of types) {
      const [type, subtype] = mimetype.split("/");
      const priority = parts.findIndex(
        (part) =>
          (part.type === type || part.type === "*") &&
          (part.subtype === subtype || part.subtype === "*"),
      );
      if (priority !== -1 && priority < min_priority) {
        accepted = mimetype;
        min_priority = priority;
      }
    }
    return accepted;
  }
  /**
   * Returns `true` if the request contains a `content-type` header with the given type
   * @param {Request} request
   * @param  {...string} types
   */
  function is_content_type(request, ...types) {
    const type =
      request.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
    return types.includes(type.toLowerCase());
  }
  /**
   * @param {Request} request
   */
  function is_form_content_type(request) {
    return is_content_type(
      request,
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "text/plain",
      BINARY_FORM_CONTENT_TYPE,
    );
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/misc.js
  var s = JSON.stringify;
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/escape.js
  /**
   * When inside a double-quoted attribute value, only `&` and `"` hold special meaning.
   * @see https://html.spec.whatwg.org/multipage/parsing.html#attribute-value-(double-quoted)-state
   * @type {Record<string, string>}
   */
  var escape_html_attr_dict = {
    "&": "&amp;",
    '"': "&quot;",
  };
  /**
   * @type {Record<string, string>}
   */
  var escape_html_dict = {
    "&": "&amp;",
    "<": "&lt;",
  };
  var escape_html_attr_regex = new RegExp(
    `[${Object.keys(escape_html_attr_dict).join("")}]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|[\\ud800-\\udbff][\\udc00-\\udfff]|[\\udc00-\\udfff]`,
    "g",
  );
  var escape_html_regex = new RegExp(
    `[${Object.keys(escape_html_dict).join("")}]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|[\\ud800-\\udbff][\\udc00-\\udfff]|[\\udc00-\\udfff]`,
    "g",
  );
  /**
   * Escapes unpaired surrogates (which are allowed in js strings but invalid in HTML) and
   * escapes characters that are special.
   *
   * @param {string} str
   * @param {boolean} [is_attr]
   * @returns {string} escaped string
   * @example const html = `<tag data-value="${escape_html('value', true)}">...</tag>`;
   */
  function escape_html(str, is_attr) {
    const dict = is_attr ? escape_html_attr_dict : escape_html_dict;
    return str.replace(
      is_attr ? escape_html_attr_regex : escape_html_regex,
      (match) => {
        if (match.length === 2) return match;
        return dict[match] ?? `&#${match.charCodeAt(0)};`;
      },
    );
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/utils.js
  /**
   * @param {Partial<Record<import('types').HttpMethod, any>>} mod
   * @param {import('types').HttpMethod} method
   */
  function method_not_allowed(mod, method) {
    return text(`${method} method not allowed`, {
      status: 405,
      headers: { allow: allowed_methods(mod).join(", ") },
    });
  }
  /** @param {Partial<Record<import('types').HttpMethod, any>>} mod */
  function allowed_methods(mod) {
    const allowed = ENDPOINT_METHODS.filter((method) => method in mod);
    if ("GET" in mod && !("HEAD" in mod)) allowed.push("HEAD");
    return allowed;
  }
  /**
   * @param {import('types').SSROptions} options
   */
  function get_global_name(options) {
    return `__sveltekit_${options.version_hash}`;
  }
  /**
   * Return as a response that renders the error.html
   *
   * @param {import('types').SSROptions} options
   * @param {number} status
   * @param {string} message
   */
  function static_error_page(options, status, message) {
    return text(
      options.templates.error({
        status,
        message: escape_html(message),
      }),
      {
        headers: { "content-type": "text/html; charset=utf-8" },
        status,
      },
    );
  }
  /**
   * @param {import('@sveltejs/kit').RequestEvent} event
   * @param {import('types').RequestState} state
   * @param {import('types').SSROptions} options
   * @param {unknown} error
   */
  async function handle_fatal_error(event, state, options, error) {
    error = error instanceof HttpError ? error : coalesce_to_error(error);
    const status = get_status(error);
    const body = await handle_error_and_jsonify(event, state, options, error);
    const type = negotiate(event.request.headers.get("accept") || "text/html", [
      "application/json",
      "text/html",
    ]);
    if (event.isDataRequest || type === "application/json")
      return json(body, { status });
    return static_error_page(options, status, body.message);
  }
  /**
   * @param {import('@sveltejs/kit').RequestEvent} event
   * @param {import('types').RequestState} state
   * @param {import('types').SSROptions} options
   * @param {any} error
   * @returns {Promise<App.Error>}
   */
  async function handle_error_and_jsonify(event, state, options, error) {
    if (error instanceof HttpError)
      return {
        message: "Unknown Error",
        ...error.body,
      };
    const status = get_status(error);
    const message = get_message(error);
    return (
      (await with_request_store(
        {
          event,
          state,
        },
        () =>
          options.hooks.handleError({
            error,
            event,
            status,
            message,
          }),
      )) ?? { message }
    );
  }
  /**
   * @param {number} status
   * @param {string} location
   */
  function redirect_response(status, location) {
    return new Response(void 0, {
      status,
      headers: { location },
    });
  }
  /**
   * @param {import('@sveltejs/kit').RequestEvent} event
   * @param {Error & { path: string }} error
   */
  function clarify_devalue_error(event, error) {
    if (error.path)
      return `Data returned from \`load\` while rendering ${event.route.id} is not serializable: ${error.message} (${error.path}). If you need to serialize/deserialize custom types, use transport hooks: https://svelte.dev/docs/kit/hooks#Universal-hooks-transport.`;
    if (error.path === "")
      return `Data returned from \`load\` while rendering ${event.route.id} is not a plain object`;
    return error.message;
  }
  /**
   * @param {import('types').ServerDataNode} node
   */
  function serialize_uses(node) {
    const uses = {};
    if (node.uses && node.uses.dependencies.size > 0)
      uses.dependencies = Array.from(node.uses.dependencies);
    if (node.uses && node.uses.search_params.size > 0)
      uses.search_params = Array.from(node.uses.search_params);
    if (node.uses && node.uses.params.size > 0)
      uses.params = Array.from(node.uses.params);
    if (node.uses?.parent) uses.parent = 1;
    if (node.uses?.route) uses.route = 1;
    if (node.uses?.url) uses.url = 1;
    return uses;
  }
  /**
   * Returns `true` if the given path was prerendered
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @param {string} pathname Should include the base and be decoded
   */
  function has_prerendered_path(manifest, pathname) {
    return (
      manifest._.prerendered_routes.has(pathname) ||
      (pathname.at(-1) === "/" &&
        manifest._.prerendered_routes.has(pathname.slice(0, -1)))
    );
  }
  /**
   * Formats the error into a nice message with sanitized stack trace
   * @param {number} status
   * @param {Error} error
   * @param {import('@sveltejs/kit').RequestEvent} event
   */
  function format_server_error(status, error, event) {
    const formatted_text = `\n\x1b[1;31m[${status}] ${event.request.method} ${event.url.pathname}\x1b[0m`;
    if (status === 404) return formatted_text;
    return `${formatted_text}\n${error.stack}`;
  }
  /**
   * Returns the filename without the extension. e.g., `+page.server`, `+page`, etc.
   * @param {string | undefined} node_id
   * @returns {string}
   */
  function get_node_type(node_id) {
    const filename = node_id?.split("/")?.at(-1);
    if (!filename) return "unknown";
    return filename.split(".").slice(0, -1).join(".");
  }

  //#region node_modules/@sveltejs/kit/src/utils/array.js
  /**
   * Removes nullish values from an array.
   *
   * @template T
   * @param {Array<T>} arr
   */
  function compact(arr) {
    return arr.filter(
      /** @returns {val is NonNullable<T>} */
      (val) => val != null,
    );
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/pathname.js
  var DATA_SUFFIX = "/__data.json";
  var HTML_DATA_SUFFIX = ".html__data.json";
  /** @param {string} pathname */
  function has_data_suffix(pathname) {
    return (
      pathname.endsWith(DATA_SUFFIX) || pathname.endsWith(HTML_DATA_SUFFIX)
    );
  }
  /** @param {string} pathname */
  function add_data_suffix(pathname) {
    if (pathname.endsWith(".html"))
      return pathname.replace(/\.html$/, HTML_DATA_SUFFIX);
    return pathname.replace(/\/$/, "") + DATA_SUFFIX;
  }
  /** @param {string} pathname */
  function strip_data_suffix(pathname) {
    if (pathname.endsWith(HTML_DATA_SUFFIX))
      return pathname.slice(0, -16) + ".html";
    return pathname.slice(0, -12);
  }
  var ROUTE_SUFFIX = "/__route.js";
  /**
   * @param {string} pathname
   * @returns {boolean}
   */
  function has_resolution_suffix(pathname) {
    return pathname.endsWith(ROUTE_SUFFIX);
  }
  /**
   * Convert a regular URL to a route to send to SvelteKit's server-side route resolution endpoint
   * @param {string} pathname
   * @returns {string}
   */
  function add_resolution_suffix(pathname) {
    return pathname.replace(/\/$/, "") + ROUTE_SUFFIX;
  }
  /**
   * @param {string} pathname
   * @returns {string}
   */
  function strip_resolution_suffix(pathname) {
    return pathname.slice(0, -11);
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/telemetry/noop.js
  /**
   * @type {Span}
   */
  var noop_span = {
    spanContext() {
      return noop_span_context;
    },
    setAttribute() {
      return this;
    },
    setAttributes() {
      return this;
    },
    addEvent() {
      return this;
    },
    setStatus() {
      return this;
    },
    updateName() {
      return this;
    },
    end() {
      return this;
    },
    isRecording() {
      return false;
    },
    recordException() {
      return this;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
  };
  /**
   * @type {SpanContext}
   */
  var noop_span_context = {
    traceId: "",
    spanId: "",
    traceFlags: 0,
  };
  var internal = new URL("sveltekit-internal://");
  /**
   * @param {string} base
   * @param {string} path
   */
  function resolve(base, path) {
    if (path[0] === "/" && path[1] === "/") return path;
    let url = new URL(base, internal);
    url = new URL(path, url);
    return url.protocol === internal.protocol
      ? url.pathname + url.search + url.hash
      : url.href;
  }
  /**
   * @param {string} path
   * @param {import('types').TrailingSlash} trailing_slash
   */
  function normalize_path(path, trailing_slash) {
    if (path === "/" || trailing_slash === "ignore") return path;
    if (trailing_slash === "never")
      return path.endsWith("/") ? path.slice(0, -1) : path;
    else if (trailing_slash === "always" && !path.endsWith("/"))
      return path + "/";
    return path;
  }
  /**
   * Decode pathname excluding %25 to prevent further double decoding of params
   * @param {string} pathname
   */
  function decode_pathname(pathname) {
    return pathname.split("%25").map(decodeURI).join("%25");
  }
  /** @param {Record<string, string>} params */
  function decode_params(params) {
    for (const key in params) params[key] = decodeURIComponent(params[key]);
    return params;
  }
  /**
   * @param {URL} url
   * @param {() => void} callback
   * @param {(search_param: string) => void} search_params_callback
   * @param {boolean} [allow_hash]
   */
  function make_trackable(
    url,
    callback,
    search_params_callback,
    allow_hash = false,
  ) {
    const tracked = new URL(url);
    Object.defineProperty(tracked, "searchParams", {
      value: new Proxy(tracked.searchParams, {
        get(obj, key) {
          if (key === "get" || key === "getAll" || key === "has")
            return (param, ...rest) => {
              search_params_callback(param);
              return obj[key](param, ...rest);
            };
          callback();
          const value = Reflect.get(obj, key);
          return typeof value === "function" ? value.bind(obj) : value;
        },
      }),
      enumerable: true,
      configurable: true,
    });
    /**
     * URL properties that could change during the lifetime of the page,
     * which excludes things like `origin`
     */
    const tracked_url_properties = [
      "href",
      "pathname",
      "search",
      "toString",
      "toJSON",
    ];
    if (allow_hash) tracked_url_properties.push("hash");
    for (const property of tracked_url_properties)
      Object.defineProperty(tracked, property, {
        get() {
          callback();
          return url[property];
        },
        enumerable: true,
        configurable: true,
      });
    tracked[Symbol.for("nodejs.util.inspect.custom")] = (
      _depth,
      opts,
      inspect,
    ) => {
      return inspect(url, opts);
    };
    tracked.searchParams[Symbol.for("nodejs.util.inspect.custom")] = (
      _depth,
      opts,
      inspect,
    ) => {
      return inspect(url.searchParams, opts);
    };
    if (!allow_hash) disable_hash(tracked);
    return tracked;
  }
  /**
   * Disallow access to `url.hash` on the server and in `load`
   * @param {URL} url
   */
  function disable_hash(url) {
    allow_nodejs_console_log(url);
    Object.defineProperty(url, "hash", {
      get() {
        throw new Error(
          "Cannot access event.url.hash. Consider using `page.url.hash` inside a component instead",
        );
      },
    });
  }
  /**
   * Disallow access to `url.search` and `url.searchParams` during prerendering
   * @param {URL} url
   */
  function disable_search(url) {
    allow_nodejs_console_log(url);
    for (const property of ["search", "searchParams"])
      Object.defineProperty(url, property, {
        get() {
          throw new Error(
            `Cannot access url.${property} on a page with prerendering enabled`,
          );
        },
      });
  }
  /**
   * Allow URL to be console logged, bypassing disabled properties.
   * @param {URL} url
   */
  function allow_nodejs_console_log(url) {
    url[Symbol.for("nodejs.util.inspect.custom")] = (_depth, opts, inspect) => {
      return inspect(new URL(url), opts);
    };
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/hash.js
  /**
   * Hash using djb2
   * @param {import('types').StrictBody[]} values
   */
  function hash(...values) {
    let hash = 5381;
    for (const value of values)
      if (typeof value === "string") {
        let i = value.length;
        while (i) hash = (hash * 33) ^ value.charCodeAt(--i);
      } else if (ArrayBuffer.isView(value)) {
        const buffer = new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        let i = buffer.length;
        while (i) hash = (hash * 33) ^ buffer[--i];
      } else throw new TypeError("value must be a string or TypedArray");
    return (hash >>> 0).toString(36);
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/routing.js
  /**
   * @param {RegExpMatchArray} match
   * @param {import('types').RouteParam[]} params
   * @param {Record<string, import('@sveltejs/kit').ParamMatcher>} matchers
   */
  function exec(match, params, matchers) {
    /** @type {Record<string, string>} */
    const result = {};
    const values = match.slice(1);
    const values_needing_match = values.filter((value) => value !== void 0);
    let buffered = 0;
    for (let i = 0; i < params.length; i += 1) {
      const param = params[i];
      let value = values[i - buffered];
      if (param.chained && param.rest && buffered) {
        value = values
          .slice(i - buffered, i + 1)
          .filter((s) => s)
          .join("/");
        buffered = 0;
      }
      if (value === void 0)
        if (param.rest) value = "";
        else continue;
      if (!param.matcher || matchers[param.matcher](value)) {
        result[param.name] = value;
        const next_param = params[i + 1];
        const next_value = values[i + 1];
        if (
          next_param &&
          !next_param.rest &&
          next_param.optional &&
          next_value &&
          param.chained
        )
          buffered = 0;
        if (
          !next_param &&
          !next_value &&
          Object.keys(result).length === values_needing_match.length
        )
          buffered = 0;
        continue;
      }
      if (param.optional && param.chained) {
        buffered++;
        continue;
      }
      return;
    }
    if (buffered) return;
    return result;
  }
  /**
   * Find the first route that matches the given path
   * @template {{pattern: RegExp, params: import('types').RouteParam[]}} Route
   * @param {string} path - The decoded pathname to match
   * @param {Route[]} routes
   * @param {Record<string, import('@sveltejs/kit').ParamMatcher>} matchers
   * @returns {{ route: Route, params: Record<string, string> } | null}
   */
  function find_route(path, routes, matchers) {
    for (const route of routes) {
      const match = route.pattern.exec(path);
      if (!match) continue;
      const matched = exec(match, route.params, matchers);
      if (matched)
        return {
          route,
          params: decode_params(matched),
        };
    }
    return null;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/exports.js
  /**
   * @param {Set<string>} expected
   */
  function validator(expected) {
    /**
     * @param {any} module
     * @param {string} [file]
     */
    function validate(module, file) {
      if (!module) return;
      for (const key in module) {
        if (key[0] === "_" || expected.has(key)) continue;
        const values = [...expected.values()];
        const hint =
          hint_for_supported_files(key, file?.slice(file.lastIndexOf("."))) ??
          `valid exports are ${values.join(", ")}, or anything with a '_' prefix`;
        throw new Error(
          `Invalid export '${key}'${file ? ` in ${file}` : ""} (${hint})`,
        );
      }
    }
    return validate;
  }
  /**
   * @param {string} key
   * @param {string} ext
   * @returns {string | void}
   */
  function hint_for_supported_files(key, ext = ".js") {
    const supported_files = [];
    if (valid_layout_exports.has(key)) supported_files.push(`+layout${ext}`);
    if (valid_page_exports.has(key)) supported_files.push(`+page${ext}`);
    if (valid_layout_server_exports.has(key))
      supported_files.push(`+layout.server${ext}`);
    if (valid_page_server_exports.has(key))
      supported_files.push(`+page.server${ext}`);
    if (valid_server_exports.has(key)) supported_files.push(`+server${ext}`);
    if (supported_files.length > 0)
      return `'${key}' is a valid export in ${supported_files.slice(0, -1).join(", ")}${supported_files.length > 1 ? " or " : ""}${supported_files.at(-1)}`;
  }
  var valid_layout_exports = new Set([
    "load",
    "prerender",
    "csr",
    "ssr",
    "trailingSlash",
    "config",
  ]);
  var valid_page_exports = new Set([...valid_layout_exports, "entries"]);
  var valid_layout_server_exports = new Set([...valid_layout_exports]);
  var valid_page_server_exports = new Set([
    ...valid_layout_server_exports,
    "actions",
    "entries",
  ]);
  var valid_server_exports = new Set([
    "GET",
    "POST",
    "PATCH",
    "PUT",
    "DELETE",
    "OPTIONS",
    "HEAD",
    "fallback",
    "prerender",
    "trailingSlash",
    "config",
    "entries",
  ]);
  var validate_layout_exports = validator(valid_layout_exports);
  var validate_page_exports = validator(valid_page_exports);
  var validate_layout_server_exports = validator(valid_layout_server_exports);
  var validate_page_server_exports = validator(valid_page_server_exports);

  //#region \0virtual:__sveltekit/server
  var read_implementation = null;
  function set_read_implementation(fn) {
    read_implementation = fn;
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/dom/elements/events.js
  /**
   * Used on elements, as a map of event type -> event handler,
   * and on events themselves to track which element handled an event
   */
  var event_symbol = Symbol("events");
  /** @type {Set<string>} */
  var all_registered_events = /* @__PURE__ */ new Set();
  /** @type {Set<(events: Array<string>) => void>} */
  var root_event_handles = /* @__PURE__ */ new Set();
  var last_propagated_event = null;
  /**
   * @this {EventTarget}
   * @param {Event} event
   * @returns {void}
   */
  function handle_event_propagation(event) {
    var handler_element = this;
    var owner_document = handler_element.ownerDocument;
    var event_name = event.type;
    var path = event.composedPath?.() || [];
    var current_target = path[0] || event.target;
    last_propagated_event = event;
    var path_idx = 0;
    var handled_at = last_propagated_event === event && event[event_symbol];
    if (handled_at) {
      var at_idx = path.indexOf(handled_at);
      if (
        at_idx !== -1 &&
        (handler_element === document || handler_element === window)
      ) {
        event[event_symbol] = handler_element;
        return;
      }
      var handler_idx = path.indexOf(handler_element);
      if (handler_idx === -1) return;
      if (at_idx <= handler_idx) path_idx = at_idx;
    }
    current_target = path[path_idx] || event.target;
    if (current_target === handler_element) return;
    define_property(event, "currentTarget", {
      configurable: true,
      get() {
        return current_target || owner_document;
      },
    });
    var previous_reaction = active_reaction;
    var previous_effect = active_effect;
    set_active_reaction(null);
    set_active_effect(null);
    try {
      /**
       * @type {unknown}
       */
      var throw_error;
      /**
       * @type {unknown[]}
       */
      var other_errors = [];
      while (current_target !== null) {
        /** @type {null | Element} */
        var parent_element =
          current_target.assignedSlot ||
          current_target.parentNode ||
          current_target.host ||
          null;
        try {
          var delegated = current_target[event_symbol]?.[event_name];
          if (
            delegated != null &&
            (!current_target.disabled || event.target === current_target)
          )
            delegated.call(current_target, event);
        } catch (error) {
          if (throw_error) other_errors.push(error);
          else throw_error = error;
        }
        if (
          event.cancelBubble ||
          parent_element === handler_element ||
          parent_element === null
        )
          break;
        current_target = parent_element;
      }
      if (throw_error) {
        for (let error of other_errors)
          queueMicrotask(() => {
            throw error;
          });
        throw throw_error;
      }
    } finally {
      event[event_symbol] = handler_element;
      delete event.currentTarget;
      set_active_reaction(previous_reaction);
      set_active_effect(previous_effect);
    }
  }
  //#endregion
  //#region node_modules/svelte/src/internal/client/dom/template.js
  /**
   * @param {TemplateNode} start
   * @param {TemplateNode | null} end
   */
  function assign_nodes(start, end) {
    var effect = active_effect;
    if (effect.nodes === null)
      effect.nodes = {
        start,
        end,
        a: null,
        t: null,
      };
  }
  /**
   * Mounts a component to the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component.
   * Transitions will play during the initial render unless the `intro` option is set to `false`.
   *
   * @template {Record<string, any>} Props
   * @template {Record<string, any>} Exports
   * @param {ComponentType<SvelteComponent<Props>> | Component<Props, Exports, any>} component
   * @param {MountOptions<Props>} options
   * @returns {Exports}
   */
  function mount(component, options) {
    return _mount(component, options);
  }
  /**
   * Hydrates a component on the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component
   *
   * @template {Record<string, any>} Props
   * @template {Record<string, any>} Exports
   * @param {ComponentType<SvelteComponent<Props>> | Component<Props, Exports, any>} component
   * @param {{} extends Props ? {
   * 		target: Document | Element | ShadowRoot;
   * 		props?: Props;
   * 		events?: Record<string, (e: any) => any>;
   *  	context?: Map<any, any>;
   * 		intro?: boolean;
   * 		recover?: boolean;
   *		transformError?: (error: unknown) => unknown;
   * 	} : {
   * 		target: Document | Element | ShadowRoot;
   * 		props: Props;
   * 		events?: Record<string, (e: any) => any>;
   *  	context?: Map<any, any>;
   * 		intro?: boolean;
   * 		recover?: boolean;
   *		transformError?: (error: unknown) => unknown;
   * 	}} options
   * @returns {Exports}
   */
  function hydrate(component, options) {
    init_operations();
    options.intro = options.intro ?? false;
    const target = options.target;
    const was_hydrating = hydrating;
    const previous_hydrate_node = hydrate_node;
    try {
      var anchor = /* @__PURE__ */ get_first_child(target);
      while (anchor && (anchor.nodeType !== 8 || anchor.data !== "["))
        anchor = /* @__PURE__ */ get_next_sibling(anchor);
      if (!anchor) throw HYDRATION_ERROR;
      set_hydrating(true);
      set_hydrate_node(anchor);
      const instance = _mount(component, {
        ...options,
        anchor,
      });
      set_hydrating(false);
      return instance;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message
          .split("\n")
          .some((line) => line.startsWith("https://svelte.dev/e/"))
      )
        throw error;
      if (error !== HYDRATION_ERROR) console.warn("Failed to hydrate: ", error);
      if (options.recover === false) hydration_failed();
      init_operations();
      clear_text_content(target);
      set_hydrating(false);
      return mount(component, options);
    } finally {
      set_hydrating(was_hydrating);
      set_hydrate_node(previous_hydrate_node);
    }
  }
  /** @type {Map<EventTarget, Map<string, number>>} */
  var listeners = /* @__PURE__ */ new Map();
  /**
   * @template {Record<string, any>} Exports
   * @param {ComponentType<SvelteComponent<any>> | Component<any>} Component
   * @param {MountOptions} options
   * @returns {Exports}
   */
  function _mount(
    Component,
    {
      target,
      anchor,
      props = {},
      events,
      context,
      intro = true,
      transformError,
    },
  ) {
    init_operations();
    /** @type {Exports} */
    var component = void 0;
    var unmount = component_root(() => {
      var anchor_node = anchor ?? target.appendChild(create_text());
      boundary(
        anchor_node,
        { pending: () => {} },
        (anchor_node) => {
          push({});
          var ctx = component_context;
          if (context) ctx.c = context;
          if (events) /** @type {any} */ props.$$events = events;
          if (hydrating) assign_nodes(anchor_node, null);
          component = Component(anchor_node, props) || {};
          if (hydrating) {
            /** @type {Effect & { nodes: EffectNodes }} */ active_effect.nodes.end =
              hydrate_node;
            if (
              hydrate_node === null ||
              hydrate_node.nodeType !== 8 ||
              hydrate_node.data !== "]"
            ) {
              hydration_mismatch();
              throw HYDRATION_ERROR;
            }
          }
          pop();
        },
        transformError,
      );
      /** @type {Set<string>} */
      var registered_events = /* @__PURE__ */ new Set();
      /** @param {Array<string>} events */
      var event_handle = (events) => {
        for (var i = 0; i < events.length; i++) {
          var event_name = events[i];
          if (registered_events.has(event_name)) continue;
          registered_events.add(event_name);
          var passive = is_passive_event(event_name);
          for (const node of [target, document]) {
            var counts = listeners.get(node);
            if (counts === void 0) {
              counts = /* @__PURE__ */ new Map();
              listeners.set(node, counts);
            }
            var count = counts.get(event_name);
            if (count === void 0) {
              node.addEventListener(event_name, handle_event_propagation, {
                passive,
              });
              counts.set(event_name, 1);
            } else counts.set(event_name, count + 1);
          }
        }
      };
      event_handle(array_from(all_registered_events));
      root_event_handles.add(event_handle);
      return () => {
        for (var event_name of registered_events)
          for (const node of [target, document]) {
            var counts = listeners.get(node);
            var count = counts.get(event_name);
            if (--count == 0) {
              node.removeEventListener(event_name, handle_event_propagation);
              counts.delete(event_name);
              if (counts.size === 0) listeners.delete(node);
            } else counts.set(event_name, count);
          }
        root_event_handles.delete(event_handle);
        if (anchor_node !== anchor)
          anchor_node.parentNode?.removeChild(anchor_node);
      };
    });
    mounted_components.set(component, unmount);
    return component;
  }
  /**
   * References of the components that were mounted or hydrated.
   * Uses a `WeakMap` to avoid memory leaks.
   */
  var mounted_components = /* @__PURE__ */ new WeakMap();
  /**
   * Unmounts a component that was previously mounted using `mount` or `hydrate`.
   *
   * Since 5.13.0, if `options.outro` is `true`, [transitions](https://svelte.dev/docs/svelte/transition) will play before the component is removed from the DOM.
   *
   * Returns a `Promise` that resolves after transitions have completed if `options.outro` is true, or immediately otherwise (prior to 5.13.0, returns `void`).
   *
   * ```js
   * import { mount, unmount } from 'svelte';
   * import App from './App.svelte';
   *
   * const app = mount(App, { target: document.body });
   *
   * // later...
   * unmount(app, { outro: true });
   * ```
   * @param {Record<string, any>} component
   * @param {{ outro?: boolean }} [options]
   * @returns {Promise<void>}
   */
  function unmount(component, options) {
    const fn = mounted_components.get(component);
    if (fn) {
      mounted_components.delete(component);
      return fn(options);
    }
    return Promise.resolve();
  }
  //#endregion
  //#region node_modules/svelte/src/legacy/legacy-client.js
  /** @import { ComponentConstructorOptions, ComponentType, SvelteComponent, Component } from 'svelte' */
  /**
   * Takes the component function and returns a Svelte 4 compatible component constructor.
   *
   * @deprecated Use this only as a temporary solution to migrate your imperative component code to Svelte 5.
   *
   * @template {Record<string, any>} Props
   * @template {Record<string, any>} Exports
   * @template {Record<string, any>} Events
   * @template {Record<string, any>} Slots
   *
   * @param {SvelteComponent<Props, Events, Slots> | Component<Props>} component
   * @returns {ComponentType<SvelteComponent<Props, Events, Slots> & Exports>}
   */
  function asClassComponent$1(component) {
    return class extends Svelte4Component {
      /** @param {any} options */
      constructor(options) {
        super({
          component,
          ...options,
        });
      }
    };
  }
  /**
   * Support using the component as both a class and function during the transition period
   * @typedef  {{new (o: ComponentConstructorOptions): SvelteComponent;(...args: Parameters<Component<Record<string, any>>>): ReturnType<Component<Record<string, any>, Record<string, any>>>;}} LegacyComponentType
   */
  var Svelte4Component = class {
    /** @type {any} */
    #events;
    /** @type {Record<string, any>} */
    #instance;
    /**
     * @param {ComponentConstructorOptions & {
     *  component: any;
     * }} options
     */
    constructor(options) {
      var sources = /* @__PURE__ */ new Map();
      /**
       * @param {string | symbol} key
       * @param {unknown} value
       */
      var add_source = (key, value) => {
        var s = /* @__PURE__ */ mutable_source(value, false, false);
        sources.set(key, s);
        return s;
      };
      const props = new Proxy(
        {
          ...(options.props || {}),
          $$events: {},
        },
        {
          get(target, prop) {
            return get(
              sources.get(prop) ?? add_source(prop, Reflect.get(target, prop)),
            );
          },
          has(target, prop) {
            if (prop === LEGACY_PROPS) return true;
            get(
              sources.get(prop) ?? add_source(prop, Reflect.get(target, prop)),
            );
            return Reflect.has(target, prop);
          },
          set(target, prop, value) {
            set(sources.get(prop) ?? add_source(prop, value), value);
            return Reflect.set(target, prop, value);
          },
        },
      );
      this.#instance = (options.hydrate ? hydrate : mount)(options.component, {
        target: options.target,
        anchor: options.anchor,
        props,
        context: options.context,
        intro: options.intro ?? false,
        recover: options.recover,
        transformError: options.transformError,
      });
      if (!options?.props?.$$host || options.sync === false) flushSync();
      this.#events = props.$$events;
      for (const key of Object.keys(this.#instance)) {
        if (key === "$set" || key === "$destroy" || key === "$on") continue;
        define_property(this, key, {
          get() {
            return this.#instance[key];
          },
          /** @param {any} value */
          set(value) {
            this.#instance[key] = value;
          },
          enumerable: true,
        });
      }
      this.#instance.$set = (next) => {
        Object.assign(props, next);
      };
      this.#instance.$destroy = () => {
        unmount(this.#instance);
      };
    }
    /** @param {Record<string, any>} props */
    $set(props) {
      this.#instance.$set(props);
    }
    /**
     * @param {string} event
     * @param {(...args: any[]) => any} callback
     * @returns {any}
     */
    $on(event, callback) {
      this.#events[event] = this.#events[event] || [];
      /** @param {any[]} args */
      const cb = (...args) => callback.call(this, ...args);
      this.#events[event].push(cb);
      return () => {
        this.#events[event] = this.#events[event].filter(
          /** @param {any} fn */
          (fn) => fn !== cb,
        );
      };
    }
    $destroy() {
      this.#instance.$destroy();
    }
  };
  //#endregion
  //#region node_modules/svelte/src/legacy/legacy-server.js
  /** @import { SvelteComponent } from '../index.js' */
  /** @import { Csp } from '#server' */
  /** @typedef {{ head: string, html: string, css: { code: string, map: null }; hashes?: { script: `sha256-${string}`[] } }} LegacyRenderResult */
  /**
   * Takes a Svelte 5 component and returns a Svelte 4 compatible component constructor.
   *
   * @deprecated Use this only as a temporary solution to migrate your imperative component code to Svelte 5.
   *
   * @template {Record<string, any>} Props
   * @template {Record<string, any>} Exports
   * @template {Record<string, any>} Events
   * @template {Record<string, any>} Slots
   *
   * @param {SvelteComponent<Props, Events, Slots>} component
   * @returns {typeof SvelteComponent<Props, Events, Slots> & Exports}
   */
  function asClassComponent(component) {
    const component_constructor = asClassComponent$1(component);
    /** @type {(props?: {}, opts?: { $$slots?: {}; context?: Map<any, any>; csp?: Csp; transformError?: (error: unknown) => unknown }) => LegacyRenderResult & PromiseLike<LegacyRenderResult> } */
    const _render = (props, { context, csp, transformError } = {}) => {
      const result = render(component, {
        props,
        context,
        csp,
        transformError,
      });
      const munged = Object.defineProperties(
        {},
        {
          css: {
            value: {
              code: "",
              map: null,
            },
          },
          head: { get: () => result.head },
          html: { get: () => result.body },
          then: {
            /**
             * this is not type-safe, but honestly it's the best I can do right now, and it's a straightforward function.
             *
             * @template TResult1
             * @template [TResult2=never]
             * @param { (value: LegacyRenderResult) => TResult1 } onfulfilled
             * @param { (reason: unknown) => TResult2 } onrejected
             */
            value: (onfulfilled, onrejected) => {
              {
                const user_result = onfulfilled({
                  css: munged.css,
                  head: munged.head,
                  html: munged.html,
                });
                return Promise.resolve(user_result);
              }
            },
          },
        },
      );
      return munged;
    };
    component_constructor.render = _render;
    return component_constructor;
  }
  //#endregion
  //#region .svelte-kit/generated/root.svelte
  function Root($$renderer, $$props) {
    $$renderer.component(($$renderer) => {
      let {
        stores,
        page,
        constructors,
        components = [],
        form,
        data_0 = null,
        data_1 = null,
      } = $$props;
      setContext("__svelte__", stores);
      stores.page.set(page);
      const Pyramid_1 = derived(() => constructors[1]);
      if (constructors[1]) {
        $$renderer.push("<!--[0-->");
        const Pyramid_0 = constructors[0];
        if (Pyramid_0) {
          $$renderer.push("<!--[-->");
          Pyramid_0($$renderer, {
            data: data_0,
            form,
            params: page.params,
            children: ($$renderer) => {
              if (Pyramid_1()) {
                $$renderer.push("<!--[-->");
                Pyramid_1()($$renderer, {
                  data: data_1,
                  form,
                  params: page.params,
                });
                $$renderer.push("<!--]-->");
              } else {
                $$renderer.push("<!--[!-->");
                $$renderer.push("<!--]-->");
              }
            },
            $$slots: { default: true },
          });
          $$renderer.push("<!--]-->");
        } else {
          $$renderer.push("<!--[!-->");
          $$renderer.push("<!--]-->");
        }
      } else {
        $$renderer.push("<!--[-1-->");
        const Pyramid_0 = constructors[0];
        if (Pyramid_0) {
          $$renderer.push("<!--[-->");
          Pyramid_0($$renderer, {
            data: data_0,
            form,
            params: page.params,
          });
          $$renderer.push("<!--]-->");
        } else {
          $$renderer.push("<!--[!-->");
          $$renderer.push("<!--]-->");
        }
      }
      $$renderer.push(`<!--]--> `);
      $$renderer.push("<!--[-1-->");
      $$renderer.push(`<!--]-->`);
    });
  }
  //#endregion
  //#region .svelte-kit/generated/server/internal.js
  var options = {
    app_template_contains_nonce: false,
    async: false,
    csp: {
      mode: "auto",
      directives: {
        "upgrade-insecure-requests": false,
        "block-all-mixed-content": false,
      },
      reportOnly: {
        "upgrade-insecure-requests": false,
        "block-all-mixed-content": false,
      },
    },
    csrf_check_origin: true,
    csrf_trusted_origins: [],
    embedded: false,
    env_public_prefix: "PUBLIC_",
    env_private_prefix: "",
    hash_routing: false,
    hooks: null,
    preload_strategy: "modulepreload",
    root: asClassComponent(Root),
    service_worker: false,
    service_worker_options: void 0,
    server_error_boundaries: false,
    templates: {
      app: ({ head, body, assets, nonce, env }) =>
        '<!doctype html>\n<html lang="en">\n	<head>\n		<meta charset="utf-8" />\n		<meta name="viewport" content="width=device-width, initial-scale=1" />\n		<meta name="text-scale" content="scale" />\n		' +
        head +
        '\n	</head>\n	<body data-sveltekit-preload-data="hover">\n		<div style="display: contents">' +
        body +
        "</div>\n	</body>\n</html>\n",
      error: ({ status, message }) =>
        '<!doctype html>\n<html lang="en">\n	<head>\n		<meta charset="utf-8" />\n		<title>' +
        message +
        "</title>\n\n		<style>\n			body {\n				--bg: white;\n				--fg: #222;\n				--divider: #ccc;\n				background: var(--bg);\n				color: var(--fg);\n				font-family:\n					system-ui,\n					-apple-system,\n					BlinkMacSystemFont,\n					'Segoe UI',\n					Roboto,\n					Oxygen,\n					Ubuntu,\n					Cantarell,\n					'Open Sans',\n					'Helvetica Neue',\n					sans-serif;\n				display: flex;\n				align-items: center;\n				justify-content: center;\n				height: 100vh;\n				margin: 0;\n			}\n\n			.error {\n				display: flex;\n				align-items: center;\n				max-width: 32rem;\n				margin: 0 1rem;\n			}\n\n			.status {\n				font-weight: 200;\n				font-size: 3rem;\n				line-height: 1;\n				position: relative;\n				top: -0.05rem;\n			}\n\n			.message {\n				border-left: 1px solid var(--divider);\n				padding: 0 0 0 1rem;\n				margin: 0 0 0 1rem;\n				min-height: 2.5rem;\n				display: flex;\n				align-items: center;\n			}\n\n			.message h1 {\n				font-weight: 400;\n				font-size: 1em;\n				margin: 0;\n			}\n\n			@media (prefers-color-scheme: dark) {\n				body {\n					--bg: #222;\n					--fg: #ddd;\n					--divider: #666;\n				}\n			}\n		</style>\n	</head>\n	<body>\n		<div class=\"error\">\n			<span class=\"status\">" +
        status +
        '</span>\n			<div class="message">\n				<h1>' +
        message +
        "</h1>\n			</div>\n		</div>\n	</body>\n</html>\n",
    },
    version_hash: "cquf5p",
  };
  async function get_hooks() {
    let handle;
    let handleFetch;
    let handleError;
    let handleValidationError;
    let init;
    let reroute;
    let transport;
    return {
      handle,
      handleFetch,
      handleError,
      handleValidationError,
      init,
      reroute,
      transport,
    };
  }

  var cookie = {};

  /*!
   * cookie
   * Copyright(c) 2012-2014 Roman Shtylman
   * Copyright(c) 2015 Douglas Christopher Wilson
   * MIT Licensed
   */

  var hasRequiredCookie;

  function requireCookie() {
    if (hasRequiredCookie) return cookie;
    hasRequiredCookie = 1;

    /**
     * Module exports.
     * @public
     */

    cookie.parse = parse;
    cookie.serialize = serialize;

    /**
     * Module variables.
     * @private
     */

    var __toString = Object.prototype.toString;

    /**
     * RegExp to match field-content in RFC 7230 sec 3.2
     *
     * field-content = field-vchar [ 1*( SP / HTAB ) field-vchar ]
     * field-vchar   = VCHAR / obs-text
     * obs-text      = %x80-FF
     */

    var fieldContentRegExp = /^[\u0009\u0020-\u007e\u0080-\u00ff]+$/;

    /**
     * Parse a cookie header.
     *
     * Parse the given cookie header string into an object
     * The object has the various cookies as keys(names) => values
     *
     * @param {string} str
     * @param {object} [options]
     * @return {object}
     * @public
     */

    function parse(str, options) {
      if (typeof str !== "string") {
        throw new TypeError("argument str must be a string");
      }

      var obj = {};
      var opt = options || {};
      var dec = opt.decode || decode;

      var index = 0;
      while (index < str.length) {
        var eqIdx = str.indexOf("=", index);

        // no more cookie pairs
        if (eqIdx === -1) {
          break;
        }

        var endIdx = str.indexOf(";", index);

        if (endIdx === -1) {
          endIdx = str.length;
        } else if (endIdx < eqIdx) {
          // backtrack on prior semicolon
          index = str.lastIndexOf(";", eqIdx - 1) + 1;
          continue;
        }

        var key = str.slice(index, eqIdx).trim();

        // only assign once
        if (undefined === obj[key]) {
          var val = str.slice(eqIdx + 1, endIdx).trim();

          // quoted values
          if (val.charCodeAt(0) === 0x22) {
            val = val.slice(1, -1);
          }

          obj[key] = tryDecode(val, dec);
        }

        index = endIdx + 1;
      }

      return obj;
    }

    /**
     * Serialize data into a cookie header.
     *
     * Serialize the a name value pair into a cookie string suitable for
     * http headers. An optional options object specified cookie parameters.
     *
     * serialize('foo', 'bar', { httpOnly: true })
     *   => "foo=bar; httpOnly"
     *
     * @param {string} name
     * @param {string} val
     * @param {object} [options]
     * @return {string}
     * @public
     */

    function serialize(name, val, options) {
      var opt = options || {};
      var enc = opt.encode || encode;

      if (typeof enc !== "function") {
        throw new TypeError("option encode is invalid");
      }

      if (!fieldContentRegExp.test(name)) {
        throw new TypeError("argument name is invalid");
      }

      var value = enc(val);

      if (value && !fieldContentRegExp.test(value)) {
        throw new TypeError("argument val is invalid");
      }

      var str = name + "=" + value;

      if (null != opt.maxAge) {
        var maxAge = opt.maxAge - 0;

        if (isNaN(maxAge) || !isFinite(maxAge)) {
          throw new TypeError("option maxAge is invalid");
        }

        str += "; Max-Age=" + Math.floor(maxAge);
      }

      if (opt.domain) {
        if (!fieldContentRegExp.test(opt.domain)) {
          throw new TypeError("option domain is invalid");
        }

        str += "; Domain=" + opt.domain;
      }

      if (opt.path) {
        if (!fieldContentRegExp.test(opt.path)) {
          throw new TypeError("option path is invalid");
        }

        str += "; Path=" + opt.path;
      }

      if (opt.expires) {
        var expires = opt.expires;

        if (!isDate(expires) || isNaN(expires.valueOf())) {
          throw new TypeError("option expires is invalid");
        }

        str += "; Expires=" + expires.toUTCString();
      }

      if (opt.httpOnly) {
        str += "; HttpOnly";
      }

      if (opt.secure) {
        str += "; Secure";
      }

      if (opt.partitioned) {
        str += "; Partitioned";
      }

      if (opt.priority) {
        var priority =
          typeof opt.priority === "string"
            ? opt.priority.toLowerCase()
            : opt.priority;

        switch (priority) {
          case "low":
            str += "; Priority=Low";
            break;
          case "medium":
            str += "; Priority=Medium";
            break;
          case "high":
            str += "; Priority=High";
            break;
          default:
            throw new TypeError("option priority is invalid");
        }
      }

      if (opt.sameSite) {
        var sameSite =
          typeof opt.sameSite === "string"
            ? opt.sameSite.toLowerCase()
            : opt.sameSite;

        switch (sameSite) {
          case true:
            str += "; SameSite=Strict";
            break;
          case "lax":
            str += "; SameSite=Lax";
            break;
          case "strict":
            str += "; SameSite=Strict";
            break;
          case "none":
            str += "; SameSite=None";
            break;
          default:
            throw new TypeError("option sameSite is invalid");
        }
      }

      return str;
    }

    /**
     * URL-decode string value. Optimized to skip native call when no %.
     *
     * @param {string} str
     * @returns {string}
     */

    function decode(str) {
      return str.indexOf("%") !== -1 ? decodeURIComponent(str) : str;
    }

    /**
     * URL-encode value.
     *
     * @param {string} val
     * @returns {string}
     */

    function encode(val) {
      return encodeURIComponent(val);
    }

    /**
     * Determine if value is a Date.
     *
     * @param {*} val
     * @private
     */

    function isDate(val) {
      return __toString.call(val) === "[object Date]" || val instanceof Date;
    }

    /**
     * Try decoding a string using a decoding function.
     *
     * @param {string} str
     * @param {function} decode
     * @private
     */

    function tryDecode(str, decode) {
      try {
        return decode(str);
      } catch (e) {
        return str;
      }
    }
    return cookie;
  }

  var cookieExports = requireCookie();

  var defaultParseOptions = {
    decodeValues: true,
    map: false,
    silent: false,
    split: "auto", // auto = split strings but not arrays
  };

  function isForbiddenKey(key) {
    return typeof key !== "string" || key in {};
  }

  function createNullObj() {
    return Object.create(null);
  }

  function isNonEmptyString(str) {
    return typeof str === "string" && !!str.trim();
  }

  function parseString(setCookieValue, options) {
    var parts = setCookieValue.split(";").filter(isNonEmptyString);

    var nameValuePairStr = parts.shift();
    var parsed = parseNameValuePair(nameValuePairStr);
    var name = parsed.name;
    var value = parsed.value;

    options = options
      ? Object.assign({}, defaultParseOptions, options)
      : defaultParseOptions;

    if (isForbiddenKey(name)) {
      return null;
    }

    try {
      value = options.decodeValues ? decodeURIComponent(value) : value; // decode cookie value
    } catch (e) {
      console.error(
        "set-cookie-parser: failed to decode cookie value. Set options.decodeValues=false to disable decoding.",
        e,
      );
    }

    var cookie = createNullObj();
    cookie.name = name;
    cookie.value = value;

    parts.forEach(function (part) {
      var sides = part.split("=");
      var key = sides.shift().trimLeft().toLowerCase();
      if (isForbiddenKey(key)) {
        return;
      }
      var value = sides.join("=");
      if (key === "expires") {
        cookie.expires = new Date(value);
      } else if (key === "max-age") {
        var n = parseInt(value, 10);
        if (!Number.isNaN(n)) cookie.maxAge = n;
      } else if (key === "secure") {
        cookie.secure = true;
      } else if (key === "httponly") {
        cookie.httpOnly = true;
      } else if (key === "samesite") {
        cookie.sameSite = value;
      } else if (key === "partitioned") {
        cookie.partitioned = true;
      } else if (key) {
        cookie[key] = value;
      }
    });

    return cookie;
  }

  function parseNameValuePair(nameValuePairStr) {
    // Parses name-value-pair according to rfc6265bis draft

    var name = "";
    var value = "";
    var nameValueArr = nameValuePairStr.split("=");
    if (nameValueArr.length > 1) {
      name = nameValueArr.shift();
      value = nameValueArr.join("="); // everything after the first =, joined by a "=" if there was more than one part
    } else {
      value = nameValuePairStr;
    }

    return { name: name, value: value };
  }

  function parseSetCookie(input, options) {
    options = options
      ? Object.assign({}, defaultParseOptions, options)
      : defaultParseOptions;

    if (!input) {
      if (!options.map) {
        return [];
      } else {
        return createNullObj();
      }
    }

    if (input.headers) {
      if (typeof input.headers.getSetCookie === "function") {
        // for fetch responses - they combine headers of the same type in the headers array,
        // but getSetCookie returns an uncombined array
        input = input.headers.getSetCookie();
      } else if (input.headers["set-cookie"]) {
        // fast-path for node.js (which automatically normalizes header names to lower-case)
        input = input.headers["set-cookie"];
      } else {
        // slow-path for other environments - see #25
        var sch =
          input.headers[
            Object.keys(input.headers).find(function (key) {
              return key.toLowerCase() === "set-cookie";
            })
          ];
        // warn if called on a request-like object with a cookie header rather than a set-cookie header - see #34, 36
        if (!sch && input.headers.cookie && !options.silent) {
          console.warn(
            "Warning: set-cookie-parser appears to have been called on a request object. It is designed to parse Set-Cookie headers from responses, not Cookie headers from requests. Set the option {silent: true} to suppress this warning.",
          );
        }
        input = sch;
      }
    }

    var split = options.split;
    var isArray = Array.isArray(input);

    if (split === "auto") {
      split = !isArray;
    }

    if (!isArray) {
      input = [input];
    }

    input = input.filter(isNonEmptyString);

    if (split) {
      input = input.map(splitCookiesString).flat();
    }

    if (!options.map) {
      return input
        .map(function (str) {
          return parseString(str, options);
        })
        .filter(Boolean);
    } else {
      var cookies = createNullObj();
      return input.reduce(function (cookies, str) {
        var cookie = parseString(str, options);
        if (cookie && !isForbiddenKey(cookie.name)) {
          cookies[cookie.name] = cookie;
        }
        return cookies;
      }, cookies);
    }
  }

  /*
	  Set-Cookie header field-values are sometimes comma joined in one string. This splits them without choking on commas
	  that are within a single set-cookie field-value, such as in the Expires portion.

	  This is uncommon, but explicitly allowed - see https://tools.ietf.org/html/rfc2616#section-4.2
	  Node.js does this for every header *except* set-cookie - see https://github.com/nodejs/node/blob/d5e363b77ebaf1caf67cd7528224b651c86815c1/lib/_http_incoming.js#L128
	  React Native's fetch does this for *every* header, including set-cookie.

	  Based on: https://github.com/google/j2objc/commit/16820fdbc8f76ca0c33472810ce0cb03d20efe25
	  Credits to: https://github.com/tomball for original and https://github.com/chrusart for JavaScript implementation
	*/
  function splitCookiesString(cookiesString) {
    if (Array.isArray(cookiesString)) {
      return cookiesString;
    }
    if (typeof cookiesString !== "string") {
      return [];
    }

    var cookiesStrings = [];
    var pos = 0;
    var start;
    var ch;
    var lastComma;
    var nextStart;
    var cookiesSeparatorFound;

    function skipWhitespace() {
      while (
        pos < cookiesString.length &&
        /\s/.test(cookiesString.charAt(pos))
      ) {
        pos += 1;
      }
      return pos < cookiesString.length;
    }

    function notSpecialChar() {
      ch = cookiesString.charAt(pos);

      return ch !== "=" && ch !== ";" && ch !== ",";
    }

    while (pos < cookiesString.length) {
      start = pos;
      cookiesSeparatorFound = false;

      while (skipWhitespace()) {
        ch = cookiesString.charAt(pos);
        if (ch === ",") {
          // ',' is a cookie separator if we have later first '=', not ';' or ','
          lastComma = pos;
          pos += 1;

          skipWhitespace();
          nextStart = pos;

          while (pos < cookiesString.length && notSpecialChar()) {
            pos += 1;
          }

          // currently special character
          if (pos < cookiesString.length && cookiesString.charAt(pos) === "=") {
            // we found cookies separator
            cookiesSeparatorFound = true;
            // pos is inside the next cookie, so back up and return it.
            pos = nextStart;
            cookiesStrings.push(cookiesString.substring(start, lastComma));
            start = pos;
          } else {
            // in param ',' or param separator ';',
            // we continue from that comma
            pos = lastComma + 1;
          }
        } else {
          pos += 1;
        }
      }

      if (!cookiesSeparatorFound || pos >= cookiesString.length) {
        cookiesStrings.push(
          cookiesString.substring(start, cookiesString.length),
        );
      }
    }

    return cookiesStrings;
  }

  // named export for CJS
  parseSetCookie.parseSetCookie = parseSetCookie;
  // for backwards compatibility
  parseSetCookie.parse = parseSetCookie;
  parseSetCookie.parseString = parseString;
  parseSetCookie.splitCookiesString = splitCookiesString;

  //#region node_modules/@sveltejs/kit/src/utils/promise.js
  /** @see https://github.com/microsoft/TypeScript/blob/904e7dd97dc8da1352c8e05d70829dff17c73214/src/lib/es2024.promise.d.ts */
  /**
   * @template T
   * @typedef {{
   *   promise: Promise<T>;
   *   resolve: (value: T | PromiseLike<T>) => void;
   *   reject: (reason?: any) => void;
   * }} PromiseWithResolvers<T>
   */
  /**
   * TODO: Whenever Node >21 is minimum supported version, we can use `Promise.withResolvers` to avoid this ceremony
   *
   * @template T
   * @returns {PromiseWithResolvers<T>}
   */
  function with_resolvers() {
    let resolve;
    let reject;
    return {
      promise: new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
      resolve,
      reject,
    };
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/constants.js
  var NULL_BODY_STATUS = [101, 103, 204, 205, 304];
  var IN_WEBCONTAINER = !!globalThis.process?.versions?.webcontainer;
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/endpoint.js
  /**
   * @param {import('@sveltejs/kit').RequestEvent} event
   * @param {import('types').RequestState} event_state
   * @param {import('types').SSREndpoint} mod
   * @param {import('types').SSRState} state
   * @returns {Promise<Response>}
   */
  async function render_endpoint(event, event_state, mod, state) {
    const method = event.request.method;
    let handler = mod[method] || mod.fallback;
    if (method === "HEAD" && !mod.HEAD && mod.GET) handler = mod.GET;
    if (!handler) return method_not_allowed(mod, method);
    const prerender = mod.prerender ?? state.prerender_default;
    if (prerender && (mod.POST || mod.PATCH || mod.PUT || mod.DELETE))
      throw new Error("Cannot prerender endpoints that have mutative methods");
    if (state.prerendering && !state.prerendering.inside_reroute && !prerender)
      if (state.depth > 0)
        throw new Error(`${event.route.id} is not prerenderable`);
      else return new Response(void 0, { status: 204 });
    try {
      const response = await with_request_store(
        {
          event,
          state: event_state,
        },
        () => handler(event),
      );
      if (!(response instanceof Response))
        throw new Error(
          `Invalid response from route ${event.url.pathname}: handler should return a Response object`,
        );
      if (
        state.prerendering &&
        (!state.prerendering.inside_reroute || prerender)
      ) {
        const cloned = new Response(response.clone().body, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        });
        cloned.headers.set("x-sveltekit-prerender", String(prerender));
        if (state.prerendering.inside_reroute && prerender) {
          cloned.headers.set("x-sveltekit-routeid", encodeURI(event.route.id));
          state.prerendering.dependencies.set(event.url.pathname, {
            response: cloned,
            body: null,
          });
        } else return cloned;
      }
      return response;
    } catch (e) {
      if (e instanceof Redirect)
        return new Response(void 0, {
          status: e.status,
          headers: { location: e.location },
        });
      throw e;
    }
  }
  /**
   * @param {import('@sveltejs/kit').RequestEvent} event
   */
  function is_endpoint_request(event) {
    const { method, headers } = event.request;
    if (ENDPOINT_METHODS.includes(method) && !PAGE_METHODS.includes(method))
      return true;
    if (method === "POST" && headers.get("x-sveltekit-action") === "true")
      return false;
    return (
      negotiate(event.request.headers.get("accept") ?? "*/*", [
        "*",
        "text/html",
      ]) !== "text/html"
    );
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/telemetry/record_span.js
  /** @import { RecordSpan } from 'types' */
  /** @type {RecordSpan} */
  async function record_span({ name, attributes, fn }) {
    return fn(noop_span);
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/actions.js
  /** @import { RequestEvent, ActionResult, Actions } from '@sveltejs/kit' */
  /** @import { SSROptions, SSRNode, ServerNode, ServerHooks } from 'types' */
  /** @param {RequestEvent} event */
  function is_action_json_request(event) {
    return (
      negotiate(event.request.headers.get("accept") ?? "*/*", [
        "application/json",
        "text/html",
      ]) === "application/json" && event.request.method === "POST"
    );
  }
  /**
   * @param {RequestEvent} event
   * @param {import('types').RequestState} event_state
   * @param {SSROptions} options
   * @param {SSRNode['server'] | undefined} server
   */
  async function handle_action_json_request(
    event,
    event_state,
    options,
    server,
  ) {
    const actions = server?.actions;
    if (!actions) {
      const no_actions_error = new SvelteKitError(
        405,
        "Method Not Allowed",
        `POST method not allowed. No form actions exist for this page`,
      );
      return action_json(
        {
          type: "error",
          error: await handle_error_and_jsonify(
            event,
            event_state,
            options,
            no_actions_error,
          ),
        },
        {
          status: no_actions_error.status,
          headers: { allow: "GET" },
        },
      );
    }
    check_named_default_separate(actions);
    try {
      const data = await call_action(event, event_state, actions);
      if (data instanceof ActionFailure)
        return action_json({
          type: "failure",
          status: data.status,
          data: stringify_action_response(
            data.data,
            event.route.id,
            options.hooks.transport,
          ),
        });
      else
        return action_json({
          type: "success",
          status: data ? 200 : 204,
          data: stringify_action_response(
            data,
            event.route.id,
            options.hooks.transport,
          ),
        });
    } catch (e) {
      const err = normalize_error(e);
      if (err instanceof Redirect) return action_json_redirect(err);
      return action_json(
        {
          type: "error",
          error: await handle_error_and_jsonify(
            event,
            event_state,
            options,
            check_incorrect_fail_use(err),
          ),
        },
        { status: get_status(err) },
      );
    }
  }
  /**
   * @param {HttpError | Error} error
   */
  function check_incorrect_fail_use(error) {
    return error instanceof ActionFailure
      ? /* @__PURE__ */ new Error('Cannot "throw fail()". Use "return fail()"')
      : error;
  }
  /**
   * @param {Redirect} redirect
   */
  function action_json_redirect(redirect) {
    return action_json({
      type: "redirect",
      status: redirect.status,
      location: redirect.location,
    });
  }
  /**
   * @param {ActionResult} data
   * @param {ResponseInit} [init]
   */
  function action_json(data, init) {
    return json(data, init);
  }
  /**
   * @param {RequestEvent} event
   */
  function is_action_request(event) {
    return event.request.method === "POST";
  }
  /**
   * @param {RequestEvent} event
   * @param {import('types').RequestState} event_state
   * @param {SSRNode['server'] | undefined} server
   * @returns {Promise<ActionResult>}
   */
  async function handle_action_request(event, event_state, server) {
    const actions = server?.actions;
    if (!actions) {
      event.setHeaders({ allow: "GET" });
      return {
        type: "error",
        error: new SvelteKitError(
          405,
          "Method Not Allowed",
          `POST method not allowed. No form actions exist for this page`,
        ),
      };
    }
    check_named_default_separate(actions);
    try {
      const data = await call_action(event, event_state, actions);
      if (data instanceof ActionFailure)
        return {
          type: "failure",
          status: data.status,
          data: data.data,
        };
      else
        return {
          type: "success",
          status: 200,
          data,
        };
    } catch (e) {
      const err = normalize_error(e);
      if (err instanceof Redirect)
        return {
          type: "redirect",
          status: err.status,
          location: err.location,
        };
      return {
        type: "error",
        error: check_incorrect_fail_use(err),
      };
    }
  }
  /**
   * @param {Actions} actions
   */
  function check_named_default_separate(actions) {
    if (actions.default && Object.keys(actions).length > 1)
      throw new Error(
        "When using named actions, the default action cannot be used. See the docs for more info: https://svelte.dev/docs/kit/form-actions#named-actions",
      );
  }
  /**
   * @param {RequestEvent} event
   * @param {import('types').RequestState} event_state
   * @param {NonNullable<ServerNode['actions']>} actions
   * @throws {Redirect | HttpError | SvelteKitError | Error}
   */
  async function call_action(event, event_state, actions) {
    const url = new URL(event.request.url);
    let name = "default";
    for (const param of url.searchParams)
      if (param[0].startsWith("/")) {
        name = param[0].slice(1);
        if (name === "default")
          throw new Error('Cannot use reserved action name "default"');
        break;
      }
    const action = actions[name];
    if (!action)
      throw new SvelteKitError(
        404,
        "Not Found",
        `No action with name '${name}' found`,
      );
    if (!is_form_content_type(event.request))
      throw new SvelteKitError(
        415,
        "Unsupported Media Type",
        `Form actions expect form-encoded data — received ${event.request.headers.get("content-type")}`,
      );
    return record_span({
      name: "sveltekit.form_action",
      attributes: {
        "http.route": event.route.id || "unknown",
      },
      fn: async (current) => {
        const traced_event = merge_tracing(event, current);
        const result = await with_request_store(
          {
            event: traced_event,
            state: event_state,
          },
          () => action(traced_event),
        );
        if (result instanceof ActionFailure)
          current.setAttributes({
            "sveltekit.form_action.result.type": "failure",
            "sveltekit.form_action.result.status": result.status,
          });
        return result;
      },
    });
  }
  /**
   * Try to `devalue.uneval` the data object, and if it fails, return a proper Error with context
   * @param {any} data
   * @param {string} route_id
   * @param {ServerHooks['transport']} transport
   */
  function uneval_action_response(data, route_id, transport) {
    const replacer = (thing) => {
      for (const key in transport) {
        const encoded = transport[key].encode(thing);
        if (encoded)
          return `app.decode('${key}', ${uneval(encoded, replacer)})`;
      }
    };
    return try_serialize(data, (value) => uneval(value, replacer), route_id);
  }
  /**
   * Try to `devalue.stringify` the data object, and if it fails, return a proper Error with context
   * @param {any} data
   * @param {string} route_id
   * @param {ServerHooks['transport']} transport
   */
  function stringify_action_response(data, route_id, transport) {
    const encoders = Object.fromEntries(
      Object.entries(transport).map(([key, value]) => [key, value.encode]),
    );
    return try_serialize(
      data,
      (value) => stringify$1(value, encoders),
      route_id,
    );
  }
  /**
   * @param {any} data
   * @param {(data: any) => string} fn
   * @param {string} route_id
   */
  function try_serialize(data, fn, route_id) {
    try {
      return fn(data);
    } catch (e) {
      const error = e;
      if (data instanceof Response)
        throw new Error(
          `Data returned from action inside ${route_id} is not serializable. Form actions need to return plain objects or fail(). E.g. return { success: true } or return fail(400, { message: "invalid" });`,
          { cause: e },
        );
      if ("path" in error) {
        let message = `Data returned from action inside ${route_id} is not serializable: ${error.message}`;
        if (error.path !== "") message += ` (data.${error.path})`;
        throw new Error(message, { cause: e });
      }
      throw error;
    }
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/streaming.js
  /**
   * Create an async iterator and a function to push values into it
   * @template T
   * @returns {{
   *   iterate: (transform?: (input: T) => T) => AsyncIterable<T>;
   *   add: (promise: Promise<T>) => void;
   * }}
   */
  function create_async_iterator() {
    let resolved = -1;
    let returned = -1;
    /** @type {import('./promise.js').PromiseWithResolvers<T>[]} */
    const deferred = [];
    return {
      iterate: (transform = (x) => x) => {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                const next = deferred[++returned];
                if (!next)
                  return {
                    value: null,
                    done: true,
                  };
                return {
                  value: transform(await next.promise),
                  done: false,
                };
              },
            };
          },
        };
      },
      add: (promise) => {
        deferred.push(with_resolvers());
        promise.then((value) => {
          deferred[++resolved].resolve(value);
        });
      },
    };
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/data_serializer.js
  /**
   * If the serialized data contains promises, `chunks` will be an
   * async iterable containing their resolutions
   * @param {import('@sveltejs/kit').RequestEvent} event
   * @param {import('types').RequestState} event_state
   * @param {import('types').SSROptions} options
   * @returns {import('./types.js').ServerDataSerializer}
   */
  function server_data_serializer(event, event_state, options) {
    let promise_id = 1;
    let max_nodes = -1;
    const iterator = create_async_iterator();
    const global = get_global_name(options);
    /** @param {number} index */
    function get_replacer(index) {
      /** @param {any} thing */
      return function replacer(thing) {
        if (typeof thing?.then === "function") {
          const id = promise_id++;
          const promise = thing
            .then(
              /** @param {any} data */
              (data) => ({ data }),
            )
            .catch(
              /** @param {any} error */
              async (error) => ({
                error: await handle_error_and_jsonify(
                  event,
                  event_state,
                  options,
                  error,
                ),
              }),
            )
            .then(
              /**
               * @param {{data: any; error: any}} result
               */
              async ({ data, error }) => {
                let str;
                try {
                  str = uneval(error ? [, error] : [data], replacer);
                } catch {
                  error = await handle_error_and_jsonify(
                    event,
                    event_state,
                    options,
                    /* @__PURE__ */ new Error(
                      `Failed to serialize promise while rendering ${event.route.id}`,
                    ),
                  );
                  str = uneval([, error], replacer);
                }
                return {
                  index,
                  str: `${global}.resolve(${id}, ${str.includes("app.decode") ? `(app) => ${str}` : `() => ${str}`})`,
                };
              },
            );
          iterator.add(promise);
          return `${global}.defer(${id})`;
        } else
          for (const key in options.hooks.transport) {
            const encoded = options.hooks.transport[key].encode(thing);
            if (encoded)
              return `app.decode('${key}', ${uneval(encoded, replacer)})`;
          }
      };
    }
    const strings = [];
    return {
      set_max_nodes(i) {
        max_nodes = i;
      },
      add_node(i, node) {
        try {
          if (!node) {
            strings[i] = "null";
            return;
          }
          /** @type {any} */
          const payload = {
            type: "data",
            data: node.data,
            uses: serialize_uses(node),
          };
          if (node.slash) payload.slash = node.slash;
          strings[i] = uneval(payload, get_replacer(i));
        } catch (e) {
          e.path = e.path.slice(1);
          throw new Error(clarify_devalue_error(event, e), { cause: e });
        }
      },
      get_data(csp) {
        const open = `<script${csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ""}>`;
        const close = `<\/script>\n`;
        return {
          data: `[${compact(max_nodes > -1 ? strings.slice(0, max_nodes) : strings).join(",")}]`,
          chunks:
            promise_id > 1
              ? iterator.iterate(({ index, str }) => {
                  if (max_nodes > -1 && index >= max_nodes) return "";
                  return open + str + close;
                })
              : null,
        };
      },
    };
  }
  /**
   * If the serialized data contains promises, `chunks` will be an
   * async iterable containing their resolutions
   * @param {import('@sveltejs/kit').RequestEvent} event
   * @param {import('types').RequestState} event_state
   * @param {import('types').SSROptions} options
   * @returns {import('./types.js').ServerDataSerializerJson}
   */
  function server_data_serializer_json(event, event_state, options) {
    let promise_id = 1;
    const iterator = create_async_iterator();
    const reducers = {
      ...Object.fromEntries(
        Object.entries(options.hooks.transport).map(([key, value]) => [
          key,
          value.encode,
        ]),
      ),
      /** @param {any} thing */
      Promise: (thing) => {
        if (typeof thing?.then !== "function") return;
        const id = promise_id++;
        /** @type {'data' | 'error'} */
        let key = "data";
        const promise = thing
          .catch(
            /** @param {any} e */
            async (e) => {
              key = "error";
              return handle_error_and_jsonify(event, event_state, options, e);
            },
          )
          .then(
            /** @param {any} value */
            async (value) => {
              let str;
              try {
                str = stringify$1(value, reducers);
              } catch {
                const error = await handle_error_and_jsonify(
                  event,
                  event_state,
                  options,
                  /* @__PURE__ */ new Error(
                    `Failed to serialize promise while rendering ${event.route.id}`,
                  ),
                );
                key = "error";
                str = stringify$1(error, reducers);
              }
              return `{"type":"chunk","id":${id},"${key}":${str}}\n`;
            },
          );
        iterator.add(promise);
        return id;
      },
    };
    const strings = [];
    return {
      add_node(i, node) {
        try {
          if (!node) {
            strings[i] = "null";
            return;
          }
          if (node.type === "error" || node.type === "skip") {
            strings[i] = JSON.stringify(node);
            return;
          }
          strings[i] =
            `{"type":"data","data":${stringify$1(node.data, reducers)},"uses":${JSON.stringify(serialize_uses(node))}${node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ""}}`;
        } catch (e) {
          e.path = "data" + e.path;
          throw new Error(clarify_devalue_error(event, e), { cause: e });
        }
      },
      get_data() {
        return {
          data: `{"type":"data","nodes":[${strings.join(",")}]}\n`,
          chunks: promise_id > 1 ? iterator.iterate() : null,
        };
      },
    };
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/load_data.js
  /**
   * Calls the user's server `load` function.
   * @param {{
   *   event: import('@sveltejs/kit').RequestEvent;
   *   event_state: import('types').RequestState;
   *   state: import('types').SSRState;
   *   node: import('types').SSRNode | undefined;
   *   parent: () => Promise<Record<string, any>>;
   * }} opts
   * @returns {Promise<import('types').ServerDataNode | null>}
   */
  async function load_server_data({ event, event_state, state, node, parent }) {
    if (!node?.server) return null;
    let is_tracking = true;
    const uses = {
      dependencies: /* @__PURE__ */ new Set(),
      params: /* @__PURE__ */ new Set(),
      parent: false,
      route: false,
      url: false,
      search_params: /* @__PURE__ */ new Set(),
    };
    const load = node.server.load;
    const slash = node.server.trailingSlash;
    if (!load)
      return {
        type: "data",
        data: null,
        uses,
        slash,
      };
    const url = make_trackable(
      event.url,
      () => {
        if (is_tracking) uses.url = true;
      },
      (param) => {
        if (is_tracking) uses.search_params.add(param);
      },
    );
    if (state.prerendering) disable_search(url);
    return {
      type: "data",
      data:
        (await record_span({
          name: "sveltekit.load",
          attributes: {
            "sveltekit.load.node_id": node.server_id || "unknown",
            "sveltekit.load.node_type": get_node_type(node.server_id),
            "http.route": event.route.id || "unknown",
          },
          fn: async (current) => {
            const traced_event = merge_tracing(event, current);
            return await with_request_store(
              {
                event: traced_event,
                state: event_state,
              },
              () =>
                load.call(null, {
                  ...traced_event,
                  fetch: (info, init) => {
                    new URL(
                      info instanceof Request ? info.url : info,
                      event.url,
                    );
                    return event.fetch(info, init);
                  },
                  /** @param {string[]} deps */
                  depends: (...deps) => {
                    for (const dep of deps) {
                      const { href } = new URL(dep, event.url);
                      uses.dependencies.add(href);
                    }
                  },
                  params: new Proxy(event.params, {
                    get: (target, key) => {
                      if (is_tracking) uses.params.add(key);
                      return target[key];
                    },
                  }),
                  parent: async () => {
                    if (is_tracking) uses.parent = true;
                    return parent();
                  },
                  route: new Proxy(event.route, {
                    get: (target, key) => {
                      if (is_tracking) uses.route = true;
                      return target[key];
                    },
                  }),
                  url,
                  untrack(fn) {
                    is_tracking = false;
                    try {
                      return fn();
                    } finally {
                      is_tracking = true;
                    }
                  },
                }),
            );
          },
        })) ?? null,
      uses,
      slash,
    };
  }
  /**
   * Calls the user's `load` function.
   * @param {{
   *   event: import('@sveltejs/kit').RequestEvent;
   *   event_state: import('types').RequestState;
   *   fetched: import('./types.js').Fetched[];
   *   node: import('types').SSRNode | undefined;
   *   parent: () => Promise<Record<string, any>>;
   *   resolve_opts: import('types').RequiredResolveOptions;
   *   server_data_promise: Promise<import('types').ServerDataNode | null>;
   *   state: import('types').SSRState;
   *   csr: boolean;
   * }} opts
   * @returns {Promise<Record<string, any | Promise<any>> | null>}
   */
  async function load_data({
    event,
    event_state,
    fetched,
    node,
    parent,
    server_data_promise,
    state,
    resolve_opts,
    csr,
  }) {
    const server_data_node = await server_data_promise;
    const load = node?.universal?.load;
    if (!load) return server_data_node?.data ?? null;
    return (
      (await record_span({
        name: "sveltekit.load",
        attributes: {
          "sveltekit.load.node_id": node.universal_id || "unknown",
          "sveltekit.load.node_type": get_node_type(node.universal_id),
          "http.route": event.route.id || "unknown",
        },
        fn: async (current) => {
          const traced_event = merge_tracing(event, current);
          return await with_request_store(
            {
              event: traced_event,
              state: {
                ...event_state,
                is_in_universal_load: true,
              },
            },
            () =>
              load.call(null, {
                url: event.url,
                params: event.params,
                data: server_data_node?.data ?? null,
                route: event.route,
                fetch: create_universal_fetch(
                  event,
                  state,
                  fetched,
                  csr,
                  resolve_opts,
                ),
                setHeaders: event.setHeaders,
                depends: noop,
                parent,
                untrack: (fn) => fn(),
                tracing: traced_event.tracing,
              }),
          );
        },
      })) ?? null
    );
  }
  /**
   * @param {Pick<import('@sveltejs/kit').RequestEvent, 'fetch' | 'url' | 'request' | 'route'>} event
   * @param {import('types').SSRState} state
   * @param {import('./types.js').Fetched[]} fetched
   * @param {boolean} csr
   * @param {Pick<Required<import('@sveltejs/kit').ResolveOptions>, 'filterSerializedResponseHeaders'>} resolve_opts
   * @returns {typeof fetch}
   */
  function create_universal_fetch(event, state, fetched, csr, resolve_opts) {
    /**
     * @param {URL | RequestInfo} input
     * @param {RequestInit} [init]
     */
    const universal_fetch = async (input, init) => {
      const cloned_body =
        input instanceof Request && input.body ? input.clone().body : null;
      const cloned_headers =
        input instanceof Request && [...input.headers].length
          ? new Headers(input.headers)
          : init?.headers;
      let response = await event.fetch(input, init);
      const url = new URL(
        input instanceof Request ? input.url : input,
        event.url,
      );
      const same_origin = url.origin === event.url.origin;
      /** @type {import('types').PrerenderDependency} */
      let dependency;
      if (same_origin) {
        if (state.prerendering) {
          dependency = {
            response,
            body: null,
          };
          state.prerendering.dependencies.set(url.pathname, dependency);
        }
      } else if (url.protocol === "https:" || url.protocol === "http:")
        if (
          (input instanceof Request ? input.mode : (init?.mode ?? "cors")) ===
          "no-cors"
        )
          response = new Response("", {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        else {
          const acao = response.headers.get("access-control-allow-origin");
          if (!acao || (acao !== event.url.origin && acao !== "*"))
            throw new Error(
              `CORS error: ${acao ? "Incorrect" : "No"} 'Access-Control-Allow-Origin' header is present on the requested resource`,
            );
        }
      /** @type {ReadableStream<Uint8Array>} */
      let teed_body;
      const proxy = new Proxy(response, {
        get(response, key, receiver) {
          /**
           * @param {string | undefined} body
           * @param {boolean} is_b64
           */
          async function push_fetched(body, is_b64) {
            const status_number = Number(response.status);
            if (isNaN(status_number))
              throw new Error(
                `response.status is not a number. value: "${response.status}" type: ${typeof response.status}`,
              );
            fetched.push({
              url: same_origin
                ? url.href.slice(event.url.origin.length)
                : url.href,
              method: event.request.method,
              request_body:
                input instanceof Request && cloned_body
                  ? await stream_to_string(cloned_body)
                  : init?.body,
              request_headers: cloned_headers,
              response_body: body,
              response,
              is_b64,
            });
          }
          if (key === "body") {
            if (response.body === null) return null;
            if (teed_body) return teed_body;
            const [a, b] = response.body.tee();
            (async () => {
              let result = new Uint8Array();
              for await (const chunk of a) {
                const combined = new Uint8Array(result.length + chunk.length);
                combined.set(result, 0);
                combined.set(chunk, result.length);
                result = combined;
              }
              if (dependency) dependency.body = new Uint8Array(result);
              push_fetched(base64_encode(result), true);
            })();
            return (teed_body = b);
          }
          if (key === "arrayBuffer")
            return async () => {
              const buffer = await response.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              if (dependency) dependency.body = bytes;
              if (buffer instanceof ArrayBuffer)
                await push_fetched(base64_encode(bytes), true);
              return buffer;
            };
          async function text() {
            const body = await response.text();
            if (body === "" && NULL_BODY_STATUS.includes(response.status)) {
              await push_fetched(void 0, false);
              return;
            }
            if (!body || typeof body === "string")
              await push_fetched(body, false);
            if (dependency) dependency.body = body;
            return body;
          }
          if (key === "text") return text;
          if (key === "json")
            return async () => {
              const body = await text();
              return body ? JSON.parse(body) : void 0;
            };
          const value = Reflect.get(response, key, response);
          if (value instanceof Function)
            return Object.defineProperties(
              /**
               * @this {any}
               */
              function () {
                return Reflect.apply(
                  value,
                  this === receiver ? response : this,
                  arguments,
                );
              },
              {
                name: { value: value.name },
                length: { value: value.length },
              },
            );
          return value;
        },
      });
      if (csr) {
        const get = response.headers.get;
        response.headers.get = (key) => {
          const lower = key.toLowerCase();
          const value = get.call(response.headers, lower);
          if (value && !lower.startsWith("x-sveltekit-")) {
            if (!resolve_opts.filterSerializedResponseHeaders(lower, value))
              throw new Error(
                `Failed to get response header "${lower}" — it must be included by the \`filterSerializedResponseHeaders\` option: https://svelte.dev/docs/kit/hooks#Server-hooks-handle (at ${event.route.id})`,
              );
          }
          return value;
        };
      }
      return proxy;
    };
    return (input, init) => {
      const response = universal_fetch(input, init);
      response.catch(noop);
      return response;
    };
  }
  /**
   * @param {ReadableStream<Uint8Array>} stream
   */
  async function stream_to_string(stream) {
    let result = "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        result += decoder.decode();
        break;
      }
      result += decoder.decode(value, { stream: true });
    }
    return result;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/serialize_data.js
  /**
   * Inside a script element, only `<\/script` and `<!--` hold special meaning to the HTML parser.
   *
   * The first closes the script element, so everything after is treated as raw HTML.
   * The second disables further parsing until `-->`, so the script element might be unexpectedly
   * kept open up until an unrelated HTML comment in the page.
   *
   * U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are escaped for the sake of pre-2018
   * browsers.
   *
   * @see tests for unsafe parsing examples.
   * @see https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
   * @see https://html.spec.whatwg.org/multipage/syntax.html#cdata-rcdata-restrictions
   * @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-state
   * @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-double-escaped-state
   * @see https://github.com/tc39/proposal-json-superset
   * @type {Record<string, string>}
   */
  var replacements = {
    "<": "\\u003C",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };
  var pattern = new RegExp(`[${Object.keys(replacements).join("")}]`, "g");
  /**
   * Generates a raw HTML string containing a safe script element carrying data and associated attributes.
   *
   * It escapes all the special characters needed to guarantee the element is unbroken, but care must
   * be taken to ensure it is inserted in the document at an acceptable position for a script element,
   * and that the resulting string isn't further modified.
   *
   * @param {import('./types.js').Fetched} fetched
   * @param {(name: string, value: string) => boolean} filter
   * @param {boolean} [prerendering]
   * @returns {string} The raw HTML of a script element carrying the JSON payload.
   * @example const html = serialize_data('/data.json', null, { foo: 'bar' });
   */
  function serialize_data(fetched, filter, prerendering = false) {
    /** @type {Record<string, string>} */
    const headers = {};
    let cache_control = null;
    let age = null;
    let varyAny = false;
    for (const [key, value] of fetched.response.headers) {
      if (filter(key, value)) headers[key] = value;
      if (key === "cache-control") cache_control = value;
      else if (key === "age") age = value;
      else if (key === "vary" && value.trim() === "*") varyAny = true;
    }
    const payload = {
      status: fetched.response.status,
      statusText: fetched.response.statusText,
      headers,
      body: fetched.response_body,
    };
    const safe_payload = JSON.stringify(payload).replace(
      pattern,
      (match) => replacements[match],
    );
    const attrs = [
      'type="application/json"',
      "data-sveltekit-fetched",
      `data-url="${escape_html(fetched.url, true)}"`,
    ];
    if (fetched.is_b64) attrs.push("data-b64");
    if (fetched.request_headers || fetched.request_body) {
      /** @type {import('types').StrictBody[]} */
      const values = [];
      if (fetched.request_headers)
        values.push([...new Headers(fetched.request_headers)].join(","));
      if (fetched.request_body) values.push(fetched.request_body);
      attrs.push(`data-hash="${hash(...values)}"`);
    }
    if (
      !prerendering &&
      fetched.method === "GET" &&
      cache_control &&
      !varyAny
    ) {
      const match =
        /s-maxage=(\d+)/g.exec(cache_control) ??
        /max-age=(\d+)/g.exec(cache_control);
      if (match) {
        const ttl = +match[1] - +(age ?? "0");
        attrs.push(`data-ttl="${ttl}"`);
      }
    }
    return `<script ${attrs.join(" ")}>${safe_payload}<\/script>`;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/crypto.js
  /**
   * SHA-256 hashing function adapted from https://bitwiseshiftleft.github.io/sjcl
   * modified and redistributed under BSD license
   * @param {string} data
   */
  function sha256(data) {
    if (!key[0]) precompute();
    const out = init.slice(0);
    const array = encode(data);
    for (let i = 0; i < array.length; i += 16) {
      const w = array.subarray(i, i + 16);
      let tmp;
      let a;
      let b;
      let out0 = out[0];
      let out1 = out[1];
      let out2 = out[2];
      let out3 = out[3];
      let out4 = out[4];
      let out5 = out[5];
      let out6 = out[6];
      let out7 = out[7];
      for (let i = 0; i < 64; i++) {
        if (i < 16) tmp = w[i];
        else {
          a = w[(i + 1) & 15];
          b = w[(i + 14) & 15];
          tmp = w[i & 15] =
            (((a >>> 7) ^ (a >>> 18) ^ (a >>> 3) ^ (a << 25) ^ (a << 14)) +
              ((b >>> 17) ^ (b >>> 19) ^ (b >>> 10) ^ (b << 15) ^ (b << 13)) +
              w[i & 15] +
              w[(i + 9) & 15]) |
            0;
        }
        tmp =
          tmp +
          out7 +
          ((out4 >>> 6) ^
            (out4 >>> 11) ^
            (out4 >>> 25) ^
            (out4 << 26) ^
            (out4 << 21) ^
            (out4 << 7)) +
          (out6 ^ (out4 & (out5 ^ out6))) +
          key[i];
        out7 = out6;
        out6 = out5;
        out5 = out4;
        out4 = (out3 + tmp) | 0;
        out3 = out2;
        out2 = out1;
        out1 = out0;
        out0 =
          (tmp +
            ((out1 & out2) ^ (out3 & (out1 ^ out2))) +
            ((out1 >>> 2) ^
              (out1 >>> 13) ^
              (out1 >>> 22) ^
              (out1 << 30) ^
              (out1 << 19) ^
              (out1 << 10))) |
          0;
      }
      out[0] = (out[0] + out0) | 0;
      out[1] = (out[1] + out1) | 0;
      out[2] = (out[2] + out2) | 0;
      out[3] = (out[3] + out3) | 0;
      out[4] = (out[4] + out4) | 0;
      out[5] = (out[5] + out5) | 0;
      out[6] = (out[6] + out6) | 0;
      out[7] = (out[7] + out7) | 0;
    }
    const bytes = new Uint8Array(out.buffer);
    reverse_endianness(bytes);
    return btoa(String.fromCharCode(...bytes));
  }
  /** The SHA-256 initialization vector */
  var init = new Uint32Array(8);
  /** The SHA-256 hash key */
  var key = new Uint32Array(64);
  /** Function to precompute init and key. */
  function precompute() {
    /** @param {number} x */
    function frac(x) {
      return (x - Math.floor(x)) * 4294967296;
    }
    let prime = 2;
    for (let i = 0; i < 64; prime++) {
      let is_prime = true;
      for (let factor = 2; factor * factor <= prime; factor++)
        if (prime % factor === 0) {
          is_prime = false;
          break;
        }
      if (is_prime) {
        if (i < 8) init[i] = frac(prime ** (1 / 2));
        key[i] = frac(prime ** (1 / 3));
        i++;
      }
    }
  }
  /** @param {Uint8Array} bytes */
  function reverse_endianness(bytes) {
    for (let i = 0; i < bytes.length; i += 4) {
      const a = bytes[i + 0];
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      const d = bytes[i + 3];
      bytes[i + 0] = d;
      bytes[i + 1] = c;
      bytes[i + 2] = b;
      bytes[i + 3] = a;
    }
  }
  /** @param {string} str */
  function encode(str) {
    const encoded = text_encoder$1.encode(str);
    const length = encoded.length * 8;
    const size = 512 * Math.ceil((length + 65) / 512);
    const bytes = new Uint8Array(size / 8);
    bytes.set(encoded);
    bytes[encoded.length] = 128;
    reverse_endianness(bytes);
    const words = new Uint32Array(bytes.buffer);
    words[words.length - 2] = Math.floor(length / 4294967296);
    words[words.length - 1] = length;
    return words;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/csp.js
  var array = new Uint8Array(16);
  function generate_nonce() {
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array));
  }
  var quoted = new Set([
    "self",
    "unsafe-eval",
    "unsafe-hashes",
    "unsafe-inline",
    "none",
    "strict-dynamic",
    "report-sample",
    "wasm-unsafe-eval",
    "script",
  ]);
  var crypto_pattern = /^(nonce|sha\d\d\d)-/;
  var BaseProvider = class {
    /** @type {boolean} */
    #use_hashes;
    /** @type {boolean} */
    #script_needs_csp;
    /** @type {boolean} */
    #script_src_needs_csp;
    /** @type {boolean} */
    #script_src_elem_needs_csp;
    /** @type {boolean} */
    #style_needs_csp;
    /** @type {boolean} */
    #style_src_needs_csp;
    /** @type {boolean} */
    #style_src_attr_needs_csp;
    /** @type {boolean} */
    #style_src_elem_needs_csp;
    /** @type {import('types').CspDirectives} */
    #directives;
    /** @type {Set<import('types').Csp.Source>} */
    #script_src;
    /** @type {Set<import('types').Csp.Source>} */
    #script_src_elem;
    /** @type {Set<import('types').Csp.Source>} */
    #style_src;
    /** @type {Set<import('types').Csp.Source>} */
    #style_src_attr;
    /** @type {Set<import('types').Csp.Source>} */
    #style_src_elem;
    /** @type {boolean} */
    script_needs_nonce;
    /** @type {boolean} */
    style_needs_nonce;
    /** @type {boolean} */
    script_needs_hash;
    /** @type {string} */
    #nonce;
    /**
     * @param {boolean} use_hashes
     * @param {import('types').CspDirectives} directives
     * @param {string} nonce
     */
    constructor(use_hashes, directives, nonce) {
      this.#use_hashes = use_hashes;
      this.#directives = directives;
      const d = this.#directives;
      this.#script_src = /* @__PURE__ */ new Set();
      this.#script_src_elem = /* @__PURE__ */ new Set();
      this.#style_src = /* @__PURE__ */ new Set();
      this.#style_src_attr = /* @__PURE__ */ new Set();
      this.#style_src_elem = /* @__PURE__ */ new Set();
      const effective_script_src = d["script-src"] || d["default-src"];
      const script_src_elem = d["script-src-elem"];
      const effective_style_src = d["style-src"] || d["default-src"];
      const style_src_attr = d["style-src-attr"];
      const style_src_elem = d["style-src-elem"];
      /** @param {(import('types').Csp.Source | import('types').Csp.ActionSource)[] | undefined} directive */
      const style_needs_csp = (directive) =>
        !!directive && !directive.some((value) => value === "unsafe-inline");
      /** @param {(import('types').Csp.Source | import('types').Csp.ActionSource)[] | undefined} directive */
      const script_needs_csp = (directive) =>
        !!directive &&
        (!directive.some((value) => value === "unsafe-inline") ||
          directive.some((value) => value === "strict-dynamic"));
      this.#script_src_needs_csp = script_needs_csp(effective_script_src);
      this.#script_src_elem_needs_csp = script_needs_csp(script_src_elem);
      this.#style_src_needs_csp = style_needs_csp(effective_style_src);
      this.#style_src_attr_needs_csp = style_needs_csp(style_src_attr);
      this.#style_src_elem_needs_csp = style_needs_csp(style_src_elem);
      this.#script_needs_csp =
        this.#script_src_needs_csp || this.#script_src_elem_needs_csp;
      this.#style_needs_csp =
        this.#style_src_needs_csp ||
        this.#style_src_attr_needs_csp ||
        this.#style_src_elem_needs_csp;
      this.script_needs_nonce = this.#script_needs_csp && !this.#use_hashes;
      this.style_needs_nonce = this.#style_needs_csp && !this.#use_hashes;
      this.script_needs_hash = this.#script_needs_csp && this.#use_hashes;
      this.#nonce = nonce;
    }
    /** @param {string} content */
    add_script(content) {
      if (!this.#script_needs_csp) return;
      /** @type {`nonce-${string}` | `sha256-${string}`} */
      const source = this.#use_hashes
        ? `sha256-${sha256(content)}`
        : `nonce-${this.#nonce}`;
      if (this.#script_src_needs_csp) this.#script_src.add(source);
      if (this.#script_src_elem_needs_csp) this.#script_src_elem.add(source);
    }
    /** @param {`sha256-${string}`[]} hashes */
    add_script_hashes(hashes) {
      for (const hash of hashes) {
        if (this.#script_src_needs_csp) this.#script_src.add(hash);
        if (this.#script_src_elem_needs_csp) this.#script_src_elem.add(hash);
      }
    }
    /** @param {string} content */
    add_style(content) {
      if (!this.#style_needs_csp) return;
      /** @type {`nonce-${string}` | `sha256-${string}`} */
      const source = this.#use_hashes
        ? `sha256-${sha256(content)}`
        : `nonce-${this.#nonce}`;
      if (this.#style_src_needs_csp) this.#style_src.add(source);
      if (this.#style_src_attr_needs_csp) this.#style_src_attr.add(source);
      if (this.#style_src_elem_needs_csp) {
        const sha256_empty_comment_hash =
          "sha256-9OlNO0DNEeaVzHL4RZwCLsBHA8WBQ8toBp/4F5XV2nc=";
        const d = this.#directives;
        if (
          d["style-src-elem"] &&
          !d["style-src-elem"].includes(sha256_empty_comment_hash) &&
          !this.#style_src_elem.has(sha256_empty_comment_hash)
        )
          this.#style_src_elem.add(sha256_empty_comment_hash);
        if (source !== sha256_empty_comment_hash)
          this.#style_src_elem.add(source);
      }
    }
    /**
     * @param {boolean} [is_meta]
     */
    get_header(is_meta = false) {
      const header = [];
      const directives = { ...this.#directives };
      if (this.#style_src.size > 0)
        directives["style-src"] = [
          ...(directives["style-src"] || directives["default-src"] || []),
          ...this.#style_src,
        ];
      if (this.#style_src_attr.size > 0)
        directives["style-src-attr"] = [
          ...(directives["style-src-attr"] || []),
          ...this.#style_src_attr,
        ];
      if (this.#style_src_elem.size > 0)
        directives["style-src-elem"] = [
          ...(directives["style-src-elem"] || []),
          ...this.#style_src_elem,
        ];
      if (this.#script_src.size > 0)
        directives["script-src"] = [
          ...(directives["script-src"] || directives["default-src"] || []),
          ...this.#script_src,
        ];
      if (this.#script_src_elem.size > 0)
        directives["script-src-elem"] = [
          ...(directives["script-src-elem"] || []),
          ...this.#script_src_elem,
        ];
      for (const key in directives) {
        if (
          is_meta &&
          (key === "frame-ancestors" ||
            key === "report-uri" ||
            key === "sandbox")
        )
          continue;
        const value = directives[key];
        if (!value) continue;
        const directive = [key];
        if (Array.isArray(value))
          value.forEach((value) => {
            if (quoted.has(value) || crypto_pattern.test(value))
              directive.push(`'${value}'`);
            else directive.push(value);
          });
        header.push(directive.join(" "));
      }
      return header.join("; ");
    }
  };
  var CspProvider = class extends BaseProvider {
    get_meta() {
      const content = this.get_header(true);
      if (!content) return;
      return `<meta http-equiv="content-security-policy" content="${escape_html(content, true)}">`;
    }
  };
  var CspReportOnlyProvider = class extends BaseProvider {
    /**
     * @param {boolean} use_hashes
     * @param {import('types').CspDirectives} directives
     * @param {string} nonce
     */
    constructor(use_hashes, directives, nonce) {
      super(use_hashes, directives, nonce);
      if (Object.values(directives).filter((v) => !!v).length > 0) {
        const has_report_to = directives["report-to"]?.length ?? false;
        const has_report_uri = directives["report-uri"]?.length ?? false;
        if (!has_report_to && !has_report_uri)
          throw Error(
            "`content-security-policy-report-only` must be specified with either the `report-to` or `report-uri` directives, or both",
          );
      }
    }
  };
  var Csp = class {
    /** @readonly */
    nonce = generate_nonce();
    /** @type {CspProvider} */
    csp_provider;
    /** @type {CspReportOnlyProvider} */
    report_only_provider;
    /**
     * @param {import('./types.js').CspConfig} config
     * @param {import('./types.js').CspOpts} opts
     */
    constructor({ mode, directives, reportOnly }, { prerender }) {
      const use_hashes = mode === "hash" || (mode === "auto" && prerender);
      this.csp_provider = new CspProvider(use_hashes, directives, this.nonce);
      this.report_only_provider = new CspReportOnlyProvider(
        use_hashes,
        reportOnly,
        this.nonce,
      );
    }
    get script_needs_hash() {
      return (
        this.csp_provider.script_needs_hash ||
        this.report_only_provider.script_needs_hash
      );
    }
    get script_needs_nonce() {
      return (
        this.csp_provider.script_needs_nonce ||
        this.report_only_provider.script_needs_nonce
      );
    }
    get style_needs_nonce() {
      return (
        this.csp_provider.style_needs_nonce ||
        this.report_only_provider.style_needs_nonce
      );
    }
    /** @param {string} content */
    add_script(content) {
      this.csp_provider.add_script(content);
      this.report_only_provider.add_script(content);
    }
    /** @param {`sha256-${string}`[]} hashes */
    add_script_hashes(hashes) {
      this.csp_provider.add_script_hashes(hashes);
      this.report_only_provider.add_script_hashes(hashes);
    }
    /** @param {string} content */
    add_style(content) {
      this.csp_provider.add_style(content);
      this.report_only_provider.add_style(content);
    }
  };
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/server_routing.js
  /**
   * @param {import('types').SSRClientRoute} route
   * @param {URL} url
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @returns {string}
   */
  function generate_route_object(route, url, manifest) {
    const { errors, layouts, leaf } = route;
    const nodes = [...errors, ...layouts.map((l) => l?.[1]), leaf[1]]
      .filter((n) => typeof n === "number")
      .map(
        (n) =>
          `'${n}': () => ${create_client_import(manifest._.client.nodes?.[n], url)}`,
      )
      .join(",\n		");
    /** @type {import('types').CSRRouteServer} */
    return [
      `{\n\tid: ${s(route.id)}`,
      `errors: ${s(route.errors)}`,
      `layouts: ${s(route.layouts)}`,
      `leaf: ${s(route.leaf)}`,
      `nodes: {\n\t\t${nodes}\n\t}\n}`,
    ].join(",\n	");
  }
  /**
   * @param {string | undefined} import_path
   * @param {URL} url
   */
  function create_client_import(import_path, url) {
    if (!import_path) return "Promise.resolve({})";
    if (import_path[0] === "/") return `import('${import_path}')`;
    if (assets !== "") return `import('${assets}/${import_path}')`;
    let path = get_relative_path(url.pathname, `${base}/${import_path}`);
    if (path[0] !== ".") path = `./${path}`;
    return `import('${path}')`;
  }
  /**
   * @param {string} resolved_path
   * @param {URL} url
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @returns {Promise<Response>}
   */
  async function resolve_route(resolved_path, url, manifest) {
    if (!manifest._.client.routes)
      return text("Server-side route resolution disabled", { status: 400 });
    const matchers = await manifest._.matchers();
    const result = find_route(
      resolved_path,
      manifest._.client.routes,
      matchers,
    );
    return create_server_routing_response(
      result?.route ?? null,
      result?.params ?? {},
      url,
      manifest,
    ).response;
  }
  /**
   * @param {import('types').SSRClientRoute | null} route
   * @param {Partial<Record<string, string>>} params
   * @param {URL} url
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @returns {{response: Response, body: string}}
   */
  function create_server_routing_response(route, params, url, manifest) {
    const headers = new Headers({
      "content-type": "application/javascript; charset=utf-8",
    });
    if (route) {
      const csr_route = generate_route_object(route, url, manifest);
      const body = `${create_css_import(route, url, manifest)}\nexport const route = ${csr_route}; export const params = ${JSON.stringify(params)};`;
      return {
        response: text(body, { headers }),
        body,
      };
    } else
      return {
        response: text("", { headers }),
        body: "",
      };
  }
  /**
   * This function generates the client-side import for the CSS files that are
   * associated with the current route. Vite takes care of that when using
   * client-side route resolution, but for server-side resolution it does
   * not know about the CSS files automatically.
   *
   * @param {import('types').SSRClientRoute} route
   * @param {URL} url
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @returns {string}
   */
  function create_css_import(route, url, manifest) {
    const { errors, layouts, leaf } = route;
    let css = "";
    for (const node of [...errors, ...layouts.map((l) => l?.[1]), leaf[1]]) {
      if (typeof node !== "number") continue;
      const node_css = manifest._.client.css?.[node];
      for (const css_path of node_css ?? [])
        css += `'${assets || base}/${css_path}',`;
    }
    if (!css) return "";
    return `${create_client_import(manifest._.client.start, url)}.then(x => x.load_css([${css}]));`;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/render.js
  var updated = {
    ...readable(false),
    check: () => false,
  };
  /**
   * Creates the HTML response.
   * @param {{
   *   branch: Array<import('./types.js').Loaded>;
   *   fetched: Array<import('./types.js').Fetched>;
   *   options: import('types').SSROptions;
   *   manifest: import('@sveltejs/kit').SSRManifest;
   *   state: import('types').SSRState;
   *   page_config: { ssr: boolean; csr: boolean };
   *   status: number;
   *   error: App.Error | null;
   *   event: import('@sveltejs/kit').RequestEvent;
   *   event_state: import('types').RequestState;
   *   resolve_opts: import('types').RequiredResolveOptions;
   *   action_result?: import('@sveltejs/kit').ActionResult;
   *   data_serializer: import('./types.js').ServerDataSerializer;
   *   error_components?: Array<import('types').SSRComponent | undefined>
   * }} opts
   */
  async function render_response({
    branch,
    fetched,
    options,
    manifest,
    state,
    page_config,
    status,
    error = null,
    event,
    event_state,
    resolve_opts,
    action_result,
    data_serializer,
    error_components,
  }) {
    if (state.prerendering) {
      if (options.csp.mode === "nonce")
        throw new Error(
          'Cannot use prerendering if config.kit.csp.mode === "nonce"',
        );
      if (options.app_template_contains_nonce)
        throw new Error(
          "Cannot use prerendering if page template contains %sveltekit.nonce%",
        );
    }
    const { client } = manifest._;
    const modulepreloads = new Set(client.imports);
    const stylesheets = new Set(client.stylesheets);
    const fonts = new Set(client.fonts);
    /**
     * The value of the Link header that is added to the response when not prerendering
     * @type {Set<string>}
     */
    const link_headers = /* @__PURE__ */ new Set();
    /** @type {Map<string, string>} */
    const inline_styles = /* @__PURE__ */ new Map();
    /** @type {ReturnType<typeof options.root.render>} */
    let rendered;
    const form_value =
      action_result?.type === "success" || action_result?.type === "failure"
        ? (action_result.data ?? null)
        : null;
    /** @type {string} */
    let base$1 = base;
    /** @type {string} */
    let assets$1 = assets;
    /**
     * An expression that will evaluate in the client to determine the resolved base path.
     * We use a relative path when possible to support IPFS, the internet archive, etc.
     */
    let base_expression = s(base);
    const csp = new Csp(options.csp, { prerender: !!state.prerendering });
    if (!state.prerendering?.fallback) {
      base$1 =
        event.url.pathname
          .slice(base.length)
          .split("/")
          .slice(2)
          .map(() => "..")
          .join("/") || ".";
      base_expression = `new URL(${s(base$1)}, location).pathname.slice(0, -1)`;
      if (!assets || (assets[0] === "/" && assets !== "/_svelte_kit_assets"))
        assets$1 = base$1;
    } else if (options.hash_routing)
      base_expression = "new URL('.', location).pathname.slice(0, -1)";
    if (page_config.ssr) {
      /** @type {Record<string, any>} */
      const props = {
        stores: {
          page: writable(null),
          navigating: writable(null),
          updated,
        },
        constructors: await Promise.all(
          branch.map(({ node }) => {
            if (!node.component)
              throw new Error(
                `Missing +page.svelte component for route ${event.route.id}`,
              );
            return node.component();
          }),
        ),
        form: form_value,
      };
      if (error_components) {
        if (error) props.error = error;
        props.errors = error_components;
      }
      let data = {};
      for (let i = 0; i < branch.length; i += 1) {
        data = {
          ...data,
          ...branch[i].data,
        };
        props[`data_${i}`] = data;
      }
      props.page = {
        error,
        params: event.params,
        route: event.route,
        status,
        url: event.url,
        data,
        form: form_value,
        state: {},
      };
      const render_opts = {
        context: new Map([["__request__", { page: props.page }]]),
        csp: csp.script_needs_nonce
          ? { nonce: csp.nonce }
          : { hash: csp.script_needs_hash },
        transformError: error_components
          ? async (e) => {
              if (isRedirect(e)) throw e;
              const transformed = await handle_error_and_jsonify(
                event,
                event_state,
                options,
                e,
              );
              props.page.error = props.error = error = transformed;
              props.page.status = status = get_status(e);
              return transformed;
            }
          : void 0,
      };
      try {
        rendered = await with_request_store(
          {
            event,
            state: {
              ...event_state,
              is_in_render: true,
            },
          },
          async () => {
            override({
              base: base$1,
              assets: assets$1,
            });
            const maybe_promise = options.root.render(props, render_opts);
            const rendered =
              options.async && "then" in maybe_promise
                ? maybe_promise.then((r) => r)
                : maybe_promise;
            if (options.async) reset();
            const { head, html, css, hashes } = options.async
              ? await rendered
              : rendered;
            if (hashes) csp.add_script_hashes(hashes.script);
            return {
              head,
              html,
              css,
              hashes,
            };
          },
        );
      } finally {
        reset();
      }
    } else
      rendered = {
        head: "",
        html: "",
        css: {
          code: "",
          map: null,
        },
        hashes: { script: [] },
      };
    for (const { node } of branch) {
      for (const url of node.imports) modulepreloads.add(url);
      for (const url of node.stylesheets) stylesheets.add(url);
      for (const url of node.fonts) fonts.add(url);
      if (node.inline_styles && !client.inline)
        Object.entries(await node.inline_styles()).forEach(
          ([filename, css]) => {
            if (typeof css === "string") {
              inline_styles.set(filename, css);
              return;
            }
            inline_styles.set(
              filename,
              css(`${assets$1}/${app_dir}/immutable/assets`, assets$1),
            );
          },
        );
    }
    const head = new Head(rendered.head, !!state.prerendering);
    let body = rendered.html;
    /** @param {string} path */
    const prefixed = (path) => {
      if (path.startsWith("/")) return base + path;
      return `${assets$1}/${path}`;
    };
    const style = client.inline
      ? client.inline?.style
      : Array.from(inline_styles.values()).join("\n");
    if (style) {
      const attributes = [];
      if (csp.style_needs_nonce) attributes.push(`nonce="${csp.nonce}"`);
      csp.add_style(style);
      head.add_style(style, attributes);
    }
    for (const dep of stylesheets) {
      const path = prefixed(dep);
      const attributes = ['rel="stylesheet"'];
      if (inline_styles.has(dep))
        attributes.push("disabled", 'media="(max-width: 0)"');
      else if (
        resolve_opts.preload({
          type: "css",
          path,
        })
      )
        link_headers.add(
          `<${encodeURI(path)}>; rel="preload"; as="style"; nopush`,
        );
      head.add_stylesheet(path, attributes);
    }
    for (const dep of fonts) {
      const path = prefixed(dep);
      if (
        resolve_opts.preload({
          type: "font",
          path,
        })
      ) {
        const ext = dep.slice(dep.lastIndexOf(".") + 1);
        head.add_link_tag(path, [
          'rel="preload"',
          'as="font"',
          `type="font/${ext}"`,
          "crossorigin",
        ]);
        link_headers.add(
          `<${encodeURI(path)}>; rel="preload"; as="font"; type="font/${ext}"; crossorigin; nopush`,
        );
      }
    }
    const global = get_global_name(options);
    const { data, chunks } = data_serializer.get_data(csp);
    if (page_config.ssr && page_config.csr)
      body += `\n\t\t\t${fetched.map((item) => serialize_data(item, resolve_opts.filterSerializedResponseHeaders, !!state.prerendering)).join("\n			")}`;
    if (page_config.csr) {
      const route =
        manifest._.client.routes?.find((r) => r.id === event.route.id) ?? null;
      if (client.uses_env_dynamic_public && state.prerendering)
        modulepreloads.add(`${app_dir}/env.js`);
      if (!client.inline) {
        const included_modulepreloads = Array.from(modulepreloads, (dep) =>
          prefixed(dep),
        ).filter((path) =>
          resolve_opts.preload({
            type: "js",
            path,
          }),
        );
        for (const path of included_modulepreloads) {
          link_headers.add(`<${encodeURI(path)}>; rel="modulepreload"; nopush`);
          if (options.preload_strategy !== "modulepreload")
            head.add_script_preload(path);
          else head.add_link_tag(path, ['rel="modulepreload"']);
        }
      }
      if (
        manifest._.client.routes &&
        state.prerendering &&
        !state.prerendering.fallback
      ) {
        const pathname = add_resolution_suffix(event.url.pathname);
        state.prerendering.dependencies.set(
          pathname,
          create_server_routing_response(
            route,
            event.params,
            new URL(pathname, event.url),
            manifest,
          ),
        );
      }
      const blocks = [];
      const load_env_eagerly =
        client.uses_env_dynamic_public && state.prerendering;
      const properties = [`base: ${base_expression}`];
      if (assets) properties.push(`assets: ${s(assets)}`);
      if (client.uses_env_dynamic_public)
        properties.push(`env: ${load_env_eagerly ? "null" : s(public_env)}`);
      if (chunks) {
        blocks.push("const deferred = new Map();");
        properties.push(`defer: (id) => new Promise((fulfil, reject) => {
							deferred.set(id, { fulfil, reject });
						})`);
        let app_declaration = "";
        if (Object.keys(options.hooks.transport).length > 0)
          if (client.inline)
            app_declaration = `const app = __sveltekit_${options.version_hash}.app.app;`;
          else if (client.app)
            app_declaration = `const app = await import(${s(prefixed(client.app))});`;
          else
            app_declaration = `const { app } = await import(${s(prefixed(client.start))});`;
        const prelude = app_declaration
          ? `${app_declaration}
							const [data, error] = fn(app);`
          : `const [data, error] = fn();`;
        properties.push(`resolve: async (id, fn) => {
							${prelude}

							const try_to_resolve = () => {
								if (!deferred.has(id)) {
									setTimeout(try_to_resolve, 0);
									return;
								}
								const { fulfil, reject } = deferred.get(id);
								deferred.delete(id);
								if (error) reject(error);
								else fulfil(data);
							}
							try_to_resolve();
						}`);
      }
      blocks.push(`${global} = {
						${properties.join(",\n						")}
					};`);
      const args = ["element"];
      blocks.push("const element = document.currentScript.parentElement;");
      if (page_config.ssr) {
        const serialized = {
          form: "null",
          error: "null",
        };
        if (form_value)
          serialized.form = uneval_action_response(
            form_value,
            event.route.id,
            options.hooks.transport,
          );
        if (error) serialized.error = uneval(error);
        const hydrate = [
          `node_ids: [${branch.map(({ node }) => node.index).join(", ")}]`,
          `data: ${data}`,
          `form: ${serialized.form}`,
          `error: ${serialized.error}`,
        ];
        if (status !== 200) hydrate.push(`status: ${status}`);
        if (manifest._.client.routes) {
          if (route) {
            const stringified = generate_route_object(
              route,
              event.url,
              manifest,
            ).replaceAll("\n", "\n							");
            hydrate.push(
              `params: ${uneval(event.params)}`,
              `server_route: ${stringified}`,
            );
          }
        } else if (options.embedded)
          hydrate.push(
            `params: ${uneval(event.params)}`,
            `route: ${s(event.route)}`,
          );
        const indent = "	".repeat(load_env_eagerly ? 7 : 6);
        args.push(
          `{\n${indent}\t${hydrate.join(`,\n${indent}\t`)}\n${indent}}`,
        );
      }
      const { remote } = event_state;
      let serialized_query_data = "";
      let serialized_prerender_data = "";
      if (remote.data) {
        /** @type {Record<string, any>} */
        const query = {};
        /** @type {Record<string, any>} */
        const prerender = {};
        for (const [internals, cache] of remote.data) {
          if (!internals.id) continue;
          for (const key in cache) {
            const entry = cache[key];
            if (!entry.serialize) continue;
            const remote_key = create_remote_key(internals.id, key);
            const store = internals.type === "prerender" ? prerender : query;
            if (
              event_state.remote.refreshes?.has(remote_key) ||
              event_state.remote.reconnects?.has(remote_key)
            )
              store[remote_key] = await entry.data;
            else {
              const result = await Promise.race([
                Promise.resolve(entry.data).then(
                  (v) => ({
                    settled: true,
                    value: v,
                  }),
                  (e) => ({
                    settled: true,
                    error: e,
                  }),
                ),
                new Promise((resolve) => {
                  queueMicrotask(() => resolve({ settled: false }));
                }),
              ]);
              if (result.settled) {
                if ("error" in result) throw result.error;
                store[remote_key] = result.value;
              }
            }
          }
        }
        const replacer = (thing) => {
          for (const key in options.hooks.transport) {
            const encoded = options.hooks.transport[key].encode(thing);
            if (encoded)
              return `app.decode('${key}', ${uneval(encoded, replacer)})`;
          }
        };
        if (Object.keys(query).length > 0)
          serialized_query_data = `${global}.query = ${uneval(query, replacer)};\n\n\t\t\t\t\t\t`;
        if (Object.keys(prerender).length > 0)
          serialized_prerender_data = `${global}.prerender = ${uneval(prerender, replacer)};\n\n\t\t\t\t\t\t`;
      }
      const serialized_remote_data = `${serialized_query_data}${serialized_prerender_data}`;
      const boot = client.inline
        ? `${client.inline.script}

					${serialized_remote_data}${global}.app.start(${args.join(", ")});`
        : client.app
          ? `Promise.all([
						import(${s(prefixed(client.start))}),
						import(${s(prefixed(client.app))})
					]).then(([kit, app]) => {
						${serialized_remote_data}kit.start(app, ${args.join(", ")});
					});`
          : `import(${s(prefixed(client.start))}).then((app) => {
						${serialized_remote_data}app.start(${args.join(", ")})
					});`;
      if (load_env_eagerly)
        blocks.push(`import(${s(`${base$1}/${app_dir}/env.js`)}).then(({ env }) => {
						${global}.env = env;

						${boot.replace(/\n/g, "\n	")}
					});`);
      else blocks.push(boot);
      if (options.service_worker) {
        let opts = "";
        if (options.service_worker_options != null)
          opts = `, ${s({ ...options.service_worker_options })}`;
        blocks.push(`if ('serviceWorker' in navigator) {
						const script_url = '${prefixed("service-worker.js")}';
						const policy = globalThis?.window?.trustedTypes?.createPolicy(
							'sveltekit-trusted-url',
							{ createScriptURL(url) { return url; } }
						);
						const sanitised = policy?.createScriptURL(script_url) ?? script_url;
						addEventListener('load', function () {
							navigator.serviceWorker.register(sanitised${opts});
						});
					}`);
      }
      const init_app = `
				{
					${blocks.join("\n\n					")}
				}
			`;
      csp.add_script(init_app);
      body += `\n\t\t\t<script${csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ""}>${init_app}<\/script>\n\t\t`;
    }
    const headers = new Headers({
      "x-sveltekit-page": "true",
      "content-type": "text/html",
    });
    if (state.prerendering) {
      const csp_headers = csp.csp_provider.get_meta();
      if (csp_headers) head.add_http_equiv(csp_headers);
      if (state.prerendering.cache)
        head.add_http_equiv(
          `<meta http-equiv="cache-control" content="${state.prerendering.cache}">`,
        );
    } else {
      const csp_header = csp.csp_provider.get_header();
      if (csp_header) headers.set("content-security-policy", csp_header);
      const report_only_header = csp.report_only_provider.get_header();
      if (report_only_header)
        headers.set("content-security-policy-report-only", report_only_header);
      if (link_headers.size)
        headers.set("link", Array.from(link_headers).join(", "));
    }
    const html = options.templates.app({
      head: head.build(),
      body,
      assets: assets$1,
      nonce: csp.nonce,
      env: public_env,
    });
    const transformed =
      (await resolve_opts.transformPageChunk({
        html,
        done: true,
      })) || "";
    if (!chunks) headers.set("etag", `"${hash(transformed)}"`);
    return !chunks
      ? text(transformed, {
          status,
          headers,
        })
      : new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(text_encoder$1.encode(transformed + "\n"));
              for await (const chunk of chunks)
                if (chunk.length)
                  controller.enqueue(text_encoder$1.encode(chunk));
              controller.close();
            },
            type: "bytes",
          }),
          { headers },
        );
  }
  var Head = class {
    #rendered;
    #prerendering;
    /** @type {string[]} */
    #http_equiv = [];
    /** @type {string[]} */
    #link_tags = [];
    /** @type {string[]} */
    #script_preloads = [];
    /** @type {string[]} */
    #style_tags = [];
    /** @type {string[]} */
    #stylesheet_links = [];
    /**
     * @param {string} rendered
     * @param {boolean} prerendering
     */
    constructor(rendered, prerendering) {
      this.#rendered = rendered;
      this.#prerendering = prerendering;
    }
    build() {
      return [
        ...this.#http_equiv,
        ...this.#link_tags,
        ...this.#script_preloads,
        this.#rendered,
        ...this.#style_tags,
        ...this.#stylesheet_links,
      ].join("\n		");
    }
    /**
     * @param {string} style
     * @param {string[]} attributes
     */
    add_style(style, attributes) {
      this.#style_tags.push(
        `<style${attributes.length ? " " + attributes.join(" ") : ""}>${style}</style>`,
      );
    }
    /**
     * @param {string} href
     * @param {string[]} attributes
     */
    add_stylesheet(href, attributes) {
      this.#stylesheet_links.push(
        `<link href="${href}" ${attributes.join(" ")}>`,
      );
    }
    /** @param {string} href */
    add_script_preload(href) {
      this.#script_preloads.push(
        `<link rel="preload" as="script" crossorigin="anonymous" href="${href}">`,
      );
    }
    /**
     * @param {string} href
     * @param {string[]} attributes
     */
    add_link_tag(href, attributes) {
      if (!this.#prerendering) return;
      this.#link_tags.push(`<link href="${href}" ${attributes.join(" ")}>`);
    }
    /** @param {string} tag */
    add_http_equiv(tag) {
      if (!this.#prerendering) return;
      this.#http_equiv.push(tag);
    }
  };
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/page_nodes.js
  var PageNodes = class {
    /** All layout nodes and the page node, if any */
    data;
    /**
     * @param {Array<import('types').SSRNode | undefined>} nodes
     */
    constructor(nodes) {
      this.data = nodes;
    }
    layouts() {
      return this.data.slice(0, -1);
    }
    page() {
      return this.data.at(-1);
    }
    validate() {
      for (const layout of this.layouts())
        if (layout) {
          validate_layout_server_exports(layout.server, layout.server_id);
          validate_layout_exports(layout.universal, layout.universal_id);
        }
      const page = this.page();
      if (page) {
        validate_page_server_exports(page.server, page.server_id);
        validate_page_exports(page.universal, page.universal_id);
      }
    }
    /**
     * @template {'prerender' | 'ssr' | 'csr' | 'trailingSlash'} Option
     * @param {Option} option
     * @returns {Value | undefined}
     */
    #get_option(option) {
      /** @typedef {(import('types').UniversalNode | import('types').ServerNode)[Option]} Value */
      return this.data.reduce(
        (value, node) => {
          return node?.universal?.[option] ?? node?.server?.[option] ?? value;
        },
        void 0,
      );
    }
    csr() {
      return this.#get_option("csr") ?? true;
    }
    ssr() {
      return this.#get_option("ssr") ?? true;
    }
    prerender() {
      return this.#get_option("prerender") ?? false;
    }
    trailing_slash() {
      return this.#get_option("trailingSlash") ?? "never";
    }
    get_config() {
      /** @type {any} */
      let current = {};
      for (const node of this.data) {
        if (!node?.universal?.config && !node?.server?.config) continue;
        current = {
          ...current,
          ...node?.universal?.config,
          ...node?.server?.config,
        };
      }
      return Object.keys(current).length ? current : void 0;
    }
    should_prerender_data() {
      return this.data.some(
        (node) => node?.server?.load || node?.server?.trailingSlash !== void 0,
      );
    }
  };
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/respond_with_error.js
  /**
   * @typedef {import('./types.js').Loaded} Loaded
   */
  /**
   * @param {{
   *   event: import('@sveltejs/kit').RequestEvent;
   *   event_state: import('types').RequestState;
   *   options: import('types').SSROptions;
   *   manifest: import('@sveltejs/kit').SSRManifest;
   *   state: import('types').SSRState;
   *   status: number;
   *   error: unknown;
   *   resolve_opts: import('types').RequiredResolveOptions;
   * }} opts
   */
  async function respond_with_error({
    event,
    event_state,
    options,
    manifest,
    state,
    status,
    error,
    resolve_opts,
  }) {
    if (event.request.headers.get("x-sveltekit-error"))
      return static_error_page(
        options,
        status,
        /** @type {Error} */
        error.message,
      );
    /** @type {import('./types.js').Fetched[]} */
    const fetched = [];
    try {
      const branch = [];
      const default_layout = await manifest._.nodes[0]();
      const nodes = new PageNodes([default_layout]);
      const ssr = nodes.ssr();
      const csr = nodes.csr();
      const data_serializer = server_data_serializer(
        event,
        event_state,
        options,
      );
      if (ssr) {
        state.error = true;
        const server_data_promise = load_server_data({
          event,
          event_state,
          state,
          node: default_layout,
          parent: async () => ({}),
        });
        const server_data = await server_data_promise;
        data_serializer.add_node(0, server_data);
        const data = await load_data({
          event,
          event_state,
          fetched,
          node: default_layout,
          parent: async () => ({}),
          resolve_opts,
          server_data_promise,
          state,
          csr,
        });
        branch.push(
          {
            node: default_layout,
            server_data,
            data,
          },
          {
            node: await manifest._.nodes[1](),
            data: null,
            server_data: null,
          },
        );
      }
      return await render_response({
        options,
        manifest,
        state,
        page_config: {
          ssr,
          csr,
        },
        status,
        error: await handle_error_and_jsonify(
          event,
          event_state,
          options,
          error,
        ),
        branch,
        error_components: [],
        fetched,
        event,
        event_state,
        resolve_opts,
        data_serializer,
      });
    } catch (e) {
      if (e instanceof Redirect) return redirect_response(e.status, e.location);
      return static_error_page(
        options,
        get_status(e),
        (await handle_error_and_jsonify(event, event_state, options, e))
          .message,
      );
    }
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/remote.js
  /** @import { ActionResult, RemoteForm, RequestEvent, SSRManifest } from '@sveltejs/kit' */
  /** @import { RemoteFormInternals, RemoteFunctionResponse, RemoteInternals, RequestState, SSROptions } from 'types' */
  /** @type {typeof handle_remote_call_internal} */
  async function handle_remote_call(event, state, options, manifest, id) {
    return record_span({
      name: "sveltekit.remote.call",
      attributes: {},
      fn: (current) => {
        const traced_event = merge_tracing(event, current);
        return with_request_store(
          {
            event: traced_event,
            state,
          },
          () =>
            handle_remote_call_internal(
              traced_event,
              state,
              options,
              manifest,
              id,
            ),
        );
      },
    });
  }
  /**
   * @param {RequestEvent} event
   * @param {RequestState} state
   * @param {SSROptions} options
   * @param {SSRManifest} manifest
   * @param {string} id
   */
  async function handle_remote_call_internal(
    event,
    state,
    options,
    manifest,
    id,
  ) {
    const [hash, name, additional_args] = id.split("/");
    const remotes = manifest._.remotes;
    if (!remotes[hash]) error(404);
    const fn = (await remotes[hash]()).default[name];
    if (!fn) error(404);
    /** @type {RemoteInternals} */
    const internals = fn.__;
    const transport = options.hooks.transport;
    event.tracing.current.setAttributes({
      "sveltekit.remote.call.type": internals.type,
      "sveltekit.remote.call.name": internals.name,
    });
    try {
      if (internals.type === "query_batch") {
        if (event.request.method !== "POST")
          throw new SvelteKitError(
            405,
            "Method Not Allowed",
            `\`query.batch\` functions must be invoked via POST request, not ${event.request.method}`,
          );
        /** @type {{ payloads: string[] }} */
        const { payloads } = await event.request.json();
        const args = await Promise.all(
          payloads.map((payload) => parse_remote_arg(payload, transport)),
        );
        return json({
          type: "result",
          result: stringify(
            await with_request_store(
              {
                event,
                state,
              },
              () => internals.run(args, options),
            ),
            transport,
          ),
        });
      }
      if (internals.type === "form") {
        if (event.request.method !== "POST")
          throw new SvelteKitError(
            405,
            "Method Not Allowed",
            `\`form\` functions must be invoked via POST request, not ${event.request.method}`,
          );
        if (!is_form_content_type(event.request))
          throw new SvelteKitError(
            415,
            "Unsupported Media Type",
            `\`form\` functions expect form-encoded data — received ${event.request.headers.get("content-type")}`,
          );
        const { data, meta, form_data } = await deserialize_binary_form(
          event.request,
        );
        state.remote.requested = create_requested_map(meta.remote_refreshes);
        if (additional_args && !("id" in data))
          data.id = JSON.parse(decodeURIComponent(additional_args));
        const fn = internals.fn;
        const result = await with_request_store(
          {
            event,
            state,
          },
          () => fn(data, meta, form_data),
        );
        return json({
          type: "result",
          result: stringify(result, transport),
          refreshes: result.issues
            ? void 0
            : await serialize_singleflight(state.remote.refreshes),
          reconnects: result.issues
            ? void 0
            : await serialize_singleflight(state.remote.reconnects),
        });
      }
      if (internals.type === "command") {
        /** @type {{ payload: string, refreshes?: string[] }} */
        const { payload, refreshes } = await event.request.json();
        state.remote.requested = create_requested_map(refreshes);
        const arg = parse_remote_arg(payload, transport);
        return json({
          type: "result",
          result: stringify(
            await with_request_store(
              {
                event,
                state,
              },
              () => fn(arg),
            ),
            transport,
          ),
          refreshes: await serialize_singleflight(state.remote.refreshes),
          reconnects: await serialize_singleflight(state.remote.reconnects),
        });
      }
      if (internals.type === "query_live") {
        if (event.request.method !== "GET")
          throw new SvelteKitError(
            405,
            "Method Not Allowed",
            `\`query.live\` functions must be invoked via GET request, not ${event.request.method}`,
          );
        const payload = new URL(event.request.url).searchParams.get("payload");
        const generator = internals.run(
          event,
          state,
          parse_remote_arg(payload, transport),
        );
        const encoder = new TextEncoder();
        /**
         * @param {ReadableStreamDefaultController} controller
         * @param {any} payload
         */
        function send(controller, payload) {
          controller.enqueue(encoder.encode(JSON.stringify(payload) + "\n"));
        }
        let closed = false;
        /** @type {string | undefined} */
        let result = void 0;
        async function cancel() {
          if (closed) return;
          closed = true;
          await generator.return(void 0);
        }
        event.request.signal.addEventListener("abort", cancel, { once: true });
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (event.request.signal.aborted) {
                await cancel();
                controller.close();
                return;
              }
              try {
                while (true) {
                  const { value, done } = await generator.next();
                  if (done) {
                    await cancel();
                    controller.close();
                    return;
                  }
                  if (result !== (result = stringify(value, transport))) {
                    send(controller, {
                      type: "result",
                      result,
                    });
                    return;
                  }
                }
              } catch (error) {
                if (!event.request.signal.aborted)
                  if (error instanceof Redirect)
                    send(controller, {
                      type: "redirect",
                      location: error.location,
                    });
                  else {
                    const status =
                      error instanceof HttpError ||
                      error instanceof SvelteKitError
                        ? error.status
                        : 500;
                    send(controller, {
                      type: "error",
                      error: await handle_error_and_jsonify(
                        event,
                        state,
                        options,
                        error,
                      ),
                      status,
                    });
                  }
                await cancel();
                controller.close();
              }
            },
            cancel,
          }),
          {
            headers: {
              "cache-control": "private, no-store",
              "content-type": "application/x-ndjson",
            },
          },
        );
      }
      const payload =
        internals.type === "prerender"
          ? additional_args
          : new URL(event.request.url).searchParams.get("payload");
      return json({
        type: "result",
        result: stringify(
          await with_request_store(
            {
              event,
              state,
            },
            () => fn(parse_remote_arg(payload, transport)),
          ),
          transport,
        ),
      });
    } catch (error) {
      if (error instanceof Redirect)
        return json({
          type: "redirect",
          location: error.location,
          refreshes: await serialize_singleflight(state.remote.refreshes),
          reconnects: await serialize_singleflight(state.remote.reconnects),
        });
      const status =
        error instanceof HttpError || error instanceof SvelteKitError
          ? error.status
          : 500;
      return json(
        {
          type: "error",
          error: await handle_error_and_jsonify(event, state, options, error),
          status,
        },
        {
          status: state.prerendering ? status : void 0,
          headers: { "cache-control": "private, no-store" },
        },
      );
    }
    /** @param {Map<string, Promise<any>> | null} map */
    async function serialize_singleflight(map) {
      if (!map || map.size === 0) return;
      const results = await Promise.all(
        Array.from(map, async ([key, promise]) => {
          try {
            return [
              key,
              {
                type: "result",
                data: await promise,
              },
            ];
          } catch (error) {
            return [
              key,
              {
                type: "error",
                status:
                  error instanceof HttpError || error instanceof SvelteKitError
                    ? error.status
                    : 500,
                error: await handle_error_and_jsonify(
                  event,
                  state,
                  options,
                  error,
                ),
              },
            ];
          }
        }),
      );
      return stringify(Object.fromEntries(results), transport);
    }
  }
  /**
   * @param {string[] | undefined} refreshes
   */
  function create_requested_map(refreshes) {
    /** @type {Map<string, string[]>} */
    const requested = /* @__PURE__ */ new Map();
    for (const key of refreshes ?? []) {
      const parts = split_remote_key(key);
      const existing = requested.get(parts.id);
      if (existing) existing.push(parts.payload);
      else requested.set(parts.id, [parts.payload]);
    }
    return requested;
  }
  /** @type {typeof handle_remote_form_post_internal} */
  async function handle_remote_form_post(event, state, manifest, id) {
    return record_span({
      name: "sveltekit.remote.form.post",
      attributes: {},
      fn: (current) => {
        const traced_event = merge_tracing(event, current);
        return with_request_store(
          {
            event: traced_event,
            state,
          },
          () =>
            handle_remote_form_post_internal(traced_event, state, manifest, id),
        );
      },
    });
  }
  /**
   * @param {RequestEvent} event
   * @param {RequestState} state
   * @param {SSRManifest} manifest
   * @param {string} id
   * @returns {Promise<ActionResult>}
   */
  async function handle_remote_form_post_internal(event, state, manifest, id) {
    const [hash, name, action_id] = id.split("/");
    let form = (await manifest._.remotes[hash]?.())?.default[name];
    if (!form) {
      event.setHeaders({ allow: "GET" });
      return {
        type: "error",
        error: new SvelteKitError(
          405,
          "Method Not Allowed",
          `POST method not allowed. No form actions exist for this page`,
        ),
      };
    }
    if (action_id)
      form = with_request_store(
        {
          event,
          state,
        },
        () => form.for(JSON.parse(action_id)),
      );
    try {
      const fn = form.__.fn;
      const { data, meta, form_data } = await deserialize_binary_form(
        event.request,
      );
      if (action_id && !("id" in data))
        data.id = JSON.parse(decodeURIComponent(action_id));
      await with_request_store(
        {
          event,
          state,
        },
        () => fn(data, meta, form_data),
      );
      return {
        type: "success",
        status: 200,
      };
    } catch (e) {
      const err = normalize_error(e);
      if (err instanceof Redirect)
        return {
          type: "redirect",
          status: err.status,
          location: err.location,
        };
      return {
        type: "error",
        error: check_incorrect_fail_use(err),
      };
    }
  }
  /**
   * @param {URL} url
   */
  function get_remote_id(url) {
    return (
      url.pathname.startsWith(`${base}/_app/remote/`) &&
      url.pathname.replace(`${base}/_app/remote/`, "")
    );
  }
  /**
   * @param {URL} url
   */
  function get_remote_action(url) {
    return url.searchParams.get("/remote");
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/page/index.js
  /** @import { ActionResult, RequestEvent, SSRManifest } from '@sveltejs/kit' */
  /** @import { PageNodeIndexes, RequestState, RequiredResolveOptions, ServerDataNode, SSRComponent, SSRNode, SSROptions, SSRState } from 'types' */
  /**
   * The maximum request depth permitted before assuming we're stuck in an infinite loop
   */
  var MAX_DEPTH = 10;
  /**
   * @param {RequestEvent} event
   * @param {RequestState} event_state
   * @param {PageNodeIndexes} page
   * @param {SSROptions} options
   * @param {SSRManifest} manifest
   * @param {SSRState} state
   * @param {import('../../../utils/page_nodes.js').PageNodes} nodes
   * @param {RequiredResolveOptions} resolve_opts
   * @returns {Promise<Response>}
   */
  async function render_page(
    event,
    event_state,
    page,
    options,
    manifest,
    state,
    nodes,
    resolve_opts,
  ) {
    if (state.depth > MAX_DEPTH)
      return text(`Not found: ${event.url.pathname}`, { status: 404 });
    if (is_action_json_request(event))
      return handle_action_json_request(
        event,
        event_state,
        options,
        (await manifest._.nodes[page.leaf]())?.server,
      );
    try {
      const leaf_node = nodes.page();
      let status = 200;
      /** @type {ActionResult | undefined} */
      let action_result = void 0;
      if (is_action_request(event)) {
        const remote_id = get_remote_action(event.url);
        if (remote_id)
          action_result = await handle_remote_form_post(
            event,
            event_state,
            manifest,
            remote_id,
          );
        else
          action_result = await handle_action_request(
            event,
            event_state,
            leaf_node.server,
          );
        if (action_result?.type === "redirect")
          return redirect_response(
            action_result.status,
            action_result.location,
          );
        if (action_result?.type === "error")
          status = get_status(action_result.error);
        if (action_result?.type === "failure") status = action_result.status;
      }
      const should_prerender = nodes.prerender();
      if (should_prerender) {
        if (leaf_node.server?.actions)
          throw new Error("Cannot prerender pages with actions");
      } else if (state.prerendering)
        return new Response(void 0, { status: 204 });
      state.prerender_default = should_prerender;
      const should_prerender_data = nodes.should_prerender_data();
      const data_pathname = add_data_suffix(event.url.pathname);
      /** @type {import('./types.js').Fetched[]} */
      const fetched = [];
      const ssr = nodes.ssr();
      const csr = nodes.csr();
      if (ssr === false && !(state.prerendering && should_prerender_data))
        return await render_response({
          branch: compact(nodes.data).map((node) => {
            return {
              node,
              data: null,
              server_data: null,
            };
          }),
          fetched,
          page_config: {
            ssr: false,
            csr,
          },
          status,
          error: null,
          event,
          event_state,
          options,
          manifest,
          state,
          resolve_opts,
          data_serializer: server_data_serializer(event, event_state, options),
        });
      /** @type {Array<import('./types.js').Loaded | null>} */
      const branch = [];
      /** @type {Error | null} */
      let load_error = null;
      const data_serializer = server_data_serializer(
        event,
        event_state,
        options,
      );
      const data_serializer_json =
        state.prerendering && should_prerender_data
          ? server_data_serializer_json(event, event_state, options)
          : null;
      /** @type {Array<Promise<ServerDataNode | null>>} */
      const server_promises = nodes.data.map((node, i) => {
        if (load_error) throw load_error;
        return Promise.resolve().then(async () => {
          try {
            if (node === leaf_node && action_result?.type === "error")
              throw action_result.error;
            const server_data = await load_server_data({
              event,
              event_state,
              state,
              node,
              parent: async () => {
                /** @type {Record<string, any>} */
                const data = {};
                for (let j = 0; j < i; j += 1) {
                  const parent = await server_promises[j];
                  if (parent) Object.assign(data, parent.data);
                }
                return data;
              },
            });
            if (node) data_serializer.add_node(i, server_data);
            data_serializer_json?.add_node(i, server_data);
            return server_data;
          } catch (e) {
            load_error = e;
            throw load_error;
          }
        });
      });
      /** @type {Array<Promise<Record<string, any> | null>>} */
      const load_promises = nodes.data.map((node, i) => {
        if (load_error) throw load_error;
        return Promise.resolve().then(async () => {
          try {
            return await load_data({
              event,
              event_state,
              fetched,
              node,
              parent: async () => {
                const data = {};
                for (let j = 0; j < i; j += 1)
                  Object.assign(data, await load_promises[j]);
                return data;
              },
              resolve_opts,
              server_data_promise: server_promises[i],
              state,
              csr,
            });
          } catch (e) {
            load_error = e;
            throw load_error;
          }
        });
      });
      for (const p of server_promises) p.catch(noop);
      for (const p of load_promises) p.catch(noop);
      for (let i = 0; i < nodes.data.length; i += 1) {
        const node = nodes.data[i];
        if (node)
          try {
            const server_data = await server_promises[i];
            const data = await load_promises[i];
            branch.push({
              node,
              server_data,
              data,
            });
          } catch (e) {
            const err = normalize_error(e);
            if (err instanceof Redirect) {
              if (state.prerendering && should_prerender_data) {
                const body = JSON.stringify({
                  type: "redirect",
                  location: err.location,
                });
                state.prerendering.dependencies.set(data_pathname, {
                  response: text(body),
                  body,
                });
              }
              return redirect_response(err.status, err.location);
            }
            const status = get_status(err);
            const error = await handle_error_and_jsonify(
              event,
              event_state,
              options,
              err,
            );
            while (i--)
              if (page.errors[i]) {
                const index = page.errors[i];
                const node = await manifest._.nodes[index]();
                let j = i;
                while (!branch[j]) j -= 1;
                data_serializer.set_max_nodes(j + 1);
                const layouts = compact(branch.slice(0, j + 1));
                const nodes = new PageNodes(
                  layouts.map((layout) => layout.node),
                );
                const error_branch = layouts.concat({
                  node,
                  data: null,
                  server_data: null,
                });
                return await render_response({
                  event,
                  event_state,
                  options,
                  manifest,
                  state,
                  resolve_opts,
                  page_config: {
                    ssr: nodes.ssr(),
                    csr: nodes.csr(),
                  },
                  status,
                  error,
                  error_components: await load_error_components(
                    options,
                    ssr,
                    error_branch,
                    page,
                    manifest,
                  ),
                  branch: error_branch,
                  fetched,
                  data_serializer,
                });
              }
            return static_error_page(options, status, error.message);
          }
        else branch.push(null);
      }
      if (state.prerendering && data_serializer_json) {
        let { data, chunks } = data_serializer_json.get_data();
        if (chunks) for await (const chunk of chunks) data += chunk;
        state.prerendering.dependencies.set(data_pathname, {
          response: text(data),
          body: data,
        });
      }
      return await render_response({
        event,
        event_state,
        options,
        manifest,
        state,
        resolve_opts,
        page_config: {
          csr,
          ssr,
        },
        status,
        error: null,
        branch: compact(branch),
        action_result,
        fetched,
        data_serializer: !ssr
          ? server_data_serializer(event, event_state, options)
          : data_serializer,
        error_components: await load_error_components(
          options,
          ssr,
          branch,
          page,
          manifest,
        ),
      });
    } catch (e) {
      if (e instanceof Redirect) return redirect_response(e.status, e.location);
      return await respond_with_error({
        event,
        event_state,
        options,
        manifest,
        state,
        status: e instanceof HttpError ? e.status : 500,
        error: e,
        resolve_opts,
      });
    }
  }
  /**
   *
   * @param {SSROptions} options
   * @param {boolean} ssr
   * @param {Array<import('./types.js').Loaded | null>} branch
   * @param {PageNodeIndexes} page
   * @param {SSRManifest} manifest
   */
  async function load_error_components(options, ssr, branch, page, manifest) {
    /** @type {Array<SSRComponent | undefined> | undefined} */
    let error_components;
    if (options.server_error_boundaries && ssr) {
      let last_idx = -1;
      error_components = await Promise.all(
        branch
          .map((b, i) => {
            if (i === 0) return void 0;
            if (!b) return null;
            i--;
            while (i > last_idx + 1 && page.errors[i] === void 0) i -= 1;
            last_idx = i;
            const idx = page.errors[i];
            if (idx == null) return void 0;
            return manifest._.nodes[idx]?.()
              .then((e) => e.component?.())
              .catch(() => void 0);
          })
          .filter((e) => e !== null),
      );
    }
    return error_components;
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/data/index.js
  /**
   * @param {import('@sveltejs/kit').RequestEvent} event
   * @param {import('types').RequestState} event_state
   * @param {import('types').SSRRoute} route
   * @param {import('types').SSROptions} options
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @param {import('types').SSRState} state
   * @param {boolean[] | undefined} invalidated_data_nodes
   * @param {import('types').TrailingSlash} trailing_slash
   * @returns {Promise<Response>}
   */
  async function render_data(
    event,
    event_state,
    route,
    options,
    manifest,
    state,
    invalidated_data_nodes,
    trailing_slash,
  ) {
    if (!route.page) return new Response(void 0, { status: 404 });
    try {
      const node_ids = [...route.page.layouts, route.page.leaf];
      const invalidated = invalidated_data_nodes ?? node_ids.map(() => true);
      let aborted = false;
      const url = new URL(event.url);
      url.pathname = normalize_path(url.pathname, trailing_slash);
      const new_event = {
        ...event,
        url,
      };
      const functions = node_ids.map((n, i) => {
        return once(async () => {
          try {
            if (aborted) return { type: "skip" };
            return load_server_data({
              event: new_event,
              event_state,
              state,
              node: n == void 0 ? n : await manifest._.nodes[n](),
              parent: async () => {
                /** @type {Record<string, any>} */
                const data = {};
                for (let j = 0; j < i; j += 1) {
                  const parent = await functions[j]();
                  if (parent) Object.assign(data, parent.data);
                }
                return data;
              },
            });
          } catch (e) {
            aborted = true;
            throw e;
          }
        });
      });
      const promises = functions.map(async (fn, i) => {
        if (!invalidated[i]) return { type: "skip" };
        return fn();
      });
      let length = promises.length;
      const nodes = await Promise.all(
        promises.map((p, i) =>
          p.catch(async (error) => {
            if (error instanceof Redirect) throw error;
            length = Math.min(length, i + 1);
            return {
              type: "error",
              error: await handle_error_and_jsonify(
                event,
                event_state,
                options,
                error,
              ),
              status:
                error instanceof HttpError || error instanceof SvelteKitError
                  ? error.status
                  : void 0,
            };
          }),
        ),
      );
      const data_serializer = server_data_serializer_json(
        event,
        event_state,
        options,
      );
      for (let i = 0; i < nodes.length; i++)
        data_serializer.add_node(i, nodes[i]);
      const { data, chunks } = data_serializer.get_data();
      if (!chunks) return json_response(data);
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(text_encoder$1.encode(data));
            for await (const chunk of chunks)
              controller.enqueue(text_encoder$1.encode(chunk));
            controller.close();
          },
          type: "bytes",
        }),
        {
          headers: {
            "content-type": "text/sveltekit-data",
            "cache-control": "private, no-store",
          },
        },
      );
    } catch (e) {
      const error = normalize_error(e);
      if (error instanceof Redirect) return redirect_json_response(error);
      else
        return json_response(
          await handle_error_and_jsonify(event, event_state, options, error),
          500,
        );
    }
  }
  /**
   * @param {Record<string, any> | string} json
   * @param {number} [status]
   */
  function json_response(json, status = 200) {
    return text(typeof json === "string" ? json : JSON.stringify(json), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      },
    });
  }
  /**
   * @param {Redirect} redirect
   */
  function redirect_json_response(redirect) {
    return json_response({
      type: "redirect",
      location: redirect.location,
    });
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/cookie.js
  var INVALID_COOKIE_CHARACTER_REGEX = /[\x00-\x1F\x7F()<>@,;:"/[\]?={} \t]/;
  /** @param {import('./page/types.js').Cookie['options']} options */
  function validate_options(options) {
    if (options?.path === void 0)
      throw new Error(
        "You must specify a `path` when setting, deleting or serializing cookies",
      );
  }
  /**
   * Generates a unique key for a cookie based on its domain, path, and name in
   * the format: `<domain>/<path>?<name>`.
   * If domain is undefined, it will be omitted.
   * For example: `/?name`, `example.com/foo?name`.
   *
   * @param {string | undefined} domain
   * @param {string} path
   * @param {string} name
   * @returns {string}
   */
  function generate_cookie_key(domain, path, name) {
    return `${domain || ""}${path}?${encodeURIComponent(name)}`;
  }
  /**
   * @param {Request} request
   * @param {URL} url
   */
  function get_cookies(request, url) {
    const header = request.headers.get("cookie") ?? "";
    const initial_cookies = cookieExports.parse(header, {
      decode: (value) => value,
    });
    /** @type {string | undefined} */
    let normalized_url;
    /** @type {Map<string, import('./page/types.js').Cookie>} */
    const new_cookies = /* @__PURE__ */ new Map();
    /** @type {import('cookie').CookieSerializeOptions} */
    const defaults = {
      httpOnly: true,
      sameSite: "lax",
      secure:
        url.hostname === "localhost" && url.protocol === "http:" ? false : true,
    };
    /** @type {import('@sveltejs/kit').Cookies} */
    const cookies = {
      /**
       * @param {string} name
       * @param {import('cookie').CookieParseOptions} [opts]
       */
      get(name, opts) {
        const best_match = Array.from(new_cookies.values())
          .filter((c) => {
            return (
              c.name === name &&
              domain_matches(url.hostname, c.options.domain) &&
              path_matches(url.pathname, c.options.path)
            );
          })
          .sort((a, b) => b.options.path.length - a.options.path.length)[0];
        if (best_match)
          return best_match.options.maxAge === 0 ? void 0 : best_match.value;
        return cookieExports.parse(header, { decode: opts?.decode })[name];
      },
      /**
       * @param {import('cookie').CookieParseOptions} [opts]
       */
      getAll(opts) {
        const cookies = cookieExports.parse(header, { decode: opts?.decode });
        const lookup = /* @__PURE__ */ new Map();
        for (const c of new_cookies.values())
          if (
            domain_matches(url.hostname, c.options.domain) &&
            path_matches(url.pathname, c.options.path)
          ) {
            const existing = lookup.get(c.name);
            if (
              !existing ||
              c.options.path.length > existing.options.path.length
            )
              lookup.set(c.name, c);
          }
        for (const c of lookup.values()) cookies[c.name] = c.value;
        return Object.entries(cookies).map(([name, value]) => ({
          name,
          value,
        }));
      },
      /**
       * @param {string} name
       * @param {string} value
       * @param {import('./page/types.js').Cookie['options']} options
       */
      set(name, value, options) {
        const illegal_characters = name.match(INVALID_COOKIE_CHARACTER_REGEX);
        if (illegal_characters)
          console.warn(
            `The cookie name "${name}" will be invalid in SvelteKit 3.0 as it contains ${illegal_characters.join(" and ")}. See RFC 2616 for more details https://datatracker.ietf.org/doc/html/rfc2616#section-2.2`,
          );
        validate_options(options);
        set_internal(name, value, {
          ...defaults,
          ...options,
        });
      },
      /**
       * @param {string} name
       *  @param {import('./page/types.js').Cookie['options']} options
       */
      delete(name, options) {
        validate_options(options);
        cookies.set(name, "", {
          ...options,
          maxAge: 0,
        });
      },
      /**
       * @param {string} name
       * @param {string} value
       *  @param {import('./page/types.js').Cookie['options']} options
       */
      serialize(name, value, options) {
        validate_options(options);
        let path = options.path;
        if (!options.domain || options.domain === url.hostname) {
          if (!normalized_url)
            throw new Error(
              "Cannot serialize cookies until after the route is determined",
            );
          path = resolve(normalized_url, path);
        }
        return cookieExports.serialize(name, value, {
          ...defaults,
          ...options,
          path,
        });
      },
    };
    /**
     * @param {URL} destination
     * @param {string | null} header
     */
    function get_cookie_header(destination, header) {
      /** @type {Record<string, string>} */
      const combined_cookies = { ...initial_cookies };
      for (const cookie of new_cookies.values()) {
        if (!domain_matches(destination.hostname, cookie.options.domain))
          continue;
        if (!path_matches(destination.pathname, cookie.options.path)) continue;
        const encoder = cookie.options.encode || encodeURIComponent;
        combined_cookies[cookie.name] = encoder(cookie.value);
      }
      if (header) {
        const parsed = cookieExports.parse(header, {
          decode: (value) => value,
        });
        for (const name in parsed) combined_cookies[name] = parsed[name];
      }
      return Object.entries(combined_cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    }
    /** @type {Array<() => void>} */
    const internal_queue = [];
    /**
     * @param {string} name
     * @param {string} value
     * @param {import('./page/types.js').Cookie['options']} options
     */
    function set_internal(name, value, options) {
      if (!normalized_url) {
        internal_queue.push(() => set_internal(name, value, options));
        return;
      }
      let path = options.path;
      if (!options.domain || options.domain === url.hostname)
        path = resolve(normalized_url, path);
      const cookie_key = generate_cookie_key(options.domain, path, name);
      const cookie = {
        name,
        value,
        options: {
          ...options,
          path,
        },
      };
      new_cookies.set(cookie_key, cookie);
    }
    /**
     * @param {import('types').TrailingSlash} trailing_slash
     */
    function set_trailing_slash(trailing_slash) {
      normalized_url = normalize_path(url.pathname, trailing_slash);
      internal_queue.forEach((fn) => fn());
    }
    return {
      cookies,
      new_cookies,
      get_cookie_header,
      set_internal,
      set_trailing_slash,
    };
  }
  /**
   * @param {string} hostname
   * @param {string} [constraint]
   */
  function domain_matches(hostname, constraint) {
    if (!constraint) return true;
    const normalized = constraint[0] === "." ? constraint.slice(1) : constraint;
    if (hostname === normalized) return true;
    return hostname.endsWith("." + normalized);
  }
  /**
   * @param {string} path
   * @param {string} [constraint]
   */
  function path_matches(path, constraint) {
    if (!constraint) return true;
    const normalized = constraint.endsWith("/")
      ? constraint.slice(0, -1)
      : constraint;
    if (path === normalized) return true;
    return path.startsWith(normalized + "/");
  }
  /**
   * @param {Headers} headers
   * @param {MapIterator<import('./page/types.js').Cookie>} cookies
   */
  function add_cookies_to_headers(headers, cookies) {
    for (const new_cookie of cookies) {
      const { name, value, options } = new_cookie;
      headers.append(
        "set-cookie",
        cookieExports.serialize(name, value, options),
      );
      if (options.path.endsWith(".html")) {
        const path = add_data_suffix(options.path);
        headers.append(
          "set-cookie",
          cookieExports.serialize(name, value, {
            ...options,
            path,
          }),
        );
      }
    }
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/fetch.js
  /**
   * @param {{
   *   event: import('@sveltejs/kit').RequestEvent;
   *   options: import('types').SSROptions;
   *   manifest: import('@sveltejs/kit').SSRManifest;
   *   state: import('types').SSRState;
   *   get_cookie_header: (url: URL, header: string | null) => string;
   *   set_internal: (name: string, value: string, opts: import('./page/types.js').Cookie['options']) => void;
   * }} opts
   * @returns {typeof fetch}
   */
  function create_fetch({
    event,
    options,
    manifest,
    state,
    get_cookie_header,
    set_internal,
  }) {
    /**
     * @type {typeof fetch}
     */
    const server_fetch = async (info, init) => {
      const original_request = normalize_fetch_input(info, init, event.url);
      let mode = (info instanceof Request ? info.mode : init?.mode) ?? "cors";
      let credentials =
        (info instanceof Request ? info.credentials : init?.credentials) ??
        "same-origin";
      return options.hooks.handleFetch({
        event,
        request: original_request,
        fetch: async (info, init) => {
          const request = normalize_fetch_input(info, init, event.url);
          const url = new URL(request.url);
          if (!request.headers.has("origin"))
            request.headers.set("origin", event.url.origin);
          if (info !== original_request) {
            mode = (info instanceof Request ? info.mode : init?.mode) ?? "cors";
            credentials =
              (info instanceof Request
                ? info.credentials
                : init?.credentials) ?? "same-origin";
          }
          if (
            (request.method === "GET" || request.method === "HEAD") &&
            ((mode === "no-cors" && url.origin !== event.url.origin) ||
              url.origin === event.url.origin)
          )
            request.headers.delete("origin");
          const decoded = decodeURIComponent(url.pathname);
          if (
            url.origin !== event.url.origin ||
            (base && decoded !== base && !decoded.startsWith(`${base}/`))
          ) {
            if (
              `.${url.hostname}`.endsWith(`.${event.url.hostname}`) &&
              credentials !== "omit"
            ) {
              const cookie = get_cookie_header(
                url,
                request.headers.get("cookie"),
              );
              if (cookie) request.headers.set("cookie", cookie);
            }
            return fetch(request);
          }
          const prefix = assets || base;
          const filename = (
            decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded
          ).slice(1);
          const filename_html = `${filename}/index.html`;
          const is_asset =
            manifest.assets.has(filename) ||
            filename in manifest._.server_assets;
          const is_asset_html =
            manifest.assets.has(filename_html) ||
            filename_html in manifest._.server_assets;
          if (is_asset || is_asset_html) {
            const file = is_asset ? filename : filename_html;
            if (state.read) {
              const type = is_asset
                ? manifest.mimeTypes[filename.slice(filename.lastIndexOf("."))]
                : "text/html";
              return new Response(state.read(file), {
                headers: type ? { "content-type": type } : {},
              });
            } else if (
              read_implementation &&
              file in manifest._.server_assets
            ) {
              const length = manifest._.server_assets[file];
              const type =
                manifest.mimeTypes[file.slice(file.lastIndexOf("."))];
              return new Response(read_implementation(file), {
                headers: {
                  "Content-Length": "" + length,
                  "Content-Type": type,
                },
              });
            }
            return await fetch(request);
          }
          if (has_prerendered_path(manifest, base + decoded))
            return await fetch(request);
          if (credentials !== "omit") {
            const cookie = get_cookie_header(
              url,
              request.headers.get("cookie"),
            );
            if (cookie) request.headers.set("cookie", cookie);
            const authorization = event.request.headers.get("authorization");
            if (authorization && !request.headers.has("authorization"))
              request.headers.set("authorization", authorization);
          }
          if (!request.headers.has("accept"))
            request.headers.set("accept", "*/*");
          if (!request.headers.has("accept-language"))
            request.headers.set(
              "accept-language",
              event.request.headers.get("accept-language"),
            );
          const response = await internal_fetch(
            request,
            options,
            manifest,
            state,
          );
          const set_cookie = response.headers.get("set-cookie");
          if (set_cookie)
            for (const str of splitCookiesString(set_cookie)) {
              const { name, value, ...options } = parseString(str, {
                decodeValues: false,
              });
              set_internal(name, value, {
                path:
                  options.path ??
                  (url.pathname.split("/").slice(0, -1).join("/") || "/"),
                encode: (value) => value,
                ...options,
              });
            }
          return response;
        },
      });
    };
    return (input, init) => {
      const response = server_fetch(input, init);
      response.catch(noop);
      return response;
    };
  }
  /**
   * @param {RequestInfo | URL} info
   * @param {RequestInit | undefined} init
   * @param {URL} url
   */
  function normalize_fetch_input(info, init, url) {
    if (info instanceof Request) return info;
    return new Request(
      typeof info === "string" ? new URL(info, url) : info,
      init,
    );
  }
  /**
   * @param {Request} request
   * @param {import('types').SSROptions} options
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @param {import('types').SSRState} state
   * @returns {Promise<Response>}
   */
  async function internal_fetch(request, options, manifest, state) {
    if (request.signal) {
      if (request.signal.aborted)
        throw new DOMException("The operation was aborted.", "AbortError");
      let remove_abort_listener = noop;
      /** @type {Promise<never>} */
      const abort_promise = new Promise((_, reject) => {
        const on_abort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        request.signal.addEventListener("abort", on_abort, { once: true });
        remove_abort_listener = () =>
          request.signal.removeEventListener("abort", on_abort);
      });
      const result = await Promise.race([
        respond(request, options, manifest, {
          ...state,
          depth: state.depth + 1,
        }),
        abort_promise,
      ]);
      remove_abort_listener();
      return result;
    } else
      return await respond(request, options, manifest, {
        ...state,
        depth: state.depth + 1,
      });
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/env_module.js
  /** @type {string} */
  var body;
  /** @type {string} */
  var etag;
  /** @type {Headers} */
  var headers;
  /**
   * @param {Request} request
   * @returns {Response}
   */
  function get_public_env(request) {
    body ??= `export const env=${JSON.stringify(public_env)}`;
    etag ??= `W/${Date.now()}`;
    headers ??= new Headers({
      "content-type": "application/javascript; charset=utf-8",
      etag,
    });
    if (request.headers.get("if-none-match") === etag)
      return new Response(void 0, {
        status: 304,
        headers,
      });
    return new Response(body, { headers });
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/respond.js
  /** @import { RequestState, SSRNode } from 'types' */
  /** @type {import('types').RequiredResolveOptions['transformPageChunk']} */
  var default_transform = ({ html }) => html;
  /** @type {import('types').RequiredResolveOptions['filterSerializedResponseHeaders']} */
  var default_filter = () => false;
  /** @type {import('types').RequiredResolveOptions['preload']} */
  var default_preload = ({ type }) => type === "js" || type === "css";
  var page_methods = new Set(["GET", "HEAD", "POST"]);
  var allowed_page_methods = new Set(["GET", "HEAD", "OPTIONS"]);
  var respond = propagate_context(internal_respond);
  /**
   * @param {Request} request
   * @param {import('types').SSROptions} options
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   * @param {import('types').SSRState} state
   * @returns {Promise<Response>}
   */
  async function internal_respond(request, options, manifest, state) {
    /** URL but stripped from the potential `/__data.json` suffix and its search param  */
    const url = new URL(request.url);
    const is_route_resolution_request = has_resolution_suffix(url.pathname);
    const is_data_request = has_data_suffix(url.pathname);
    const remote_id = get_remote_id(url);
    {
      const request_origin = request.headers.get("origin");
      if (remote_id) {
        if (request.method !== "GET" && request_origin !== url.origin)
          return json(
            { message: "Cross-site remote requests are forbidden" },
            { status: 403 },
          );
      } else if (options.csrf_check_origin) {
        if (
          is_form_content_type(request) &&
          (request.method === "POST" ||
            request.method === "PUT" ||
            request.method === "PATCH" ||
            request.method === "DELETE") &&
          request_origin !== url.origin &&
          (!request_origin ||
            !options.csrf_trusted_origins.includes(request_origin))
        ) {
          const message = `Cross-site ${request.method} form submissions are forbidden`;
          const opts = { status: 403 };
          if (request.headers.get("accept") === "application/json")
            return json({ message }, opts);
          return text(message, opts);
        }
      }
    }
    if (
      options.hash_routing &&
      url.pathname !== base + "/" &&
      url.pathname !== "/[fallback]"
    )
      return text("Not found", { status: 404 });
    /** @type {boolean[] | undefined} */
    let invalidated_data_nodes;
    if (is_route_resolution_request)
      /**
       * If the request is for a route resolution, first modify the URL, then continue as normal
       * for path resolution, then return the route object as a JS file.
       */
      url.pathname = strip_resolution_suffix(url.pathname);
    else if (is_data_request) {
      url.pathname =
        strip_data_suffix(url.pathname) +
          (url.searchParams.get("x-sveltekit-trailing-slash") === "1"
            ? "/"
            : "") || "/";
      url.searchParams.delete(TRAILING_SLASH_PARAM);
      invalidated_data_nodes = url.searchParams
        .get(INVALIDATED_PARAM)
        ?.split("")
        .map((node) => node === "1");
      url.searchParams.delete(INVALIDATED_PARAM);
    } else if (remote_id) {
      url.pathname = request.headers.get("x-sveltekit-pathname") ?? base;
      url.search = request.headers.get("x-sveltekit-search") ?? "";
    }
    /** @type {Record<string, string>} */
    const headers = {};
    const {
      cookies,
      new_cookies,
      get_cookie_header,
      set_internal,
      set_trailing_slash,
    } = get_cookies(request, url);
    /** @type {RequestState} */
    const event_state = {
      prerendering: state.prerendering,
      transport: options.hooks.transport,
      handleValidationError: options.hooks.handleValidationError,
      tracing: { record_span },
      remote: {
        data: null,
        forms: null,
        /** A map of remote function key to corresponding single-flight-mutation promise */
        refreshes: null,
        reconnects: null,
        /** A map of remote function ID to payloads requested for refreshing by the client */
        requested: null,
      },
      is_in_remote_function: false,
      is_in_render: false,
      is_in_universal_load: false,
    };
    /** @type {import('@sveltejs/kit').RequestEvent} */
    const event = {
      cookies,
      fetch: null,
      getClientAddress:
        state.getClientAddress ||
        (() => {
          throw new Error(
            `@slate/adapter-quickjs does not specify getClientAddress. Please raise an issue`,
          );
        }),
      locals: {},
      params: {},
      platform: state.platform,
      request,
      route: { id: null },
      setHeaders: (new_headers) => {
        for (const key in new_headers) {
          const lower = key.toLowerCase();
          const value = new_headers[key];
          if (lower === "set-cookie")
            throw new Error(
              "Use `event.cookies.set(name, value, options)` instead of `event.setHeaders` to set cookies",
            );
          else if (lower in headers)
            if (lower === "server-timing") headers[lower] += ", " + value;
            else throw new Error(`"${key}" header is already set`);
          else {
            headers[lower] = value;
            if (state.prerendering && lower === "cache-control")
              state.prerendering.cache = value;
          }
        }
      },
      url,
      isDataRequest: is_data_request,
      isSubRequest: state.depth > 0,
      isRemoteRequest: !!remote_id,
    };
    event.fetch = create_fetch({
      event,
      options,
      manifest,
      state,
      get_cookie_header,
      set_internal,
    });
    if (state.emulator?.platform)
      event.platform = await state.emulator.platform({
        config: {},
        prerender: !!state.prerendering?.fallback,
      });
    let resolved_path = url.pathname;
    if (!remote_id) {
      const prerendering_reroute_state = state.prerendering?.inside_reroute;
      try {
        if (state.prerendering) state.prerendering.inside_reroute = true;
        resolved_path =
          (await options.hooks.reroute({
            url: new URL(url),
            fetch: event.fetch,
          })) ?? url.pathname;
      } catch {
        return text("Internal Server Error", { status: 500 });
      } finally {
        if (state.prerendering)
          state.prerendering.inside_reroute = prerendering_reroute_state;
      }
    }
    try {
      resolved_path = decode_pathname(resolved_path);
    } catch {
      return text("Malformed URI", { status: 400 });
    }
    if (
      resolved_path !== decode_pathname(url.pathname) &&
      !state.prerendering?.fallback &&
      has_prerendered_path(manifest, resolved_path)
    ) {
      const url = new URL(request.url);
      url.pathname = is_data_request
        ? add_data_suffix(resolved_path)
        : is_route_resolution_request
          ? add_resolution_suffix(resolved_path)
          : resolved_path;
      try {
        const response = await fetch(url, request);
        const headers = new Headers(response.headers);
        if (headers.has("content-encoding")) {
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        return new Response(response.body, {
          headers,
          status: response.status,
          statusText: response.statusText,
        });
      } catch (error) {
        return await handle_fatal_error(event, event_state, options, error);
      }
    }
    /** @type {import('types').SSRRoute | null} */
    let route = null;
    if (base && !state.prerendering?.fallback) {
      if (!resolved_path.startsWith(base))
        return text("Not found", { status: 404 });
      resolved_path = resolved_path.slice(base.length) || "/";
    }
    if (is_route_resolution_request)
      return resolve_route(resolved_path, new URL(request.url), manifest);
    if (resolved_path === `/_app/env.js`) return get_public_env(request);
    if (!remote_id && resolved_path.startsWith(`/_app`)) {
      const headers = new Headers();
      headers.set("cache-control", "public, max-age=0, must-revalidate");
      return text("Not found", {
        status: 404,
        headers,
      });
    }
    if (!state.prerendering?.fallback) {
      const matchers = await manifest._.matchers();
      const result = find_route(resolved_path, manifest._.routes, matchers);
      if (result) {
        route = result.route;
        event.route = { id: route.id };
        event.params = result.params;
      }
    }
    /** @type {import('types').RequiredResolveOptions} */
    let resolve_opts = {
      transformPageChunk: default_transform,
      filterSerializedResponseHeaders: default_filter,
      preload: default_preload,
    };
    /** @type {import('types').TrailingSlash} */
    let trailing_slash = "never";
    try {
      /** @type {PageNodes | undefined} */
      const page_nodes = route?.page
        ? new PageNodes(await load_page_nodes(route.page, manifest))
        : void 0;
      if (route && !remote_id) {
        if (url.pathname === base || url.pathname === base + "/")
          trailing_slash = "always";
        else if (page_nodes) trailing_slash = page_nodes.trailing_slash();
        else if (route.endpoint)
          trailing_slash = (await route.endpoint()).trailingSlash ?? "never";
        if (!is_data_request) {
          const normalized = normalize_path(url.pathname, trailing_slash);
          if (normalized !== url.pathname && !state.prerendering?.fallback)
            return new Response(void 0, {
              status: 308,
              headers: {
                "x-sveltekit-normalize": "1",
                location:
                  (normalized.startsWith("//")
                    ? url.origin + normalized
                    : normalized) + (url.search === "?" ? "" : url.search),
              },
            });
        }
        if (state.before_handle || state.emulator?.platform) {
          let config = {};
          /** @type {import('types').PrerenderOption} */
          let prerender = false;
          if (route.endpoint) {
            const node = await route.endpoint();
            config = node.config ?? config;
            prerender = node.prerender ?? prerender;
          } else if (page_nodes) {
            config = page_nodes.get_config() ?? config;
            prerender = page_nodes.prerender();
          }
          if (state.before_handle)
            state.before_handle(event, config, prerender);
          if (state.emulator?.platform)
            event.platform = await state.emulator.platform({
              config,
              prerender,
            });
        }
      }
      set_trailing_slash(trailing_slash);
      if (
        state.prerendering &&
        !state.prerendering.fallback &&
        !state.prerendering.inside_reroute
      )
        disable_search(url);
      const response = await record_span({
        name: "sveltekit.handle.root",
        attributes: {
          "http.route": event.route.id || "unknown",
          "http.method": event.request.method,
          "http.url": event.url.href,
          "sveltekit.is_data_request": is_data_request,
          "sveltekit.is_sub_request": event.isSubRequest,
        },
        fn: async (root_span) => {
          const traced_event = {
            ...event,
            tracing: {
              enabled: false,
              root: root_span,
              current: root_span,
            },
          };
          return await with_request_store(
            {
              event: traced_event,
              state: event_state,
            },
            () =>
              options.hooks.handle({
                event: traced_event,
                resolve: (event, opts) => {
                  return record_span({
                    name: "sveltekit.resolve",
                    attributes: { "http.route": event.route.id || "unknown" },
                    fn: (resolve_span) => {
                      return with_request_store(null, () =>
                        resolve(
                          merge_tracing(event, resolve_span),
                          page_nodes,
                          opts,
                        ).then((response) => {
                          for (const key in headers) {
                            const value = headers[key];
                            response.headers.set(key, value);
                          }
                          add_cookies_to_headers(
                            response.headers,
                            new_cookies.values(),
                          );
                          if (state.prerendering && event.route.id !== null)
                            response.headers.set(
                              "x-sveltekit-routeid",
                              encodeURI(event.route.id),
                            );
                          resolve_span.setAttributes({
                            "http.response.status_code": response.status,
                            "http.response.body.size":
                              response.headers.get("content-length") ||
                              "unknown",
                          });
                          return response;
                        }),
                      );
                    },
                  });
                },
              }),
          );
        },
      });
      if (response.status === 200 && response.headers.has("etag")) {
        let if_none_match_value = request.headers.get("if-none-match");
        if (if_none_match_value?.startsWith('W/"'))
          if_none_match_value = if_none_match_value.substring(2);
        const etag = response.headers.get("etag");
        if (if_none_match_value === etag) {
          const headers = new Headers({ etag });
          for (const key of [
            "cache-control",
            "content-location",
            "date",
            "expires",
            "vary",
            "set-cookie",
          ]) {
            const value = response.headers.get(key);
            if (value) headers.set(key, value);
          }
          return new Response(void 0, {
            status: 304,
            headers,
          });
        }
      }
      if (is_data_request && response.status >= 300 && response.status <= 308) {
        const location = response.headers.get("location");
        if (location)
          return redirect_json_response(
            new Redirect(response.status, location),
          );
      }
      return response;
    } catch (e) {
      if (e instanceof Redirect)
        try {
          const response =
            is_data_request || remote_id
              ? redirect_json_response(e)
              : route?.page && is_action_json_request(event)
                ? action_json_redirect(e)
                : redirect_response(e.status, e.location);
          add_cookies_to_headers(response.headers, new_cookies.values());
          return response;
        } catch (err) {
          return await handle_fatal_error(event, event_state, options, err);
        }
      return await handle_fatal_error(event, event_state, options, e);
    }
    /**
     * @param {import('@sveltejs/kit').RequestEvent} event
     * @param {PageNodes | undefined} page_nodes
     * @param {import('@sveltejs/kit').ResolveOptions} [opts]
     */
    async function resolve(event, page_nodes, opts) {
      try {
        if (opts)
          resolve_opts = {
            transformPageChunk: opts.transformPageChunk || default_transform,
            filterSerializedResponseHeaders:
              opts.filterSerializedResponseHeaders || default_filter,
            preload: opts.preload || default_preload,
          };
        if (options.hash_routing || state.prerendering?.fallback)
          return await render_response({
            event,
            event_state,
            options,
            manifest,
            state,
            page_config: {
              ssr: false,
              csr: true,
            },
            status: 200,
            error: null,
            branch: [
              {
                node: await manifest._.nodes[0](),
                data: null,
                server_data: null,
              },
            ],
            fetched: [],
            resolve_opts,
            data_serializer: server_data_serializer(
              event,
              event_state,
              options,
            ),
          });
        if (remote_id)
          return await handle_remote_call(
            event,
            event_state,
            options,
            manifest,
            remote_id,
          );
        if (route) {
          const method = event.request.method;
          /** @type {Response} */
          let response;
          if (is_data_request)
            response = await render_data(
              event,
              event_state,
              route,
              options,
              manifest,
              state,
              invalidated_data_nodes,
              trailing_slash,
            );
          else if (
            route.endpoint &&
            (!route.page || is_endpoint_request(event))
          )
            response = await render_endpoint(
              event,
              event_state,
              await route.endpoint(),
              state,
            );
          else if (route.page)
            if (!page_nodes)
              throw new Error("page_nodes not found. This should never happen");
            else if (page_methods.has(method))
              response = await render_page(
                event,
                event_state,
                route.page,
                options,
                manifest,
                state,
                page_nodes,
                resolve_opts,
              );
            else {
              const allowed_methods = new Set(allowed_page_methods);
              if ((await manifest._.nodes[route.page.leaf]())?.server?.actions)
                allowed_methods.add("POST");
              if (method === "OPTIONS")
                response = new Response(null, {
                  status: 204,
                  headers: {
                    allow: Array.from(allowed_methods.values()).join(", "),
                  },
                });
              else
                response = method_not_allowed(
                  [...allowed_methods].reduce((acc, curr) => {
                    acc[curr] = true;
                    return acc;
                  }, {}),
                  method,
                );
            }
          else
            throw new Error(
              "Route is neither page nor endpoint. This should never happen",
            );
          if (request.method === "GET" && route.page && route.endpoint) {
            const vary = response.headers
              .get("vary")
              ?.split(",")
              ?.map((v) => v.trim().toLowerCase());
            if (!(vary?.includes("accept") || vary?.includes("*"))) {
              response = new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: new Headers(response.headers),
              });
              response.headers.append("Vary", "Accept");
            }
          }
          return response;
        }
        if (state.error && event.isSubRequest) {
          const headers = new Headers(request.headers);
          headers.set("x-sveltekit-error", "true");
          return await fetch(request, { headers });
        }
        if (state.error) return text("Internal Server Error", { status: 500 });
        if (state.depth === 0)
          return await respond_with_error({
            event,
            event_state,
            options,
            manifest,
            state,
            status: 404,
            error: new SvelteKitError(
              404,
              "Not Found",
              `Not found: ${event.url.pathname}`,
            ),
            resolve_opts,
          });
        if (state.prerendering) return text("not found", { status: 404 });
        const response = await fetch(request);
        return new Response(response.body, response);
      } catch (e) {
        return await handle_fatal_error(event, event_state, options, e);
      } finally {
        event.cookies.set = () => {
          throw new Error(
            "Cannot use `cookies.set(...)` after the response has been generated",
          );
        };
        event.setHeaders = () => {
          throw new Error(
            "Cannot use `setHeaders(...)` after the response has been generated",
          );
        };
      }
    }
  }
  /**
   * @param {import('types').PageNodeIndexes} page
   * @param {import('@sveltejs/kit').SSRManifest} manifest
   */
  function load_page_nodes(page, manifest) {
    return Promise.all([
      ...page.layouts.map((n) => (n == void 0 ? n : manifest._.nodes[n]())),
      manifest._.nodes[page.leaf](),
    ]);
  }
  /**
   * It's likely that, in a distributed system, there are spans starting outside the SvelteKit server -- eg.
   * started on the frontend client, or in a service that calls the SvelteKit server. There are standardized
   * ways to represent this context in HTTP headers, so we can extract that context and run our tracing inside of it
   * so that when our traces are exported, they are associated with the correct parent context.
   * @param {typeof internal_respond} fn
   * @returns {typeof internal_respond}
   */
  function propagate_context(fn) {
    return async (req, ...rest) => {
      return fn(req, ...rest);
    };
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/utils/env.js
  /**
   * @param {Record<string, string>} env
   * @param {string} allowed
   * @param {string} disallowed
   * @returns {Record<string, string>}
   */
  function filter_env(env, allowed, disallowed) {
    return Object.fromEntries(
      Object.entries(env).filter(
        ([k]) =>
          k.startsWith(allowed) &&
          (disallowed === "" || !k.startsWith(disallowed)),
      ),
    );
  }
  /**
   * @param {{ decoders: Record<string, (data: any) => any> }} value
   */
  function set_app(value) {}
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/server/index.js
  /** @import { PromiseWithResolvers } from '../../utils/promise.js' */
  /** @type {Promise<any>} */
  var init_promise;
  /** @type {Promise<void> | null} */
  var current = null;
  var Server = class {
    /** @type {import('types').SSROptions} */
    #options;
    /** @type {import('@sveltejs/kit').SSRManifest} */
    #manifest;
    /** @param {import('@sveltejs/kit').SSRManifest} manifest */
    constructor(manifest) {
      /** @type {import('types').SSROptions} */
      this.#options = options;
      this.#manifest = manifest;
      if (IN_WEBCONTAINER) {
        const respond = this.respond.bind(this);
        /** @type {typeof respond} */
        this.respond = async (...args) => {
          const { promise, resolve } = with_resolvers();
          const previous = current;
          current = promise;
          await previous;
          return respond(...args).finally(resolve);
        };
      }
    }
    /**
     * @param {import('@sveltejs/kit').ServerInitOptions} opts
     */
    async init({ env, read }) {
      const { env_public_prefix, env_private_prefix } = this.#options;
      set_private_env(filter_env(env, env_private_prefix, env_public_prefix));
      set_public_env(filter_env(env, env_public_prefix, env_private_prefix));
      if (read) {
        /** @param {string} file */
        const wrapped_read = (file) => {
          const result = read(file);
          if (result instanceof ReadableStream) return result;
          else
            return new ReadableStream({
              async start(controller) {
                try {
                  const stream = await Promise.resolve(result);
                  if (!stream) {
                    controller.close();
                    return;
                  }
                  const reader = stream.getReader();
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    controller.enqueue(value);
                  }
                  controller.close();
                } catch (error) {
                  controller.error(error);
                }
              },
            });
        };
        set_read_implementation(wrapped_read);
      }
      await (init_promise ??= (async () => {
        try {
          const module = await get_hooks();
          this.#options.hooks = {
            handle: module.handle || (({ event, resolve }) => resolve(event)),
            handleError:
              module.handleError ||
              (({ status, error, event }) => {
                const error_message = format_server_error(status, error, event);
                console.error(error_message);
              }),
            handleFetch:
              module.handleFetch || (({ request, fetch }) => fetch(request)),
            handleValidationError:
              module.handleValidationError ||
              (({ issues }) => {
                console.error(
                  "Remote function schema validation failed:",
                  issues,
                );
                return { message: "Bad Request" };
              }),
            reroute: module.reroute || noop,
            transport: module.transport || {},
          };
          set_app({
            decoders: module.transport
              ? Object.fromEntries(
                  Object.entries(module.transport).map(([k, v]) => [
                    k,
                    v.decode,
                  ]),
                )
              : {},
          });
          if (module.init) await module.init();
        } catch (e) {
          throw e;
        }
      })());
    }
    /**
     * @param {Request} request
     * @param {import('types').RequestOptions} options
     */
    async respond(request, options) {
      return respond(request, this.#options, this.#manifest, {
        ...options,
        error: false,
        depth: 0,
      });
    }
  };

  const manifest = (() => {
    function __memo(fn) {
      let value;
      return () => (value ??= value = fn());
    }

    return {
      appDir: "_app",
      appPath: "_app",
      assets: new Set(["robots.txt"]),
      mimeTypes: { ".txt": "text/plain" },
      _: {
        client: {
          start: "_app/immutable/entry/start.BpoTxqFR.js",
          app: "_app/immutable/entry/app.BRo-2o5s.js",
          imports: [
            "_app/immutable/entry/start.BpoTxqFR.js",
            "_app/immutable/chunks/CPHkRnRQ.js",
            "_app/immutable/chunks/D4lhcwCg.js",
            "_app/immutable/entry/app.BRo-2o5s.js",
            "_app/immutable/chunks/D4lhcwCg.js",
            "_app/immutable/chunks/Dj6f-nJM.js",
            "_app/immutable/chunks/DEDqjojZ.js",
          ],
          stylesheets: [],
          fonts: [],
          uses_env_dynamic_public: false,
        },
        nodes: [
          __memo(() => Promise.resolve().then(() => _0)),
          __memo(() => Promise.resolve().then(() => _1)),
          __memo(() => Promise.resolve().then(() => _2)),
        ],
        remotes: {},
        routes: [
          {
            id: "/",
            pattern: /^\/$/,
            params: [],
            page: { layouts: [0], errors: [1], leaf: 2 },
            endpoint: null,
          },
        ],
        prerendered_routes: new Set([]),
        matchers: async () => {
          return {};
        },
        server_assets: {},
      },
    };
  })();

  // @slate/adapter-quickjs — server entry (bundled to IIFE)
  // This file is the temporary rollup entry point.
  // After bundling, the output is a single IIFE entry.js with no imports.

  // ━━ Headers ━━
  if (typeof Headers === "undefined") {
    globalThis.Headers = class Headers {
      constructor(init) {
        this._list = [];
        if (init) {
          if (init instanceof Headers) {
            init._list.forEach((entry) => this._list.push([entry[0], entry[1]]));
          } else if (Array.isArray(init)) {
            for (let i = 0; i < init.length; i++) {
              this._list.push([String(init[i][0]).toLowerCase(), String(init[i][1])]);
            }
          } else if (typeof init === "object") {
            const keys = Object.keys(init);
            for (let i = 0; i < keys.length; i++) {
              this._list.push([keys[i].toLowerCase(), String(init[keys[i]])]);
            }
          }
        }
      }
      get(name) {
        const n = name.toLowerCase();
        if (n === 'set-cookie') {
          for (let i = 0; i < this._list.length; i++) { if (this._list[i][0] === n) return this._list[i][1]; }
          return null;
        }
        const values = [];
        for (let i = 0; i < this._list.length; i++) { if (this._list[i][0] === n) values.push(this._list[i][1]); }
        return values.length > 0 ? values.join(', ') : null;
      }
      set(name, value) { const n = name.toLowerCase(); this._list = this._list.filter((e) => e[0] !== n); this._list.push([n, String(value)]); }
      has(name) { const n = name.toLowerCase(); for (let i = 0; i < this._list.length; i++) { if (this._list[i][0] === n) return true; } return false; }
      delete(name) { const n = name.toLowerCase(); this._list = this._list.filter((e) => e[0] !== n); }
      append(name, value) { this._list.push([name.toLowerCase(), String(value)]); }
      entries() { return this._list[Symbol.iterator](); }
      keys() { const seen = {}, result = []; for (let i = 0; i < this._list.length; i++) { if (!seen[this._list[i][0]]) { seen[this._list[i][0]] = true; result.push(this._list[i][0]); } } return result[Symbol.iterator](); }
      values() { return this._list.map((e) => e[1])[Symbol.iterator](); }
      [Symbol.iterator]() { return this._list[Symbol.iterator](); }
      forEach(cb) { for (let i = 0; i < this._list.length; i++) { cb(this._list[i][1], this._list[i][0], this); } }
      getSetCookie() { return this._list.filter((e) => e[0] === 'set-cookie').map((e) => e[1]); }
    };
  }

  // ━━ Request ━━
  if (typeof Request === "undefined") {
    globalThis.Request = class Request {
      constructor(input, init = {}) {
        if (input instanceof Request) {
          this.url = input.url;
          this.method = init.method || input.method;
          this.headers = new Headers(init.headers || input.headers);
          this._body = init.body !== undefined ? init.body : input._body;
        } else {
          this.url = typeof input === "string" ? input : String(input);
          this.method = init.method || "GET";
          this.headers = new Headers(init.headers || {});
          this._body = init.body || null;
        }
      }
      async json() {
        return JSON.parse(typeof this._body === "string" ? this._body : "");
      }
      async text() {
        return typeof this._body === "string" ? this._body : "";
      }
      async arrayBuffer() {
        const str = typeof this._body === "string" ? this._body : "";
        const buf = new ArrayBuffer(str.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
        return buf;
      }
      clone() {
        return new Request(this.url, {
          method: this.method,
          headers: this.headers,
          body: this._body,
        });
      }
    };
  }

  // ━━ Response ━━
  if (typeof Response === "undefined") {
    globalThis.Response = class Response {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status || 200;
        this.headers = new Headers(init.headers || {});
        this.ok = this.status >= 200 && this.status < 300;
        this.type = "default";
        this.redirected = false;
        this.url = "";
      }
      async json() {
        return JSON.parse(typeof this.body === "string" ? this.body : "");
      }
      async text() {
        return typeof this.body === "string" ? this.body : "";
      }
      async arrayBuffer() {
        if (this.body instanceof ArrayBuffer) return this.body;
        const str = typeof this.body === "string" ? this.body : "";
        const buf = new ArrayBuffer(str.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
        return buf;
      }
      clone() {
        return new Response(this.body, {
          status: this.status,
          headers: this.headers,
        });
      }
      static json(data, init = {}) {
        const body = JSON.stringify(data);
        return new Response(body, {
          status: init.status || 200,
          headers: { "content-type": "application/json", ...init.headers },
        });
      }
      static redirect(url, status = 302) {
        const res = new Response(null, { status });
        res.headers.set("location", url);
        return res;
      }
    };
  }

  // ━━ TextEncoder / TextDecoder ━━
  // Native implementations are injected by Rust BEFORE eval.
  // If Rust didn't inject them, provide JS fallbacks.
  if (typeof TextEncoder === "undefined") {
    globalThis.TextEncoder = class TextEncoder {
      encode(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
          const code = str.charCodeAt(i);
          if (code < 0x80) bytes.push(code);
          else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
          } else {
            bytes.push(
              0xe0 | (code >> 12),
              0x80 | ((code >> 6) & 0x3f),
              0x80 | (code & 0x3f),
            );
          }
        }
        return new Uint8Array(bytes);
      }
    };
  }
  if (typeof TextDecoder === "undefined") {
    globalThis.TextDecoder = class TextDecoder {
      decode(bytes) {
        if (!bytes) return "";
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let str = "";
        for (let i = 0; i < arr.length; i++) {
          str += String.fromCharCode(arr[i]);
        }
        return decodeURIComponent(escape(str));
      }
    };
  }

  // ━━ URL / URLSearchParams ━━
  // Injected by Rust polyfills before this IIFE evals.
  // If somehow still missing (e.g. running outside slate-ssr), provide fallback.
  // NOTE: Using new RegExp() instead of regex literals to avoid conflicts
  // with template string escaping in generateServerEntry().
  if (typeof URL === "undefined") {
    var _reAbsolute = new RegExp("^[a-zA-Z]+:");
    globalThis.URL = function URL(url, base) {
      if (base && !_reAbsolute.test(url)) {
        if (!_reAbsolute.test(base)) base = "http://localhost" + base;
        url = base.replace(new RegExp("[^/]*$"), "") + url;
      }
      if (!_reAbsolute.test(url)) url = "http://localhost" + url;
      this._url = url;
      var r = new RegExp(
        "^([a-zA-Z]+):..([^/:?#]*)(?::(d+))?([^?#]*)(\?[^#]*)?(#.*)?$",
      ).exec(url);
      this.protocol = r[1] + ":";
      this.hostname = r[2];
      this.port = r[3] || "";
      this.host = this.hostname + (this.port ? ":" + this.port : "");
      this.origin = this.protocol + "//" + this.host;
      this.pathname = r[4] || "/";
      this.search = r[5] || "";
      this.hash = r[6] || "";
      this.href = url;
    };
    URL.prototype.toString = function () {
      return this.href;
    };
  }
  if (typeof URLSearchParams === "undefined") {
    globalThis.URLSearchParams = function URLSearchParams(init) {
      this._params = [];
      if (typeof init === "string") {
        init = init.replace(new RegExp("^\?"), "");
        if (init)
          init.split("&").forEach(
            function (p) {
              var kv = p.split("=");
              this._params.push([
                decodeURIComponent(kv[0]),
                decodeURIComponent(kv[1] || ""),
              ]);
            }.bind(this),
          );
      }
    };
    URLSearchParams.prototype.get = function (n) {
      for (var i = 0; i < this._params.length; i++)
        if (this._params[i][0] === n) return this._params[i][1];
      return null;
    };
    URLSearchParams.prototype.has = function (n) {
      return this._params.some(function (p) {
        return p[0] === n;
      });
    };
    URLSearchParams.prototype.toString = function () {
      return this._params
        .map(function (p) {
          return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]);
        })
        .join("&");
    };
  }

  // ━━ console ━━
  // QuickJS has console built-in, so this is rarely needed.
  if (typeof console === "undefined") {
    globalThis.console = {
      log:
        typeof __rust_console_log !== "undefined"
          ? __rust_console_log
          : function () {},
      error:
        typeof __rust_console_log !== "undefined"
          ? __rust_console_log
          : function () {},
      warn:
        typeof __rust_console_log !== "undefined"
          ? __rust_console_log
          : function () {},
    };
  }

  // ━━ globalThis.fetch Override ━━
  // MUST be set before Server init, because SvelteKit's Server
  // calls fetch during initialization for route resolution.
  globalThis.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || String(input);
    const method = init?.method || "GET";
    const body = init?.body || null;
    const headers = init?.headers || {};

    // Absolute URL → reqwest (external HTTP)
    if (url.startsWith("https://") || url.startsWith("http://")) {
      const result = await __rust_http_fetch(url, method, body, headers);
      return new Response(result.body, {
        status: result.status,
        headers: new Headers(result.headers),
      });
    }

    // Relative path → Salvo internal dispatch (zero HTTP)
    const result = await __rust_internal_dispatch(method, url, body, headers);
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  };

  const server = new Server(manifest);

  // IIFE does not support top-level await, so we store the init promise
  // and await it inside __render before handling any requests.
  // QuickJS may not reliably drive async init via ??= pattern,
  // so we also provide a manual fallback to ensure hooks are set.
  const _initPromise = server.init({
    env: globalThis.__env || {},
  });

  // Track whether init completed successfully
  var _initDone = false;

  // ━━ __render Entry Point ━━
  // Called by SsrEngine::render() for each SSR request.
  globalThis.__render = async function (request) {
    // Ensure server.init() has completed before responding.
    // On the first call this actually awaits; subsequent calls
    // resolve immediately because the promise is already settled.
    if (!_initDone) {
      try {
        await _initPromise;
      } catch (e) {
        // Init may fail due to QuickJS async limitations.
        // The hooks fallback below will handle this.
      }
      _initDone = true;
    }

    const webRequest = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers || {}),
      body: request.body || undefined,
    });

    const response = await server.respond(webRequest, {
      getClientAddress: () => request.remote_addr || "127.0.0.1",
    });

    // Extract body: response.text() may return empty if body is Uint8Array
    // (native TextEncoder.encode returns TypedArray, Response polyfill may not handle it)
    var body;
    try {
      body = await response.text();
    } catch (e) {}
    if (!body && response.body) {
      if (typeof response.body === "string") body = response.body;
      else if (response.body instanceof Uint8Array)
        body = String.fromCharCode.apply(null, response.body);
    }

    var hdrs = [];
    response.headers.forEach(function(v, k) {
      hdrs.push([k, v]);
    });

    return {
      status: response.status,
      headers: hdrs,
      body: body || "",
    };
  };

  const index$2 = 0;
  let component_cache$2;
  const component$2 = async () =>
    (component_cache$2 ??= (await Promise.resolve().then(() => _layout_svelte))
      .default);
  const imports$2 = [
    "_app/immutable/nodes/0.C7PB7s1P.js",
    "_app/immutable/chunks/D4lhcwCg.js",
    "_app/immutable/chunks/DEDqjojZ.js",
  ];
  const stylesheets$2 = [];
  const fonts$2 = [];

  const _0 = /*#__PURE__*/ Object.freeze(
    /*#__PURE__*/ Object.defineProperty(
      {
        __proto__: null,
        component: component$2,
        fonts: fonts$2,
        imports: imports$2,
        index: index$2,
        stylesheets: stylesheets$2,
      },
      Symbol.toStringTag,
      { value: "Module" },
    ),
  );

  const index$1 = 1;
  let component_cache$1;
  const component$1 = async () =>
    (component_cache$1 ??= (await Promise.resolve().then(() => error_svelte))
      .default);
  const imports$1 = [
    "_app/immutable/nodes/1.DBzjzGnp.js",
    "_app/immutable/chunks/D4lhcwCg.js",
    "_app/immutable/chunks/CPHkRnRQ.js",
    "_app/immutable/chunks/DEDqjojZ.js",
  ];
  const stylesheets$1 = [];
  const fonts$1 = [];

  const _1 = /*#__PURE__*/ Object.freeze(
    /*#__PURE__*/ Object.defineProperty(
      {
        __proto__: null,
        component: component$1,
        fonts: fonts$1,
        imports: imports$1,
        index: index$1,
        stylesheets: stylesheets$1,
      },
      Symbol.toStringTag,
      { value: "Module" },
    ),
  );

  const index = 2;
  let component_cache;
  const component = async () =>
    (component_cache ??= (await Promise.resolve().then(() => _page_svelte))
      .default);
  const imports = [
    "_app/immutable/nodes/2.DkILpycR.js",
    "_app/immutable/chunks/D4lhcwCg.js",
    "_app/immutable/chunks/DEDqjojZ.js",
  ];
  const stylesheets = [];
  const fonts = [];

  const _2 = /*#__PURE__*/ Object.freeze(
    /*#__PURE__*/ Object.defineProperty(
      {
        __proto__: null,
        component,
        fonts,
        imports,
        index,
        stylesheets,
      },
      Symbol.toStringTag,
      { value: "Module" },
    ),
  );

  //#region src/lib/assets/favicon.svg
  var favicon_default =
    "data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20width='107'%20height='128'%20viewBox='0%200%20107%20128'%3e%3ctitle%3esvelte-logo%3c/title%3e%3cpath%20d='M94.157%2022.819c-10.4-14.885-30.94-19.297-45.792-9.835L22.282%2029.608A29.92%2029.92%200%200%200%208.764%2049.65a31.5%2031.5%200%200%200%203.108%2020.231%2030%2030%200%200%200-4.477%2011.183%2031.9%2031.9%200%200%200%205.448%2024.116c10.402%2014.887%2030.942%2019.297%2045.791%209.835l26.083-16.624A29.92%2029.92%200%200%200%2098.235%2078.35a31.53%2031.53%200%200%200-3.105-20.232%2030%2030%200%200%200%204.474-11.182%2031.88%2031.88%200%200%200-5.447-24.116'%20style='fill:%23ff3e00'/%3e%3cpath%20d='M45.817%20106.582a20.72%2020.72%200%200%201-22.237-8.243%2019.17%2019.17%200%200%201-3.277-14.503%2018%2018%200%200%201%20.624-2.435l.49-1.498%201.337.981a33.6%2033.6%200%200%200%2010.203%205.098l.97.294-.09.968a5.85%205.85%200%200%200%201.052%203.878%206.24%206.24%200%200%200%206.695%202.485%205.8%205.8%200%200%200%201.603-.704L69.27%2076.28a5.43%205.43%200%200%200%202.45-3.631%205.8%205.8%200%200%200-.987-4.371%206.24%206.24%200%200%200-6.698-2.487%205.7%205.7%200%200%200-1.6.704l-9.953%206.345a19%2019%200%200%201-5.296%202.326%2020.72%2020.72%200%200%201-22.237-8.243%2019.17%2019.17%200%200%201-3.277-14.502%2017.99%2017.99%200%200%201%208.13-12.052l26.081-16.623a19%2019%200%200%201%205.3-2.329%2020.72%2020.72%200%200%201%2022.237%208.243%2019.17%2019.17%200%200%201%203.277%2014.503%2018%2018%200%200%201-.624%202.435l-.49%201.498-1.337-.98a33.6%2033.6%200%200%200-10.203-5.1l-.97-.294.09-.968a5.86%205.86%200%200%200-1.052-3.878%206.24%206.24%200%200%200-6.696-2.485%205.8%205.8%200%200%200-1.602.704L37.73%2051.72a5.42%205.42%200%200%200-2.449%203.63%205.79%205.79%200%200%200%20.986%204.372%206.24%206.24%200%200%200%206.698%202.486%205.8%205.8%200%200%200%201.602-.704l9.952-6.342a19%2019%200%200%201%205.295-2.328%2020.72%2020.72%200%200%201%2022.237%208.242%2019.17%2019.17%200%200%201%203.277%2014.503%2018%2018%200%200%201-8.13%2012.053l-26.081%2016.622a19%2019%200%200%201-5.3%202.328'%20style='fill:%23fff'/%3e%3c/svg%3e";
  //#endregion
  //#region src/routes/+layout.svelte
  function _layout($$renderer, $$props) {
    let { children } = $$props;
    head("12qhfyh", $$renderer, ($$renderer) => {
      $$renderer.push(`<link rel="icon"${attr("href", favicon_default)}/>`);
    });
    children($$renderer);
    $$renderer.push(`<!---->`);
  }

  const _layout_svelte = /*#__PURE__*/ Object.freeze(
    /*#__PURE__*/ Object.defineProperty(
      {
        __proto__: null,
        default: _layout,
      },
      Symbol.toStringTag,
      { value: "Module" },
    ),
  );

  var is_legacy =
    noop$1.toString().includes("$$") ||
    /function \w+\(\) \{\}/.test(noop$1.toString());
  var placeholder_url = "a:";
  if (is_legacy) {
    new URL(placeholder_url);
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/client/client.js
  /** @import { RemoteQueryCacheEntry } from './remote-functions/query.svelte.js' */
  /** @import { RemoteLiveQueryCacheEntry } from './remote-functions/query-live.svelte.js' */
  var { onMount, tick } = index_server_exports;
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/app/state/server.js
  function context() {
    return getContext("__request__");
  }
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/app/state/index.js
  /**
   * A read-only reactive object with information about the current page, serving several use cases:
   * - retrieving the combined `data` of all pages/layouts anywhere in your component tree (also see [loading data](https://svelte.dev/docs/kit/load))
   * - retrieving the current value of the `form` prop anywhere in your component tree (also see [form actions](https://svelte.dev/docs/kit/form-actions))
   * - retrieving the page state that was set through `goto`, `pushState` or `replaceState` (also see [goto](https://svelte.dev/docs/kit/$app-navigation#goto) and [shallow routing](https://svelte.dev/docs/kit/shallow-routing))
   * - retrieving metadata such as the URL you're on, the current route and its parameters, and whether or not there was an error
   *
   * ```svelte
   * <!--- file: +layout.svelte --->
   * <script>
   * 	import { page } from '$app/state';
   * <\/script>
   *
   * <p>Currently at {page.url.pathname}</p>
   *
   * {#if page.error}
   * 	<span class="red">Problem detected</span>
   * {:else}
   * 	<span class="small">All systems operational</span>
   * {/if}
   * ```
   *
   * Changes to `page` are available exclusively with runes. (The legacy reactivity syntax will not reflect any changes)
   *
   * ```svelte
   * <!--- file: +page.svelte --->
   * <script>
   * 	import { page } from '$app/state';
   * 	const id = $derived(page.params.id); // This will correctly update id for usage on this page
   * 	$: badId = page.params.id; // Do not use; will never update after initial load
   * <\/script>
   * ```
   *
   * On the server, values can only be read during rendering (in other words _not_ in e.g. `load` functions). In the browser, the values can be read at any time.
   *
   * @type {import('@sveltejs/kit').Page}
   */
  var page = {
    get error() {
      return context().page.error;
    },
    get status() {
      return context().page.status;
    },
  };
  //#endregion
  //#region node_modules/@sveltejs/kit/src/runtime/components/svelte-5/error.svelte
  function Error$1($$renderer, $$props) {
    $$renderer.component(($$renderer) => {
      $$renderer.push(
        `<h1>${escape_html$1(page.status)}</h1> <p>${escape_html$1(page.error?.message)}</p>`,
      );
    });
  }

  const error_svelte = /*#__PURE__*/ Object.freeze(
    /*#__PURE__*/ Object.defineProperty(
      {
        __proto__: null,
        default: Error$1,
      },
      Symbol.toStringTag,
      { value: "Module" },
    ),
  );

  //#region src/routes/+page.svelte
  function _page($$renderer) {
    $$renderer.push(
      `<h1>Welcome to SvelteKit</h1> <p>Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation</p>`,
    );
  }

  const _page_svelte = /*#__PURE__*/ Object.freeze(
    /*#__PURE__*/ Object.defineProperty(
      {
        __proto__: null,
        default: _page,
      },
      Symbol.toStringTag,
      { value: "Module" },
    ),
  );
})();
