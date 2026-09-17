/**
 * D27 (2026-09-16) — External reviewer portal: emailed one-time code.
 *
 * WHY THIS EXISTS
 *
 * A grant can be marked `mfaRequired`. The portal sign-in used to answer a
 * missing code with MFA_REQUIRED and then accept ANY six digits: it recorded
 * MFA_CHALLENGE_PASSED and stamped `mfaSatisfiedAtUtc` without checking the
 * digits against anything. The comment above it described a TOTP secret bound
 * to the grant; no such secret exists. An external reviewer has no user
 * account and no enrolled factor, so the only second factor the product can
 * honestly offer is possession of the mailbox the invitation was sent to.
 *
 * THE DESIGN
 *
 *   - A six-digit code, generated with the CSPRNG, emailed to the grant's
 *     reviewer address through the canonical email authority
 *     (`sendCustomEmailViaResend` -> `deliverEmail`), with an idempotency key
 *     derived from (grant id, challenge id).
 *   - One live challenge per grant, held in Redis under
 *     `portal:mfa-challenge:<grantId>` with a TTL equal to its expiry
 *     (10 minutes). The stored value is a scrypt verifier of the code under a
 *     per-challenge random salt — the same construction the MFA recovery codes
 *     use (`services/security/mfa-recovery.ts`). The plaintext code is never
 *     stored and never logged.
 *   - Five wrong answers delete the challenge. Attempts are reserved
 *     atomically BEFORE the comparison (a Lua script), so concurrent guesses
 *     cannot each observe "four so far" and slip past the bound.
 *   - A correct answer consumes the challenge with a compare-and-delete on the
 *     challenge id, so the same code can never open two sessions.
 *   - There is NO in-memory fallback. A process-local store would let a second
 *     API instance answer "no challenge" or, worse, keep a challenge another
 *     instance already consumed. When Redis cannot be reached every operation
 *     throws `PortalMfaChallengeUnavailableError` and the caller fails closed.
 */

import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import IORedis from "ioredis";
import { maskEmail } from "@proovra/shared";
import { mintEmailIdempotencyKey } from "@proovra/shared-runtime";

import {
  escapeEmailHtml,
  getEmailBrandName,
  getEmailFromHeader,
  getEmailSupportAddress,
  renderEmailShell,
  sendCustomEmailViaResend,
} from "../email.service.js";
import { enforceRateLimit } from "../rate-limit.js";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** How long an emailed code stays valid. */
export const PORTAL_MFA_CODE_TTL_MS = 10 * 60 * 1000;
/** A live code younger than this is reused instead of sending another email. */
export const PORTAL_MFA_RESEND_COOLDOWN_MS = 60 * 1000;
/** Wrong answers allowed before the challenge is destroyed. */
export const PORTAL_MFA_MAX_ATTEMPTS = 5;
/** Code issuance budget per grant. */
export const PORTAL_MFA_ISSUE_LIMIT = { max: 5, windowSec: 15 * 60 } as const;

/** scrypt parameters — identical to the recovery-code verifier. */
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DK_LEN = 32;

const KEY_PREFIX = "portal:mfa-challenge:";

// ---------------------------------------------------------------------------
// Redis access — no memory fallback, by design
// ---------------------------------------------------------------------------

export class PortalMfaChallengeUnavailableError extends Error {
  constructor() {
    super("portal MFA challenge store unavailable");
    this.name = "PortalMfaChallengeUnavailableError";
  }
}

type RedisLike = Pick<IORedis, "status" | "connect" | "eval" | "multi" | "set" | "pexpire" | "del">;

let client: IORedis | null = null;
let override: RedisLike | null = null;

/**
 * Test seam: point the challenge store at a specific client (for example one
 * aimed at an unreachable loopback port). `null` restores the default.
 */
export function setPortalMfaChallengeRedisForTests(next: RedisLike | null): void {
  override = next;
}

