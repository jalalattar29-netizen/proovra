/**
 * PHASE 13 §1 (NEW-022) — the ONE proxy-trust policy authority.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The service used to decide trust with a boolean `API_TRUST_PROXY`. Passed to
 * Fastify as `trustProxy: true`, that means "trust EVERY hop", so Fastify
 * resolves `req.ip` to the LEFTMOST `X-Forwarded-For` entry — the one the
 * caller supplies. On the proven production topology (one Caddy hop, the API
 * bound to 127.0.0.1 and never directly reachable) the correct client is the
 * RIGHTMOST entry, the address Caddy appends. Leftmost-selection let any caller
 * choose its own rate-limit identity and its own recorded forensic address.
 *
 * THE DECISION IS DELEGATED, NOT REIMPLEMENTED
 * ---------------------------------------------------------------------------
 * The chain walk itself is Fastify's, via its bundled `@fastify/proxy-addr`
 * (the same vetted parser Express uses). This module does NOT parse
 * `X-Forwarded-For`. It only turns a declared POLICY into the value Fastify's
 * `trustProxy` option expects, and validates that policy. There is therefore
 * exactly one address-selection authority in the process — Fastify's — and no
 * hand-rolled comma splitter competing with it.
 *
 * Measured Fastify 5 behaviour that this policy relies on:
 *   trustProxy=false → req.ip = socket peer, forwarded headers ignored
 *   trustProxy=1     → req.ip = rightmost XFF entry (Caddy-appended client);
 *                      a prepended spoof is ignored; a private client is kept
 *   trustProxy=<cidr[]> → req.ip = first hop from the right not in the CIDRs
 *   trustProxy=true  → req.ip = leftmost XFF entry  ← the vulnerability
 *
 * THE MODES
 * ---------------------------------------------------------------------------
 *   off  — ignore all forwarded headers; the client is the socket peer.
 *   hop  — trust exactly N proxy hops nearest the server. Correct only when the
 *          deployment GUARANTEES a fixed proxy depth. Our topology is hop=1.
 *   cidr — trust proxies whose address is in an explicit set of networks.
 *
 * There is no "trust everything" mode, by construction.
 */

export type ProxyTrustMode = "off" | "hop" | "cidr";

export type ProxyTrustPolicy =
  | { mode: "off"; source: string }
  | { mode: "hop"; hops: number; source: string }
  | { mode: "cidr"; cidrs: string[]; source: string };

/** A hop count above this is never a real topology; it is a misconfiguration. */
export const MAX_TRUSTED_PROXY_HOPS = 10;

// ---------------------------------------------------------------------------
// Minimal IP / CIDR VALIDATION.
//
// This validates CONFIGURATION at startup and NORMALISES a resolved address for
// use as a stable key. It deliberately does NOT select an address from a chain
// — that is Fastify's job. Keeping the surface this small is what stops it from
// becoming a second, competing resolver.
// ---------------------------------------------------------------------------

/** Strip an IPv4-mapped IPv6 prefix and surrounding brackets/whitespace. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let v = String(raw).trim();
  if (v.length === 0) return null;
  // Reject control characters outright — a normalised key must be inert.
  // The control characters ARE the subject: `no-control-regex` exists to catch
  // one written by accident, and this one is the check itself.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) return null;
  // `[::1]:1234` / `[::1]` → `::1`
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1] as string;
  // `1.2.3.4:5678` → `1.2.3.4` (only when it is unambiguously v4:port)
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (v4port) v = v4port[1] as string;
  // `::ffff:1.2.3.4` → `1.2.3.4`
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped) v = mapped[1] as string;
  if (isValidIpv4(v)) return v;
  const lower = v.toLowerCase();
  if (isValidIpv6(lower)) return lower;
  return null;
}

export function isValidIpv4(v: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o.replace(/^0(?=\d)/, "0");
  });
}

export function isValidIpv6(v: string): boolean {
  // Accept the common forms including `::`, embedded v4 tail, and compression.
  if (v.length === 0 || v.length > 45) return false;
  if (!/^[0-9a-f:.]+$/.test(v)) return false;
  const parts = v.split("::");
  if (parts.length > 2) return false;
  const hextet = (s: string): boolean => /^[0-9a-f]{1,4}$/.test(s);
  const groups = (s: string): string[] => (s.length ? s.split(":") : []);
  const head = groups(parts[0] ?? "");
  const tail = groups(parts[1] ?? "");
  // An embedded IPv4 tail counts as two hextets.
  const expand = (g: string[]): string[] | null => {
    const out: string[] = [];
    for (let i = 0; i < g.length; i++) {
      const part = g[i] as string;
      if (part.includes(".")) {
        if (i !== g.length - 1) return null;
        if (!isValidIpv4(part)) return null;
        out.push("0", "0");
      } else if (hextet(part)) {
        out.push(part);
      } else {
        return null;
      }
    }
    return out;
  };
  const h = expand(head);
  const t = expand(tail);
  if (h == null || t == null) return false;
  if (parts.length === 2) return h.length + t.length <= 7;
  return h.length === 8 && t.length === 0;
}

/** `10.0.0.0/8`, `172.18.0.0/16`, `::1/128`, `fd00::/8`. */
export function isValidCidr(v: string): boolean {
  const slash = v.lastIndexOf("/");
  if (slash < 0) return false;
  const addr = v.slice(0, slash);
  const bitsStr = v.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsStr)) return false;
  const bits = Number(bitsStr);
  if (isValidIpv4(addr)) return bits >= 0 && bits <= 32;
  if (isValidIpv6(addr.toLowerCase())) return bits >= 0 && bits <= 128;
  return false;
}

