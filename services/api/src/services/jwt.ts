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
