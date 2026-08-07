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

import type { PrismaClient } from "@prisma/client";
import {
  evaluateExternalReviewAccess,
  isAllowedExternalReviewTransition,
  type ExternalReviewAccessFacts,
  type ExternalReviewAccessState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// Phase O1.5E — bounded external.review.notify span. NEVER reviewer
// email, name, or token in attributes — bounded scope only.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";

// =============================================================================
// Bounded vocabulary
// =============================================================================

export const EXTERNAL_REVIEW_SCOPE_KINDS = [
  "EVIDENCE",
  "CASE",
  "PACKAGE",
] as const;

export type ExternalReviewScopeKind =
  (typeof EXTERNAL_REVIEW_SCOPE_KINDS)[number];

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
] as const;

export type ExternalReviewGrantDenialCode =
  (typeof EXTERNAL_REVIEW_GRANT_DENIAL_CODES)[number];

// Token lifetime bounds — operators can issue grants between 15 min
// and 30 days. Anything outside the range is refused at creation.
const MIN_GRANT_LIFETIME_MS = 15 * 60 * 1000;
const MAX_GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const RAW_TOKEN_BYTES = 32; // 256-bit token, hex-encoded → 64 chars

// =============================================================================
// Public projections
// =============================================================================

export type ExternalReviewGrantRow = {
  id: string;
  teamId: string;
  scopeKind: ExternalReviewScopeKind;
  evidenceId: string | null;
  caseId: string | null;
  packageId: string | null;
  reviewerEmail: string;
  reviewerDisplayName: string | null;
  state: ExternalReviewAccessState;
  invitedByUserId: string;
  approvedByUserId: string | null;
  revokedByUserId: string | null;
  expiresAtUtc: string;
  acceptedAtUtc: string | null;
  revokedAtUtc: string | null;
  lastAccessedAtUtc: string | null;
  accessCount: number;
  allowOriginalDownload: boolean;
  allowPackageDownload: boolean;
  redactionPolicyVersion: string | null;
  safeNote: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

type RawGrantRow = {
  id: string;
  team_id: string;
  scope_kind: string;
  evidence_id: string | null;
  case_id: string | null;
  package_id: string | null;
  reviewer_email: string;
  reviewer_display_name: string | null;
  state: string;
  invited_by_user_id: string;
  approved_by_user_id: string | null;
  revoked_by_user_id: string | null;
  expires_at_utc: Date;
  accepted_at_utc: Date | null;
  revoked_at_utc: Date | null;
  last_accessed_at_utc: Date | null;
  access_count: number;
  allow_original_download: boolean;
  allow_package_download: boolean;
  redaction_policy_version: string | null;
  safe_note: string | null;
  created_at_utc: Date;
  updated_at_utc: Date;
};

function projectRow(raw: RawGrantRow): ExternalReviewGrantRow {
  return {
    id: raw.id,
    teamId: raw.team_id,
    scopeKind: raw.scope_kind as ExternalReviewScopeKind,
    evidenceId: raw.evidence_id,
    caseId: raw.case_id,
    packageId: raw.package_id,
    reviewerEmail: raw.reviewer_email,
    reviewerDisplayName: raw.reviewer_display_name,
    state: raw.state as ExternalReviewAccessState,
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

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("hex");
}

// =============================================================================
// Create grant
// =============================================================================

export type IssueGrantInput = {
  teamId: string;
  invitedByUserId: string;
  scopeKind: ExternalReviewScopeKind;
  evidenceId?: string | null;
  caseId?: string | null;
  packageId?: string | null;
  reviewerEmail: string;
  reviewerDisplayName?: string | null;
  expiresAtUtc: string | Date;
  allowOriginalDownload?: boolean;
  allowPackageDownload?: boolean;
  redactionPolicyVersion?: string | null;
  safeNote?: string | null;
};

export type IssueGrantResult =
  | { ok: true; grant: ExternalReviewGrantRow; rawToken: string }
  | { ok: false; reason: ExternalReviewGrantDenialCode };

/**
 * Issue a new external review grant. The caller MUST have already
 * passed the canonical authorize() gate before calling — this service
 * does NOT re-derive permissions. Returns the raw token EXACTLY ONCE
 * — it is never re-derivable.
 */
export async function issueExternalReviewGrant(
  input: IssueGrantInput,
  client: PrismaClient = defaultPrisma,
): Promise<IssueGrantResult> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.EXTERNAL_REVIEW_NOTIFY,
    {
      "proovra.team_id": input.teamId,
      "proovra.operation": "external_review_notify",
      "proovra.stage": String(input.scopeKind),
    },
    () => issueExternalReviewGrantInner(input, client),
  );
}