function redis(): RedisLike {
  if (override) return override;
  if (client && client.status !== "end") return client;
  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new PortalMfaChallengeUnavailableError();
  client = new IORedis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
  });
  // An ioredis client with no error listener crashes the process on the
  // first connection failure. The failure is answered per call instead.
  client.on("error", () => undefined);
  return client;
}

async function withRedis<T>(fn: (r: RedisLike) => Promise<T>): Promise<T> {
  try {
    const r = redis();
    if (r.status === "wait") await r.connect();
    return await fn(r);
  } catch {
    throw new PortalMfaChallengeUnavailableError();
  }
}

const keyFor = (grantId: string) => `${KEY_PREFIX}${grantId}`;

// ---------------------------------------------------------------------------
// Session-bound satisfaction (D27b)
// ---------------------------------------------------------------------------
//
// A verified code satisfies the SESSION it opened, never the grant: a second
// holder of the same token starts a new session and must answer a code sent
// to the invited mailbox. The record slides with activity and lives no longer
// than the portal's inactivity window. A store failure is an error, so the
// gate fails closed.

const SESSION_KEY_PREFIX = "portal:mfa-session:";
const sessionKeyFor = (grantId: string, sessionId: string) =>
  `${SESSION_KEY_PREFIX}${grantId}:${sessionId}`;

export async function markPortalMfaSessionSatisfied(input: {
  grantId: string;
  sessionId: string;
  ttlMs: number;
}): Promise<void> {
  await withRedis((r) => r.set(sessionKeyFor(input.grantId, input.sessionId), "1", "PX", input.ttlMs));
}

/** True when this session answered a code and has been active since; slides the window. */
export async function isPortalMfaSessionSatisfied(input: {
  grantId: string;
  sessionId: string;
  ttlMs: number;
}): Promise<boolean> {
  const refreshed = await withRedis((r) =>
    r.pexpire(sessionKeyFor(input.grantId, input.sessionId), input.ttlMs),
  );
  return refreshed === 1;
}

/** Logout: the session's satisfaction ends with it. */
export async function clearPortalMfaSession(input: { grantId: string; sessionId: string }): Promise<void> {
  await withRedis((r) => r.del(sessionKeyFor(input.grantId, input.sessionId)));
}

// ---------------------------------------------------------------------------
// Code + verifier
// ---------------------------------------------------------------------------

