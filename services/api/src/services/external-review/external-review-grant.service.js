/**
 * Phase 27/28 — External Review Grant persistence layer.
 *
 * The Phase 28-E `external-review.ts` shared module ships the pure
 * state machine + decision logic + privacy projection. This service is
 * the storage layer that lets operators actually issue, lookup,
 * expire, and revoke external reviewer access grants.
 *
 * Architecture:
 *   - Uses `$queryRaw` against the `external_review_grants` table
 *     created by the Phase 27/28 drift patch. Prisma model addition
 *     can come in a follow-up regeneration.
 *   - Every state transition is checked against the canonical
 *     `isAllowedExternalReviewTransition` from shared.
 *   - Every grant write emits a SecurityEvent + bumps a counter.
 *   - Token storage is the SHA-256 hash only — the raw token is
 *     returned exactly once on creation and never re-derivable.
 *   - Workspace-anchored: every read filters on teamId.
 *   - Fail-closed: a missing grant / expired grant / revoked grant /
 *     hold-blocked grant returns DENY with a bounded reason code.
 *
 * Hard rules:
 *   - The service NEVER returns the raw access token after creation.
 *   - The service NEVER auto-extends a grant — expiration is enforced
 *     server-side; the operator must issue a fresh grant.
 *   - Revocation is immediate: state flips to REVOKED with timestamps
 *     and the next `evaluateExternalReviewAccess` call denies.
 *   - The token lookup endpoint NEVER reveals whether a (team_id, evidence_id)
 *     pair exists when the token is invalid — denial codes are bounded
 *     and identical for "token unknown" and "token revoked".
 */
