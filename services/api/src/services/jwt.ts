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
  /**
   * PHASE 10 §10.2 (2026-07-23) — GLOBAL authentication PROVENANCE. This JWT
   * is a GLOBAL authentication token (no Organization binding — org context
   * is server-side via `User.currentWorkspaceId` + the platform-context
   * envelope, re-evaluated per request). `authMethod` records the
   * server-VERIFIED authentication ceremony; it is assigned ONLY at the
   * validated mint sites, NEVER from a client field/header/cookie. Absent on
   * legacy tokens → treated as UNKNOWN (fails closed for SSO-required
   * Organization access; independently-allowed Personal access is
   * unaffected). NO `policyVersion` claim lives here — policy version is
   * Organization-specific and enforced live at each org-context seam.
   */
  authMethod?: AuthProvenanceMethod;
  /** Epoch seconds of the PRIMARY authentication ceremony (never reset on refresh). */
  authAt?: number;
  /**
   * §10.2 correction — ORG-BOUND SSO satisfaction. For SAML/OIDC, the exact
   * verified `SsoConnection.id` this session authenticated through. A
   * connection uniquely binds (Organization + issuer), so the org-context gate
   * resolves it by id and requires it to be ACTIVE and owned by the TARGET
   * Organization — a SAML/OIDC method ALONE never satisfies an arbitrary org.
   */
  ssoConnId?: string;
  /**
   * §10.3 correction — MFA is an ADDITIONAL assurance event; it does not
   * replace the primary `authMethod`. Epoch seconds MFA was satisfied.
   */
  mfaAt?: number;
};

/**
 * The server-verified PRIMARY authentication ceremonies (Phase 10 §10.2).
 * GUEST is intentionally NOT a member — guest login was REMOVED from runtime
 * (2026-07-23); there is no guest authentication method. UNKNOWN is the
 * truthful legacy class (legacy/guest/missing provenance) that fails closed
 * for SSO-required Organization access and is never upgraded.
 */
export type AuthProvenanceMethod =
  | "PASSWORD"
  | "MAGIC_LINK"
  | "SOCIAL_OAUTH"
  | "SAML"
  | "OIDC"
  | "UNKNOWN";

/**
 * The set of SUPPORTED, server-proven interactive authentication ceremonies.
 * A token whose `authMethod` is NOT one of these (missing, malformed, UNKNOWN,
 * or any historical/unsupported provider such as legacy GUEST) has no proven
 * provenance and MUST require reauthentication — it is NEVER coerced to a valid
 * method. This is the ONE canonical rule; there is no per-provider branch.
 */
export type SupportedAuthProvenance =
  | "PASSWORD"
  | "MAGIC_LINK"
  | "SOCIAL_OAUTH"
  | "SAML"
  | "OIDC";

/**
 * Canonical provenance gate: return the SUPPORTED provenance, or `null` when it
 * is missing/malformed/UNKNOWN/unsupported (→ the caller must require
 * reauthentication). NO fallback to PASSWORD or any valid method. A legacy
 * GUEST/UNKNOWN token deserialized here resolves to `null` and is denied
 * interactive access everywhere (Personal, Owned Workspace, Organization,
 * context switch) — it is never upgraded.
 */
export function resolveSupportedProvenance(
  m: string | null | undefined,
): SupportedAuthProvenance | null {
  switch (m) {
    case "PASSWORD":
    case "MAGIC_LINK":
    case "SOCIAL_OAUTH":
    case "SAML":
    case "OIDC":
      return m;
    default:
      return null; // missing / malformed / UNKNOWN / legacy GUEST → reauthenticate
  }
}

/**
 * Map a SUPPORTED provenance → the org security-policy AuthMethod vocabulary
 * (PASSWORD | OAUTH | SSO). SAML/OIDC → SSO (org-binding checked separately in
 * the gate); SOCIAL_OAUTH → OAUTH; PASSWORD/MAGIC_LINK → PASSWORD.
 *
 * Returns `null` for any non-supported provenance (missing/UNKNOWN/legacy
 * GUEST) — the caller MUST treat `null` as "reauthenticate", never as PASSWORD.
 * This function performs NO fail-closed coercion to a valid method.
 */
export function provenanceToPolicyAuthMethod(
  m: string | null | undefined,
): "PASSWORD" | "OAUTH" | "SSO" | null {
  const supported = resolveSupportedProvenance(m);
  if (supported === null) return null;
  if (supported === "SAML" || supported === "OIDC") return "SSO";
  if (supported === "SOCIAL_OAUTH") return "OAUTH";
  return "PASSWORD"; // PASSWORD | MAGIC_LINK (proven, non-SSO)
}

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
