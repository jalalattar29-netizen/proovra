/**
 * PHASE R8.1.1 — MFA orchestrator service.
 *
 * Composes the R8.1 pure helpers (mfa-totp, mfa-recovery,
 * mfa-secret-storage) with Prisma + the canonical
 * `safeEmitSecurityEvent` for operator-visible audit emission.
 *
 * SECURITY CONTRACT:
 *   - No plaintext secret leaves this service. Secrets are sealed
 *     before the database touch and opened only inside verify paths.
 *   - Recovery plaintexts return to the caller ONCE (at issuance)
 *     and never again.
 *   - Every successful state transition emits the corresponding
 *     R8 event via `safeEmitSecurityEvent` with bounded `details`.
 *   - On verify failure we emit `mfa_verification_failed` but never
 *     include the user's code or the plaintext secret.
 *   - Events use `teamId: null` because MFA is per-user (not
 *     per-workspace); the actor's `userId` is carried in `details`
 *     so the audit timeline still attributes correctly.
 *
 * R8.1.1 does NOT integrate this service into the login flow. The
 * login-time MFA challenge is explicitly deferred — touching
 * auth.routes.ts in the same phase as the orchestrator + REST is
 * the kind of plumbing surprise the recovery roadmap consistently
 * avoids. R8.1.2 owns login-flow integration.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";
import { buildOtpauthUri, generateTotpSecretBytes, TOTP_ALGORITHM, TOTP_DIGITS, TOTP_PERIOD_SECONDS, verifyTotpCode, } from "./mfa-totp.js";
import { buildRecoveryVerifier, computeLookupHash, generateRecoveryBatch, RECOVERY_CODE_BATCH_SIZE, verifyRecoveryVerifier, } from "./mfa-recovery.js";
import { openSecret, sealSecret, } from "./mfa-secret-storage.js";
const ISSUER = "PROOVRA";
const LABEL_MAX = 60;
function sanitizeLabel(raw) {
    const cleaned = (raw ?? "Authenticator").trim().slice(0, LABEL_MAX);
    return cleaned.length > 0 ? cleaned : "Authenticator";
}
/**
 * Begin TOTP enrollment for a user. Generates a fresh secret,
 * persists an ENROLLING factor with the sealed secret, and returns
 * the otpauth URI + Base32 secret for one-time display.
 */
export async function beginTotpEnrollment(input) {
    const label = sanitizeLabel(input.label);
    const secret = generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const otpauthUri = buildOtpauthUri({
        secret,
        issuer: ISSUER,
        accountName: input.accountName,
    });
    const secretBase32 = otpauthUri.match(/secret=([A-Z0-9=]+)/)?.[1] ?? "";
    const factor = await prisma.mfaFactor.create({
        data: {
            userId: input.userId,
            kind: "TOTP",
            status: "ENROLLING",
            label,
            // Buffer.from coerces the Uint8Array views returned by
            // sealSecret into the precise `Buffer<ArrayBuffer>` Prisma
            // expects under TS 5.7+ strict typing.
            secretCiphertext: Buffer.from(sealed.ciphertext),
            secretIv: Buffer.from(sealed.iv),
            secretAuthTag: Buffer.from(sealed.authTag),
            secretKekId: sealed.kekId,
            algorithm: TOTP_ALGORITHM,
            digits: TOTP_DIGITS,
            periodSeconds: TOTP_PERIOD_SECONDS,
        },
        select: { id: true },
    });
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_enrollment_started",
        severity: "INFO",
        details: { actorUserId: input.userId, factorId: factor.id, label },
    });
    return {
        factorId: factor.id,
        otpauthUri,
        secretBase32,
    };
}
/**
 * Verify the user-supplied code against an ENROLLING factor and
 * activate it. On success: transitions to ACTIVE, generates a fresh
 * recovery batch, emits events, returns recovery codes (one-time).
 * On failure: emits `mfa_verification_failed`, leaves the factor
 * ENROLLING so the user can retry.
 */
