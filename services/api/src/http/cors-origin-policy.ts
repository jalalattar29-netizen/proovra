/**
 * The ONE decision of which browser origins the API admits for credentialed
 * CORS (UC-SEC-002 / UC-SEC-005).
 *
 * Production (NODE_ENV=production) admits exactly:
 *   - the Proovra web origins (https://proovra.com, https://www.proovra.com,
 *     https://app.proovra.com) and any https://<sub>.proovra.com;
 *   - every origin listed in CORS_ORIGINS (comma list, exact match) — this is
 *     where an operator names a preview deployment that must reach this API;
 *   - the pinned browser-extension origins (`isAllowedExtensionOrigin`: the
 *     chrome-extension://<id> of each EXTENSION_OAUTH_REDIRECT_ALLOW redirect
 *     plus EXTENSION_ALLOWED_ORIGINS).
 * It no longer trusts any `*.vercel.app` origin (a suffix anyone can deploy
 * under) nor the localhost development origins.
 *
 * Every environment: a `chrome-extension://` origin is admitted ONLY when it is
 * pinned — fail closed when neither extension variable is set — so a third-party
 * extension is never an allowed credentialed origin, even in development.
 *
 * Outside production the remaining origins stay permissive (local development,
 * previews against a non-production API), exactly as before.
 */
import { isAllowedExtensionOrigin } from "../services/auth/extension-oauth.service.js";

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

export function isProovraOrigin(normalized: string): boolean {
  if ((PROOVRA_WEB_ORIGINS as readonly string[]).includes(normalized)) return true;
  // https only, and a real subdomain label of proovra.com.
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.proovra\.com$/.test(normalized);
}

export function isCorsOriginAllowed(origin: string | undefined, env: CorsEnv = process.env): boolean {
  // Same-origin / non-browser requests carry no Origin header.
  if (!origin) return true;
  const isProd = env.NODE_ENV === "production";
  const normalized = normalizeOrigin(origin);

  if (normalized.startsWith("chrome-extension://")) {
    // Extension origins are case-sensitive ids of [a-p]; compare the raw value.
    return isAllowedExtensionOrigin(origin.trim(), env);
  }
  if (isProovraOrigin(normalized)) return true;
  if (configuredCorsOrigins(env).includes(normalized)) return true;
  if (!isProd) return true;
  return false;
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