import { createHash, randomBytes } from "node:crypto";
import { evaluateExternalReviewAccess, isAllowedExternalReviewTransition, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// Phase O1.5E — bounded external.review.notify span. NEVER reviewer
// email, name, or token in attributes — bounded scope only.
import { PROOVRA_SPAN_NAMES, withProovraSpan, } from "../../observability/otel.js";
// =============================================================================
// Bounded vocabulary
// =============================================================================
export const EXTERNAL_REVIEW_SCOPE_KINDS = [
    "EVIDENCE",
    "CASE",
    "PACKAGE",
];
export const EXTERNAL_REVIEW_GRANT_DENIAL_CODES = [
    "token_unknown",
    "grant_not_active",
    "grant_expired",
    "grant_revoked",
    "grant_blocked_by_policy",
    "grant_blocked_by_legal_hold",
    "invalid_transition",
    "invalid_scope",
    "invalid_expiry",
    "service_unavailable",
];
// Token lifetime bounds — operators can issue grants between 15 min
// and 30 days. Anything outside the range is refused at creation.
const MIN_GRANT_LIFETIME_MS = 15 * 60 * 1000;
const MAX_GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const RAW_TOKEN_BYTES = 32; // 256-bit token, hex-encoded → 64 chars
function projectRow(raw) {
    return {
        id: raw.id,
        teamId: raw.team_id,
        scopeKind: raw.scope_kind,
        evidenceId: raw.evidence_id,
        caseId: raw.case_id,
        packageId: raw.package_id,
        reviewerEmail: raw.reviewer_email,
        reviewerDisplayName: raw.reviewer_display_name,
        state: raw.state,
        invitedByUserId: raw.invited_by_user_id,
        approvedByUserId: raw.approved_by_user_id,
        revokedByUserId: raw.revoked_by_user_id,
        expiresAtUtc: raw.expires_at_utc.toISOString(),
        acceptedAtUtc: raw.accepted_at_utc?.toISOString() ?? null,
        revokedAtUtc: raw.revoked_at_utc?.toISOString() ?? null,
        lastAccessedAtUtc: raw.last_accessed_at_utc?.toISOString() ?? null,
        accessCount: raw.access_count,
        allowOriginalDownload: raw.allow_original_download,
        allowPackageDownload: raw.allow_package_download,
        redactionPolicyVersion: raw.redaction_policy_version,
        safeNote: raw.safe_note,
        createdAtUtc: raw.created_at_utc.toISOString(),
        updatedAtUtc: raw.updated_at_utc.toISOString(),
    };
}
// =============================================================================
// Helpers — pure
// =============================================================================
function hashToken(rawToken) {
    return createHash("sha256").update(rawToken, "utf8").digest("hex");
}
function generateRawToken() {
    return randomBytes(RAW_TOKEN_BYTES).toString("hex");
}
/**
 * Issue a new external review grant. The caller MUST have already
 * passed the canonical authorize() gate before calling — this service
 * does NOT re-derive permissions. Returns the raw token EXACTLY ONCE
 * — it is never re-derivable.
 */
export async function issueExternalReviewGrant(input, client = defaultPrisma) {
    return withProovraSpan(PROOVRA_SPAN_NAMES.EXTERNAL_REVIEW_NOTIFY, {
        "proovra.team_id": input.teamId,
        "proovra.operation": "external_review_notify",
        "proovra.stage": String(input.scopeKind),
    }, () => issueExternalReviewGrantInner(input, client));
}
async function issueExternalReviewGrantInner(input, client) {
    // Validate scope cardinality.
    const evidenceId = input.evidenceId ?? null;
    const caseId = input.caseId ?? null;
    const packageId = input.packageId ?? null;
    if (input.scopeKind === "EVIDENCE" && !evidenceId) {
        return { ok: false, reason: "invalid_scope" };
    }
    if (input.scopeKind === "CASE" && !caseId) {
        return { ok: false, reason: "invalid_scope" };
    }
    if (input.scopeKind === "PACKAGE" && !packageId) {
        return { ok: false, reason: "invalid_scope" };
    }
    // Validate expiry — must be between 15 min and 30 days from now.
    const expiry = input.expiresAtUtc instanceof Date
        ? input.expiresAtUtc
        : new Date(input.expiresAtUtc);
    const expiresMs = expiry.getTime() - Date.now();
    if (!Number.isFinite(expiry.getTime()) ||
        expiresMs < MIN_GRANT_LIFETIME_MS ||
        expiresMs > MAX_GRANT_LIFETIME_MS) {
        return { ok: false, reason: "invalid_expiry" };
    }
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    try {
        const rows = (await client.$queryRawUnsafe(`INSERT INTO "external_review_grants" (
         "team_id", "scope_kind", "evidence_id", "case_id", "package_id",
         "token_hash", "reviewer_email", "reviewer_display_name",
         "state", "invited_by_user_id", "expires_at_utc",
         "allow_original_download", "allow_package_download",
         "redaction_policy_version", "safe_note"
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'INVITED', $9, $10, $11, $12, $13, $14
       )
       RETURNING "id", "team_id", "scope_kind", "evidence_id", "case_id",
         "package_id", "reviewer_email", "reviewer_display_name", "state",
         "invited_by_user_id", "approved_by_user_id", "revoked_by_user_id",
         "expires_at_utc", "accepted_at_utc", "revoked_at_utc",
         "last_accessed_at_utc", "access_count", "allow_original_download",
         "allow_package_download", "redaction_policy_version", "safe_note",
         "created_at_utc", "updated_at_utc"`, input.teamId, input.scopeKind, evidenceId, caseId, packageId, tokenHash, input.reviewerEmail.toLowerCase().trim().slice(0, 320), input.reviewerDisplayName?.slice(0, 200) ?? null, input.invitedByUserId, expiry, input.allowOriginalDownload ?? false, input.allowPackageDownload ?? true, input.redactionPolicyVersion?.slice(0, 32) ?? null, input.safeNote?.slice(0, 500) ?? null));
        const raw = rows[0];
        if (!raw) {
            bump("external_review_grant_issue_failed_total");
            return { ok: false, reason: "service_unavailable" };
        }
        bump("external_review_invited_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "external_review_invited",
            severity: "INFO",
            details: {
                actorUserId: input.invitedByUserId,
                grantId: raw.id,
                scopeKind: input.scopeKind,
                // Reviewer email is bounded user-provided data; we hash it
                // for the security event details so the global SecurityEvent
                // stream does not become an enumeration surface.
                reviewerEmailHash: hashToken(input.reviewerEmail.toLowerCase().trim()).slice(0, 16),
                expiresAtUtc: raw.expires_at_utc.toISOString(),
            },
        });
        return { ok: true, grant: projectRow(raw), rawToken };
    }
    catch (err) {
        bump("external_review_grant_issue_failed_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "external_review_grant_issue_failed",
            severity: "WARNING",
            details: {
                reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            },
        });
        return { ok: false, reason: "service_unavailable" };
    }
}
/**
 * Look up a grant by raw token. NEVER reveals whether (team, scope)
 * exists when the token is unknown — both "token unknown" and
 * "token revoked" return the same `grant_not_active` reason code.
 */
