export type RouteType =
  | "public"
  | "app"
  | "admin"
  | "auth"
  | "api"
  | "unknown";

function stripQuery(path: string): string {
  const qIndex = path.indexOf("?");
  return qIndex >= 0 ? path.slice(0, qIndex) : path;
}

export function normalizeRoutePath(
  path: string | null | undefined
): string | null {
  if (!path) return null;

  const normalized = stripQuery(path).trim();
  return normalized || null;
}

/* --------------------------------------------------------------------------
 * Analytics path/event redaction (server-side defense in depth).
 * Even if a client mis-sends a raw verification token, evidence UUID, or
 * OAuth code, the server must redact it before persisting to
 * AnalyticsEvent.path / AnalyticsSession.landingPath / referrer.
 * ------------------------------------------------------------------------ */

const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN_REGEX = /\b[A-Za-z0-9_-]{24,}\b/g;
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

const SENSITIVE_ROUTE_REPLACEMENTS: ReadonlyArray<{
  prefix: string;
  safe: string;
}> = [
  { prefix: "/verify/", safe: "/verify/[redacted]" },
  { prefix: "/v/", safe: "/v/[redacted]" },
  { prefix: "/evidence/", safe: "/evidence/[redacted]" },
  { prefix: "/cases/", safe: "/cases/[redacted]" },
  { prefix: "/case/", safe: "/case/[redacted]" },
  { prefix: "/share/", safe: "/share/[redacted]" },
  { prefix: "/intake/", safe: "/intake/[redacted]" },
  { prefix: "/portal/", safe: "/portal/[redacted]" },
  { prefix: "/offline-verifier/", safe: "/offline-verifier/[redacted]" },
  { prefix: "/auth/callback", safe: "/auth/callback/[redacted]" },
];

/**
 * Redact a path before persistence. Strips the query string, replaces
 * dynamic segments of sensitive route families with stable placeholders,
 * and scrubs UUIDs / JWTs / long tokens / emails anywhere else.
 */
export function redactAnalyticsPath(
  path: string | null | undefined
): string | null {
  const base = normalizeRoutePath(path);
  if (!base) return null;
  const safePrefixed = base.startsWith("/") ? base : `/${base}`;

  for (const { prefix, safe } of SENSITIVE_ROUTE_REPLACEMENTS) {
    if (safePrefixed.startsWith(prefix)) {
      return safe;
    }
  }

  return safePrefixed
    .replace(JWT_REGEX, "[jwt]")
    .replace(EMAIL_REGEX, "[email]")
    .replace(UUID_REGEX, "[uuid]")
    .replace(LONG_TOKEN_REGEX, "[token]");
}

/**
 * Redact a referrer value for storage. Drops everything but the host +
 * redacted path. Returns null for malformed input.
 */
export function redactAnalyticsReferrer(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      const safePath = redactAnalyticsPath(u.pathname) ?? "/";
      return `${u.protocol}//${u.host}${safePath}`;
    }
  } catch {
    // fall through to path-only redaction
  }

  return redactAnalyticsPath(raw);
}

const PUBLIC_SENSITIVE_PREFIXES = [
  "/verify",
  "/v/",
  "/share",
  "/intake",
  "/portal",
  "/auth",
];

/**
 * Returns true when an analytics event from a public/sensitive route family
 * carries no aggregate analytic value beyond what the routeType already
 * captures. Such events are rejected before persistence to avoid storing
 * tokens or evidence IDs that the client should never have sent.
 *
 * Currently scoped to `page_view` events on /verify, /v, /share, /intake,
 * /portal, and /auth — these are the routes that ever appear in a URL with
 * a sensitive identifier.
 */
export function shouldRejectAnalyticsEvent(
  eventType: string,
  path: string | null | undefined
): boolean {
  if (eventType !== "page_view") return false;
  const base = normalizeRoutePath(path);
  if (!base) return false;
  const safePrefixed = base.startsWith("/") ? base : `/${base}`;
  return PUBLIC_SENSITIVE_PREFIXES.some((rawPrefix) => {
    const prefix = rawPrefix.replace(/\/$/, "");
    return safePrefixed === prefix || safePrefixed.startsWith(`${prefix}/`);
  });
}

export function classifyRouteType(
  path: string | null | undefined
): RouteType {
  const normalized = normalizeRoutePath(path);
  if (!normalized) return "unknown";

  if (normalized.startsWith("/admin") || normalized.startsWith("/v1/admin")) {
    return "admin";
  }

  if (normalized.startsWith("/auth") || normalized.startsWith("/v1/auth")) {
    return "auth";
  }

  if (normalized.startsWith("/api") || normalized.startsWith("/v1/")) {
    return "api";
  }

  if (
    normalized.startsWith("/home") ||
    normalized.startsWith("/capture") ||
    normalized.startsWith("/cases") ||
    normalized.startsWith("/evidence") ||
    normalized.startsWith("/teams") ||
    normalized.startsWith("/reports") ||
    normalized.startsWith("/billing") ||
    normalized.startsWith("/settings") ||
    normalized.startsWith("/app")
  ) {
    return "app";
  }

  if (
    normalized === "/" ||
    normalized.startsWith("/pricing") ||
    normalized.startsWith("/about") ||
    normalized.startsWith("/verify") ||
    normalized.startsWith("/privacy") ||
    normalized.startsWith("/terms") ||
    normalized.startsWith("/legal") ||
    normalized.startsWith("/support") ||
    normalized.startsWith("/login") ||
    normalized.startsWith("/register") ||
    normalized.startsWith("/reset-password")
  ) {
    return "public";
  }

  return "public";
}