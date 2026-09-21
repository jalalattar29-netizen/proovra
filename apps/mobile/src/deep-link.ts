/**
 * PHASE 11 §5 — THE ONE mobile universal/deep-link authority (client side).
 *
 * An incoming link is a resource LOCATOR only. The mobile app NEVER derives
 * tenant truth from the URL: any workspace/team value in the link is DROPPED,
 * and the SERVER authority — POST /v1/deep-link/resolve — re-derives the
 * authoritative Workspace from persistence + canonical authorization
 * (lifecycle, ACTIVE membership, capability; anti-enumeration 404).
 *
 *   universal link
 *     → parseCanonicalMobileDeepLink (closed shape; unsupported → null)
 *     → active capture/upload guard (unsafe context change is blocked)
 *     → POST /v1/deep-link/resolve (server approval FIRST)
 *     → stale-generation check
 *     → navigate to the mobile route with the SERVER-returned workspace.
 *
 * Denials are indistinguishable: server 404 → { status: "denied" } with no
 * existence/reason detail. Unsupported/external URLs fail safely (ignored).
 */

/** The ONLY resource families the mobile app can open from a link. */
const MOBILE_ROUTES: Record<string, (id: string) => string> = {
  evidence: (id) => `/(stack)/evidence/${encodeURIComponent(id)}`,
  cases: (id) => `/(stack)/case/${encodeURIComponent(id)}`,
};

export type ParsedMobileDeepLink = {
  resourceType: "evidence" | "cases";
  resourceId: string;
  /** The in-app route for this resource (id-only — no tenant segment). */
  route: string;
};

/**
 * CREDENTIAL LINKS — a SEPARATE family from the tenant resources above.
 *
 * Email verification, password reset and invitation links are handed to a user
 * who has NO session yet, and they address no tenant resource. They therefore
 * must NOT pass through `POST /v1/deep-link/resolve` (which requires a session
 * and re-derives a workspace): that gate is right for evidence/cases and wrong
 * for these. The token stays opaque here and is proven by the screen's own API
 * call, exactly as the Web routes do it.
 *
 * Until this existed, `(stack)/verify-email.tsx`, `(stack)/reset-password.tsx`
 * and `(stack)/invite/[token].tsx` were complete screens that NOTHING in the
 * app could navigate to — every emailed account-recovery link dead-ended. The
 * superseded surface contract declared all three "REACHABLE"; reachability is
 * now derived from this table by `test/native-route-reachability.test.mjs`.
 */
const CREDENTIAL_ROUTES: Record<string, (token: string) => string> = {
  "verify-email": (t) => `/(stack)/verify-email?token=${encodeURIComponent(t)}`,
  "reset-password": (t) => `/(stack)/reset-password?token=${encodeURIComponent(t)}`,
  invite: (t) => `/(stack)/invite/${encodeURIComponent(t)}`,
};

/** Web path aliases for the same three flows (the emails link to the web host). */
const CREDENTIAL_ALIASES: Record<string, string> = {
  "auth/verify-email": "verify-email",
  "verify-email": "verify-email",
  "reset-password": "reset-password",
  invite: "invite",
};

export type ParsedCredentialLink = {
  family: "verify-email" | "reset-password" | "invite";
  token: string;
  route: string;
};

/**
 * Parse an unauthenticated credential link:
 *   https://<host>/auth/verify-email?token=…   https://<host>/verify-email/<token>
 *   https://<host>/reset-password?token=…      https://<host>/invite/<token>
 *   proovra://verify-email?token=…             proovra://invite/<token>
 * The token may arrive as a path segment or as `?token=`. Anything else returns
 * null and the caller ignores the link.
 */
export function parseCredentialDeepLink(url: string): ParsedCredentialLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "proovra:") return null;

  const segments =
    parsed.protocol === "proovra:"
      ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)]
      : parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  // Match the longest alias first so "auth/verify-email" wins over "verify-email".
  const twoSeg = segments.slice(0, 2).join("/");
  const family =
    CREDENTIAL_ALIASES[twoSeg] ??
    CREDENTIAL_ALIASES[segments[0] ?? ""] ??
    null;
  if (!family) return null;

  const consumed = CREDENTIAL_ALIASES[twoSeg] ? 2 : 1;
  const pathToken = segments.slice(consumed).join("/");
  const token = (parsed.searchParams.get("token") ?? pathToken ?? "").trim();
  if (!token) return null;

  return {
    family: family as ParsedCredentialLink["family"],
    token,
    route: CREDENTIAL_ROUTES[family](token),
  };
}

