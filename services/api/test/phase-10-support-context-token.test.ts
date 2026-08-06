/**
 * PHASE 10 CLOSURE FIX 1 / HARDENING FIX 1 (2026-07-23) — support-context
 * token sign/verify unit coverage.
 *
 * Isolated from the DB / route layer: exercises ONLY
 * `services/identity/support-context-token.service.ts` — the HMAC sign/verify
 * pair `middleware/authorize.ts` and `routes/enterprise-security.routes.ts`
 * (`/v1/support-access/enter`) both depend on. No mocks — the real
 * `node:crypto` primitives (including `hkdfSync`) run.
 *
 * HARDENING FIX 1 additions: session binding (`sessionIdHash` in the
 * payload), the HKDF-derived signing key (domain label
 * "proovra/support-context/v1"), the `jti` nonce, and the version bump to
 * `support_context_v2`.
 */

import { beforeEach, describe, expect, it } from "vitest";

const SECRET_A = "phase-10-closure-fix-1-secret-a";
const SECRET_B = "phase-10-closure-fix-1-secret-b";

const GRANT = "grant-abc-123";
const ACTOR = "support-user-1";
const SESSION_HASH = "session-hash-aaaa";
const OTHER_SESSION_HASH = "session-hash-bbbb";

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = SECRET_A;
});

