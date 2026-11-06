/**
 * NATIVE AUTH API SURFACE (Phase 4C). Typed wrappers over the canonical backend
 * auth endpoints — the ONE place native auth talks to the server. Screens call
 * these; they never hand-build auth requests. Contracts mirror services/api
 * (auth.routes.ts) and the legal endpoints (users.routes.ts).
 *
 * The single 30-day JWT model has no refresh token; email register is
 * verification-first (returns no session). MFA-enabled logins return a pending
 * token instead of a session. These wrappers surface those shapes as typed
 * results so the screens can branch without guessing.
 */
import { apiFetch, publicFetch } from "../api";
import {
  MFA_ENROLL_START_PATH,
  MFA_ENROLL_VERIFY_PATH,
  buildEnrollStartBody,
  buildEnrollVerifyBody,
  parseRecoveryCodes,
  parseTotpEnrollment,
  type TotpEnrollment,
} from "../product/account-security";
import { SSO_DISCOVER_PATH, SSO_EXCHANGE_PATH, parseSsoDiscovery } from "./sso-native";

export interface AuthUser {
  id: string;
  email?: string | null;
  displayName?: string | null;
}

export interface AuthSession {
  token: string;
  user?: AuthUser | null;
}

/** Login/OAuth can resolve to a session, an MFA challenge, or an MFA-enrolment requirement. */
export type LoginResult =
  | { kind: "session"; token: string; user?: AuthUser | null }
  | { kind: "mfaRequired"; mfaPendingToken: string }
  /**
   * The organization requires MFA and the account has no factor: the server
   * refuses with 403 { mfaEnrollmentRequired: true, code: "MFA_ENROLLMENT_REQUIRED",
   * mfaEnrollmentToken, mfaEnrollmentExpiresInSeconds } and no session. That
   * token reaches only the enrolment routes below.
   */
  | { kind: "mfaEnrollmentRequired"; mfaEnrollmentToken: string | null; expiresInSeconds: number | null };

function enrollmentRefusal(err: unknown): Extract<LoginResult, { kind: "mfaEnrollmentRequired" }> | null {
  const e = err as { statusCode?: number; body?: Record<string, unknown> } | null;
  if (e?.statusCode !== 403 || e.body?.["mfaEnrollmentRequired"] !== true) return null;
  const token = e.body["mfaEnrollmentToken"];
  const expires = e.body["mfaEnrollmentExpiresInSeconds"];
  return {
    kind: "mfaEnrollmentRequired",
    mfaEnrollmentToken: typeof token === "string" && token.length > 0 ? token : null,
    expiresInSeconds: typeof expires === "number" ? expires : null,
  };
}

