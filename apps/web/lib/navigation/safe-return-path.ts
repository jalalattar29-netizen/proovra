/**
 * F-26g — THE return-path rule for every sign-in, sign-up and verification
 * surface.
 *
 * `/login`, `/register`, `/auth/verify-email` and the OAuth callback all take a
 * `next` / `returnUrl` from the URL and navigate to it after authentication.
 * They used to accept anything that `startsWith("/")`, which includes
 * `//evil.com` and `/\evil.com`: the Next router resolves the value against the
 * current origin (`new URL(href, location.href)`) and, finding another origin,
 * performs a full navigation there — an open redirect at the moment the person
 * has just trusted us with a password.
 *
 * The decision is the shared `isSafeRedirectAfter` (the same check the MFA page
 * and the SSO routes use): no `//`, no backslash or control characters, and the
 * value must resolve to the same origin a browser would resolve it to. On top
 * of it this requires a PATH (an absolute URL is never a return path here) and
 * falls back to `fallback` for anything refused, so a caller cannot forget the
 * default.
 *
 * A query string survives (`/billing?plan=pro`, `/invite/<token>`); the value
 * is never decoded again, so `%2F%2F` stays a path segment.
 */
import { isSafeRedirectAfter } from "@proovra/shared";

export const DEFAULT_RETURN_PATH = "/home";

/**
 * Longer than any path this product links to, and the same cap the API applies
 * before it carries `next` in a verification email (email-verification.service),
 * so a value the page accepts is never silently dropped from the link.
 */
const MAX_RETURN_PATH_LENGTH = 512;

export function safeReturnPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_RETURN_PATH,
): string {
  if (typeof raw !== "string") return fallback;
  if (!raw.startsWith("/") || raw.length > MAX_RETURN_PATH_LENGTH) return fallback;
  return isSafeRedirectAfter(raw) ? raw : fallback;
}