export async function verifyAndActivateEnrollment(input) {
    const factor = await prisma.mfaFactor.findUnique({
        where: { id: input.factorId },
        select: {
            id: true,
            userId: true,
            status: true,
            secretCiphertext: true,
            secretIv: true,
            secretAuthTag: true,
            secretKekId: true,
        },
    });
    if (!factor || factor.userId !== input.userId) {
        return { ok: false, reason: "factor_not_found" };
    }
    if (factor.status !== "ENROLLING") {
        return { ok: false, reason: "factor_not_enrolling" };
    }
    const secret = openSecret({
        ciphertext: factor.secretCiphertext,
        iv: factor.secretIv,
        authTag: factor.secretAuthTag,
        kekId: factor.secretKekId,
    });
    if (!verifyTotpCode(secret, input.code)) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_verification_failed",
            severity: "WARNING",
            details: {
                actorUserId: input.userId,
                factorId: factor.id,
                context: "enrollment",
            },
        });
        return { ok: false, reason: "code_invalid" };
    }
    const now = new Date();
    const recoveryCodes = generateRecoveryBatch();
    const batchId = randomUUID();
    const recoveryRows = recoveryCodes.map((code) => {
        const lookupHash = computeLookupHash(code);
        const verifier = buildRecoveryVerifier(code);
        return {
            userId: input.userId,
            batchId,
            codeLookupHash: lookupHash,
            // Same Buffer.from coercion as the factor row — keeps the
            // Prisma input type happy under TS 5.7+ stricter typing.
            codeVerifier: Buffer.from(verifier.verifier),
            codeVerifierSalt: Buffer.from(verifier.salt),
        };
    });
    await prisma.$transaction([
        prisma.mfaFactor.update({
            where: { id: factor.id },
            data: { status: "ACTIVE", enrolledAt: now, lastUsedAt: now },
        }),
        prisma.mfaRecoveryCode.createMany({ data: recoveryRows }),
    ]);
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_enrollment_completed",
        severity: "INFO",
        details: { actorUserId: input.userId, factorId: factor.id },
    });
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_factor_added",
        severity: "INFO",
        details: { actorUserId: input.userId, factorId: factor.id },
    });
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_verification_succeeded",
        severity: "INFO",
        details: {
            actorUserId: input.userId,
            factorId: factor.id,
            context: "enrollment",
        },
    });
    return { ok: true, factorId: factor.id, recoveryCodes };
}
/** Verify a TOTP code against a user's ACTIVE factor (e.g. step-up). */
export async function verifyActiveTotp(input) {
    const factor = await prisma.mfaFactor.findFirst({
        where: { userId: input.userId, status: "ACTIVE", kind: "TOTP" },
        select: {
            id: true,
            secretCiphertext: true,
            secretIv: true,
            secretAuthTag: true,
            secretKekId: true,
        },
    });
    if (!factor) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_verification_failed",
            severity: "WARNING",
            details: { actorUserId: input.userId, reason: "no_active_factor" },
        });
        return { ok: false, factorId: null };
    }
    const secret = openSecret({
        ciphertext: factor.secretCiphertext,
        iv: factor.secretIv,
        authTag: factor.secretAuthTag,
        kekId: factor.secretKekId,
    });
    const ok = verifyTotpCode(secret, input.code);
    if (ok) {
        await prisma.mfaFactor.update({
            where: { id: factor.id },
            data: { lastUsedAt: new Date() },
        });
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_verification_succeeded",
            severity: "INFO",
            details: {
                actorUserId: input.userId,
                factorId: factor.id,
                context: "verify",
            },
        });
    }
    else {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_verification_failed",
            severity: "WARNING",
            details: {
                actorUserId: input.userId,
                factorId: factor.id,
                context: "verify",
            },
        });
    }
    return { ok, factorId: ok ? factor.id : null };
}
/** Revoke an ACTIVE factor. Idempotent. */
export async function revokeFactor(input) {
    const factor = await prisma.mfaFactor.findUnique({
        where: { id: input.factorId },
        select: { id: true, userId: true, status: true },
    });
    if (!factor || factor.userId !== input.userId) {
        return { ok: false, reason: "factor_not_found" };
    }
    if (factor.status === "REVOKED")
        return { ok: true };
    await prisma.mfaFactor.update({
        where: { id: factor.id },
        data: {
            status: "REVOKED",
            revokedAt: new Date(),
            revokedReason: (input.reason ?? "user_revoked").slice(0, 120),
        },
    });
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_factor_removed",
        severity: "INFO",
        details: {
            actorUserId: input.userId,
            factorId: factor.id,
            reason: input.reason ?? "user_revoked",
        },
    });
    return { ok: true };
}
/** Consume a recovery code. */
export async function consumeRecoveryCode(input) {
    const lookupHash = computeLookupHash(input.code);
    const row = await prisma.mfaRecoveryCode.findUnique({
        where: { codeLookupHash: lookupHash },
        select: {
            id: true,
            userId: true,
            codeVerifier: true,
            codeVerifierSalt: true,
            usedAt: true,
            batchInvalidatedAt: true,
        },
    });
    if (!row) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_verification_failed",
            severity: "WARNING",
            details: { actorUserId: input.userId, context: "recovery_code", reason: "not_found" },
        });
        return { ok: false, reason: "not_found" };
    }
    if (row.userId !== input.userId) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_verification_failed",
            severity: "WARNING",
            details: { actorUserId: input.userId, context: "recovery_code", reason: "wrong_user" },
        });
        return { ok: false, reason: "wrong_user" };
    }
    if (row.usedAt)
        return { ok: false, reason: "already_used" };
    if (row.batchInvalidatedAt)
        return { ok: false, reason: "invalidated" };
    const verifierOk = verifyRecoveryVerifier(input.code, {
        salt: Buffer.from(row.codeVerifierSalt),
        verifier: Buffer.from(row.codeVerifier),
    });
    if (!verifierOk) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_verification_failed",
            severity: "WARNING",
            details: { actorUserId: input.userId, context: "recovery_code", reason: "code_invalid" },
        });
        return { ok: false, reason: "code_invalid" };
    }
    await prisma.mfaRecoveryCode.update({
        where: { id: row.id },
        data: { usedAt: new Date(), usedFromIp: input.ipAddress ?? null },
    });
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_verification_succeeded",
        severity: "INFO",
        details: {
            actorUserId: input.userId,
            context: "recovery_code",
            codeId: row.id,
        },
    });
    return { ok: true };
}
/** Regenerate the recovery batch atomically. */
export async function regenerateRecoveryBatch(input) {
    const now = new Date();
    const recoveryCodes = generateRecoveryBatch();
    const batchId = randomUUID();
    const rows = recoveryCodes.map((code) => {
        const lookupHash = computeLookupHash(code);
        const verifier = buildRecoveryVerifier(code);
        return {
            userId: input.userId,
            batchId,
            codeLookupHash: lookupHash,
            codeVerifier: Buffer.from(verifier.verifier),
            codeVerifierSalt: Buffer.from(verifier.salt),
        };
    });
    await prisma.$transaction([
        prisma.mfaRecoveryCode.updateMany({
            where: { userId: input.userId, usedAt: null, batchInvalidatedAt: null },
            data: { batchInvalidatedAt: now },
        }),
        prisma.mfaRecoveryCode.createMany({ data: rows }),
    ]);
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_verification_succeeded",
        severity: "INFO",
        details: {
            actorUserId: input.userId,
            context: "recovery_regenerated",
            batchSize: RECOVERY_CODE_BATCH_SIZE,
        },
    });
    return { recoveryCodes };
}
/** Read-only MFA status for a user. */
export async function readMfaStatus(input) {
    const [factors, recoveryRemaining] = await Promise.all([
        prisma.mfaFactor.findMany({
            where: { userId: input.userId },
            select: {
                id: true,
                label: true,
                status: true,
                enrolledAt: true,
                lastUsedAt: true,
            },
            orderBy: { createdAt: "desc" },
        }),
        prisma.mfaRecoveryCode.count({
            where: {
                userId: input.userId,
                usedAt: null,
                batchInvalidatedAt: null,
            },
        }),
    ]);
    const hasMfa = factors.some((f) => f.status === "ACTIVE");
    return {
        hasMfa,
        factors: factors.map((f) => ({
            id: f.id,
            label: f.label,
            status: f.status,
            enrolledAt: f.enrolledAt ? f.enrolledAt.toISOString() : null,
            lastUsedAt: f.lastUsedAt ? f.lastUsedAt.toISOString() : null,
        })),
        recoveryCodesRemaining: recoveryRemaining,
    };
}
// =============================================================================
// PHASE R8.1.3 — DURABLE MFA PENDING CHALLENGE STORE
//
// Replaces the R8.1.2 process-local JTI deny-list with a Prisma row
// so replay protection survives multi-instance / serverless / multi-
// region deployments. The signed token continues to carry the JTI
// (`sid`); this layer is the source of truth for whether that JTI
// has already been consumed.
// =============================================================================
/** TTL for a login MFA pending challenge — mirrors `MFA_PENDING_TTL_SECONDS`
 *  in `jwt.ts`. Both must stay in lockstep so the signed token and
 *  the DB row expire together. */
