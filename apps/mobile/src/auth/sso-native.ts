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
 * The verifier is held for the length of one attempt and spent once: in memory,
 * and in the secure store so a return that cold-starts the app after it was
 * killed can still be redeemed (see "the in-flight verifier" below).
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

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

/**
 * A refusal the server reported back, in words; never the raw reason code alone.
 * The reason codes are the API's own (sso-auth.routes.ts, saml-auth.routes.ts,
 * sso-session-completion.service.ts) and cover the same cases the web sign-in
 * page words (apps/web/lib/identity/ssoSignIn.ts): not provisioned, connection
 * unavailable, the session limit, a conflicting managed identity.
 */
export function ssoFailureMessage(reason: string): string {
  if (reason === "seat_limit_reached" || reason === "seat_contention") {
    return "Your organization has no free seat for this sign-in. Ask your administrator.";
  }
  if (reason.startsWith("idp_")) return "Your organization's sign-in did not complete. Try again.";
  if (reason.includes("expired") || reason.includes("replayed") || reason.includes("browser_mismatch")) {
    return "This sign-in has expired. Start again from this screen.";
  }
  if (/(jit_disabled|not_provisioned)/.test(reason)) {
    return "You have not been added to this organization yet. Ask your administrator.";
  }
  if (/(connection_unavailable|connection_inactive|not_configured|connection_revoked|issuer_unpinned)/.test(reason)) {
    return "Your organization's sign-in is not available right now. Ask your administrator.";
  }
  if (/(concurrent|session_limit)/.test(reason)) {
    return "You have reached your organization's limit of active sessions. Sign out on another device and try again.";
  }
  if (reason === "organization_suspended") {
    return "Your organization's access is suspended. Ask your administrator.";
  }
  if (reason === "rate_limited") return "Too many sign-in attempts. Wait a minute and try again.";
  if (reason.includes("domain") || reason.includes("account_link") || reason.includes("managed_identity_conflict")) {
    return "Your organization did not accept this account for single sign-on. Ask your administrator.";
  }
  return "Single sign-on did not complete. Try again, or ask your administrator.";
}

export const SSO_NOT_AVAILABLE_FOR_EMAIL =
  "No single sign-on is set up for this email address. Sign in with your email and password, or ask your administrator.";

/* --------------------------------------------- the in-flight verifier ---- */
//
// NAT-SSO-01 (Free audit 0ea0, R1-G-002) — memory alone did not survive the
// one thing a phone does routinely during an SSO sign-in: kill the app while
// the system browser is in front. The return then cold-starts the app, the
// verifier was gone, and a sign-in the person had just completed at their IdP
// ended in "This sign-in has expired". So the verifier is ALSO kept in the
// device's secure store (Keychain / Keystore, never AsyncStorage) for the
// attempt's own lifetime, and:
//   - a process that started an attempt uses its memory only — the auth
//     session and a deep-link landing race there, and memory is what keeps
//     the spend single;
//   - only a process that started no attempt (a cold start) reads the stored
//     copy, once, deleting it as it does;
//   - every spend (redeem, refusal, cancel, failure) deletes the stored copy.
// The verifier alone is worthless without the single-use, two-minute code the
// IdP return carries, and the code is worthless without it.

export const SSO_VERIFIER_STORE_KEY = "proovra-sso-verifier";
/** The attempt's own bound (sso-native-handoff.service.ts NATIVE_SSO_CHALLENGE_TTL_MS). */
export const SSO_VERIFIER_TTL_MS = 15 * 60 * 1000;

let heldVerifier: string | null = null;
/** True once this process has started an attempt: its memory is then the only truth. */
let attemptStartedHere = false;
/** A cold start reads the stored copy once, whichever landing asks first. */
let storedCopyClaimed = false;

function forgetStoredVerifier(): void {
  void SecureStore.deleteItemAsync(SSO_VERIFIER_STORE_KEY).catch(() => undefined);
}

/** Hold this attempt's verifier; resolves once the stored copy is written (best effort). */
export async function holdSsoVerifier(verifier: string): Promise<void> {
  heldVerifier = verifier;
  attemptStartedHere = true;
  try {
    await SecureStore.setItemAsync(
      SSO_VERIFIER_STORE_KEY,
      JSON.stringify({ verifier, expiresAt: Date.now() + SSO_VERIFIER_TTL_MS }),
    );
  } catch {
    // Without the secure store the attempt still completes while the app lives.
  }
}

export function hasHeldSsoVerifier(): boolean {
  return heldVerifier !== null;
}

/** Spent once: a second return for the same attempt finds nothing. */
export function takeSsoVerifier(): string | null {
  const v = heldVerifier;
  heldVerifier = null;
  forgetStoredVerifier();
  return v;
}

/**
 * The verifier for a return being redeemed: this process's own attempt, or —
 * only on a cold start — the copy stored before the app was killed, if it is
 * still within the attempt's lifetime. Either way it is spent here.
 */
export async function takeSsoVerifierForReturn(): Promise<string | null> {
  if (heldVerifier !== null || attemptStartedHere) return takeSsoVerifier();
  if (storedCopyClaimed) return null;
  storedCopyClaimed = true;
  let raw: string | null = null;
  try {
    raw = await SecureStore.getItemAsync(SSO_VERIFIER_STORE_KEY);
  } catch {
    raw = null;
  }
  forgetStoredVerifier();
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as { verifier?: unknown; expiresAt?: unknown };
    if (typeof rec.verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(rec.verifier)) return null;
    if (typeof rec.expiresAt !== "number" || rec.expiresAt <= Date.now()) return null;
    return rec.verifier;
  } catch {
    return null;
  }
}