/**
 * Parse ONLY the canonical supported shapes:
 *   https://<host>/evidence/<id>     https://<host>/cases/<id>
 *   proovra://evidence/<id>          proovra://cases/<id>
 * Anything else — unknown scheme, unknown family, extra segments, empty id —
 * returns null (fail-safe: the caller ignores the link). Query params
 * (?workspace=… / ?team=…) are DISCARDED — never tenant truth.
 */
export function parseCanonicalMobileDeepLink(url: string): ParsedMobileDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "proovra:") return null;

  // For proovra:// the "host" is the first path segment (proovra://evidence/ev-1).
  const segments =
    parsed.protocol === "proovra:"
      ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)]
      : parsed.pathname.split("/").filter(Boolean);

  if (segments.length !== 2) return null;
  const [family, rawId] = segments;
  const route = MOBILE_ROUTES[family];
  const id = decodeURIComponent(rawId ?? "").trim();
  if (!route || !id) return null;

  return {
    resourceType: family as "evidence" | "cases",
    resourceId: id,
    route: route(id),
  };
}

/**
 * Extract a public verification id from whatever the user pastes: a full web
 * verification URL (…/verify/<id> or ?id=<id>), a proovra://verify?id=<id> link,
 * or a bare id. Public/read-only — it does NOT go through the tenant resolve gate
 * (that is only for evidence/cases). Returns null when nothing usable is present.
 */
export function extractVerificationId(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  // Try to parse as a URL first.
  try {
    const u = new URL(raw);
    const qp = u.searchParams.get("id");
    if (qp && qp.trim()) return qp.trim();
    const segs =
      u.protocol === "proovra:"
        ? [u.hostname, ...u.pathname.split("/").filter(Boolean)]
        : u.pathname.split("/").filter(Boolean);
    const vi = segs.lastIndexOf("verify");
    if (vi >= 0 && segs[vi + 1]) return decodeURIComponent(segs[vi + 1]).trim();
    // A URL with no verify segment/param carries no id.
    return null;
  } catch {
    // Not a URL — treat as a bare id, but reject anything with whitespace/slashes.
    return /^[\w.-]+$/.test(raw) ? raw : null;
  }
}

export type MobileDeepLinkOutcome =
  | { status: "navigate"; route: string; workspaceId: string }
  | { status: "denied" } // anti-enum: covers missing / mismatch / membership / suspension
  | { status: "blocked_busy" } // active capture/upload — unsafe context change
  | { status: "unsupported" } // not a canonical link → ignored safely
  | { status: "stale" }; // superseded by a newer link — discarded

export type MobileDeepLinkDeps = {
  /** POST /v1/deep-link/resolve via the app's authenticated api client. */
  resolve: (input: { resourceType: string; resourceId: string }) => Promise<{
    ok?: boolean;
    workspaceId?: string;
  } | null>;
  /** True while a capture/upload is in flight (unsafe to switch context). */
  hasActiveWork: () => boolean;
};

// Generation counter — a resolution that lands after a newer link began is
// discarded (never navigated, never mutates context).
let generation = 0;

/** Test-only reset so node:test cases are order-independent. */
export function __resetDeepLinkGeneration(): void {
  generation = 0;
}

export async function resolveMobileDeepLink(
  url: string,
  deps: MobileDeepLinkDeps,
): Promise<MobileDeepLinkOutcome> {
  const parsed = parseCanonicalMobileDeepLink(url);
  if (!parsed) return { status: "unsupported" };

  // Active capture/upload → the context transition is unsafe; block BEFORE
  // any server call or navigation side effect.
  if (deps.hasActiveWork()) return { status: "blocked_busy" };

  const myGeneration = ++generation;
  let res: Awaited<ReturnType<MobileDeepLinkDeps["resolve"]>>;
  try {
    // SERVER approval first — the app decides nothing about tenant access.
    res = await deps.resolve({
      resourceType: parsed.resourceType,
      resourceId: parsed.resourceId,
    });
  } catch {
    // Anti-enumeration 404 (or transport failure) — one indistinguishable denial.
    return myGeneration === generation ? { status: "denied" } : { status: "stale" };
  }

  // A newer link superseded this one while resolving — discard.
  if (myGeneration !== generation) return { status: "stale" };

  if (res && res.ok === true && typeof res.workspaceId === "string") {
    // Navigation uses the SERVER-returned workspace; the URL never carried it.
    return { status: "navigate", route: parsed.route, workspaceId: res.workspaceId };
  }
  return { status: "denied" };
}