type StoredChallenge = {
  challengeId: string;
  saltHex: string;
  verifierHex: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function deriveVerifier(code: string, salt: Buffer): Buffer {
  return scryptSync(code, salt, SCRYPT_DK_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function codeMatches(code: string, stored: StoredChallenge): boolean {
  const expected = Buffer.from(stored.verifierHex, "hex");
  if (expected.length !== SCRYPT_DK_LEN) return false;
  const candidate = deriveVerifier(code, Buffer.from(stored.saltHex, "hex"));
  return timingSafeEqual(candidate, expected);
}

function parseStored(raw: unknown): StoredChallenge | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredChallenge>;
    if (
      typeof v.challengeId === "string" &&
      typeof v.saltHex === "string" &&
      typeof v.verifierHex === "string" &&
      typeof v.issuedAtMs === "number" &&
      typeof v.expiresAtMs === "number"
    ) {
      return v as StoredChallenge;
    }
  } catch {
    // Unreadable record — treated as absent (fail closed).
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store primitives
// ---------------------------------------------------------------------------

const READ_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
return {redis.call('HGET', KEYS[1], 'record'), redis.call('HGET', KEYS[1], 'attempts')}
`;

/** Reserve one attempt atomically, then hand back the record to check against. */
const RESERVE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
return {redis.call('HGET', KEYS[1], 'record'), n}
`;

/** Delete only if the live challenge is still the one that was checked. */
const CONSUME_SCRIPT = `
if redis.call('HGET', KEYS[1], 'cid') == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function readLive(grantId: string): Promise<StoredChallenge | null> {
  const res = (await withRedis((r) => r.eval(READ_SCRIPT, 1, keyFor(grantId)))) as
    | [unknown, unknown]
    | null;
  if (!res) return null;
  const stored = parseStored(res[0]);
  if (!stored || stored.expiresAtMs <= Date.now()) return null;
  return stored;
}

async function writeChallenge(grantId: string, stored: StoredChallenge): Promise<void> {
  const ttl = Math.max(1, stored.expiresAtMs - Date.now());
  const key = keyFor(grantId);
  await withRedis(async (r) => {
    const res = await r
      .multi()
      .del(key)
      .hset(key, "cid", stored.challengeId, "record", JSON.stringify(stored), "attempts", "0")
      .pexpire(key, ttl)
      .exec();
    if (!res || res.some(([err]) => err)) throw new Error("challenge write failed");
  });
}

async function consume(grantId: string, challengeId: string): Promise<boolean> {
  const n = await withRedis((r) => r.eval(CONSUME_SCRIPT, 1, keyFor(grantId), challengeId));
  return Number(n) === 1;
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export type IssuePortalMfaCodeResult =
  | {
      ok: true;
      /** False when a live code younger than the cooldown was reused. */
      sent: boolean;
      destination: string | null;
      resendAvailableInSeconds: number;
      expiresAtUtc: string;
      challengeId: string;
    }
  | { ok: false; reason: "RATE_LIMITED" | "MFA_UNAVAILABLE" };

/**
 * Ensure the reviewer has a live emailed code: reuse one sent less than a
 * minute ago, otherwise replace any older challenge with a new one and send it.
 */
export async function issuePortalMfaCode(input: {
  grantId: string;
  reviewerEmail: string;
}): Promise<IssuePortalMfaCodeResult> {
  const destination = maskEmail(input.reviewerEmail);
  const now = Date.now();

  let live: StoredChallenge | null;
  try {
    live = await readLive(input.grantId);
  } catch {
    return { ok: false, reason: "MFA_UNAVAILABLE" };
  }
  if (live && now - live.issuedAtMs < PORTAL_MFA_RESEND_COOLDOWN_MS) {
    return {
      ok: true,
      sent: false,
      destination,
      resendAvailableInSeconds: Math.ceil(
        (live.issuedAtMs + PORTAL_MFA_RESEND_COOLDOWN_MS - now) / 1000,
      ),
      expiresAtUtc: new Date(live.expiresAtMs).toISOString(),
      challengeId: live.challengeId,
    };
  }

  const budget = await enforceRateLimit({
    key: `portal:mfa-code:grant:${input.grantId}`,
    max: PORTAL_MFA_ISSUE_LIMIT.max,
    windowSec: PORTAL_MFA_ISSUE_LIMIT.windowSec,
  });
  if (!budget.allowed) return { ok: false, reason: "RATE_LIMITED" };

  const code = generateCode();
  const salt = randomBytes(16);
  const stored: StoredChallenge = {
    challengeId: randomUUID(),
    saltHex: salt.toString("hex"),
    verifierHex: deriveVerifier(code, salt).toString("hex"),
    issuedAtMs: now,
    expiresAtMs: now + PORTAL_MFA_CODE_TTL_MS,
  };
  try {
    await writeChallenge(input.grantId, stored);
  } catch {
    return { ok: false, reason: "MFA_UNAVAILABLE" };
  }

  const sent = await sendCodeEmail({
    to: input.reviewerEmail,
    code,
    grantId: input.grantId,
    challengeId: stored.challengeId,
  });
  if (!sent) {
    // A code nobody received must not stay answerable.
    await consume(input.grantId, stored.challengeId).catch(() => false);
    return { ok: false, reason: "MFA_UNAVAILABLE" };
  }

  return {
    ok: true,
    sent: true,
    destination,
    resendAvailableInSeconds: Math.ceil(PORTAL_MFA_RESEND_COOLDOWN_MS / 1000),
    expiresAtUtc: new Date(stored.expiresAtMs).toISOString(),
    challengeId: stored.challengeId,
  };
}

async function sendCodeEmail(input: {
  to: string;
  code: string;
  grantId: string;
  challengeId: string;
}): Promise<boolean> {
  const brand = getEmailBrandName();
  const minutes = Math.round(PORTAL_MFA_CODE_TTL_MS / 60_000);
  // The code leads the subject so a reviewer can read it from the inbox
  // preview; it is the whole purpose of this message.
  const subject = `${input.code} is your ${brand} reviewer sign-in code`;
  const notice =
    `If you did not try to open the ${brand} reviewer portal, ignore this ` +
    `email and tell the person who invited you, or ${getEmailSupportAddress()}.`;
  const html = renderEmailShell({
    title: "Your reviewer sign-in code",
    preheader: `Your sign-in code expires in ${minutes} minutes.`,
    bodyHtml:
      `<div style="margin:0 0 14px 0;">Enter this code to open the reviewer portal:</div>` +
      `<div style="margin:0 0 14px 0;font-size:28px;font-weight:700;letter-spacing:6px;">` +
      `${escapeEmailHtml(input.code)}</div>` +
      `<div style="margin:0;">The code expires in ${minutes} minutes and works once.</div>`,
    noticeTitle: "Security notice",
    noticeText: notice,
  });
  const text =
    `Your ${brand} reviewer sign-in code is ${input.code}.\n\n` +
    `It expires in ${minutes} minutes and works once.\n\n${notice}\n`;
  try {
    const res = await sendCustomEmailViaResend({
      from: getEmailFromHeader(),
      to: input.to,
      subject,
      html,
      text,
      idempotencyKey: mintEmailIdempotencyKey(
        "external_review_mfa_code",
        input.grantId,
        input.challengeId,
      ),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifyPortalMfaCodeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "MFA_INVALID" | "MFA_CODE_EXHAUSTED" | "MFA_UNAVAILABLE";
      attemptsRemaining: number | null;
    };

export async function verifyPortalMfaCode(input: {
  grantId: string;
  code: string;
}): Promise<VerifyPortalMfaCodeResult> {
  // A malformed answer is not checked and does not spend an attempt: it
  // cannot be right, and counting it would let a typo burn the challenge.
  if (!/^[0-9]{6}$/.test(input.code)) {
    return { ok: false, reason: "MFA_INVALID", attemptsRemaining: null };
  }
  let reserved: [unknown, unknown] | null;
  try {
    reserved = (await withRedis((r) =>
      r.eval(RESERVE_SCRIPT, 1, keyFor(input.grantId)),
    )) as [unknown, unknown] | null;
  } catch {
    return { ok: false, reason: "MFA_UNAVAILABLE", attemptsRemaining: null };
  }
  // No live challenge: never pass.
  if (!reserved) return { ok: false, reason: "MFA_INVALID", attemptsRemaining: null };
  const stored = parseStored(reserved[0]);
  const attempt = Number(reserved[1]);
  if (!stored || stored.expiresAtMs <= Date.now() || !Number.isFinite(attempt)) {
    // Unreadable or past its expiry: never pass. The key's TTL removes it.
    return { ok: false, reason: "MFA_INVALID", attemptsRemaining: null };
  }

  if (attempt <= PORTAL_MFA_MAX_ATTEMPTS && codeMatches(input.code, stored)) {
    let consumed: boolean;
    try {
      consumed = await consume(input.grantId, stored.challengeId);
    } catch {
      return { ok: false, reason: "MFA_UNAVAILABLE", attemptsRemaining: null };
    }
    // Lost the race to another request holding the same code.
    return consumed ? { ok: true } : { ok: false, reason: "MFA_INVALID", attemptsRemaining: null };
  }

  if (attempt >= PORTAL_MFA_MAX_ATTEMPTS) {
    try {
      await consume(input.grantId, stored.challengeId);
    } catch {
      // The attempt counter already refuses this challenge; its TTL ends it.
    }
    return { ok: false, reason: "MFA_CODE_EXHAUSTED", attemptsRemaining: 0 };
  }
  return {
    ok: false,
    reason: "MFA_INVALID",
    attemptsRemaining: PORTAL_MFA_MAX_ATTEMPTS - attempt,
  };
}
