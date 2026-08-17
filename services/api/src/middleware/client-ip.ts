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

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
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

/** The value `server.ts` must pass to Fastify's `trustProxy` option. */
export function fastifyTrustProxy(): false | number | string[] {
  return fastifyTrustProxyValue(proxyTrustPolicy());
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