export const MFA_PENDING_CHALLENGE_TTL_SECONDS = 5 * 60;
/** How long expired/consumed rows are retained before opportunistic
 *  GC removes them. Short enough to keep the table small; long
 *  enough that postmortem SecOps queries still find recent rows. */
const MFA_PENDING_CHALLENGE_RETENTION_SECONDS = 60 * 60;
/** Bounded opportunistic GC. Each verify / create call deletes up to
 *  this many stale rows; full cleanup is the job's natural drip. */
const MFA_PENDING_CHALLENGE_GC_BATCH = 50;
/** Stable per-process pepper for ip/UA hashes. Mirrors the convention
 *  used by sso-auth.routes.ts deviceIdHash so the same IP hashes to
 *  the same value across surfaces. */
const HASH_SECRET = process.env["IDENTITY_SECURITY_HASH_SECRET"] || "phase26-dev";
function hashPepperedSha256(input) {
    if (!input)
        return null;
    return createHash("sha256")
        .update(`${HASH_SECRET}:${input}`)
        .digest("hex");
}
/**
 * Opportunistic GC. Called by `createMfaPendingChallenge` and by
 * `consumeMfaPendingChallenge` on failure paths. Deletes a bounded
 * batch of rows that are either consumed-and-old or expired-and-old.
 * Cheap (single bounded DELETE); safe under concurrency.
 */