async function issueExternalReviewGrantInner(
  input: IssueGrantInput,
  client: PrismaClient,
): Promise<IssueGrantResult> {
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
  const expiry =
    input.expiresAtUtc instanceof Date
      ? input.expiresAtUtc
      : new Date(input.expiresAtUtc);
  const expiresMs = expiry.getTime() - Date.now();
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiresMs < MIN_GRANT_LIFETIME_MS ||
    expiresMs > MAX_GRANT_LIFETIME_MS
  ) {
    return { ok: false, reason: "invalid_expiry" };
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);

  try {
    const rows = (await client.$queryRawUnsafe(
      `INSERT INTO "external_review_grants" (
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
         "created_at_utc", "updated_at_utc"`,
      input.teamId,
      input.scopeKind,
      evidenceId,
      caseId,
      packageId,
      tokenHash,
      input.reviewerEmail.toLowerCase().trim().slice(0, 320),
      input.reviewerDisplayName?.slice(0, 200) ?? null,
      input.invitedByUserId,
      expiry,
      input.allowOriginalDownload ?? false,
      input.allowPackageDownload ?? true,
      input.redactionPolicyVersion?.slice(0, 32) ?? null,
      input.safeNote?.slice(0, 500) ?? null,
    )) as RawGrantRow[];
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
  } catch (err) {
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

// =============================================================================
// Token lookup — used by the external-reviewer-facing routes
// =============================================================================

export type LookupGrantResult =
  | { ok: true; grant: ExternalReviewGrantRow }
  | { ok: false; reason: ExternalReviewGrantDenialCode };

/**
 * PHASE 5 §8.5 — does the grant's scoped resource carry an ACTIVE
 * Legal Hold? EVIDENCE/PACKAGE resolve to one evidence row; CASE holds
 * match either a case-scoped hold or a hold on any evidence linked to
 * the case. FAIL OPEN only on lookup errors is NOT acceptable for a
 * hold check — errors propagate to the caller's catch (denied as
 * service_unavailable), never silently treated as "no hold".
 */
async function grantScopeHasActiveLegalHold(
  grant: Pick<
    ExternalReviewGrantRow,
    "teamId" | "scopeKind" | "evidenceId" | "caseId" | "packageId"
  >,
  client: PrismaClient,
): Promise<boolean> {
  if (grant.scopeKind === "CASE" && grant.caseId) {
    const caseHold = await client.evidenceLegalHold.findFirst({
      where: { teamId: grant.teamId, caseId: grant.caseId, status: "ACTIVE" },
      select: { id: true },
    });
    if (caseHold) return true;
    const linked = await client.caseEvidenceLink.findMany({
      where: { teamId: grant.teamId, caseId: grant.caseId },
      select: { evidenceId: true },
      take: 500,
    });
    if (linked.length === 0) return false;
    const held = await client.evidenceLegalHold.findFirst({
      where: {
        teamId: grant.teamId,
        evidenceId: { in: linked.map((l) => l.evidenceId) },
        status: "ACTIVE",
      },
      select: { id: true },
    });
    return held !== null;
  }

  let evidenceId = grant.evidenceId;
  if (grant.scopeKind === "PACKAGE" && grant.packageId) {
    const pkg = await client.verificationPackage.findFirst({
      where: { id: grant.packageId },
      select: { evidenceId: true },
    });
    evidenceId = pkg?.evidenceId ?? evidenceId;
  }
  if (!evidenceId) return false;
  const hold = await client.evidenceLegalHold.findFirst({
    where: { teamId: grant.teamId, evidenceId, status: "ACTIVE" },
    select: { id: true },
  });
  return hold !== null;
}

/**
 * Look up a grant by raw token. NEVER reveals whether (team, scope)
 * exists when the token is unknown — both "token unknown" and
 * "token revoked" return the same `grant_not_active` reason code.
 */
export async function lookupExternalReviewGrantByToken(
  rawToken: string,
  client: PrismaClient = defaultPrisma,
): Promise<LookupGrantResult> {
  if (!rawToken || rawToken.length === 0) {
    return { ok: false, reason: "token_unknown" };
  }
  const tokenHash = hashToken(rawToken);
  try {
    const rows = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "scope_kind", "evidence_id", "case_id",
              "package_id", "reviewer_email", "reviewer_display_name",
              "state", "invited_by_user_id", "approved_by_user_id",
              "revoked_by_user_id", "expires_at_utc", "accepted_at_utc",
              "revoked_at_utc", "last_accessed_at_utc", "access_count",
              "allow_original_download", "allow_package_download",
              "redaction_policy_version", "safe_note",
              "created_at_utc", "updated_at_utc"
         FROM "external_review_grants"
         WHERE "token_hash" = $1
         LIMIT 1`,
      tokenHash,
    )) as RawGrantRow[];
    const raw = rows[0];
    if (!raw) {
      // ANTI-ENUMERATION: same response as revoked / expired below.
      bump("external_review_grant_lookup_denied_total");
      return { ok: false, reason: "grant_not_active" };
    }
    const grant = projectRow(raw);
    // PHASE 5 §8.5 (2026-07-22) — Legal Hold PREVAILS at token lookup.
    // Previously hardcoded false ("caller-supplied via separate call")
    // but no caller ever made that call, so a grant over held evidence
    // still resolved. The hold is derived from the grant's own scope.
    const hasActiveLegalHold = await grantScopeHasActiveLegalHold(
      grant,
      client,
    );
    // Evaluate against the canonical shared engine. Treat expired /
    // revoked / blocked as bounded denial reasons.
    const decision = evaluateExternalReviewAccess({
      state: grant.state,
      expiresAtUtc: grant.expiresAtUtc,
      hasActiveLegalHold,
      nowIsoUtc: new Date().toISOString(),
    } as ExternalReviewAccessFacts);
    if (!decision.allowed) {
      bump("external_review_grant_lookup_denied_total");
      const reason: ExternalReviewGrantDenialCode =
        decision.reason === "expired"
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
  } catch (err) {
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

// =============================================================================
// State transitions — revoke / accept / mark-accessed
// =============================================================================

export type TransitionInput = {
  grantId: string;
  teamId: string;
  toState: ExternalReviewAccessState;
  actorUserId: string;
};

export type TransitionResult =
  | { ok: true; grant: ExternalReviewGrantRow }
  | { ok: false; reason: ExternalReviewGrantDenialCode };

export async function transitionExternalReviewGrant(
  input: TransitionInput,
  client: PrismaClient = defaultPrisma,
): Promise<TransitionResult> {
  try {
    const current = (await client.$queryRawUnsafe(
      `SELECT "state" FROM "external_review_grants"
         WHERE "id" = $1 AND "team_id" = $2 LIMIT 1`,
      input.grantId,
      input.teamId,
    )) as Array<{ state: string }>;
    if (current.length === 0) {
      return { ok: false, reason: "token_unknown" };
    }
    const fromState = current[0]!.state as ExternalReviewAccessState;
    if (!isAllowedExternalReviewTransition(fromState, input.toState)) {
      return { ok: false, reason: "invalid_transition" };
    }
    const revokedAt = input.toState === "REVOKED" ? new Date() : null;
    const acceptedAt = input.toState === "ACTIVE" ? new Date() : null;
    const rows = (await client.$queryRawUnsafe(
      `UPDATE "external_review_grants"
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
           "created_at_utc", "updated_at_utc"`,
      input.grantId,
      input.teamId,
      input.toState,
      revokedAt,
      input.toState === "REVOKED" ? input.actorUserId : null,
      acceptedAt,
      input.toState === "ACTIVE" ? input.actorUserId : null,
    )) as RawGrantRow[];
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
    } else if (input.toState === "ACTIVE") {
      bump("external_review_accepted_total");
    }
    return { ok: true, grant: projectRow(raw) };
  } catch (err) {
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
export async function recordExternalReviewAccess(
  input: { grantId: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await client.$executeRawUnsafe(
      `UPDATE "external_review_grants"
         SET "access_count" = "access_count" + 1,
             "last_accessed_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2`,
      input.grantId,
      input.teamId,
    );
    bump("external_review_accessed_total");
  } catch {
    // Best-effort — never block the reviewer's read.
  }
}

