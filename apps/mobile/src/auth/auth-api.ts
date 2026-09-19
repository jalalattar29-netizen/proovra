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
import { apiFetch } from "../api";

export interface AuthUser {
  id: string;
  email?: string | null;
  displayName?: string | null;
}

export interface AuthSession {
  token: string;
  user?: AuthUser | null;
}

/** Login/OAuth can resolve to a session OR an MFA challenge. */
export type LoginResult =
  | { kind: "session"; token: string; user?: AuthUser | null }
  | { kind: "mfaRequired"; mfaPendingToken: string };

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
  const data = await apiFetch("/v1/auth/email/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return toLoginResult(data);
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

export async function verifyEmail(token: string): Promise<AuthSession> {
  const data = await apiFetch("/v1/auth/email/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
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

/* ------------------------------------------------------------------ OAuth */

export async function oauthGoogle(idToken: string): Promise<LoginResult> {
  return toLoginResult(await apiFetch("/v1/auth/google", { method: "POST", body: JSON.stringify({ idToken }) }));
}

export async function oauthApple(idToken: string): Promise<LoginResult> {
  return toLoginResult(await apiFetch("/v1/auth/apple", { method: "POST", body: JSON.stringify({ idToken }) }));
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

export async function recordLegalAcceptance(
  acceptances: Array<{ policyKey: string; version: string }>,
): Promise<void> {
  await apiFetch("/v1/users/legal-acceptance", {
    method: "POST",
    body: JSON.stringify({ acceptances }),
  });
}