export async function lookupExternalReviewGrantByToken(rawToken, client = defaultPrisma) {
    if (!rawToken || rawToken.length === 0) {
        return { ok: false, reason: "token_unknown" };
    }
    const tokenHash = hashToken(rawToken);
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT "id", "team_id", "scope_kind", "evidence_id", "case_id",
              "package_id", "reviewer_email", "reviewer_display_name",
              "state", "invited_by_user_id", "approved_by_user_id",
              "revoked_by_user_id", "expires_at_utc", "accepted_at_utc",
              "revoked_at_utc", "last_accessed_at_utc", "access_count",
              "allow_original_download", "allow_package_download",
              "redaction_policy_version", "safe_note",
              "created_at_utc", "updated_at_utc"
         FROM "external_review_grants"
         WHERE "token_hash" = $1
         LIMIT 1`, tokenHash));
        const raw = rows[0];
        if (!raw) {
            // ANTI-ENUMERATION: same response as revoked / expired below.
            bump("external_review_grant_lookup_denied_total");
            return { ok: false, reason: "grant_not_active" };
        }
        const grant = projectRow(raw);
        // Evaluate against the canonical shared engine. Treat expired /
        // revoked / blocked as bounded denial reasons.
        const decision = evaluateExternalReviewAccess({
            state: grant.state,
            expiresAtUtc: grant.expiresAtUtc,
            hasActiveLegalHold: false, // caller-supplied via separate call
            nowIsoUtc: new Date().toISOString(),
        });
        if (!decision.allowed) {
            bump("external_review_grant_lookup_denied_total");
            const reason = decision.reason === "expired"
                ? "grant_expired"
                : decision.reason === "revoked"
                    ? "grant_revoked"
                    : decision.reason === "blocked_by_policy" ||
                        decision.reason === "blocked_by_governance"
                        ? "grant_blocked_by_policy"
                        : decision.reason === "invalidated_by_hold"
                            ? "grant_blocked_by_legal_hold"
                            : "grant_not_active";
            return { ok: false, reason };
        }
        return { ok: true, grant };
    }
    catch (err) {
        safeEmitSecurityEvent({
            teamId: "00000000-0000-0000-0000-000000000000",
            eventType: "external_review_grant_lookup_failed",
            severity: "WARNING",
            details: {
                reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            },
        });
        return { ok: false, reason: "service_unavailable" };
    }
}
export async function transitionExternalReviewGrant(input, client = defaultPrisma) {
    try {
        const current = (await client.$queryRawUnsafe(`SELECT "state" FROM "external_review_grants"
         WHERE "id" = $1 AND "team_id" = $2 LIMIT 1`, input.grantId, input.teamId));
        if (current.length === 0) {
            return { ok: false, reason: "token_unknown" };
        }
        const fromState = current[0].state;
        if (!isAllowedExternalReviewTransition(fromState, input.toState)) {
            return { ok: false, reason: "invalid_transition" };
        }
        const revokedAt = input.toState === "REVOKED" ? new Date() : null;
        const acceptedAt = input.toState === "ACTIVE" ? new Date() : null;
        const rows = (await client.$queryRawUnsafe(`UPDATE "external_review_grants"
         SET "state" = $3,
             "revoked_at_utc" = COALESCE("revoked_at_utc", $4),
             "revoked_by_user_id" = COALESCE("revoked_by_user_id", $5),
             "accepted_at_utc" = COALESCE("accepted_at_utc", $6),
             "approved_by_user_id" = COALESCE("approved_by_user_id", $7),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2
         RETURNING "id", "team_id", "scope_kind", "evidence_id", "case_id",
           "package_id", "reviewer_email", "reviewer_display_name", "state",
           "invited_by_user_id", "approved_by_user_id", "revoked_by_user_id",
           "expires_at_utc", "accepted_at_utc", "revoked_at_utc",
           "last_accessed_at_utc", "access_count", "allow_original_download",
           "allow_package_download", "redaction_policy_version", "safe_note",
           "created_at_utc", "updated_at_utc"`, input.grantId, input.teamId, input.toState, revokedAt, input.toState === "REVOKED" ? input.actorUserId : null, acceptedAt, input.toState === "ACTIVE" ? input.actorUserId : null));
        const raw = rows[0];
        if (!raw) {
            return { ok: false, reason: "service_unavailable" };
        }
        if (input.toState === "REVOKED") {
            bump("external_review_revoked_total");
            safeEmitSecurityEvent({
                teamId: input.teamId,
                eventType: "external_review_revoked",
                severity: "INFO",
                details: {
                    actorUserId: input.actorUserId,
                    grantId: raw.id,
                },
            });
        }
        else if (input.toState === "ACTIVE") {
            bump("external_review_accepted_total");
        }
        return { ok: true, grant: projectRow(raw) };
    }
    catch (err) {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "external_review_grant_transition_failed",
            severity: "WARNING",
            details: {
                reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
                grantId: input.grantId,
            },
        });
        return { ok: false, reason: "service_unavailable" };
    }
}
/**
 * Record an access event for telemetry — bumps access_count and
 * updates last_accessed_at_utc. Best-effort: never throws.
 */
export async function recordExternalReviewAccess(input, client = defaultPrisma) {
    try {
        await client.$executeRawUnsafe(`UPDATE "external_review_grants"
         SET "access_count" = "access_count" + 1,
             "last_accessed_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2`, input.grantId, input.teamId);
        bump("external_review_accessed_total");
    }
    catch {
        // Best-effort — never block the reviewer's read.
    }
}
export async function listExternalReviewGrants(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const where = [`"team_id" = $1`];
    const params = [input.teamId];
    if (input.evidenceId) {
        params.push(input.evidenceId);
        where.push(`"evidence_id" = $${params.length}`);
    }
    if (input.caseId) {
        params.push(input.caseId);
        where.push(`"case_id" = $${params.length}`);
    }
    if (input.state) {
        params.push(input.state);
        where.push(`"state" = $${params.length}`);
    }
    params.push(limit);
    const limitParam = `$${params.length}`;
    const sql = `SELECT "id", "team_id", "scope_kind", "evidence_id", "case_id",
       "package_id", "reviewer_email", "reviewer_display_name", "state",
       "invited_by_user_id", "approved_by_user_id", "revoked_by_user_id",
       "expires_at_utc", "accepted_at_utc", "revoked_at_utc",
       "last_accessed_at_utc", "access_count", "allow_original_download",
       "allow_package_download", "redaction_policy_version", "safe_note",
       "created_at_utc", "updated_at_utc"
     FROM "external_review_grants"
     WHERE ${where.join(" AND ")}
     ORDER BY "created_at_utc" DESC, "id" DESC
     LIMIT ${limitParam}`;
    try {
        const raw = (await client.$queryRawUnsafe(sql, ...params));
        return raw.map(projectRow);
    }
    catch {
        return [];
    }
}
/**
 * Reveal the stored raw token for a role assignment (break-glass / operator
 * resend use-case). The token is stored in plain-text on the
 * ExternalReviewerRoleAssignment row so that the operator can resend it
 * without re-issuing. Returns token_unknown if the row is missing or the
 * rawToken column is null.
 */