async function gcStalePendingChallenges() {
    const cutoff = new Date(Date.now() - MFA_PENDING_CHALLENGE_RETENTION_SECONDS * 1000);
    try {
        // Two-step bounded delete — pick ids, then delete by id. This
        // avoids a `DELETE ... LIMIT` (which Postgres doesn't support)
        // while still bounding the work per call.
        const stale = await prisma.mfaPendingChallenge.findMany({
            where: {
                OR: [
                    { consumedAt: { not: null, lt: cutoff } },
                    { expiresAt: { lt: cutoff } },
                ],
            },
            select: { id: true },
            take: MFA_PENDING_CHALLENGE_GC_BATCH,
        });
        if (stale.length === 0)
            return;
        await prisma.mfaPendingChallenge.deleteMany({
            where: { id: { in: stale.map((r) => r.id) } },
        });
    }
    catch {
        // GC is best-effort — if it fails, the next call will try again.
    }
}
/**
 * Create a durable pending challenge row. Returns the JTI for the
 * caller to embed in a signed token. NEVER returns the signed token
 * itself — the token-signing layer (jwt.ts) is the only place that
 * holds the secret.
 */
export async function createMfaPendingChallenge(input) {
    void gcStalePendingChallenges();
    const ttl = typeof input.ttlSeconds === "number" && input.ttlSeconds > 0
        ? Math.min(input.ttlSeconds, MFA_PENDING_CHALLENGE_TTL_SECONDS)
        : MFA_PENDING_CHALLENGE_TTL_SECONDS;
    const jti = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const row = await prisma.mfaPendingChallenge.create({
        data: {
            jti,
            userId: input.userId,
            purpose: (input.purpose ?? "LOGIN"),
            expiresAt,
            ipHash: hashPepperedSha256(input.ipAddress ?? null),
            userAgentHash: hashPepperedSha256(input.userAgent ?? null),
            // Prisma JsonB nullability is awkward — pass `undefined` when
            // we want the column to default to NULL; `null` is a sentinel
            // value distinct from absent. The InputJsonValue type
            // forbids arbitrary Record<string, unknown> so we cast via
            // `Prisma.InputJsonValue` (the same pattern used by
            // billing.service.ts / sso.service.ts).
            ...(input.metadata
                ? { metadata: input.metadata }
                : {}),
        },
        select: { id: true, jti: true, expiresAt: true },
    });
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_challenge_created",
        severity: "INFO",
        details: {
            actorUserId: input.userId,
            challengeIdHash: createHash("sha256").update(row.id).digest("hex").slice(0, 32),
            purpose: input.purpose ?? "LOGIN",
        },
    });
    return { jti: row.jti, id: row.id, expiresAt: row.expiresAt };
}
/**
 * Atomically consume a pending challenge. On success the row's
 * `consumedAt` is set in a SINGLE UPDATE keyed by
 * `(id, consumedAt: null, expiresAt > now)`. The UPDATE rowcount
 * tells us whether we won the race. Replay attempts (rowcount 0
 * with `consumedAt IS NOT NULL`) and expired attempts (rowcount 0
 * with `expiresAt <= now`) collapse to bounded reason codes.
 */
