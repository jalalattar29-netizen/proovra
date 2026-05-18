/**
 * Phase 21 — Recursive metadata redactor.
 *
 * Used by:
 *   - the incident service to sanitise incident.metadataJson before
 *     persistence
 *   - the ObservabilityProvider Sentry wrap before forwarding context
 *   - any caller that wants a defense-in-depth scrub on top of Fastify
 *     pino redaction (which only handles the request envelope, not
 *     arbitrary metadata objects).
 *
 * Behaviour:
 *   - Any key whose lowercased form CONTAINS one of the canonical
 *     redaction substrings (from @proovra/shared) is replaced with
 *     "[REDACTED]".
 *   - Strings longer than `STRING_MAX_CHARS` are truncated with an
 *     ellipsis suffix.
 *   - Arrays are sliced to `ARRAY_MAX_LEN` to bound the payload.
 *   - Objects are bounded to `OBJECT_MAX_KEYS` keys.
 *   - Recursion is bounded to `MAX_DEPTH` levels.
 *
 * Hard invariants:
 *   - The function NEVER throws on adversarial input. It returns a
 *     primitive or a stripped object/array; circular references
 *     short-circuit with `"[circular]"`.
 *   - We deliberately err on the side of over-redacting. Adding a
 *     false positive (a harmless field redacted) is cheaper than
 *     leaking a secret.
 */

import { shouldRedactKey } from "@proovra/shared";

const STRING_MAX_CHARS = 2000;
const ARRAY_MAX_LEN = 50;
const OBJECT_MAX_KEYS = 40;
const MAX_DEPTH = 6;

/**
 * Recursively redact known-secret keys + bound payload size. Returns
 * an opaque value suitable for JSON serialisation; never throws.
 */
export function redactMetadata(input: unknown): unknown {
  return redactInner(input, 0, new WeakSet());
}

function redactInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_DEPTH) return "[max_depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > STRING_MAX_CHARS) {
      return value.slice(0, STRING_MAX_CHARS - 1) + "…";
    }
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out = value
      .slice(0, ARRAY_MAX_LEN)
      .map((v) => redactInner(v, depth + 1, seen));
    if (value.length > ARRAY_MAX_LEN) out.push(`[+${value.length - ARRAY_MAX_LEN} more]`);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (i >= OBJECT_MAX_KEYS) {
        out["__truncated"] = true;
        break;
      }
      const key = k.length > 120 ? k.slice(0, 120) : k;
      if (shouldRedactKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactInner(v, depth + 1, seen);
      }
      i += 1;
    }
    return out;
  }
  // Functions / symbols never serialise sensibly.
  return null;
}

/**
 * Convenience for callers that need a JSON-serialisable object. Throws
 * only when JSON.stringify itself fails (extremely rare after the
 * redact pass).
 */
export function safeJsonSnapshot(value: unknown): unknown {
  const redacted = redactMetadata(value);
  // Round-trip through JSON to drop any remaining oddities.
  try {
    return JSON.parse(JSON.stringify(redacted));
  } catch {
    return null;
  }
}