// =============================================================================
// Operator list — used by the governance dashboard
// =============================================================================

export type ListGrantsInput = {
  teamId: string;
  evidenceId?: string | null;
  caseId?: string | null;
  state?: ExternalReviewAccessState | null;
  limit?: number;
};

export async function listExternalReviewGrants(
  input: ListGrantsInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<ExternalReviewGrantRow>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const where: string[] = [`"team_id" = $1`];
  const params: unknown[] = [input.teamId];
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
    const raw = (await client.$queryRawUnsafe(
      sql,
      ...params,
    )) as RawGrantRow[];
    return raw.map(projectRow);
  } catch {
    return [];
  }
}

// =============================================================================
// Break-glass token reveal — R7 ExternalReviewerRoleAssignment
// =============================================================================

export type RotateTokenInput = {
  grantId: string;
  teamId: string;
  actorUserId: string;
  reason: string;
};

export type RotateTokenResult =
  | { ok: true; rawToken: string }
  | { ok: false; reason: ExternalReviewGrantDenialCode };

/**
 * PHASE 12 REMEDIATION §4.3 (2026-08-06) — SERVER-OWNED SUCCESSOR TOKEN.
 *
 * What this replaces
 * ------------------
 * This function's contract used to be "reveal the stored raw token", reading
 * a PLAINTEXT `ExternalReviewerRoleAssignment.rawToken` column. Two things
 * were wrong with that, and the Phase-12 remediation corrects both:
 *
 *   1. The column is never written by ANY production writer —
 *      `issueInvitation` persists only the SHA-256 hash on
 *      `external_review_grants`, exactly as the module contract requires.
 *      The reveal path therefore could only ever return `token_unknown`;
 *      the break-glass route was inert.
 *   2. Even if it had been populated, retaining a bearer token in plaintext
 *      so it can be re-read is precisely the storage shape this service
 *      exists to avoid ("token storage is the SHA-256 hash only").
 *
 * What it does now
 * ----------------
 * The token is HASH-ONLY and therefore genuinely unrecoverable, so the
 * canonical answer is to MINT A SUCCESSOR server-side:
 *
 *   * a fresh 256-bit token is generated here, never accepted from a caller;
 *   * its hash ATOMICALLY supersedes the prior hash in a single guarded
 *     UPDATE — the predicate pins team, grant and a live state, so a
 *     concurrent revoke/expire wins and no token is minted for a dead grant;
 *   * the predecessor stops authenticating the instant that UPDATE commits;
 *   * invitation history is untouched — the grant row keeps its identity,
 *     its issuance provenance, its scope and its activity trail;
 *   * the raw value is returned EXACTLY ONCE to the authorized caller and is
 *     never persisted, logged, or emitted in an audit payload.
 *
 * The name is unchanged because the ROUTE contract is unchanged: this is
 * still "the operator asked for a usable token for this invitation", and it
 * still returns `{ ok: true, rawToken }` exactly once. Only the mechanism
 * became honest.
 */