/** A sign-in exchange: the enrolment refusal is an ANSWER, every other failure still throws. */
async function signInExchange(path: string, init: RequestInit): Promise<LoginResult> {
  try {
    return toLoginResult(await apiFetch(path, init));
  } catch (err) {
    const refusal = enrollmentRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
}

function toLoginResult(data: Record<string, unknown>): LoginResult {
  if (data && data["mfaRequired"] === true && typeof data["mfaPendingToken"] === "string") {
    return { kind: "mfaRequired", mfaPendingToken: data["mfaPendingToken"] as string };
  }
  return {
    kind: "session",
    token: String(data["token"] ?? ""),
    user: (data["user"] as AuthUser | null | undefined) ?? null,
  };
}

/* ------------------------------------------------------------- email/pw */

export async function emailLogin(email: string, password: string): Promise<LoginResult> {
  return signInExchange("/v1/auth/email/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export interface RegisterResult {
  verificationSent: boolean;
  email: string;
}

export async function registerAccount(input: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<RegisterResult> {
  const data = await apiFetch("/v1/auth/email/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { verificationSent: data["verificationSent"] === true, email: String(data["email"] ?? input.email) };
}

export async function verifyEmail(token: string, password?: string): Promise<AuthSession> {
  const data = await apiFetch("/v1/auth/email/verify", {
    method: "POST",
    body: JSON.stringify(password ? { token, password } : { token }),
  });
  return { token: String(data["token"] ?? ""), user: (data["user"] as AuthUser | null) ?? null };
}

export async function resendVerification(email: string): Promise<void> {
  await apiFetch("/v1/auth/email/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await apiFetch("/v1/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  await apiFetch("/v1/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({ token, newPassword }),
  });
}

/* -------------------------------------------------------------------- MFA */

export async function verifyMfa(
  mfaPendingToken: string,
  challenge: { code: string } | { recoveryCode: string },
): Promise<AuthSession> {
  const data = await apiFetch("/v1/auth/mfa/verify", {
    method: "POST",
    body: JSON.stringify({ mfaPendingToken, ...challenge }),
  });
  return { token: String(data["token"] ?? ""), user: (data["user"] as AuthUser | null) ?? null };
}

/*
 * Enrolment during a refused sign-in. These go through publicFetch with the
 * enrolment token as the bearer: there is no session yet, and an answer here
 * says nothing about one.
 */

export const MFA_ENROLLMENT_COMPLETE_PATH = "/v1/auth/mfa/enrollment/complete";

export async function startSignInEnrollment(enrollmentToken: string): Promise<TotpEnrollment | null> {
  const data = await publicFetch(
    MFA_ENROLL_START_PATH,
    { method: "POST", body: JSON.stringify(buildEnrollStartBody()) },
    { bearer: enrollmentToken },
  );
  return parseTotpEnrollment(data);
}

export interface VerifiedEnrollment {
  recoveryCodes: string[];
  /** The new token proving the factor. Only this one can call complete. */
  provingToken: string | null;
}

export async function verifySignInEnrollment(
  enrollmentToken: string,
  factorId: string,
  code: string,
): Promise<VerifiedEnrollment> {
  const data = (await publicFetch(
    MFA_ENROLL_VERIFY_PATH,
    { method: "POST", body: JSON.stringify(buildEnrollVerifyBody(factorId, code)) },
    { bearer: enrollmentToken },
  )) as Record<string, unknown> | null;
  const proving = data?.["mfaEnrollmentToken"];
  return {
    recoveryCodes: parseRecoveryCodes(data),
    provingToken: typeof proving === "string" && proving.length > 0 ? proving : null,
  };
}

export async function completeSignInEnrollment(provingToken: string): Promise<AuthSession> {
  const data = (await publicFetch(
    MFA_ENROLLMENT_COMPLETE_PATH,
    { method: "POST", body: JSON.stringify({}) },
    { bearer: provingToken },
  )) as Record<string, unknown>;
  return { token: String(data["token"] ?? ""), user: (data["user"] as AuthUser | null) ?? null };
}

/* ------------------------------------------------------------------ OAuth */

/**
 * PRO-034 — the nonce the API issues for ONE Google or Apple sign-in or link
 * attempt. The provider signs it into the id_token and the API accepts that
 * token once; fetch a fresh one for every attempt.
 */
export const OAUTH_NONCE_PATH = "/v1/auth/oauth/nonce";

export async function fetchOAuthNonce(provider: "google" | "apple"): Promise<string> {
  const data = (await publicFetch(OAUTH_NONCE_PATH, {
    method: "POST",
    body: JSON.stringify({ provider }),
  })) as Record<string, unknown> | null;
  const nonce = data?.["nonce"];
  if (typeof nonce !== "string" || nonce.length === 0) throw new Error("oauth_nonce_unavailable");
  return nonce;
}

export async function oauthGoogle(idToken: string): Promise<LoginResult> {
  return signInExchange("/v1/auth/google", { method: "POST", body: JSON.stringify({ idToken }) });
}

export async function oauthApple(idToken: string): Promise<LoginResult> {
  return signInExchange("/v1/auth/apple", { method: "POST", body: JSON.stringify({ idToken }) });
}

/* ------------------------------------------------------- Enterprise SSO */

/** MOBILE-002 — the Organization sign-in route for this address, or null (sso-native.ts). */
export async function discoverSso(email: string): Promise<string | null> {
  return parseSsoDiscovery(
    await publicFetch(SSO_DISCOVER_PATH, { method: "POST", body: JSON.stringify({ email }) }),
  );
}

/** MOBILE-002 — redeem the single-use code from proovra://sso/complete with this attempt's verifier. */
export async function exchangeNativeSso(code: string, codeVerifier: string): Promise<LoginResult> {
  return signInExchange(SSO_EXCHANGE_PATH, { method: "POST", body: JSON.stringify({ code, codeVerifier }) });
}

/* -------------------------------------------------------------- session */

export async function fetchMe(): Promise<AuthUser | null> {
  const data = await apiFetch("/v1/auth/me", { method: "GET" });
  return (data["user"] as AuthUser | null) ?? null;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch("/v1/auth/logout", { method: "POST" });
  } catch {
    // logout is best-effort server-side; the client always clears local state.
  }
}

/**
 * Revoke ONE session by its own token, without touching the device's current
 * session (PRO-113: the session a verification link created when the person
 * chose to stay signed in). Best effort, like logout.
 */
export async function revokeSessionToken(token: string): Promise<void> {
  try {
    await publicFetch("/v1/auth/logout", { method: "POST" }, { bearer: token });
  } catch {
    // The session expires on its own; nothing on the device depends on it.
  }
}

/* -------------------------------------------------------------- legal */

export interface LegalStatus {
  ok: boolean;
  missingPolicies: string[];
  requiredVersions: Record<string, string>;
}

export async function getLegalStatus(): Promise<LegalStatus> {
  const data = await apiFetch("/v1/users/legal-status", { method: "GET" });
  const missing = Array.isArray(data["missingPolicies"])
    ? (data["missingPolicies"] as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const versions = (data["requiredVersions"] as Record<string, string> | undefined) ?? {};
  return { ok: data["ok"] !== false && missing.length === 0, missingPolicies: missing, requiredVersions: versions };
}

/**
 * The server schema (users.routes.ts LegalAcceptanceBody) is
 * `{ source?, acceptances: [{ policyKey, policyVersion }] }`. This used to
 * post `version`, which the schema rejects — every native acceptance failed
 * with a 400 and a user who owed a re-acceptance could not pass the gate.
 * `source` names the flow, as the web does ("login", "register", "settings").
 */
export function buildLegalAcceptanceBody(
  acceptances: Array<{ policyKey: string; version: string }>,
  source: string,
): { source: string; acceptances: Array<{ policyKey: string; policyVersion: string }> } {
  return { source, acceptances: acceptances.map((a) => ({ policyKey: a.policyKey, policyVersion: a.version })) };
}

export async function recordLegalAcceptance(
  acceptances: Array<{ policyKey: string; version: string }>,
  source = "mobile_legal_gate",
): Promise<void> {
  await apiFetch("/v1/users/legal-acceptance", {
    method: "POST",
    body: JSON.stringify(buildLegalAcceptanceBody(acceptances, source)),
  });
}
