/**
 * UC-1 §4.1 — the extension access-token SCOPE boundary.
 *
 * The first-party extension OAuth token is an ordinary AUTH_JWT (so the canonical
 * requireAuth accepts it) but it carries a restricted `scope` claim. A token with
 * this scope may reach ONLY the small set of routes Direct Web Capture actually
 * needs; on any other route requireAuth refuses it (403), so a stolen extension
 * token cannot drive unrelated privileged API operations even though it belongs
 * to a normal authenticated user.
 *
 * This is DENY-BY-DEFAULT for scoped tokens and a NO-OP for ordinary tokens
 * (which carry no `scope`): normal web/app/mobile AUTH_JWT users are unaffected.
 * Scope is NOT workspace authorization — both must independently pass; every
 * allowed route still runs its own requireAuth + authorizeOrFail / ownership
 * checks.
 */

/** The one restricted scope the extension token carries. */
export const EXTENSION_CAPTURE_SCOPE = "capture.direct" as const;

/** All scopes requireAuth treats as restricted (deny-by-default off the allowlist). */
const RESTRICTED_SCOPES: ReadonlySet<string> = new Set([EXTENSION_CAPTURE_SCOPE]);

export function isRestrictedScope(scope: unknown): scope is string {
  return typeof scope === "string" && RESTRICTED_SCOPES.has(scope);
}

/**
 * The routes a `capture.direct`-scoped token may reach, as {method, match}. The
 * match is tested against the Fastify ROUTE PATTERN (e.g.
 * "/v1/capture/direct-sessions/:id/evidence"), never the raw URL, so a path
 * segment cannot smuggle past it. This is exactly the extension's own call set:
 * open a session, reserve evidence, presign a part, declare a digest, and seal
 * (web-complete); plus reading the signed-in account context in the popup.
 */
type ScopeRule = { method: string; test: (routePattern: string) => boolean };

const CAPTURE_DIRECT_RULES: ReadonlyArray<ScopeRule> = [
  // Every direct-capture session sub-route (open, /evidence, /parts/:n/declaration,
  // /web-complete). The extension only POSTs to these.
  { method: "POST", test: (p) => p === "/v1/capture/direct-sessions" || p.startsWith("/v1/capture/direct-sessions/") },
  // The canonical part presign the capture upload uses.
  { method: "POST", test: (p) => p === "/v1/evidence/:id/parts" },
  // The popup shows the signed-in account from the platform context.
  { method: "GET", test: (p) => p === "/v1/platform/context" },
];

const RULES_BY_SCOPE: Readonly<Record<string, ReadonlyArray<ScopeRule>>> = {
  [EXTENSION_CAPTURE_SCOPE]: CAPTURE_DIRECT_RULES,
};

/**
 * True when a token carrying `scope` is permitted to reach `method routePattern`.
 * A restricted scope with no rules, or a route off its allowlist, is refused.
 */
export function isRouteAllowedForScope(
  scope: string,
  method: string,
  routePattern: string | null | undefined,
): boolean {
  const rules = RULES_BY_SCOPE[scope];
  if (!rules || !routePattern) return false;
  const m = method.toUpperCase();
  return rules.some((r) => r.method === m && r.test(routePattern));
}
