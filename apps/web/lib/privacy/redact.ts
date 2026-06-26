/**
 * Privacy redaction utilities shared by Sentry, AI Chat page context,
 * and any client telemetry. Keep this module free of side effects.
 *
 * Tokens, UUIDs, evidence/case IDs, verification tokens, share/intake/portal
 * tokens, OAuth code/state, emails, and JWT-like strings must never leave the
 * browser in raw form via observability, analytics, or AI prompts.
 */

const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Long opaque tokens (hex, base64-ish, URL-safe). 24+ chars to avoid mangling
// ordinary words.
const LONG_TOKEN_REGEX = /\b[A-Za-z0-9_-]{24,}\b/g;

const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

const SENSITIVE_QUERY_KEYS = [
  "code",
  "state",
  "token",
  "secret",
  "id_token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "email",
  "session",
];

const SENSITIVE_ROUTE_PREFIXES: ReadonlyArray<{ prefix: string; safe: string }> =
  [
    { prefix: "/verify/", safe: "/verify/[redacted]" },
    { prefix: "/v/", safe: "/v/[redacted]" },
    { prefix: "/evidence/", safe: "/evidence/[redacted]" },
    { prefix: "/cases/", safe: "/cases/[redacted]" },
    { prefix: "/case/", safe: "/case/[redacted]" },
    { prefix: "/share/", safe: "/share/[redacted]" },
    { prefix: "/intake/", safe: "/intake/[redacted]" },
    { prefix: "/portal/", safe: "/portal/[redacted]" },
    { prefix: "/auth/callback", safe: "/auth/callback/[redacted]" },
  ];

const FULLY_REDACTED_ROUTE_PREFIXES: ReadonlyArray<string> = [
  "/offline-verifier",
];

/**
 * Returns true if the path belongs to a route family that handles
 * verification tokens or evidence/case identifiers in the URL.
 */
export function isSensitiveRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.split("?")[0]!;
  if (!p.startsWith("/")) return false;

  if (FULLY_REDACTED_ROUTE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
    return true;
  }

  for (const { prefix } of SENSITIVE_ROUTE_PREFIXES) {
    if (p === prefix.replace(/\/$/, "") || p.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

/** Strip query strings; never returned to caller. */
function stripQuery(input: string): string {
  const q = input.indexOf("?");
  if (q === -1) return input;
  return input.slice(0, q);
}

/** Replace UUIDs, JWTs, emails, long tokens with placeholders. */
export function redactSensitiveText(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(JWT_REGEX, "[jwt]")
      .replace(EMAIL_REGEX, "[email]")
      .replace(UUID_REGEX, "[uuid]")
      .replace(LONG_TOKEN_REGEX, "[token]");
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitiveText(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Drop obvious credential fields entirely.
      if (
        /authorization|cookie|set-cookie|password|secret|api[-_]?key|bearer/i.test(
          k,
        )
      ) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactSensitiveText(v);
    }
    return out;
  }
  return value;
}

/**
 * Redact a pathname (no host) to remove tokens, ids, and other dynamic
 * sensitive segments. Always strips query.
 */
export function redactSensitivePath(value: string | null | undefined): string {
  if (!value) return "/";
  let p = stripQuery(value);
  if (!p.startsWith("/")) p = `/${p}`;

  for (const { prefix, safe } of SENSITIVE_ROUTE_PREFIXES) {
    if (p.startsWith(prefix)) {
      return safe;
    }
  }

  for (const prefix of FULLY_REDACTED_ROUTE_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      return `${prefix}/[redacted]`;
    }
  }

  // Generic UUID/token cleanup for any other route.
  return p
    .replace(UUID_REGEX, "[uuid]")
    .replace(LONG_TOKEN_REGEX, "[token]");
}

/**
 * Redact a full URL (possibly absolute) - host preserved, path redacted,
 * sensitive query params dropped to `[redacted]`.
 */
export function redactSensitiveUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const raw = String(value);
  if (!raw) return null;

  let urlString = raw;
  let prefix = "";

  // Cheap parsing that doesn't throw on relative URLs.
  let hostPart = "";
  let pathPart = "";
  let queryPart = "";

  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      prefix = `${parsed.protocol}//`;
      hostPart = parsed.host;
      pathPart = parsed.pathname || "/";
      queryPart = parsed.search || "";
    } else {
      // Treat as path + optional query
      const qIdx = raw.indexOf("?");
      pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
      queryPart = qIdx === -1 ? "" : raw.slice(qIdx);
      urlString = raw;
    }
  } catch {
    return "[redacted]";
  }

  const safePath = redactSensitivePath(pathPart);

  let safeQuery = "";
  if (queryPart) {
    try {
      const params = new URLSearchParams(queryPart.startsWith("?") ? queryPart.slice(1) : queryPart);
      const cleaned = new URLSearchParams();
      let hadSensitive = false;
      for (const [k, v] of params.entries()) {
        if (SENSITIVE_QUERY_KEYS.includes(k.toLowerCase())) {
          cleaned.append(k, "[redacted]");
          hadSensitive = true;
        } else {
          cleaned.append(k, String(redactSensitiveText(v)));
        }
      }
      // We redact the whole query if anything sensitive was present; otherwise
      // drop it entirely to be safe (Sentry/analytics don't need it).
      safeQuery = hadSensitive ? `?${cleaned.toString()}` : "";
    } catch {
      safeQuery = "";
    }
  }

  void urlString;
  return `${prefix}${hostPart}${safePath}${safeQuery}`;
}

/**
 * Returns the *safe* page context for telemetry: a coarse route class plus
 * a redacted path. Never include the title — titles can contain evidence
 * names, case numbers, share recipient names, etc.
 */
export function getSafePageContext(pathname: string | null | undefined): {
  routeClass: string;
  safePath: string;
} {
  const safePath = redactSensitivePath(pathname ?? null);
  return {
    routeClass: classifyRouteClass(pathname ?? null),
    safePath,
  };
}

export function classifyRouteClass(
  pathname: string | null | undefined,
): string {
  if (!pathname) return "unknown";
  const p = pathname.split("?")[0]!;
  if (!p.startsWith("/")) return "unknown";

  if (p.startsWith("/admin")) return "admin";
  if (p.startsWith("/auth")) return "auth";
  if (p.startsWith("/api") || p.startsWith("/v1/")) return "api";
  if (
    p.startsWith("/verify") ||
    p.startsWith("/v/") ||
    p.startsWith("/share") ||
    p.startsWith("/intake") ||
    p.startsWith("/portal") ||
    p.startsWith("/offline-verifier")
  ) {
    return "public-sensitive";
  }
  if (
    p === "/home" ||
    p.startsWith("/capture") ||
    p.startsWith("/cases") ||
    p.startsWith("/case/") ||
    p.startsWith("/evidence") ||
    p.startsWith("/teams") ||
    p.startsWith("/reports") ||
    p.startsWith("/billing") ||
    p.startsWith("/settings") ||
    p.startsWith("/dashboard")
  ) {
    return "app";
  }
  return "public";
}
