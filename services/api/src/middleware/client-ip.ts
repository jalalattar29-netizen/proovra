/**
 * PHASE 13 §1 (NEW-022) — the ONE place this service resolves the caller's IP.
 *
 * HISTORY, BECAUSE IT EXPLAINS THE SHAPE
 * ---------------------------------------------------------------------------
 * PHASE1-002/003 removed five hand-rolled `x-forwarded-for` splitters and
 * routed every security consumer through one binding. NEW-019 corrected its
 * socket fallback. NEW-022 finishes the job: the binding used to make its OWN
 * trust decision (a leftmost-public walk in shared-runtime), which a caller
 * could forge on a trusting deployment. Address selection is now Fastify's,
 * via its bundled `@fastify/proxy-addr`, configured from the declared
 * `ProxyTrustPolicy`. Once `trustProxy` carries a real hop/CIDR policy instead
 * of the boolean `true`, `req.ip` IS the correctly-resolved client — the
 * rightmost hop for a single-proxy topology, the socket peer when trust is off
 * — and there is exactly ONE selection authority in the process.
 *
 * This module therefore no longer walks headers. It reads the policy, hands
 * `server.ts` the Fastify option, and exposes the resolved client (`req.ip`,
 * normalised) and the raw transport peer (`req.socket.remoteAddress`) as two
 * distinct values, because the security contract sometimes needs each.
 */

import type { FastifyRequest } from "fastify";

import {
  fastifyTrustProxyValue,
  normalizeIp,
  parseProxyTrustPolicy,
  validateProxyTrustPolicy,
  type ProxyTrustPolicy,
} from "@proovra/shared-runtime/technical-metadata";
import { deployedInfrastructureRequired } from "@proovra/shared-runtime";

/**
 * F-08 / F-41 (independent forward audit) — "deployed" is THE deployment
 * classification (production, staging, or ambiguous), not the NODE_ENV string:
 * a staging process with another NODE_ENV must declare its proxy too.
 */
function isProduction(): boolean {
  return deployedInfrastructureRequired(process.env);
}

// The policy is resolved once per process. It is derived from the environment,
// which does not change under the process, and re-parsing per request would be
// wasteful and could mask a mid-flight env mutation as if it were legitimate.
let cachedPolicy: ProxyTrustPolicy | null = null;

export function proxyTrustPolicy(): ProxyTrustPolicy {
  if (cachedPolicy) return cachedPolicy;
  const { policy } = parseProxyTrustPolicy(process.env, {
    isProduction: isProduction(),
  });
  cachedPolicy = policy;
  return policy;
}

/**
 * Assert the configured policy is valid, throwing on a production
 * misconfiguration so the process FAILS TO START rather than silently
 * resolving client IPs wrongly. Called from `buildServer`.
 *
 * Outside production an invalid policy is reported and falls back to the safe
 * `off` behaviour, so a developer's typo does not block local work — but it can
 * never widen trust.
 */
export function assertProxyTrustPolicyValidOrThrow(): void {
  const { policy, errors: parseErrors } = parseProxyTrustPolicy(process.env, {
    isProduction: isProduction(),
  });
  const errors = [...parseErrors, ...validateProxyTrustPolicy(policy)];
  if (errors.length === 0) {
    cachedPolicy = policy;
    return;
  }
  const message =
    "Invalid proxy-trust configuration:\n  - " + errors.join("\n  - ");
  if (isProduction()) {
    throw new Error(message);
  }
  // Non-production: report and fail closed to `off`.
  // eslint-disable-next-line no-console
  console.warn(`[client-ip] ${message}\n  → falling back to trust=off.`);
  cachedPolicy = { mode: "off", source: "invalid-config-failed-closed-nonprod" };
}

/** Fastify's trust-function form: `hop` 0 is the socket peer, counting leftward. */
export type FastifyTrustProxyFunction = (address: string, hop: number) => boolean;

