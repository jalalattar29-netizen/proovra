import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type JwtPayload = {
  sub: string;
  provider: string;
  email?: string | null;
  /** Present when user is a platform admin (dashboard / audit). */
  role?: string | null;
  exp?: number;
  /**
   * Phase 19 — issued-at (epoch seconds). Always set by `signJwt`;
   * may be missing on JWTs issued before Phase 19. Used by the
   * session-revocation deny list for ALL_FOR_USER revoke.
   */
  iat?: number;
  /**
   * Phase 19 — opaque session id. Always set by `signJwt` (random
   * 16 bytes hex). Hashed and persisted in `revoked_sessions` when
   * an operator revokes a single session.
   */
  sid?: string;
  /**
   * PHASE R8.1.2 — MFA-pending discriminator. When set to "pending"
   * the token represents a half-completed login: primary credentials
   * have verified but the MFA challenge has not. The canonical
   * `requireAuth` middleware MUST refuse pending tokens — they only
   * authorize calls to `POST /v1/auth/mfa/verify`. Absent on normal
   * fully-authenticated session tokens.
   */
  mfa?: "pending";
};

function base64UrlEncode(input: Buffer | string) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(input.length / 4) * 4,
    "="
  );
  return Buffer.from(padded, "base64");
}

function signHmac(data: string, secret: string) {
  return createHmac("sha256", secret).update(data).digest();
}

export function signJwt(
  payload: JwtPayload,
  secret: string,
  expiresInSec: number
) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expiresInSec;
  // Phase 19 — always populate iat + sid so the session-revocation
  // registry has something to key on. sid is a fresh random per
  // signing; caller cannot override (deliberate — we don't want sid
  // collisions across signings).
  const sid = randomBytes(16).toString("hex");
  const payloadWithExp = { ...payload, iat: now, exp, sid };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payloadWithExp));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlEncode(signHmac(signingInput, secret));
  return `${signingInput}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token");
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = signHmac(signingInput, secret);
  const actual = base64UrlDecode(signatureB64);
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error("Invalid signature");
  }
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as JwtPayload;
  if (!payload.exp || Date.now() / 1000 >= payload.exp) {
    throw new Error("Token expired");
  }
  return payload;
}

// =============================================================================
// PHASE R8.1.2 — MFA-pending token (signature primitives).
//
// A pending token is a short-lived (5-min) JWT that proves "primary
// credentials passed; MFA still required". It is NOT a session — it
// authorizes EXACTLY ONE endpoint (`POST /v1/auth/mfa/verify`). The
// canonical `requireAuth` middleware rejects it because of the
// `mfa: "pending"` discriminator.
//
// PHASE R8.1.3 update: durable `MfaPendingChallenge` row is the
// source of replay truth — `consumeMfaPendingChallenge` runs an
// atomic UPDATE that survives multi-instance / serverless
// deployments.
//
// PHASE R8.1.4 update: the legacy in-process JTI deny list AND its
// legacy verify-and-consume helper have been REMOVED from this file.
// They were defence-in-depth before R8.1.3; once the durable
// consume became the production check the helper had no remaining
// callers in src/. Keeping it would have been dead code with a
// misleading name. `verifyMfaPendingTokenSignature` is the only
// verify path.
// =============================================================================

/** TTL for the MFA-pending token. Short-circuits replay window. */
export const MFA_PENDING_TTL_SECONDS = 5 * 60;

/**
 * Sign an MFA-pending token. The caller must already have validated
 * primary credentials. The returned token MUST be returned in the
 * response body — DO NOT set the canonical `proovra_session` cookie
 * with this token.
 *
 * R8.1.3 update: when `jti` is supplied, the resulting token's `sid`
 * claim is that exact JTI string (instead of a freshly-random sid).
 * The caller (auth.routes.ts gate) supplies the JTI returned by
 * `createMfaPendingChallenge` so the signed token and the durable
 * DB row reference the same opaque identifier. The verify endpoint
 * then atomically consumes the DB row keyed by that JTI.
 *
 * If `jti` is omitted (legacy call sites), signJwt mints a fresh
 * sid as before — the in-memory deny list still catches replay in
 * that path. R8.1.3 production paths SHOULD always supply jti.
 */
export function signMfaPendingToken(
  payload: Omit<JwtPayload, "exp" | "iat" | "sid" | "mfa">,
  secret: string,
  jti?: string,
): string {
  if (jti) {
    // Sign with the caller-supplied JTI as `sid`. We build the JWT
    // manually because signJwt always replaces `sid` with a fresh
    // random — by design — and we need the durable row's id here.
    const header = { alg: "HS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const exp = now + MFA_PENDING_TTL_SECONDS;
    const payloadWithExp = {
      ...payload,
      mfa: "pending" as const,
      iat: now,
      exp,
      sid: jti,
    };
    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payloadWithExp));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = base64UrlEncode(signHmac(signingInput, secret));
    return `${signingInput}.${signature}`;
  }
  return signJwt(
    { ...payload, mfa: "pending" },
    secret,
    MFA_PENDING_TTL_SECONDS,
  );
}

/**
 * Pure signature-verification of an MFA-pending token. No
 * in-process side effects, no deny-list lookup. The caller is
 * responsible for invoking `consumeMfaPendingChallenge` against
 * the durable store before issuing a session. Used by the R8.1.3
 * verify endpoint.
 */
export function verifyMfaPendingTokenSignature(
  token: string,
  secret: string,
): JwtPayload {
  const payload = verifyJwt(token, secret);
  if (payload.mfa !== "pending") {
    throw new Error("not_a_pending_token");
  }
  return payload;
}
