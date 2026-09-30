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
  // The popup shows the signed-in account and its capture workspaces from the
  // platform context.
  { method: "GET", test: (p) => p === "/v1/platform/context" },
  // UC-EXT-010 — the popup lists the cases a capture may be filed into. READ
  // only; the case itself is re-authorized when the session opens with it.
  { method: "GET", test: (p) => p === "/v1/cases" },
  // UC-EXT-009 — the extension revokes its own token on sign-out.
  { method: "POST", test: (p) => p === "/v1/oauth/extension/revoke" },
];

const RULES_BY_SCOPE: Readonly<Record<string, ReadonlyArray<ScopeRule>>> = {
  [EXTENSION_CAPTURE_SCOPE]: CAPTURE_DIRECT_RULES,
};

/**
 * ET-DC-11 — the part presign is on the extension's route allowlist, but an
 * extension token may presign ONLY for the record its own capture reserved: a
 * record bound to the owner's ACTIVE extension capture session. It could
 * presign parts on any unsealed record the user owned.
 */
export async function extensionMayPresignPart(
  input: { evidenceId: string; userId: string },
  client: Pick<import("@prisma/client").PrismaClient, "captureSession">,
): Promise<boolean> {
  const session = await client.captureSession.findFirst({
    where: {
      finalizedEvidenceId: input.evidenceId,
      ownerUserId: input.userId,
      acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION",
      status: "ACTIVE",
    },
    select: { id: true },
  });
  return session !== null;
}

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

/**
 * UC-SEC-004 — the organization policy of the TARGET workspace, for an
 * extension capture.
 *
 * requireAuth evaluates organization session policy against the token's session
 * anchor (the workspace of the session that authorized the extension). A capture
 * names its own target workspace, which can be a different Organization — so the
 * capture authority must also ask whether THIS token's authentication satisfies
 * the target's policy (mandatory SSO bound to that Organization, organization
 * lifecycle, session policy). This is the same canonical evaluation requireAuth
 * runs, applied to the target; it is a no-op for tokens without the capture
 * scope (ordinary sessions are anchored by the context switch). FAIL CLOSED: a
 * missing provenance is refused, and a read failure propagates to the caller
 * (which must answer 503, never allow).
 */
export async function evaluateExtensionCaptureTargetPolicy(input: {
  user: {
    sub: string;
    tokenScope?: string | null;
    authMethod?: string | null;
    authAt?: number | null;
    ssoConnId?: string | null;
  };
  teamId: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  if (!isRestrictedScope(input.user.tokenScope ?? null)) return { allowed: true };
  const [{ provenanceToPolicyAuthMethod }, { evaluateOrgContextForSession }] = await Promise.all([
    import("../jwt.js"),
    import("../identity/org-security-policy.service.js"),
  ]);
  const method = provenanceToPolicyAuthMethod(input.user.authMethod ?? null);
  if (!method) return { allowed: false, reason: "reauthentication_required" };
  const authAtMs = typeof input.user.authAt === "number" && input.user.authAt > 0 ? input.user.authAt * 1000 : Date.now();
  return evaluateOrgContextForSession({
    userId: input.user.sub,
    teamId: input.teamId,
    method,
    ssoConnId: input.user.ssoConnId ?? null,
    authAtMs,
    lastSeenAtMs: Date.now(),
  });
}