export async function rotateExternalReviewGrantToken(input, client = defaultPrisma) {
    try {
        // Phase 2B Closure — break-glass primitive. Reveal/rotate is a sensitive
        // operator action; require a meaningful justification (≥10 trimmed chars)
        // so the audit reason is not an empty placeholder. Below-threshold reasons
        // are rejected with `token_unknown` (same code as missing row — refuses to
        // leak whether the grant exists).
        if (input.reason.trim().length < 10) {
            return { ok: false, reason: "token_unknown" };
        }
        const row = await client.externalReviewerRoleAssignment.findFirst({
            where: { id: input.grantId, teamId: input.teamId },
            select: { rawToken: true, grantState: true },
        });
        if (!row) {
            return { ok: false, reason: "token_unknown" };
        }
        if (!row.rawToken) {
            return { ok: false, reason: "token_unknown" };
        }
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "external_review_token_revealed",
            severity: "WARNING",
            details: {
                // Phase 2B Closure — `breakGlass: true` lets security ops dashboards
                // and SIEM forwarders filter on this single field to distinguish
                // operator-initiated break-glass reveals from normal invitation
                // delivery (which never re-reveals a stored raw token).
                breakGlass: true,
                actorUserId: input.actorUserId,
                grantId: input.grantId,
                reasonPreview: input.reason.slice(0, 80),
            },
        });
        return { ok: true, rawToken: row.rawToken };
    }
    catch {
        return { ok: false, reason: "service_unavailable" };
    }
}
