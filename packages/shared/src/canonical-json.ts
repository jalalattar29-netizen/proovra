/**
 * PROOVRA Phase 1B Closure — cross-runtime canonical-JSON serialiser.
 *
 * SINGLE source of truth for canonical-JSON. Mobile (React Native +
 * Expo), API (Node), Web (browser), and downstream tooling import
 * THIS module so the bytes the device signs are exactly the bytes
 * the server verifies, regardless of platform JSON differences.
 *
 * Rules:
 *
 *   * Object keys sorted lexicographically (JS string compare —
 *     UTF-16 code unit order; matches Array.prototype.sort default).
 *   * Arrays preserve insertion order.
 *   * Strings emit with bounded escapes (`\\`, `\"`, `\n`, `\r`,
 *     `\t`, `\b`, `\f`, and `\uXXXX` for control + non-ASCII).
 *   * Numbers emit via `Number.prototype.toString()` (shortest
 *     round-trip).
 *   * No whitespace.
 *   * Reject `undefined`, `NaN`, `+/-Infinity`, BigInt.
 *
 * This file is pure: no platform APIs, no node-only modules.
 */

export class CanonicalJsonError extends Error {
  constructor(public readonly reason: string) {
    super(`canonical-json: ${reason}`);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalize(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return writeNumber(value);
  if (typeof value === "string") return writeString(value);
  if (typeof value === "bigint") {
    throw new CanonicalJsonError("BigInt values are not permitted");
  }
  if (Array.isArray(value)) return writeArray(value);
  if (typeof value === "object") {
    return writeObject(value as Record<string, unknown>);
  }
  throw new CanonicalJsonError(`unsupported value type: ${typeof value}`);
}

function writeNumber(n: number): string {
  if (Number.isNaN(n)) throw new CanonicalJsonError("NaN is not permitted");
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError("Infinity is not permitted");
  }
  return n.toString();
}

const ESCAPE_TABLE: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

function writeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const advance = code >= 0x10000 ? 2 : 1;
    const esc = ESCAPE_TABLE[ch];
    if (esc !== undefined) {
      out += esc;
    } else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else if (code < 0x80) {
      out += ch;
    } else if (code >= 0x10000) {
      // Surrogate pair
      const cp = code - 0x10000;
      const hi = 0xd800 + ((cp >> 10) & 0x3ff);
      const lo = 0xdc00 + (cp & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0");
      out += "\\u" + lo.toString(16).padStart(4, "0");
    } else {
      out += "\\u" + code.toString(16).padStart(4, "0");
    }
    i += advance;
  }
  return out + '"';
}

function writeArray(a: ReadonlyArray<unknown>): string {
  return "[" + a.map((v) => write(v)).join(",") + "]";
}

function writeObject(o: Record<string, unknown>): string {
  const keys = Object.keys(o).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = o[k];
    if (v === undefined) continue;
    parts.push(writeString(k) + ":" + write(v));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * UTF-8 byte length of the canonical form. Used by the on-device
 * crypto path which signs bytes (not chars).
 */
export function canonicalUtf8Length(value: unknown): number {
  // Use TextEncoder when available; fall back to a manual count
  // (React Native already provides TextEncoder in modern Hermes; we
  // include the fallback to keep this module pure).
  const s = canonicalize(value);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TE: any = (globalThis as Record<string, unknown>).TextEncoder;
  if (typeof TE === "function") {
    return new TE().encode(s).length;
  }
  // Manual UTF-8 byte count.
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i)!;
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code < 0x10000) n += 3;
    else {
      n += 4;
      i += 1;
    }
    i += 1;
  }
  return n;
}
