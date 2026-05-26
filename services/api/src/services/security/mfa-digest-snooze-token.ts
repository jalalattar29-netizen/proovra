/**
 * PHASE R8.1.9 — signed one-click snooze token for MFA recovery
 * digest emails.
 *
 * The token is a self-contained HS256 JWT signed with the same
 * `AUTH_JWT_SECRET` used by the canonical session machinery, but
 * carries a strict `purpose: "mfa_recovery_digest_snooze"`
 * discriminator. Verifying code MUST refuse any token that does
 * not have this exact purpose value — defends against signed-token
 * cross-use even if a session JWT and a snooze JWT happen to
 * share the secret.
 *
 * Hard rules:
 *   - The token is UX-ONLY. It can apply a digest snooze. It
 *     CANNOT authenticate the user, mint a session, or escalate
 *     any other right.
 *   - The token's raw bytes are NEVER persisted. The verify
 *     endpoint signs/verifies in memory and applies the
 *     suppress-until UPDATE atomically.
 *   - The token's JTI (`jti` claim, fresh per signing) is
 *     recorded for single-use enforcement via the existing
 *     `MfaPendingChallenge` deny-list pattern — see R8.1.3's
 *     durable challenge store for the precedent.
 *   - The TTL is BOUNDED — default 15 days, matching the snooze
 *     duration so a token cannot live longer than the action it
 *     describes.
 *
 * Generated tokens are embedded in the digest email's HTML +
 * text bodies as `?token=...` URL params. The verify endpoint
 * sets `suppressUntil = now + 15d` for the scope encoded in the
 * token (global or team-scoped).
 */

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const MFA_DIGEST_SNOOZE_PURPOSE = "mfa_recovery_digest_snooze" as const;

/** Default TTL — 15 days. The token cannot live longer than the
 *  snooze it would apply. */
export const MFA_DIGEST_SNOOZE_TTL_SECONDS = 15 * 24 * 60 * 60;

export interface DigestSnoozeTokenPayload {
  /** Discriminator — refuse any other purpose value. */
  purpose: typeof MFA_DIGEST_SNOOZE_PURPOSE;
  /** The admin user the snooze applies to. */
  sub: string;
  /** Optional team scope. null/absent = global digest snooze. */
  teamId: string | null;
  /** Snooze duration in seconds (the verify endpoint stamps
   *  `suppressUntil = now + ttlSeconds`). Bounded by the TTL. */
  snoozeSeconds: number;
  /** Fresh JTI per signing — defends replay via the deny-list
   *  the verify endpoint maintains. */
  jti: string;
  /** Token expiry (epoch seconds). */
  exp: number;
  /** Issued-at (epoch seconds). */
  iat: number;
}

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

function signHmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export interface SignDigestSnoozeTokenInput {
  userId: string;
  teamId: string | null;
  snoozeSeconds?: number;
}

/**
 * Sign a one-click snooze token. The caller is the API code path
 * that assembles the digest email; the raw token is embedded in
 * the email URL ONCE and never persisted.
 */
export function signMfaDigestSnoozeToken(
  input: SignDigestSnoozeTokenInput,
  secret: string,
): string {
  const ttl = input.snoozeSeconds ?? MFA_DIGEST_SNOOZE_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const payload: DigestSnoozeTokenPayload = {
    purpose: MFA_DIGEST_SNOOZE_PURPOSE,
    sub: input.userId,
    teamId: input.teamId,
    snoozeSeconds: ttl,
    jti: randomBytes(16).toString("hex"),
    iat: now,
    exp: now + ttl,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlEncode(signHmac(signingInput, secret));
  return `${signingInput}.${signature}`;
}

export type VerifyDigestSnoozeError =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_purpose";

export interface VerifyDigestSnoozeResult {
  ok: boolean;
  payload?: DigestSnoozeTokenPayload;
  reason?: VerifyDigestSnoozeError;
}

/**
 * Pure verification. NO side effects — the verify endpoint is
 * responsible for replay tracking + applying the snooze.
 */
export function verifyMfaDigestSnoozeToken(
  token: string,
  secret: string,
): VerifyDigestSnoozeResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = signHmac(signingInput, secret);
  const actual = base64UrlDecode(signatureB64);
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed: DigestSnoozeTokenPayload;
  try {
    parsed = JSON.parse(
      base64UrlDecode(payloadB64).toString("utf8"),
    ) as DigestSnoozeTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.purpose !== MFA_DIGEST_SNOOZE_PURPOSE) {
    return { ok: false, reason: "wrong_purpose" };
  }
  if (!parsed.exp || Date.now() / 1000 >= parsed.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: parsed };
}