/**
 * The value `server.ts` must pass to Fastify's `trustProxy` option.
 *
 * AUD-0063 — `hop` mode is passed as a FUNCTION that trusts the nearest N hops.
 * Fastify 5.12 (the release carrying the advisory fixes) treats a NUMERIC
 * trustProxy as "trust nothing", because a hop count does not check who the
 * immediate peer is. Passed through unchanged, every request behind Caddy
 * would resolve to Caddy's address: per-IP limits would collapse onto one key
 * and audit rows would record the proxy. The function keeps the hop-count
 * semantics the policy states; its safety still rests on what the policy
 * documents for `hop` — the API is reachable only through that proxy (bound to
 * 127.0.0.1 behind one Caddy hop). `cidr` (which does check the peer) and
 * `off` pass through as before.
 */
export function fastifyTrustProxy(): false | string[] | FastifyTrustProxyFunction {
  const value = fastifyTrustProxyValue(proxyTrustPolicy());
  if (typeof value === "number") {
    const hops = value;
    return (_address: string, hop: number) => hop < hops;
  }
  return value;
}

/** Whether a proxy is trusted at all — retained for callers that only need the boolean. */
export function apiTrustsProxy(): boolean {
  return proxyTrustPolicy().mode !== "off";
}

/**
 * The RAW transport peer — the address of whoever actually opened the socket.
 * Never influenced by a header under any `trustProxy` setting. Exposed for the
 * cases whose contract is "who connected to us", distinct from "who the client
 * is behind the proxy".
 */
export function rawSocketPeer(req: FastifyRequest): string | null {
  return normalizeIp(req.socket?.remoteAddress ?? null);
}

/**
 * The resolved client address.
 *
 * `req.ip` is computed by Fastify under the configured policy: the client hop
 * for a trusted proxy, the socket peer when trust is off. This function only
 * normalises it — no second walk exists.
 */
export function trustedClientIp(req: FastifyRequest): string | null {
  return normalizeIp(req.ip ?? null) ?? rawSocketPeer(req);
}

/** As {@link trustedClientIp}, with a stable placeholder for limiter keys. */
export function trustedClientIpKey(req: FastifyRequest): string {
  return trustedClientIp(req) ?? "unknown";
}

/** Test seam: drop the cached policy so a suite can re-read the environment. */
export function __resetProxyTrustPolicyForTests(): void {
  cachedPolicy = null;
}

/**
 * B2A-F-16 (free-audit 0ea0) — the public lead routes' limiter key.
 *
 * The web marketing proxy calls `/v1/contact-sales` and `/v1/demo-requests`
 * from its own egress and names the visitor in the LEFTMOST `x-forwarded-for`
 * entry (intermediaries only append). That entry is trusted ONLY when the
 * request carries the proxy's shared `x-internal-key`
 * (`CONTACT_SALES_FORWARDING_KEY`, constant-time compare, 16-char floor);
 * every other caller is keyed on the resolved client (`req.ip`, under the
 * process's proxy-trust policy), so a direct caller's `x-forwarded-for` can
 * never choose its own bucket. Without the key configured on the API, the
 * behaviour is exactly the previous one.
 */
export function leadForwardedClientIpKey(
  req: FastifyRequest,
  keyMatches: (provided: unknown) => boolean,
): string {
  const rawKey = req.headers["x-internal-key"];
  const provided = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (keyMatches(provided)) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    const visitor = normalizeIp(first ?? null);
    if (visitor) return `fwd:${visitor}`;
  }
  return trustedClientIpKey(req);
}

/**
 * PRO-P1-02 — the address a public lead route RECORDS (and scores for spam),
 * from the SAME decision as its limiter key: the proxy-forwarded visitor when
 * the request carries the proxy's key, the resolved client otherwise. The
 * route used to key the limiter on the visitor but record the proxy's egress,
 * so five genuine website leads in 15 minutes marked every later one as spam.
 */
export function leadRecordedClientIp(
  req: FastifyRequest,
  keyMatches: (provided: unknown) => boolean,
): string | null {
  const key = leadForwardedClientIpKey(req, keyMatches);
  if (key.startsWith("fwd:")) return key.slice(4);
  return trustedClientIp(req);
}
