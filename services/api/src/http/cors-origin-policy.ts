/**
 * The ONE decision of which browser origins the API trusts with credentials
 * (UC-SEC-002 / UC-SEC-005 / AUD-021) — for credentialed CORS AND for the
 * cookie-session mutation guard. Both answer the same question, so they read
 * the same allow-list and can never disagree.
 *
 * Every environment admits exactly:
 *   - the Proovra web origins: https://proovra.com, https://www.proovra.com,
 *     https://app.proovra.com — EXACT, not "any *.proovra.com". A sibling
 *     subdomain (a status page, a docs host, a marketing tool) is same-site
 *     with the API, so the SameSite=lax session cookie reaches the API from it;
 *     it is not an application origin and is trusted with nothing;
 *   - every origin listed in CORS_ORIGINS (comma list, exact match) — where an
 *     operator names a staging or preview web origin that must reach this API;
 *   - the pinned browser-extension origins (`isAllowedExtensionOrigin`: the
 *     chrome-extension://<id> of each EXTENSION_OAUTH_REDIRECT_ALLOW redirect
 *     plus EXTENSION_ALLOWED_ORIGINS), fail closed when neither is set.
 * Outside production, additionally the LOOPBACK development origins
 * (http://localhost:<port>, http://127.0.0.1:<port>, http://[::1]:<port>).
 *
 * Nothing else, in any environment. Development used to reflect EVERY origin
 * with credentials, so any page a developer visited could drive their local
 * session; previews and CI name their web origin in CORS_ORIGINS instead.
 */
import { isAllowedExtensionOrigin } from "../services/auth/extension-oauth.service.js";
import { developmentSurfacesAllowed } from "@proovra/shared-runtime";

export type CorsEnv = Readonly<Record<string, string | undefined>>;

const PROOVRA_WEB_ORIGINS = [
  "https://www.proovra.com",
  "https://proovra.com",
  "https://app.proovra.com",
] as const;

export function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

export function configuredCorsOrigins(env: CorsEnv = process.env): string[] {
  const parsed = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
  return Array.from(new Set(parsed));
}

/**
 * Is this a Proovra-DOMAIN origin? Used ONLY to decide the session cookie's
 * `domain` attribute (`isProovraProductionRequest`). It is never a trust
 * decision — that is `isTrustedWebOrigin`, which admits exact origins only.
 */
export function isProovraOrigin(normalized: string): boolean {
  if ((PROOVRA_WEB_ORIGINS as readonly string[]).includes(normalized)) return true;
  // https only, and a real subdomain label of proovra.com.
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.proovra\.com$/.test(normalized);
}

/** A loopback development origin: http(s)://localhost|127.0.0.1|[::1][:port]. */
export function isLoopbackDevOrigin(normalized: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(normalized);
}

/**
 * Is this exact origin trusted with the user's credentials? Exact parsing only:
 * `https://proovra.com.evil.example`, `https://evilproovra.com` and
 * `https://status.proovra.com` are all refused unless explicitly configured.
 */
export function isTrustedWebOrigin(origin: string, env: CorsEnv = process.env): boolean {
  const raw = origin.trim();
  if (raw.length === 0 || raw === "null") return false;
  const normalized = normalizeOrigin(raw);
  if (normalized.startsWith("chrome-extension://")) {
    // Extension origins are case-sensitive ids of [a-p]; compare the raw value.
    return isAllowedExtensionOrigin(raw, env);
  }
  if ((PROOVRA_WEB_ORIGINS as readonly string[]).includes(normalized)) return true;
  if (configuredCorsOrigins(env).includes(normalized)) return true;
  // F-41 (independent forward audit, closure) — the development fallback needs an EXPLICIT development or test environment (developmentSurfacesAllowed); a staging or undeclared deployment fails closed like production.
  if (developmentSurfacesAllowed(env) && isLoopbackDevOrigin(normalized)) return true;
  return false;
}

export function isCorsOriginAllowed(origin: string | undefined, env: CorsEnv = process.env): boolean {
  // Same-origin / non-browser requests carry no Origin header.
  if (!origin) return true;
  return isTrustedWebOrigin(origin, env);
}

// -----------------------------------------------------------------------------
// AUD-021 — cookie-session mutation guard (CSRF).
// -----------------------------------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type CookieMutationRefusal =
  | "origin_missing"
  | "origin_not_allowed"
  | "cross_site_request";

/**
 * A state-changing request authenticated by the session COOKIE must come from
 * a trusted web origin. The cookie is SameSite=lax for .proovra.com, so every
 * sibling subdomain is "same-site" and the browser attaches it; SameSite alone
 * is not a CSRF defence here.
 *
 *   - safe methods, and requests carrying no session cookie, are not cookie
 *     mutations;
 *   - a request presenting a bearer token is authenticated by that token, not
 *     the cookie (mobile, extension, API clients, the web's server side), and
 *     an attacker page cannot set an Authorization header cross-origin
 *     without a preflight CORS refuses;
 *   - `Sec-Fetch-Site: cross-site` is refused outright;
 *   - Origin must be a trusted web origin; when a browser omits Origin the
 *     Referer's origin stands in; when both are absent the request is refused.
 */
export function evaluateCookieMutation(
  input: {
    method: string;
    hasBearer: boolean;
    hasSessionCookie: boolean;
    origin?: string | undefined;
    referer?: string | undefined;
    secFetchSite?: string | undefined;
  },
  env: CorsEnv = process.env,
): { ok: true } | { ok: false; reason: CookieMutationRefusal } {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (input.hasBearer || !input.hasSessionCookie) return { ok: true };
  if ((input.secFetchSite ?? "").trim().toLowerCase() === "cross-site") {
    return { ok: false, reason: "cross_site_request" };
  }
  let source = (input.origin ?? "").trim();
  if (source.length === 0) {
    const referer = (input.referer ?? "").trim();
    if (referer.length > 0) {
      try {
        source = new URL(referer).origin;
      } catch {
        return { ok: false, reason: "origin_not_allowed" };
      }
    }
  }
  if (source.length === 0) return { ok: false, reason: "origin_missing" };
  return isTrustedWebOrigin(source, env) ? { ok: true } : { ok: false, reason: "origin_not_allowed" };
}

/**
 * UC-SEC-005 — is this request served for the Proovra production domain? Exact
 * host/origin parsing, never a substring test: `https://proovra.com.evil.example`
 * contains "proovra.com" but is not Proovra.
 */
export function isProovraProductionRequest(host: string | undefined, origin: string | undefined): boolean {
  const hostname = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (hostname === "proovra.com" || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.proovra\.com$/.test(hostname)) return true;
  return typeof origin === "string" && origin.length > 0 && isProovraOrigin(normalizeOrigin(origin));
}
