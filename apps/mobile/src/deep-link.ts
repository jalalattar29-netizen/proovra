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
  // A SEPARATE token namespace from the collaboration invite above. Sending an
  // organization token to the collaboration endpoint answers 404 by design,
  // which would tell the user their invitation was invalid when it was only
  // sent to the wrong place.
  "org-invite": (t) => `/(stack)/org-invite/${encodeURIComponent(t)}`,
  // MFA recovery carries BOTH a request id and a token, so its route is built
  // from the URL's own query rather than from a token alone; the entry exists
  // so the family table stays the one place the shapes are declared.
  "mfa-recovery": (t) => `/(stack)/mfa-recovery-verify?token=${encodeURIComponent(t)}`,
};

/** Web path aliases for the same three flows (the emails link to the web host). */
const CREDENTIAL_ALIASES: Record<string, string> = {
  "auth/verify-email": "verify-email",
  "verify-email": "verify-email",
  "reset-password": "reset-password",
  invite: "invite",
  // apps/web/app/(app)/org-invites/[token]/accept/page.tsx
  "org-invites": "org-invite",
  // apps/web/app/auth/mfa-recovery/verify/page.tsx
  "auth/mfa-recovery": "mfa-recovery",
};

export type ParsedCredentialLink = {
  family: "verify-email" | "reset-password" | "invite" | "mfa-recovery" | "org-invite";
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

  // The organization invite's web path is /org-invites/<token>/accept, so the
  // token is a PATH SEGMENT with a trailing verb after it. Joining the
  // remaining segments would produce "<token>/accept" and post a token that
  // does not exist.
  if (family === "org-invite") {
    const inviteToken = decodeURIComponent(segments[1] ?? "").trim();
    if (!inviteToken || inviteToken === "accept") return null;
    return {
      family: "org-invite",
      token: inviteToken,
      route: CREDENTIAL_ROUTES["org-invite"](inviteToken),
    };
  }

  // MFA recovery is the one credential link that addresses a REQUEST as well
  // as carrying a token; both halves have to reach the screen or it can only
  // report missing_params.
  if (family === "mfa-recovery") {
    const requestId = (parsed.searchParams.get("id") ?? "").trim();
    // Both halves come from the QUERY. The web path is
    // /auth/mfa-recovery/verify?id=&token=, so the trailing "verify" segment
    // would otherwise be mistaken for a token when ?token= is absent — and
    // posting "verify" as a recovery token would burn the attempt.
    const queryToken = (parsed.searchParams.get("token") ?? "").trim();
    if (!requestId || !queryToken) return null;
    return {
      family: "mfa-recovery",
      token: queryToken,
      route:
        `/(stack)/mfa-recovery-verify?id=${encodeURIComponent(requestId)}` +
        `&token=${encodeURIComponent(queryToken)}`,
    };
  }

  return {
    family: family as ParsedCredentialLink["family"],
    token,
    route: CREDENTIAL_ROUTES[family](token),
  };
}

/**
 * PUBLIC DOCUMENT LINKS — a THIRD family, and the simplest of the three.
 *
 * A legal document link addresses no tenant resource and carries no credential.
 * It must not pass through `POST /v1/deep-link/resolve` (which requires a
 * session and re-derives a workspace) and it must not be deferred behind the
 * auth gateway: a user who taps "Privacy Policy" in an email, or is asked to
 * accept terms before signing in, has to be able to read the document.
 *
 * The shapes are the canonical web paths, which is what the emails and the
 * documents' own cross-references contain:
 *
 *   https://<host>/legal/<slug>            proovra://legal/<slug>
 *   https://<host>/settings/legal/<slug>   (the authenticated web reader)
 *   https://<host>/privacy | /terms | /subprocessors | /data-retention
 *                          | /abuse-reporting     (web 308s these to /legal/…)
 *   https://<host>/security-overview       (the web's legacy security alias)
 *
 * The slug is NOT validated here. `GET /v1/legal/:slug` owns the allow-list,
 * and a second copy of it in the client is the duplicate-truth failure the
 * canonical delivery exists to remove; an unknown slug lands on the reader's
 * "no such document" state.
 */
