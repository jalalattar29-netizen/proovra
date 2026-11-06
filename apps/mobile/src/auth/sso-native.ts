/**
 * ENTERPRISE SSO SIGN-IN ON THE PHONE (MOBILE-002).
 *
 * The web signs an SSO member in with a browser cookie the app cannot use, so
 * an Organization that requires its single sign-on had no way into the app.
 * The app now uses the platform's own SSO flow, unchanged, with one native leg
 * (services/api/src/services/access-control/sso-native-handoff.service.ts):
 *
 *   1. `POST /v1/auth/sso/discover { email }` names the Organization's sign-in
 *      route for a DNS-verified domain (the same discovery the web login uses);
 *   2. the app opens that route in the SYSTEM BROWSER with `native=1` and its
 *      PKCE challenge — the IdP, the state/nonce ledger and the browser binding
 *      are the web's own;
 *   3. the browser returns to `proovra://sso/complete?code=…` (never a session
 *      token in a URL); the app redeems the single-use code with the verifier
 *      only it holds, at `POST /v1/auth/sso/native/exchange`, and gets the same
 *      answers any sign-in gets (session, MFA challenge, MFA enrolment).
 *
 * The verifier is held in memory for the length of one attempt and spent once.
 */
import * as Crypto from "expo-crypto";

export const SSO_RETURN_URL = "proovra://sso/complete";
export const SSO_COMPLETE_ROUTE = "/(stack)/sso-complete";
export const SSO_DISCOVER_PATH = "/v1/auth/sso/discover";
export const SSO_EXCHANGE_PATH = "/v1/auth/sso/native/exchange";

/** Only the server's own sign-in routes may be opened (discover answers one of these). */
const LOGIN_PATH_RE = /^\/v1\/auth\/(sso\/[0-9a-f-]{36}\/initiate|saml\/[0-9a-f-]{36}\/login)$/i;

export function isSsoLoginPath(path: unknown): path is string {
  return typeof path === "string" && LOGIN_PATH_RE.test(path);
}

/** The discover answer: the route to open, or null when no SSO applies to this address. */
export function parseSsoDiscovery(payload: unknown): string | null {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return d.sso === true && isSsoLoginPath(d.loginPath) ? (d.loginPath as string) : null;
}

export function buildNativeSsoUrl(apiBase: string, loginPath: string, codeChallenge: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return `${base}${loginPath}?native=1&codeChallenge=${encodeURIComponent(codeChallenge)}`;
}

const toBase64Url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 7636: a 43-character verifier from 32 random bytes, and its S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = Crypto.getRandomBytes(32);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const verifier = toBase64Url(btoa(bin));
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return { verifier, challenge: toBase64Url(digest) };
}

export type SsoReturn = { kind: "code"; code: string } | { kind: "error"; reason: string };

/** What proovra://sso/complete carried, or null for any other URL. */
export function parseSsoReturn(url: string | null | undefined): SsoReturn | null {
  if (!url || !(url === SSO_RETURN_URL || url.startsWith(`${SSO_RETURN_URL}?`))) return null;
  const query = url.slice(SSO_RETURN_URL.length + 1);
  const params = new URLSearchParams(query);
  const code = params.get("code");
  if (code) return { kind: "code", code };
  return { kind: "error", reason: params.get("error") ?? "sso_failed" };
}

/** The deep-link landing for the return, when the platform opens it as a link. */
export function ssoReturnRoute(url: string): { pathname: string; params: Record<string, string> } | null {
  const parsed = parseSsoReturn(url);
  if (!parsed) return null;
  return {
    pathname: SSO_COMPLETE_ROUTE,
    params: parsed.kind === "code" ? { code: parsed.code } : { error: parsed.reason },
  };
}

/** A refusal the server reported back, in words; never the raw reason code alone. */
export function ssoFailureMessage(reason: string): string {
  if (reason === "seat_limit_reached" || reason === "seat_contention") {
    return "Your organization has no free seat for this sign-in. Ask your administrator.";
  }
  if (reason.startsWith("idp_")) return "Your organization's sign-in did not complete. Try again.";
  if (reason.includes("expired") || reason.includes("replayed") || reason.includes("browser_mismatch")) {
    return "This sign-in has expired. Start again from this screen.";
  }
  if (reason.includes("domain") || reason.includes("account_link")) {
    return "Your organization did not accept this account for single sign-on. Ask your administrator.";
  }
  return "Single sign-on did not complete. Try again, or ask your administrator.";
}

export const SSO_NOT_AVAILABLE_FOR_EMAIL =
  "No single sign-on is set up for this email address. Sign in with your email and password, or ask your administrator.";

/* --------------------------------------------- the in-flight verifier ---- */

let heldVerifier: string | null = null;

export function holdSsoVerifier(verifier: string): void {
  heldVerifier = verifier;
}

export function hasHeldSsoVerifier(): boolean {
  return heldVerifier !== null;
}

/** Spent once: a second return for the same attempt finds nothing. */
export function takeSsoVerifier(): string | null {
  const v = heldVerifier;
  heldVerifier = null;
  return v;
}