export async function rotateExternalReviewGrantToken(
  input: RotateTokenInput,
  client: PrismaClient = defaultPrisma,
): Promise<RotateTokenResult> {
  try {
    // Phase 2B Closure — rotation is a sensitive operator action; require a
    // meaningful justification (≥10 trimmed chars) so the audit reason is not
    // an empty placeholder. Below-threshold reasons are rejected with
    // `token_unknown` (the same code as a missing row — the service refuses
    // to leak whether the grant exists).
    if (input.reason.trim().length < 10) {
      return { ok: false, reason: "token_unknown" };
    }
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    // ATOMIC SUPERSEDE. The WHERE clause is the concurrency control: the
    // grant must still belong to this workspace AND still be in a state that
    // can authenticate a reviewer. `expires_at_utc > now()` keeps an expired
    // grant from being silently resurrected by a rotation.
    // PHASE 12 CORRECTIVE PASS §2/§3 — the generation counter moves WITH the
    // hash, in the same guarded UPDATE.
    //
    // Rotation already superseded the predecessor correctly for
    // AUTHENTICATION. What was missing was a durable statement that the
    // CONTENT of the invitation had changed, and the delivery layer needs
    // exactly that: without it, the message carrying the successor link
    // collapsed onto the superseded message's provider idempotency key, the
    // provider acknowledged it as a repeat, and the reviewer was left holding
    // a dead link with no successor to replace it. Incrementing here — rather
    // than in the mail path — means no caller can rotate without the delivery
    // layer noticing.
    const rows = (await client.$queryRawUnsafe(
      `UPDATE "external_review_grants"
          SET "token_hash" = $1,
              "token_version" = "token_version" + 1,
              "updated_at_utc" = now()
        WHERE "id" = $2::uuid
          AND "team_id" = $3::uuid
          AND "state" IN ('INVITED', 'ACTIVE')
          AND "revoked_at_utc" IS NULL
          AND "expires_at_utc" > now()
        RETURNING "id", "state"`,
      tokenHash,
      input.grantId,
      input.teamId,
    )) as Array<{ id: string; state: string }>;
    const updated = rows[0];
    if (!updated) {
      // Missing, foreign, revoked or expired all conceal as one code.
      return { ok: false, reason: "token_unknown" };
    }
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "external_review_token_revealed",
      severity: "WARNING",
      details: {
        // `breakGlass: true` lets security-ops dashboards and SIEM forwarders
        // filter on this single field to distinguish an operator-initiated
        // rotation from normal invitation delivery.
        breakGlass: true,
        // §4.3 — record that the predecessor was superseded, so an operator
        // reading the trail knows the older link stopped working here.
        tokenSuperseded: true,
        actorUserId: input.actorUserId,
        grantId: input.grantId,
        grantState: updated.state,
        reasonPreview: input.reason.slice(0, 80),
      },
    });
    bump("external_review_grant_token_rotated_total");
    return { ok: true, rawToken };
  } catch {
    return { ok: false, reason: "service_unavailable" };
  }
}