const PUBLIC_DOCUMENT_ALIASES: Record<string, string> = {
  privacy: "privacy",
  terms: "terms",
  subprocessors: "subprocessors",
  "data-retention": "data-retention",
  "abuse-reporting": "abuse-reporting",
  "security-overview": "security",
};

export type ParsedPublicDocumentLink = {
  family: "legal";
  slug: string;
  route: string;
};

/**
 * TOKEN-BEARING PUBLIC FLOWS — external intake and the reviewer portal.
 *
 * A FOURTH family. Like legal links they carry no tenant and need no session;
 * unlike legal links they carry a CREDENTIAL, and unlike the credential family
 * that credential belongs to somebody who has no PROOVRA account at all.
 *
 * They must not pass through `POST /v1/deep-link/resolve` (which requires a
 * session and re-derives a workspace) and must not be deferred behind the auth
 * gateway: the whole point is that the reader is not a user.
 *
 * Shapes, as the API mints them from WEB_BASE_URL:
 *
 *   /intake/<token>                     external contributor intake
 *   /portal                             portal token entry
 *   /portal/<token>                     reviewer dashboard
 *   /portal/accept/<grantId>?token=…    invitation acceptance
 *
 * Until the production domain hosts its association files these arrive in a
 * browser, not here. The parser and the screens exist anyway: a link that
 * cannot yet reach the app is a DEPLOYMENT fact, and leaving the product
 * surface unwritten because of it is how a complete feature gets recorded as
 * missing.
 */
export type ParsedExternalFlowLink =
  | { family: "intake"; token: string; route: string }
  | { family: "portal-entry"; route: string }
  | { family: "portal"; token: string; route: string }
  | { family: "portal-accept"; grantId: string; token: string; route: string };

export function parseExternalFlowDeepLink(url: string): ParsedExternalFlowLink | null {
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

  const [head, second, third] = segments;

  if (head === "intake") {
    const token = decodeURIComponent(second ?? "").trim();
    // /intake/<token>/capture also lands on the intake screen: the capture
    // step needs a session the screen has not opened yet, so a link straight
    // to it would arrive without one.
    if (!token || token === "capture") return null;
    return { family: "intake", token, route: `/intake/${encodeURIComponent(token)}` };
  }

  if (head === "portal") {
    if (!second) return { family: "portal-entry", route: "/portal" };

    if (second === "accept") {
      const grantId = decodeURIComponent(third ?? "").trim();
      const token = (parsed.searchParams.get("token") ?? "").trim();
      // Both halves or nothing: posting an empty token would spend a valid
      // grant's single acceptance attempt.
      if (!grantId || !token) return null;
      return {
        family: "portal-accept",
        grantId,
        token,
        route:
          `/portal/accept/${encodeURIComponent(grantId)}` +
          `?token=${encodeURIComponent(token)}`,
      };
    }

    // /portal/sso/callback is a browser redirect target with no native
    // analogue; it is not claimed here.
    if (second === "sso") return null;

    const token = decodeURIComponent(second).trim();
    if (!token) return null;
    return { family: "portal", token, route: `/portal/${encodeURIComponent(token)}` };
  }

  return null;
}

export function parsePublicDocumentDeepLink(
  url: string,
): ParsedPublicDocumentLink | null {
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

  // /settings/legal/<slug> — the authenticated web reader's path.
  const path =
    segments[0] === "settings" && segments[1] === "legal" ? segments.slice(1) : segments;

  let slug: string | null = null;
  if (path[0] === "legal" && path.length === 2) {
    slug = decodeURIComponent(path[1] ?? "").trim();
  } else if (path.length === 1) {
    slug = PUBLIC_DOCUMENT_ALIASES[path[0] ?? ""] ?? null;
  }

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;

  return { family: "legal", slug, route: `/legal/${encodeURIComponent(slug)}` };
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