export async function consumeMfaPendingChallenge(input) {
    const row = await prisma.mfaPendingChallenge.findUnique({
        where: { jti: input.jti },
        select: {
            id: true,
            userId: true,
            purpose: true,
            expiresAt: true,
            consumedAt: true,
        },
    });
    if (!row) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "auth_login_failed",
            severity: "WARNING",
            details: { phase: "mfa_verify", reason: "challenge_not_found" },
        });
        return { ok: false, reason: "not_found" };
    }
    if (row.userId !== input.expectedUserId) {
        // Token+row mismatch — possibly a stolen token under a forged
        // user id. Fail closed.
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "auth_login_failed",
            severity: "WARNING",
            details: { phase: "mfa_verify", reason: "challenge_user_mismatch" },
        });
        return { ok: false, reason: "wrong_user" };
    }
    if (input.expectedPurpose &&
        row.purpose !== input.expectedPurpose) {
        return { ok: false, reason: "wrong_purpose" };
    }
    if (row.expiresAt.getTime() <= Date.now()) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_challenge_expired",
            severity: "INFO",
            details: {
                actorUserId: row.userId,
                challengeIdHash: createHash("sha256").update(row.id).digest("hex").slice(0, 32),
            },
        });
        void gcStalePendingChallenges();
        return { ok: false, reason: "expired" };
    }
    if (row.consumedAt) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_challenge_replayed",
            severity: "WARNING",
            details: {
                actorUserId: row.userId,
                challengeIdHash: createHash("sha256").update(row.id).digest("hex").slice(0, 32),
            },
        });
        return { ok: false, reason: "already_consumed" };
    }
    // Atomic consume — the WHERE clause includes `consumedAt: null`
    // and `expiresAt > now`, so only one writer can flip the row.
    const result = await prisma.mfaPendingChallenge.updateMany({
        where: {
            id: row.id,
            consumedAt: null,
            expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
    });
    if (result.count !== 1) {
        safeEmitSecurityEvent({
            teamId: null,
            eventType: "mfa_challenge_replayed",
            severity: "WARNING",
            details: {
                actorUserId: row.userId,
                challengeIdHash: createHash("sha256").update(row.id).digest("hex").slice(0, 32),
            },
        });
        return { ok: false, reason: "already_consumed" };
    }
    safeEmitSecurityEvent({
        teamId: null,
        eventType: "mfa_challenge_consumed",
        severity: "INFO",
        details: {
            actorUserId: row.userId,
            challengeIdHash: createHash("sha256").update(row.id).digest("hex").slice(0, 32),
        },
    });
    return { ok: true, challengeId: row.id };
}
/**
 * Best-effort failure counter bump for a still-live pending
 * challenge. The route-layer rate limiter handles cutoff; this is
 * purely for forensics + a future "auto-expire after N attempts"
 * policy. We do NOT throw if the row is gone.
 */
export async function recordPendingChallengeFailure(jti) {
    try {
        await prisma.mfaPendingChallenge.update({
            where: { jti },
            data: { failureCount: { increment: 1 } },
        });
    }
    catch {
        // Row may have been GC'd or the JTI was bogus. Best effort only.
    }
}
/**
 * Admin-callable sweep. Returns the number of rows deleted. Bounded
 * by the same batch size as the opportunistic GC; the caller may
 * loop. Documented in `docs/security/R8_1_3_*.md`.
 */
export async function sweepExpiredPendingChallenges() {
    const cutoff = new Date(Date.now() - MFA_PENDING_CHALLENGE_RETENTION_SECONDS * 1000);
    const stale = await prisma.mfaPendingChallenge.findMany({
        where: {
            OR: [
                { consumedAt: { not: null, lt: cutoff } },
                { expiresAt: { lt: cutoff } },
            ],
        },
        select: { id: true },
        take: MFA_PENDING_CHALLENGE_GC_BATCH,
    });
    if (stale.length === 0)
        return 0;
    const r = await prisma.mfaPendingChallenge.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } },
    });
    return r.count;
}