// ---------------------------------------------------------------------------
// POLICY PARSING — new vars, with a bounded legacy adapter.
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined): boolean =>
  ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());

/**
 * Parse the policy from the environment.
 *
 * Precedence: the explicit `API_TRUST_PROXY_MODE` wins. When it is absent the
 * legacy `API_TRUST_PROXY` boolean is adapted — but only to `off`, never to a
 * trust-everything policy. Legacy `true` is NOT silently honoured: it yields a
 * policy the validator refuses in production, forcing the operator to declare a
 * real depth. `isProduction` selects that fail-closed behaviour.
 *
 * Returns the policy plus any parse-time errors. `validateProxyTrustPolicy`
 * adds the semantic errors; callers surface both.
 */
export function parseProxyTrustPolicy(
  env: Env,
  opts: { isProduction: boolean },
): { policy: ProxyTrustPolicy; errors: string[] } {
  const errors: string[] = [];
  const rawMode = (env.API_TRUST_PROXY_MODE ?? "").trim().toLowerCase();

  if (rawMode.length > 0) {
    if (rawMode === "off") return { policy: { mode: "off", source: "API_TRUST_PROXY_MODE=off" }, errors };
    if (rawMode === "hop") {
      const hops = Number((env.API_TRUSTED_PROXY_HOPS ?? "").trim());
      return {
        policy: { mode: "hop", hops, source: "API_TRUST_PROXY_MODE=hop" },
        errors,
      };
    }
    if (rawMode === "cidr") {
      const cidrs = (env.API_TRUSTED_PROXY_CIDRS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return {
        policy: { mode: "cidr", cidrs, source: "API_TRUST_PROXY_MODE=cidr" },
        errors,
      };
    }
    errors.push(
      `API_TRUST_PROXY_MODE="${rawMode}" is invalid; expected one of off|hop|cidr.`,
    );
    return { policy: { mode: "off", source: "invalid-mode-failed-closed" }, errors };
  }

  // Legacy adapter. Deprecated: prefer API_TRUST_PROXY_MODE.
  if (!truthy(env.API_TRUST_PROXY)) {
    return { policy: { mode: "off", source: "legacy API_TRUST_PROXY unset/false" }, errors };
  }

  // Legacy `true` = the old trust-everything posture, which is the defect.
  if (opts.isProduction) {
    errors.push(
      "API_TRUST_PROXY=true is no longer accepted in production because it trusts every " +
        "forwarded hop (a caller could choose its own client IP). Declare the topology " +
        "explicitly: API_TRUST_PROXY_MODE=hop with API_TRUSTED_PROXY_HOPS=1 for a single " +
        "reverse proxy, or API_TRUST_PROXY_MODE=cidr with API_TRUSTED_PROXY_CIDRS.",
    );
    return { policy: { mode: "off", source: "legacy-true-refused-in-prod" }, errors };
  }
  // Outside production, adapt legacy `true` to the single-hop default so local
  // dev behind one proxy keeps working — never to trust-everything.
  return {
    policy: { mode: "hop", hops: 1, source: "legacy API_TRUST_PROXY=true (dev adapter → hop=1)" },
    errors,
  };
}

/** Semantic validation. Returns human-readable errors; empty means valid. */
export function validateProxyTrustPolicy(policy: ProxyTrustPolicy): string[] {
  const errors: string[] = [];
  if (policy.mode === "hop") {
    if (!Number.isInteger(policy.hops) || policy.hops < 1) {
      errors.push(
        `API_TRUSTED_PROXY_HOPS must be a positive integer for mode=hop; got "${policy.hops}".`,
      );
    } else if (policy.hops > MAX_TRUSTED_PROXY_HOPS) {
      errors.push(
        `API_TRUSTED_PROXY_HOPS=${policy.hops} exceeds the safe maximum of ${MAX_TRUSTED_PROXY_HOPS}.`,
      );
    }
  }
  if (policy.mode === "cidr") {
    if (policy.cidrs.length === 0) {
      errors.push("API_TRUSTED_PROXY_CIDRS must list at least one CIDR for mode=cidr.");
    }
    for (const c of policy.cidrs) {
      if (!isValidCidr(c)) errors.push(`API_TRUSTED_PROXY_CIDRS contains an invalid CIDR: "${c}".`);
    }
  }
  return errors;
}

/**
 * The value to hand Fastify's `trustProxy` option.
 *
 * off  → false            (ignore forwarded headers; req.ip = socket peer)
 * hop  → the hop count    (req.ip = the Nth hop from the right)
 * cidr → the CIDR array   (req.ip = first hop from the right outside the set)
 *
 * Never `true`.
 */
export function fastifyTrustProxyValue(
  policy: ProxyTrustPolicy,
): false | number | string[] {
  if (policy.mode === "off") return false;
  if (policy.mode === "hop") return policy.hops;
  return policy.cidrs;
}
