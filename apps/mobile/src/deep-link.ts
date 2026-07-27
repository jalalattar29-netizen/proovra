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
