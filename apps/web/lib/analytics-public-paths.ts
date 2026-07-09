/**
 * Client-side allowlist for the public marketing page-view beacon.
 *
 * The admin analytics dashboard's "Top pages" / "Countries" panels are fed by
 * `page_view` AnalyticsEvents. Public marketing pages need to emit those
 * events, but we must NEVER emit a `page_view` for a route family whose URL
 * can carry a sensitive identifier (verification token, share id, intake /
 * portal token, OAuth code, invite token). The API already rejects such
 * events server-side (route-classification.ts:shouldRejectAnalyticsEvent),
 * but this client allowlist is defense-in-depth: the beacon simply never
 * sends them in the first place.
 *
 * This module is pure (no React, no window) so the allowlist logic can be
 * unit-tested directly.
 */

/**
 * Route families that MUST NOT emit a public page_view. These either carry a
 * sensitive token/id in the path, or belong to the authenticated app / admin
 * surfaces which are tracked (if at all) by their own instrumentation — not by
 * the public marketing beacon. Kept in sync with the server's
 * PUBLIC_SENSITIVE_PREFIXES rejection list.
 */
const BLOCKED_PREFIXES: ReadonlyArray<string> = [
  "/verify",
  "/v/",
  "/share",
  "/intake",
  "/portal",
  "/auth",
  "/invite",
  "/offline-verifier",
  "/admin",
  "/home",
  "/capture",
  "/cases",
  "/case/",
  "/evidence",
  "/teams",
  "/reports",
  "/billing",
  "/settings",
  "/app",
];

function stripQuery(path: string): string {
  const hashIndex = path.indexOf("#");
  const noHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const qIndex = noHash.indexOf("?");
  return qIndex >= 0 ? noHash.slice(0, qIndex) : noHash;
}

/**
 * Normalize a pathname to a leading-slash, query/hash-stripped route with no
 * trailing slash (except for the root "/"). Returns null for empty input.
 */
export function sanitizePublicPath(
  pathname: string | null | undefined,
): string | null {
  if (!pathname) return null;
  const stripped = stripQuery(pathname).trim();
  if (!stripped) return null;
  const withSlash = stripped.startsWith("/") ? stripped : `/${stripped}`;
  if (withSlash === "/") return "/";
  return withSlash.replace(/\/+$/, "") || "/";
}

/**
 * True when a public page_view may be emitted for this path. False for the
 * sensitive token families and for authenticated app/admin surfaces.
 *
 * Match is on the sanitized path only — no tokens, ids, query strings, or
 * fragments are ever inspected or forwarded.
 */
export function isTrackablePublicPath(
  pathname: string | null | undefined,
): boolean {
  const path = sanitizePublicPath(pathname);
  if (!path) return false;

  return !BLOCKED_PREFIXES.some((rawPrefix) => {
    const prefix = rawPrefix.replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}
