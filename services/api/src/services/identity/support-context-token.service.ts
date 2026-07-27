/**
 * PHASE 10 CLOSURE FIX 1 (2026-07-23) — server-authoritative support-context
 * token (sign / verify).
 *
 * THE DEFECT THIS CLOSES: support enforcement used to be armed by a
 * CLIENT-CONTROLLED boolean header (`x-proovra-support-mode`) — any caller
 * could flip enforcement on/off by choosing whether to send the header. A
 * client must never decide whether the support-access runtime guard runs.
 *
 * THE FIX: the client can now transport only an OPAQUE, SERVER-ISSUED,
 * SERVER-VERIFIED token (`x-proovra-support-context`, see
 * `middleware/authorize.ts`). Every field it carries is server-issued;
 * mode / scope / org / workspace / action / approval are NEVER carried —
 * all of those are re-resolved from the persisted `SupportAccessGrant` row
 * on every request by `applySupportAccessGuard` (support-runtime.service.ts).
 * Presenting a forged/expired/wrong-shape token must NEVER be treated as a
 * support-context request — it fails closed to "not support context" (see
 * `verifySupportContextToken`).
 *
 * PHASE 10 HARDENING FIX 1 (2026-07-23) — SESSION BINDING + KEY-DOMAIN
 * SEPARATION.
 *
 *   1. SESSION BINDING — the payload now carries `sessionIdHash`: the hash
 *      (`hashSessionId`, session-revocation.service.ts) of the EXACT
 *      authenticated session that requested the token (`POST
 *      /v1/support-access/enter`). `middleware/authorize.ts` requires this
 *      to equal the CURRENT request's session hash before honouring the
 *      token — a token minted in Session A is REJECTED when presented from
 *      Session B, even for the same support actor. This closes a session-
 *      fixation / token-portability gap: previously the token authorized
 *      any session the actor happened to be using.
 *
 *   2. DOMAIN-SEPARATED SIGNING KEY — the token is no longer signed with
 *      the raw `AUTH_JWT_SECRET`. A sub-key is derived via HKDF-SHA256
 *      (RFC 5869, `node:crypto` `hkdfSync`) under the fixed, explicit
 *      context label `"proovra/support-context/v1"`. This gives
 *      cryptographic domain separation on top of the existing `typ`
 *      discriminator: even a party that recovers a signature computed
 *      under this scheme learns nothing usable against the raw secret or
 *      against any other HMAC surface keyed directly off it (real session
 *      JWTs, `services/jwt.ts`). No new secret / env var / migration — the
 *      root key is still the one existing `AUTH_JWT_SECRET`.
 *
 *   3. `jti` — a random per-token nonce (mirrors the `sid`/`jti` nonce
 *      vocabulary already established in `services/jwt.ts`), carried for
 *      forward-compatible replay tracking / audit correlation.
 *
 * SIGNING SCHEME: reuses the exact base64url + HMAC-SHA256 +
 * timingSafeEqual primitives already established in `services/jwt.ts` — no
 * new encoding scheme, just a domain-separated key. Cross-protocol
 * isolation from real session JWTs comes from BOTH the `typ` discriminator
 * inside the signed payload AND the derived (not raw-secret) signing key —
 * a real session JWT can never verify as a support-context token, and a
 * support-context token forged/replayed with the raw `AUTH_JWT_SECRET`
 * (bypassing the HKDF derivation) never verifies either.
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { getSecret } from "../../config/runtime-secrets.js";

const TOKEN_TYPE = "support_context_v2" as const;

/**
 * The token heals out after this many seconds. Short-lived by design: the
 * support actor re-enters context (`POST /v1/support-access/enter`) to
 * refresh it. This is independent, additional decay on top of the grant's
 * own expiry/revocation — which is re-checked fresh from the DB on every
 * request regardless of this TTL — AND on top of the session-binding check
 * (a session that outlives its own token TTL still must re-enter to mint a
 * fresh, currently-session-bound token).
 */
export const SUPPORT_CONTEXT_TOKEN_TTL_SECONDS = 15 * 60;

// -----------------------------------------------------------------------------
// PHASE 10 HARDENING FIX 1 — HKDF domain separation (RFC 5869).
//
// `HKDF_INFO` is the fixed, explicit context label for this token class —
// the "domain separation" input. `HKDF_SALT` is a second, independent
// fixed, non-secret value (RFC 5869 §3.1 permits a non-secret salt; a
// fixed non-zero salt is used here rather than an all-zero salt purely so
// this derivation can never coincide with an accidental zero-salt
// derivation elsewhere in the codebase). Both are constants, never derived
// from request data, so verification is a pure function of the (still
// single, still unmigrated) `AUTH_JWT_SECRET`.
// -----------------------------------------------------------------------------
const HKDF_DOMAIN_LABEL = "proovra/support-context/v1";
const HKDF_INFO = Buffer.from(HKDF_DOMAIN_LABEL, "utf8");
const HKDF_SALT = Buffer.from(`${HKDF_DOMAIN_LABEL}/hkdf-salt`, "utf8");
const DERIVED_KEY_LENGTH_BYTES = 32; // 256-bit key for HMAC-SHA256.

/**
 * Derive the support-context signing key from `AUTH_JWT_SECRET` via
 * HKDF-SHA256. NEVER sign/verify with the raw secret string directly —
 * doing so would let a support-context token double as (or be forged
 * from) any other HMAC surface keyed off the same root secret. Pure
 * function; no I/O, no memoisation (cheap enough to recompute per call and
 * avoids caching key material across requests).
 */
function deriveSigningKey(secret: string): Buffer {
  const ikm = Buffer.from(secret, "utf8");
  const derived = hkdfSync(
    "sha256",
    ikm,
    HKDF_SALT,
    HKDF_INFO,
    DERIVED_KEY_LENGTH_BYTES,
  );
  return Buffer.from(derived);
}

