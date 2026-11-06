/**
 * MOBILE-002 — Enterprise SSO sign-in for the native app.
 *
 * SSO sign-in was built for browsers: the callback sets the `proovra_session`
 * cookie and redirects to the web. The phone app holds a bearer token, so an
 * SSO-required member could not sign in on it at all (password and magic link
 * fail closed for them, auth.routes.ts).
 *
 * The native flow reuses EVERY existing SSO control and adds one hand-off:
 *
 *   1. The app opens the existing initiate route (OIDC `/v1/auth/sso/:id/initiate`
 *      or SAML `/v1/auth/saml/:id/login`) in the SYSTEM BROWSER with
 *      `native=1&codeChallenge=<S256>`. The state/nonce ledger, the browser
 *      binding cookie and the IdP round trip are unchanged. The challenge is
 *      recorded here against the state hash.
 *   2. The callback/ACS verifies the IdP answer exactly as for the web (state
 *      consume, browser binding, id_token / assertion checks, pre-gate, JIT).
 *      For a native attempt it then mints NO session and sets NO cookie: it
 *      records the verified identity here under a single-use, two-minute code
 *      and redirects to `proovra://sso/complete?code=…`. The code is not a
 *      session and is worthless without the app's PKCE verifier.
 *   3. The app POSTs `{ code, codeVerifier }` to `/v1/auth/sso/native/exchange`.
 *      The code is spent once, the verifier must match the challenge, and only
 *      then does the server run the same post-IdP steps the browser callback
 *      runs (MFA enforcement, session record, completeSsoSession) and answer in
 *      the shape every other sign-in answers (`{ token, user }`,
 *      `{ mfaRequired, mfaPendingToken }`, or the 403 enrolment refusal).
 *
 * No session token ever appears in a URL, and another app that receives the
 * `proovra://` redirect cannot use the code (PKCE, RFC 7636 §1).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { hashStateToken } from "./sso-hardening.service.js";

/** The app's redirect after the IdP leg. Matches app.json's `proovra` scheme. */
export const NATIVE_SSO_RETURN_URL = "proovra://sso/complete";
/** A code lives long enough for the browser to hand back, not longer. */
export const NATIVE_SSO_CODE_TTL_MS = 2 * 60 * 1000;
/** The challenge must be recorded before the IdP leg; the attempt's own TTL bounds it. */
export const NATIVE_SSO_CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** RFC 7636 §4.2: BASE64URL(SHA256(verifier)), 43 characters, no padding. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: 43..128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export function isNativeCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_RE.test(value);
}

export function isNativeCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && VERIFIER_RE.test(value);
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function hashCode(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Step 1 — record the app's challenge against the attempt's state. */
export async function recordNativeSsoChallenge(
  client: PrismaClient,
  input: { stateRaw: string; codeChallenge: string },
): Promise<void> {
  await client.ssoNativeHandoff.create({
    data: {
      stateHash: hashStateToken(input.stateRaw),
      codeChallenge: input.codeChallenge,
      expiresAtUtc: new Date(Date.now() + NATIVE_SSO_CHALLENGE_TTL_MS),
    },
  });
}

/** Whether this callback's state was started by the app (step 2 branch). */
export async function isNativeSsoState(client: PrismaClient, stateRaw: string): Promise<boolean> {
  const row = await client.ssoNativeHandoff.findUnique({
    where: { stateHash: hashStateToken(stateRaw) },
    select: { id: true },
  });
  return row !== null;
}

export type VerifiedSsoIdentity = {
  userId: string;
  email: string | null;
  teamId: string;
  ssoConnectionId: string;
  authMethod: "OIDC" | "SAML";
  idpContext: string | null;
  idpAuthAt: Date | null;
};

/**
 * Step 2 — the IdP answer is verified. Record who it proved under a fresh,
 * single-use code and return the app redirect. Null when the hand-off row is
 * missing, already used or expired (the caller bounces with an error).
 */
export async function issueNativeSsoCode(
  client: PrismaClient,
  input: { stateRaw: string; identity: VerifiedSsoIdentity },
): Promise<string | null> {
  const raw = randomBytes(32).toString("base64url");
  const updated = await client.ssoNativeHandoff.updateMany({
    where: {
      stateHash: hashStateToken(input.stateRaw),
      codeHash: null,
      usedAtUtc: null,
      expiresAtUtc: { gt: new Date() },
    },
    data: {
      codeHash: hashCode(raw),
      codeExpiresAtUtc: new Date(Date.now() + NATIVE_SSO_CODE_TTL_MS),
      userId: input.identity.userId,
      email: input.identity.email,
      teamId: input.identity.teamId,
      ssoConnectionId: input.identity.ssoConnectionId,
      authMethod: input.identity.authMethod,
      idpContext: input.identity.idpContext ? input.identity.idpContext.slice(0, 256) : null,
      idpAuthAtUtc: input.identity.idpAuthAt,
    },
  });
  if (updated.count !== 1) return null;
  const url = new URL(NATIVE_SSO_RETURN_URL);
  url.searchParams.set("code", raw);
  return url.toString();
}

/** The app redirect for a refused native attempt: a reason code, never an IdP error text. */
export function nativeSsoErrorUrl(reason: string): string {
  const url = new URL(NATIVE_SSO_RETURN_URL);
  url.searchParams.set("error", reason.replace(/[^a-z0-9_]/gi, "_").slice(0, 64).toLowerCase());
  return url.toString();
}

export type NativeSsoRedemption =
  | { ok: true; identity: VerifiedSsoIdentity }
  | { ok: false; reason: "invalid_code" | "expired_code" | "verifier_mismatch" };

/**
 * Step 3 — spend the code once, and only for the verifier whose challenge was
 * recorded before the IdP leg. A wrong verifier spends nothing, so the real
 * app can still finish; every failure is the same 400 to the caller.
 */
export async function redeemNativeSsoCode(
  client: PrismaClient,
  input: { code: string; codeVerifier: string },
): Promise<NativeSsoRedemption> {
  const row = await client.ssoNativeHandoff.findUnique({
    where: { codeHash: hashCode(input.code) },
  });
  if (!row || row.usedAtUtc || !row.userId || !row.teamId || !row.ssoConnectionId || !row.authMethod) {
    return { ok: false, reason: "invalid_code" };
  }
  if (!row.codeExpiresAtUtc || row.codeExpiresAtUtc.getTime() <= Date.now()) {
    return { ok: false, reason: "expired_code" };
  }
  const expected = Buffer.from(row.codeChallenge, "utf8");
  const presented = Buffer.from(s256(input.codeVerifier), "utf8");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return { ok: false, reason: "verifier_mismatch" };
  }
  const spent = await client.ssoNativeHandoff.updateMany({
    where: { id: row.id, usedAtUtc: null },
    data: { usedAtUtc: new Date() },
  });
  if (spent.count !== 1) return { ok: false, reason: "invalid_code" };
  return {
    ok: true,
    identity: {
      userId: row.userId,
      email: row.email,
      teamId: row.teamId,
      ssoConnectionId: row.ssoConnectionId,
      authMethod: row.authMethod === "SAML" ? "SAML" : "OIDC",
      idpContext: row.idpContext,
      idpAuthAt: row.idpAuthAtUtc,
    },
  };
}