describe("signSupportContextToken / verifySupportContextToken", () => {
  it("round-trips: a freshly signed token verifies and carries exactly grantId + supportUserId + sessionIdHash + iat + exp + jti + typ", async () => {
    const { signSupportContextToken, verifySupportContextToken, SUPPORT_CONTEXT_TOKEN_TTL_SECONDS } =
      await import("../src/services/identity/support-context-token.service.js");
    const token = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    const result = verifySupportContextToken(token);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.payload.grantId).toBe(GRANT);
    expect(result.payload.supportUserId).toBe(ACTOR);
    expect(result.payload.sessionIdHash).toBe(SESSION_HASH);
    expect(typeof result.payload.jti).toBe("string");
    expect(result.payload.jti.length).toBeGreaterThan(0);
    expect(result.payload.exp - result.payload.iat).toBe(SUPPORT_CONTEXT_TOKEN_TTL_SECONDS);
    // The bounded, exhaustive claim set — no mode/scope/org/workspace/action/approval.
    expect(Object.keys(result.payload).sort()).toEqual(
      ["exp", "grantId", "iat", "jti", "sessionIdHash", "supportUserId", "typ"],
    );
  });

  it("two tokens minted back-to-back carry DIFFERENT jti nonces", async () => {
    const { signSupportContextToken, verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const t1 = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    const t2 = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    const r1 = verifySupportContextToken(t1);
    const r2 = verifySupportContextToken(t2);
    if (!r1.valid || !r2.valid) throw new Error("expected both to verify");
    expect(r1.payload.jti).not.toBe(r2.payload.jti);
  });

  it("mint without a sessionIdHash throws (fail closed, never issues an unbound token)", async () => {
    const { signSupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    expect(() =>
      signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: "" }),
    ).toThrow();
  });

  it("a token signed with a DIFFERENT secret fails verification (key confusion)", async () => {
    const { signSupportContextToken, verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    process.env.AUTH_JWT_SECRET = SECRET_A;
    const token = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    process.env.AUTH_JWT_SECRET = SECRET_B;
    const result = verifySupportContextToken(token);
    expect(result.valid).toBe(false);
  });

  it("a bit-flipped signature fails verification", async () => {
    const { signSupportContextToken, verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const token = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    const [payloadB64, sigB64] = token.split(".");
    // Flip a bit in the signature BYTES, not in the last base64url character.
    // The trailing character of a base64url string carries padding bits, so
    // substituting it can re-encode to the SAME bytes and leave the signature
    // intact — which made this assertion depend on the last byte of whatever
    // HMAC was produced. Mutating the decoded bytes is deterministic.
    const sigBytes = Buffer.from(sigB64, "base64url");
    sigBytes[0] ^= 0x01;
    const tampered = `${payloadB64}.${sigBytes.toString("base64url")}`;
    expect(tampered).not.toBe(token);
    expect(verifySupportContextToken(tampered).valid).toBe(false);
  });

  it("a payload tampered to claim a different grantId, with the ORIGINAL signature, fails verification", async () => {
    const { signSupportContextToken, verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const token = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    const [payloadB64, sigB64] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as Record<string, unknown>;
    decoded.grantId = "grant-someone-elses";
    const forgedPayloadB64 = Buffer.from(JSON.stringify(decoded))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const forged = `${forgedPayloadB64}.${sigB64}`;
    expect(verifySupportContextToken(forged).valid).toBe(false);
  });

  it("a payload tampered to claim a different sessionIdHash, with the ORIGINAL signature, fails verification", async () => {
    const { signSupportContextToken, verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const token = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    const [payloadB64, sigB64] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as Record<string, unknown>;
    decoded.sessionIdHash = OTHER_SESSION_HASH;
    const forgedPayloadB64 = Buffer.from(JSON.stringify(decoded))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const forged = `${forgedPayloadB64}.${sigB64}`;
    expect(verifySupportContextToken(forged).valid).toBe(false);
  });

  it("malformed strings never throw and never verify: no dot, empty, random garbage", async () => {
    const { verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    expect(verifySupportContextToken("").valid).toBe(false);
    expect(verifySupportContextToken(null).valid).toBe(false);
    expect(verifySupportContextToken(undefined).valid).toBe(false);
    expect(verifySupportContextToken("no-dot-here").valid).toBe(false);
    expect(verifySupportContextToken("a.b.c").valid).toBe(false); // 3 segments (real-JWT shape), not 2
    expect(verifySupportContextToken("....").valid).toBe(false);
  });

  it("a real session JWT (services/jwt.ts signJwt) never verifies as a support-context token — no cross-protocol confusion", async () => {
    const { signJwt } = await import("../src/services/jwt.js");
    const { verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const sessionJwt = signJwt({ sub: ACTOR, provider: "password" }, SECRET_A, 3600);
    expect(verifySupportContextToken(sessionJwt).valid).toBe(false);
  });

  it("a support-context token never verifies as a real session JWT — cross-protocol isolation holds in the OTHER direction too", async () => {
    const { signSupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const { verifyJwt } = await import("../src/services/jwt.js");
    const supportToken = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    expect(() => verifyJwt(supportToken, SECRET_A)).toThrow();
  });

  it("KEY-DOMAIN SUBSTITUTION: a token forged by signing directly with the RAW AUTH_JWT_SECRET (bypassing the HKDF derivation) fails verification", async () => {
    const { verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const { createHmac } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      typ: "support_context_v2",
      supportUserId: ACTOR,
      sessionIdHash: SESSION_HASH,
      grantId: GRANT,
      iat: now,
      exp: now + 900,
      jti: "forged-jti",
    };
    const b64 = (b: Buffer | string) =>
      (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = b64(JSON.stringify(payload));
    // Signed with the RAW secret — no HKDF derivation — this is exactly the
    // OLD (pre-hardening) scheme and must no longer verify.
    const sig = createHmac("sha256", SECRET_A).update(payloadB64).digest();
    const forged = `${payloadB64}.${b64(sig)}`;
    expect(verifySupportContextToken(forged).valid).toBe(false);
  });

  it("KEY-DOMAIN SUBSTITUTION: a token signed with an HKDF key derived under a DIFFERENT info/domain label fails verification", async () => {
    const { verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const { createHmac, hkdfSync } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      typ: "support_context_v2",
      supportUserId: ACTOR,
      sessionIdHash: SESSION_HASH,
      grantId: GRANT,
      iat: now,
      exp: now + 900,
      jti: "forged-jti-2",
    };
    const b64 = (b: Buffer | string) =>
      (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = b64(JSON.stringify(payload));
    // Same HKDF construction, but a DIFFERENT domain label (info) than the
    // production "proovra/support-context/v1" — a completely different
    // derived key results, so the signature must not verify.
    const wrongInfo = Buffer.from("proovra/support-context/v0-wrong-domain", "utf8");
    const wrongSalt = Buffer.from("proovra/support-context/v0-wrong-domain/hkdf-salt", "utf8");
    const derived = Buffer.from(
      hkdfSync("sha256", Buffer.from(SECRET_A, "utf8"), wrongSalt, wrongInfo, 32),
    );
    const sig = createHmac("sha256", derived).update(payloadB64).digest();
    const forged = `${payloadB64}.${b64(sig)}`;
    expect(verifySupportContextToken(forged).valid).toBe(false);
  });

  it("a v1-shaped payload (no sessionIdHash/jti, old typ) signed under the CORRECT derived key still fails — the typ/version discriminator alone denies it", async () => {
    const { verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const { createHmac, hkdfSync } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const legacyPayload = { typ: "support_context_v1", grantId: GRANT, supportUserId: ACTOR, iat: now, exp: now + 900 };
    const b64 = (b: Buffer | string) =>
      (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = b64(JSON.stringify(legacyPayload));
    const info = Buffer.from("proovra/support-context/v1", "utf8");
    const salt = Buffer.from("proovra/support-context/v1/hkdf-salt", "utf8");
    const derived = Buffer.from(hkdfSync("sha256", Buffer.from(SECRET_A, "utf8"), salt, info, 32));
    const sig = createHmac("sha256", derived).update(payloadB64).digest();
    const legacyToken = `${payloadB64}.${b64(sig)}`;
    expect(verifySupportContextToken(legacyToken).valid).toBe(false);
  });

  it("an expired token fails verification even with a valid signature", async () => {
    const { verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const { createHmac, hkdfSync } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      typ: "support_context_v2",
      supportUserId: ACTOR,
      sessionIdHash: SESSION_HASH,
      grantId: GRANT,
      iat: now - 1000,
      exp: now - 10,
      jti: "expired-jti",
    };
    const b64 = (b: Buffer | string) =>
      (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payloadB64 = b64(JSON.stringify(payload));
    const info = Buffer.from("proovra/support-context/v1", "utf8");
    const salt = Buffer.from("proovra/support-context/v1/hkdf-salt", "utf8");
    const derived = Buffer.from(hkdfSync("sha256", Buffer.from(SECRET_A, "utf8"), salt, info, 32));
    const sig = createHmac("sha256", derived).update(payloadB64).digest();
    const expiredToken = `${payloadB64}.${b64(sig)}`;
    expect(verifySupportContextToken(expiredToken).valid).toBe(false);
  });

  it("no signing secret configured → sign throws (fail closed, never issues an unsigned token)", async () => {
    const { signSupportContextToken } = await import("../src/services/identity/support-context-token.service.js");
    const original = process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    try {
      expect(() =>
        signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH }),
      ).toThrow();
    } finally {
      process.env.AUTH_JWT_SECRET = original;
    }
  });

  it("no signing secret configured → verify returns invalid, never throws", async () => {
    const { signSupportContextToken, verifySupportContextToken } = await import(
      "../src/services/identity/support-context-token.service.js"
    );
    const token = signSupportContextToken({ grantId: GRANT, supportUserId: ACTOR, sessionIdHash: SESSION_HASH });
    const original = process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    try {
      expect(verifySupportContextToken(token).valid).toBe(false);
    } finally {
      process.env.AUTH_JWT_SECRET = original;
    }
  });
});