export type SupportContextTokenPayload = {
  /** Version discriminator — bumped from `support_context_v1` because the
   *  claim set changed (added `sessionIdHash` + `jti`). */
  typ: typeof TOKEN_TYPE;
  /** The authenticated support actor the grant belongs to. */
  supportUserId: string;
  /**
   * PHASE 10 HARDENING FIX 1 — HMAC-SHA256 hash (`hashSessionId`,
   * session-revocation.service.ts) of the EXACT authenticated session's
   * `sid` claim that was active when this token was minted. Verification
   * requires this to equal the CURRENT request's session hash.
   */
  sessionIdHash: string;
  /** The ACTIVE `SupportAccessGrant.id` already validated against the DB. */
  grantId: string;
  iat: number;
  exp: number;
  /** Random per-token nonce (mirrors the `sid`/`jti` vocabulary in services/jwt.ts). */
  jti: string;
};

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function signHmac(data: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * Reuses the app's one existing HMAC root secret (Phase P2.0 migrated
 * secret: AWS Secrets Manager cache first, `process.env` fallback — same
 * resolution order `middleware/auth.ts` uses for session JWTs). No new
 * secret is introduced — but callers MUST run it through
 * `deriveSigningKey` before use, never sign/verify with it directly.
 */
function resolveSigningSecret(): string | null {
  return getSecret("AUTH_JWT_SECRET");
}

export type SignSupportContextTokenInput = {
  /** The ACTIVE `SupportAccessGrant.id` already validated against the DB. */
  grantId: string;
  /** The authenticated support actor the grant belongs to. */
  supportUserId: string;
  /**
   * PHASE 10 HARDENING FIX 1 — the CURRENT authenticated session's hashed
   * session id (`getAuthSessionId`, src/auth.ts — already the exact hash
   * `hashSessionId(sid)` computed by `middleware/auth.ts#requireAuth`).
   * REQUIRED: minting a token without pinning it to a session would
   * reintroduce the cross-session replay gap this fix closes.
   */
  sessionIdHash: string;
};

/**
 * Mint the opaque support-context token. MUST be called ONLY from the
 * server-side entry endpoint (`POST /v1/support-access/enter`,
 * enterprise-security.routes.ts) after the caller's grant has already been
 * re-validated against the DB (ACTIVE, not expired, not revoked,
 * `supportUserId` === authenticated actor) AND the caller's current
 * session id hash has been resolved. Fails closed by throwing when the
 * signing secret is not configured, or when `sessionIdHash` is missing —
 * never issues an unsigned or unbound token.
 */
export function signSupportContextToken(
  input: SignSupportContextTokenInput,
): string {
  const secret = resolveSigningSecret();
  if (!secret) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }
  if (!input.sessionIdHash) {
    throw new Error("sessionIdHash is required to mint a support-context token");
  }
  const key = deriveSigningKey(secret);
  const now = Math.floor(Date.now() / 1000);
  const payload: SupportContextTokenPayload = {
    typ: TOKEN_TYPE,
    supportUserId: input.supportUserId,
    sessionIdHash: input.sessionIdHash,
    grantId: input.grantId,
    iat: now,
    exp: now + SUPPORT_CONTEXT_TOKEN_TTL_SECONDS,
    jti: randomBytes(16).toString("hex"),
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(signHmac(payloadB64, key));
  return `${payloadB64}.${signature}`;
}

export type VerifySupportContextTokenResult =
  | { valid: true; payload: SupportContextTokenPayload }
  | { valid: false };

/**
 * Verify the opaque support-context token. NEVER throws — any malformed,
 * unsigned, forged, wrong-`typ`, wrong-key-domain, or expired token
 * resolves to `{ valid: false }`. The caller (middleware/authorize.ts)
 * MUST treat an invalid result as "this request carries no support
 * context" — it must NEVER fall back to enforcing with client-declared
 * values, and a forged token must never be treated as a valid (nor as a
 * permissive) signal. This function verifies ONLY the signature + shape +
 * `typ` + expiry of the token itself — it does NOT check session binding
 * (the caller compares `payload.sessionIdHash` against the current
 * request's session) or grant validity (re-checked fresh from the DB by
 * `applySupportAccessGuard`).
 */
export function verifySupportContextToken(
  token: string | null | undefined,
): VerifySupportContextTokenResult {
  if (!token || typeof token !== "string") return { valid: false };

  const secret = resolveSigningSecret();
  if (!secret) return { valid: false };

  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false };
  const [payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) return { valid: false };

  let expected: Buffer;
  let actual: Buffer;
  try {
    const key = deriveSigningKey(secret);
    expected = signHmac(payloadB64, key);
    actual = base64UrlDecode(signatureB64);
  } catch {
    return { valid: false };
  }
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return { valid: false };
  }

  let payload: SupportContextTokenPayload;
  try {
    payload = JSON.parse(
      base64UrlDecode(payloadB64).toString("utf8"),
    ) as SupportContextTokenPayload;
  } catch {
    return { valid: false };
  }

  if (
    !payload ||
    payload.typ !== TOKEN_TYPE ||
    typeof payload.grantId !== "string" ||
    payload.grantId.length === 0 ||
    typeof payload.supportUserId !== "string" ||
    payload.supportUserId.length === 0 ||
    typeof payload.sessionIdHash !== "string" ||
    payload.sessionIdHash.length === 0 ||
    typeof payload.jti !== "string" ||
    payload.jti.length === 0 ||
    typeof payload.exp !== "number"
  ) {
    return { valid: false };
  }

  if (Date.now() / 1000 >= payload.exp) {
    return { valid: false };
  }

  return { valid: true, payload };
}
