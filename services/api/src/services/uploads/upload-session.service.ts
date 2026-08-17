/**
 * Phase 30 — Resumable multipart upload session service.
 *
 * Server-side state machine for the resumable upload path. The
 * existing per-part presigned URL flow continues to work; this service
 * adds a session layer so:
 *
 *   * Clients can resume an interrupted upload by querying the session
 *     and seeing which parts still need to be sent.
 *   * The completion gate refuses to mark the session COMPLETED until
 *     every required part is server-verified.
 *   * The custody event is emitted by the upload-complete handler only
 *     after the session transitions to COMPLETED.
 *   * Stale / abandoned sessions get reaped without leaving orphan
 *     S3 objects in an indeterminate state.
 *
 * Hard custody-safe rules:
 *   * `completed_at_utc` is set ONLY by the server, ONLY after every
 *     part is VERIFIED via a fresh HEAD/SHA-256 check.
 *   * Per-part `verified_at_utc` is server clock. `uploaded_at_utc_client`
 *     is preserved separately for audit but NEVER used as evidence truth.
 *   * `idempotency_key` collapses retry POSTs to the existing session
 *     within a team. No duplicate sessions, no duplicate custody events.
 *   * Bounded denial vocabulary — operators / clients see typed reason
 *     codes, never free-text Prisma errors.
 *   * Fail-closed: any unexpected query failure returns `service_unavailable`.
 *
 * Uses `$queryRaw` against the Phase 30 drift patch table. Prisma model
 * addition can come in a follow-up regeneration.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createPresignedPartUploadUrl,
  headCompletedObject,
  initiateMultipartUpload,
  verifyCompletedObject,
  type StorageMultipartDenialCode,
} from "./storage-multipart.js";

// =============================================================================
// Bounded vocabularies
// =============================================================================

export const UPLOAD_SESSION_STATES = [
  "INITIATED",
  "UPLOADING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "ABORTED",
] as const;

export type UploadSessionState = (typeof UPLOAD_SESSION_STATES)[number];

export const UPLOAD_PART_STATES = [
  "PENDING",
  "UPLOADED_UNVERIFIED",
  "VERIFIED",
  "FAILED",
] as const;

export type UploadPartState = (typeof UPLOAD_PART_STATES)[number];

export const UPLOAD_SESSION_DENIAL_CODES = [
  "session_not_found",
  "session_not_active",
  "session_already_completed",
  "session_already_terminal",
  "invalid_state_transition",
  "invalid_part_index",
  "invalid_expiry",
  "invalid_part_count",
  "hash_mismatch",
  "completion_blocked_pending_parts",
  "service_unavailable",
  // Phase R1 — the target evidence does not exist within the session's
  // team. Anti-enumeration: maps to 404 (never distinguishes "belongs to
  // another team" from "does not exist").
  "evidence_not_found",
] as const;

/**
 * Phase 30.7 — finalize-gate denial vocabulary. Distinct from the
 * session-lifecycle codes above: these codes describe WHY evidence
 * finalization was refused by the upload-session gate. Bounded so
 * route handlers never surface free-text reasons.
 */
export const UPLOAD_SESSION_FINALIZE_GATE_CODES = [
  // Resumable session exists but is not yet COMPLETED. The client
  // must finish + complete the session before evidence finalization.
  "session_not_completed",
  // Resumable session exists with at least one non-VERIFIED part
  // (PENDING / UPLOADED_UNVERIFIED / FAILED).
  "session_pending_parts",
  // Resumable session is in a terminal failure state.
  "session_failed",
  // Phase 30.11 — Resumable session failed specifically because a
  // hash check (per-part or final-object) did not match. Surfaced
  // as a distinct code so operator UI can render the integrity
  // warning with custody-careful wording.
  "session_hash_mismatch",
  // Resumable session was aborted by client or operator.
  "session_aborted",
  // Resumable session expired before completion.
  "session_expired",
  // Gate evaluation itself failed (DB unavailable / unexpected error).
  "gate_unavailable",
  // Phase 30.11 — Reserved for higher-level mixed-material co-validation
  // (one Evidence with both legacy EvidenceParts + upload_sessions).
  // The gate itself can determine all per-session blockers via the
  // codes above; `mixed_material_incomplete` is the explicit signal
  // when a caller combines this gate's verdict with a legacy-part
  // verifier and the legacy side hasn't fully validated.
  "mixed_material_incomplete",
  // Phase 30.11 — Caller asserted there should be at least one
  // server-verified material but found none (no legacy EvidencePart
  // AND no COMPLETED session). Distinct from `applies: false` which
  // signals "no resumable activity at all, gate is moot".
  "no_verified_materials",
] as const;

export type UploadSessionFinalizeGateCode =
  (typeof UPLOAD_SESSION_FINALIZE_GATE_CODES)[number];

export type UploadSessionDenialCode =
  (typeof UPLOAD_SESSION_DENIAL_CODES)[number];

// Bounded session lifetime — operators can issue sessions between 5
// min and 24h. Anything outside the range is refused.
const MIN_SESSION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Bounded per-session part count + total size — refuses pathological
// requests at creation rather than at completion.
const MAX_PARTS_PER_SESSION = 10_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024 * 50; // 50 GiB

// =============================================================================
// Projections
// =============================================================================

export type UploadSessionRow = {
  id: string;
  teamId: string;
  evidenceId: string;
  actorUserId: string;
  state: UploadSessionState;
  expectedPartCount: number;
  expectedTotalBytes: number | null;
  expectedSha256: string | null;
  safeNote: string | null;
  idempotencyKey: string | null;
  expiresAtUtc: string;
  completedAtUtc: string | null;
  abortedAtUtc: string | null;
  abortedByUserId: string | null;
  abortReason: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type UploadSessionPartRow = {
  id: string;
  sessionId: string;
  teamId: string;
  partIndex: number;
  state: UploadPartState;
  expectedBytes: number | null;
  clientSha256: string | null;
  serverSha256: string | null;
  uploadedAtUtcClient: string | null;
  verifiedAtUtc: string | null;
  retryCount: number;
  failureReason: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

type RawSession = {
  id: string;
  team_id: string;
  evidence_id: string;
  actor_user_id: string;
  state: string;
  expected_part_count: number;
  expected_total_bytes: bigint | number | null;
  expected_sha256: string | null;
  safe_note: string | null;
  idempotency_key: string | null;
  expires_at_utc: Date;
  completed_at_utc: Date | null;
  aborted_at_utc: Date | null;
  aborted_by_user_id: string | null;
  abort_reason: string | null;
  created_at_utc: Date;
  updated_at_utc: Date;
};

type RawPart = {
  id: string;
  session_id: string;
  team_id: string;
  part_index: number;
  state: string;
  expected_bytes: bigint | number | null;
  client_sha256: string | null;
  server_sha256: string | null;
  uploaded_at_utc_client: Date | null;
  verified_at_utc: Date | null;
  retry_count: number;
  failure_reason: string | null;
  created_at_utc: Date;
  updated_at_utc: Date;
};

function toNumberOrNull(value: bigint | number | null): number | null {
  if (value === null) return null;
  return typeof value === "bigint" ? Number(value) : value;
}

function projectSession(raw: RawSession): UploadSessionRow {
  return {
    id: raw.id,
    teamId: raw.team_id,
    evidenceId: raw.evidence_id,
    actorUserId: raw.actor_user_id,
    state: raw.state as UploadSessionState,
    expectedPartCount: raw.expected_part_count,
    expectedTotalBytes: toNumberOrNull(raw.expected_total_bytes),
    expectedSha256: raw.expected_sha256,
    safeNote: raw.safe_note,
    idempotencyKey: raw.idempotency_key,
    expiresAtUtc: raw.expires_at_utc.toISOString(),
    completedAtUtc: raw.completed_at_utc?.toISOString() ?? null,
    abortedAtUtc: raw.aborted_at_utc?.toISOString() ?? null,
    abortedByUserId: raw.aborted_by_user_id,
    abortReason: raw.abort_reason,
    createdAtUtc: raw.created_at_utc.toISOString(),
    updatedAtUtc: raw.updated_at_utc.toISOString(),
  };
}

function projectPart(raw: RawPart): UploadSessionPartRow {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    teamId: raw.team_id,
    partIndex: raw.part_index,
    state: raw.state as UploadPartState,
    expectedBytes: toNumberOrNull(raw.expected_bytes),
    clientSha256: raw.client_sha256,
    serverSha256: raw.server_sha256,
    uploadedAtUtcClient: raw.uploaded_at_utc_client?.toISOString() ?? null,
    verifiedAtUtc: raw.verified_at_utc?.toISOString() ?? null,
    retryCount: raw.retry_count,
    failureReason: raw.failure_reason,
    createdAtUtc: raw.created_at_utc.toISOString(),
    updatedAtUtc: raw.updated_at_utc.toISOString(),
  };
}

// =============================================================================
// Create session
// =============================================================================

export type CreateSessionInput = {
  teamId: string;
  evidenceId: string;
  actorUserId: string;
  expectedPartCount: number;
  expectedTotalBytes?: number | null;
  expectedSha256?: string | null;
  safeNote?: string | null;
  /** Bounded between 5 min and 24h. */
  expiresAtUtc?: string | Date;
  /** Idempotency — repeat POSTs with the same key collapse to the
   *  existing session for the team. */
  idempotencyKey?: string | null;
  /**
   * Phase 30.12 — upload-session → EvidencePart bridge metadata.
   * When supplied, completeStorageMultipart will create a bridging
   * EvidencePart row on success so report-v2, verification package,
   * verify page, and search indexing automatically see the
   * multipart material via the existing EvidencePart contract.
   *
   * All three fields must be supplied together for the bridge to
   * activate. Omitted ⇒ session lives in parallel to legacy parts
   * without producing an EvidencePart row (back-compat for older
   * clients that drive sessions directly without the capture-page
   * fork).
   */
  targetPartIndex?: number | null;
  originalFileName?: string | null;
  expectedMimeType?: string | null;
};

export type CreateSessionResult =
  | { ok: true; session: UploadSessionRow; reused: boolean }
  | { ok: false; reason: UploadSessionDenialCode };

export async function createUploadSession(
  input: CreateSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<CreateSessionResult> {
  if (
    !Number.isInteger(input.expectedPartCount) ||
    input.expectedPartCount < 1 ||
    input.expectedPartCount > MAX_PARTS_PER_SESSION
  ) {
    return { ok: false, reason: "invalid_part_count" };
  }
  if (
    input.expectedTotalBytes != null &&
    (input.expectedTotalBytes < 0 ||
      input.expectedTotalBytes > MAX_TOTAL_BYTES)
  ) {
    return { ok: false, reason: "invalid_part_count" };
  }
  if (
    input.expectedSha256 != null &&
    !/^[a-f0-9]{64}$/.test(input.expectedSha256)
  ) {
    return { ok: false, reason: "hash_mismatch" };
  }

  const now = Date.now();
  const expiresAt =
    input.expiresAtUtc instanceof Date
      ? input.expiresAtUtc
      : input.expiresAtUtc
        ? new Date(input.expiresAtUtc)
        : new Date(now + 60 * 60 * 1000); // 1h default
  const lifetime = expiresAt.getTime() - now;
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    lifetime < MIN_SESSION_LIFETIME_MS ||
    lifetime > MAX_SESSION_LIFETIME_MS
  ) {
    return { ok: false, reason: "invalid_expiry" };
  }

  // Phase R1 — object-level ownership guard (IDOR fix). The route/gate
  // only proves the caller is a member of `input.teamId`; it does NOT
  // prove the client-supplied `input.evidenceId` belongs to that team.
  // Without this check a member of Team A could open a session (row
  // written with A's team_id) targeting Team B's evidence id, and the
  // Phase 30.12 multipart-complete bridge would then attach an
  // `EvidencePart` to Team B's forensic Evidence (cross-tenant custody
  // tampering). Enforce that the target evidence exists WITHIN the
  // session's team before any row is written. Anti-enumeration: a
  // missing or cross-team id both return `evidence_not_found` (404).
  const owningEvidence = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { id: true },
  });
  if (!owningEvidence) {
    return { ok: false, reason: "evidence_not_found" };
  }

  // Idempotency check — collapse to existing session if the key
  // matches a non-terminal row for the team.
  if (input.idempotencyKey) {
    try {
      const existing = (await client.$queryRawUnsafe(
        `SELECT "id", "team_id", "evidence_id", "actor_user_id", "state",
                "expected_part_count", "expected_total_bytes", "expected_sha256",
                "safe_note", "idempotency_key", "expires_at_utc",
                "completed_at_utc", "aborted_at_utc", "aborted_by_user_id",
                "abort_reason", "created_at_utc", "updated_at_utc"
           FROM "evidence_upload_sessions"
           WHERE "team_id" = $1 AND "idempotency_key" = $2
           LIMIT 1`,
        input.teamId,
        input.idempotencyKey,
      )) as RawSession[];
      if (existing.length > 0) {
        bump("upload_session_idempotent_reuse_total");
        return { ok: true, session: projectSession(existing[0]!), reused: true };
      }
    } catch {
      // Fall through to insert path; the unique index will catch a
      // race.
    }
  }

  // Phase 30.12 — validate bridge fields if supplied. partIndex must be
  // a non-negative int; filename bounded to 255 chars; mime bounded to 128.
  if (
    input.targetPartIndex != null &&
    (!Number.isInteger(input.targetPartIndex) || input.targetPartIndex < 0)
  ) {
    return { ok: false, reason: "invalid_part_index" };
  }
  try {
    const rows = (await client.$queryRawUnsafe(
      `INSERT INTO "evidence_upload_sessions" (
         "team_id", "evidence_id", "actor_user_id", "state",
         "expected_part_count", "expected_total_bytes", "expected_sha256",
         "safe_note", "idempotency_key", "expires_at_utc",
         "target_part_index", "original_file_name", "expected_mime_type"
       ) VALUES ($1, $2, $3, 'INITIATED', $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING "id", "team_id", "evidence_id", "actor_user_id", "state",
         "expected_part_count", "expected_total_bytes", "expected_sha256",
         "safe_note", "idempotency_key", "expires_at_utc",
         "completed_at_utc", "aborted_at_utc", "aborted_by_user_id",
         "abort_reason", "created_at_utc", "updated_at_utc"`,
      input.teamId,
      input.evidenceId,
      input.actorUserId,
      input.expectedPartCount,
      input.expectedTotalBytes ?? null,
      input.expectedSha256 ?? null,
      input.safeNote?.slice(0, 400) ?? null,
      input.idempotencyKey?.slice(0, 120) ?? null,
      expiresAt,
      input.targetPartIndex ?? null,
      input.originalFileName?.slice(0, 255) ?? null,
      input.expectedMimeType?.slice(0, 128) ?? null,
    )) as RawSession[];
    const session = rows[0];
    if (!session) {
      return { ok: false, reason: "service_unavailable" };
    }
    // Materialise the per-part PENDING rows up-front so the resume
    // endpoint always returns a deterministic shape.
    const placeholders = Array.from(
      { length: input.expectedPartCount },
      (_, i) => `($1, $2, ${i}, 'PENDING')`,
    ).join(", ");
    await client.$executeRawUnsafe(
      `INSERT INTO "evidence_upload_session_parts"
         ("session_id", "team_id", "part_index", "state")
         VALUES ${placeholders}
         ON CONFLICT ("session_id", "part_index") DO NOTHING`,
      session.id,
      input.teamId,
    );
    bump("upload_session_created_total");
    return {
      ok: true,
      session: projectSession(session),
      reused: false,
    };
  } catch (err) {
    bump("upload_session_create_failed_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "upload_session_create_failed",
      severity: "WARNING",
      details: {
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
    });
    return { ok: false, reason: "service_unavailable" };
  }
}

// =============================================================================
// Resume session — returns the session + part progress
// =============================================================================

export type ResumeSessionInput = {
  teamId: string;
  sessionId: string;
};

export type ResumeSessionResult =
  | {
      ok: true;
      session: UploadSessionRow;
      parts: ReadonlyArray<UploadSessionPartRow>;
      pendingPartIndices: ReadonlyArray<number>;
    }
  | { ok: false; reason: UploadSessionDenialCode };

export async function resumeUploadSession(
  input: ResumeSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<ResumeSessionResult> {
  try {
    const sessions = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "evidence_id", "actor_user_id", "state",
              "expected_part_count", "expected_total_bytes", "expected_sha256",
              "safe_note", "idempotency_key", "expires_at_utc",
              "completed_at_utc", "aborted_at_utc", "aborted_by_user_id",
              "abort_reason", "created_at_utc", "updated_at_utc"
         FROM "evidence_upload_sessions"
         WHERE "id" = $1 AND "team_id" = $2
         LIMIT 1`,
      input.sessionId,
      input.teamId,
    )) as RawSession[];
    if (sessions.length === 0) {
      return { ok: false, reason: "session_not_found" };
    }
    const session = projectSession(sessions[0]!);
    const parts = (await client.$queryRawUnsafe(
      `SELECT "id", "session_id", "team_id", "part_index", "state",
              "expected_bytes", "client_sha256", "server_sha256",
              "uploaded_at_utc_client", "verified_at_utc", "retry_count",
              "failure_reason", "created_at_utc", "updated_at_utc"
         FROM "evidence_upload_session_parts"
         WHERE "session_id" = $1 AND "team_id" = $2
         ORDER BY "part_index" ASC`,
      input.sessionId,
      input.teamId,
    )) as RawPart[];
    const projectedParts = parts.map(projectPart);
    const pendingPartIndices = projectedParts
      .filter((p) => p.state !== "VERIFIED")
      .map((p) => p.partIndex);
    bump("upload_session_resumed_total");
    return {
      ok: true,
      session,
      parts: projectedParts,
      pendingPartIndices,
    };
  } catch (err) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "upload_session_resume_failed",
      severity: "WARNING",
      details: {
        sessionId: input.sessionId,
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
    });
    return { ok: false, reason: "service_unavailable" };
  }
}

// =============================================================================
// Mark part — client → server transitions
// =============================================================================

export type MarkPartUploadedInput = {
  teamId: string;
  sessionId: string;
  partIndex: number;
  /** Client-claimed SHA-256. Treated as advisory. */
  clientSha256?: string | null;
  /** Client-observed upload completion time. Treated as advisory. */
  clientUploadedAtUtc?: string | Date | null;
};

export type MarkPartResult =
  | { ok: true; part: UploadSessionPartRow }
  | { ok: false; reason: UploadSessionDenialCode };

/**
 * Client tells the server "I finished uploading part N". This
 * transitions the part to `UPLOADED_UNVERIFIED` and stores the
 * client-claimed hash + client clock for audit. The server still
 * needs to call `markPartVerified` after running its own HEAD +
 * SHA-256 check.
 */
export async function markPartUploaded(
  input: MarkPartUploadedInput,
  client: PrismaClient = defaultPrisma,
): Promise<MarkPartResult> {
  if (!Number.isInteger(input.partIndex) || input.partIndex < 0) {
    return { ok: false, reason: "invalid_part_index" };
  }
  if (
    input.clientSha256 != null &&
    !/^[a-f0-9]{64}$/.test(input.clientSha256)
  ) {
    return { ok: false, reason: "hash_mismatch" };
  }
  const clientUploaded =
    input.clientUploadedAtUtc instanceof Date
      ? input.clientUploadedAtUtc
      : input.clientUploadedAtUtc
        ? new Date(input.clientUploadedAtUtc)
        : null;
  try {
    const rows = (await client.$queryRawUnsafe(
      `UPDATE "evidence_upload_session_parts"
         SET "state" = CASE
               WHEN "state" = 'VERIFIED' THEN 'VERIFIED'
               ELSE 'UPLOADED_UNVERIFIED'
             END,
             "client_sha256" = COALESCE($4, "client_sha256"),
             "uploaded_at_utc_client" = COALESCE($5, "uploaded_at_utc_client"),
             "retry_count" = "retry_count" + CASE WHEN "state" = 'UPLOADED_UNVERIFIED' THEN 1 ELSE 0 END,
             "updated_at_utc" = NOW()
         WHERE "session_id" = $1
           AND "team_id" = $2
           AND "part_index" = $3
         RETURNING "id", "session_id", "team_id", "part_index", "state",
           "expected_bytes", "client_sha256", "server_sha256",
           "uploaded_at_utc_client", "verified_at_utc", "retry_count",
           "failure_reason", "created_at_utc", "updated_at_utc"`,
      input.sessionId,
      input.teamId,
      input.partIndex,
      input.clientSha256 ?? null,
      clientUploaded,
    )) as RawPart[];
    if (rows.length === 0) {
      return { ok: false, reason: "invalid_part_index" };
    }
    bump("upload_part_marked_uploaded_total");
    return { ok: true, part: projectPart(rows[0]!) };
  } catch {
    return { ok: false, reason: "service_unavailable" };
  }
}

export type MarkPartVerifiedInput = {
  teamId: string;
  sessionId: string;
  partIndex: number;
  /** Server-confirmed SHA-256 (computed from HEAD or stream). */
  serverSha256: string;
};

/**
 * Server confirms the part's bytes match the client's hash via a
 * fresh HEAD/SHA-256 check. If the client supplied a sha256 and it
 * doesn't match the server-computed value, we mark the part FAILED
 * with `hash_mismatch` rather than VERIFIED.
 */
export async function markPartVerified(
  input: MarkPartVerifiedInput,
  client: PrismaClient = defaultPrisma,
): Promise<MarkPartResult> {
  if (!/^[a-f0-9]{64}$/.test(input.serverSha256)) {
    return { ok: false, reason: "hash_mismatch" };
  }
  try {
    // Fetch current row to compare client hash + state.
    const current = (await client.$queryRawUnsafe(
      `SELECT "state", "client_sha256"
         FROM "evidence_upload_session_parts"
         WHERE "session_id" = $1 AND "team_id" = $2 AND "part_index" = $3
         LIMIT 1`,
      input.sessionId,
      input.teamId,
      input.partIndex,
    )) as Array<{ state: string; client_sha256: string | null }>;
    if (current.length === 0) {
      return { ok: false, reason: "invalid_part_index" };
    }
    const row = current[0]!;
    if (row.state === "VERIFIED") {
      // Idempotent re-verify — return the existing row unchanged.
      const fetch = (await client.$queryRawUnsafe(
        `SELECT "id", "session_id", "team_id", "part_index", "state",
                "expected_bytes", "client_sha256", "server_sha256",
                "uploaded_at_utc_client", "verified_at_utc", "retry_count",
                "failure_reason", "created_at_utc", "updated_at_utc"
           FROM "evidence_upload_session_parts"
           WHERE "session_id" = $1 AND "team_id" = $2 AND "part_index" = $3`,
        input.sessionId,
        input.teamId,
        input.partIndex,
      )) as RawPart[];
      return { ok: true, part: projectPart(fetch[0]!) };
    }
    // If the client claimed a hash and it doesn't match, fail the
    // part instead of verifying.
    const claimed = row.client_sha256;
    if (claimed && claimed !== input.serverSha256) {
      bump("upload_hash_mismatch_total");
      await client.$queryRawUnsafe(
        `UPDATE "evidence_upload_session_parts"
           SET "state" = 'FAILED',
               "server_sha256" = $4,
               "failure_reason" = 'hash_mismatch',
               "updated_at_utc" = NOW()
           WHERE "session_id" = $1 AND "team_id" = $2 AND "part_index" = $3
           RETURNING "id", "session_id", "team_id", "part_index", "state",
             "expected_bytes", "client_sha256", "server_sha256",
             "uploaded_at_utc_client", "verified_at_utc", "retry_count",
             "failure_reason", "created_at_utc", "updated_at_utc"`,
        input.sessionId,
        input.teamId,
        input.partIndex,
        input.serverSha256,
      );
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "upload_part_hash_mismatch",
        severity: "WARNING",
        details: {
          sessionId: input.sessionId,
          partIndex: input.partIndex,
        },
      });
      return { ok: false, reason: "hash_mismatch" };
    }
    // Happy path — mark VERIFIED with server clock.
    const rows = (await client.$queryRawUnsafe(
      `UPDATE "evidence_upload_session_parts"
         SET "state" = 'VERIFIED',
             "server_sha256" = $4,
             "verified_at_utc" = NOW(),
             "failure_reason" = NULL,
             "updated_at_utc" = NOW()
         WHERE "session_id" = $1 AND "team_id" = $2 AND "part_index" = $3
         RETURNING "id", "session_id", "team_id", "part_index", "state",
           "expected_bytes", "client_sha256", "server_sha256",
           "uploaded_at_utc_client", "verified_at_utc", "retry_count",
           "failure_reason", "created_at_utc", "updated_at_utc"`,
      input.sessionId,
      input.teamId,
      input.partIndex,
      input.serverSha256,
    )) as RawPart[];
    if (rows.length === 0) {
      return { ok: false, reason: "invalid_part_index" };
    }
    bump("upload_part_verified_total");
    return { ok: true, part: projectPart(rows[0]!) };
  } catch {
    return { ok: false, reason: "service_unavailable" };
  }
}

// =============================================================================
// Complete session — server gate
// =============================================================================

export type CompleteSessionInput = {
  teamId: string;
  sessionId: string;
};

export type CompleteSessionResult =
  | { ok: true; session: UploadSessionRow }
  | {
      ok: false;
      reason: UploadSessionDenialCode;
      pendingPartIndices?: ReadonlyArray<number>;
    };

/**
 * Server-side completion gate. Refuses to mark the session COMPLETED
 * unless every part is in state VERIFIED. The completion timestamp
 * uses the server clock — never client clock.
 *
 * Idempotent: calling complete on an already-COMPLETED session returns
 * the existing row.
 */
export async function completeUploadSession(
  input: CompleteSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<CompleteSessionResult> {
  try {
    // Atomic check + flip via a CTE so we can refuse completion if
    // any part is still PENDING/UPLOADED_UNVERIFIED/FAILED in a
    // single round-trip.
    const sessions = (await client.$queryRawUnsafe(
      `SELECT "id", "state", "expected_part_count"
         FROM "evidence_upload_sessions"
         WHERE "id" = $1 AND "team_id" = $2 LIMIT 1`,
      input.sessionId,
      input.teamId,
    )) as Array<{
      id: string;
      state: string;
      expected_part_count: number;
    }>;
    if (sessions.length === 0) {
      return { ok: false, reason: "session_not_found" };
    }
    const cur = sessions[0]!;
    if (cur.state === "COMPLETED") {
      return await fetchSession(input.teamId, input.sessionId, client);
    }
    if (
      cur.state === "ABORTED" ||
      cur.state === "EXPIRED" ||
      cur.state === "FAILED"
    ) {
      return { ok: false, reason: "session_already_terminal" };
    }
    const pending = (await client.$queryRawUnsafe(
      `SELECT "part_index"
         FROM "evidence_upload_session_parts"
         WHERE "session_id" = $1 AND "team_id" = $2 AND "state" <> 'VERIFIED'
         ORDER BY "part_index" ASC`,
      input.sessionId,
      input.teamId,
    )) as Array<{ part_index: number }>;
    if (pending.length > 0) {
      return {
        ok: false,
        reason: "completion_blocked_pending_parts",
        pendingPartIndices: pending.map((p) => p.part_index),
      };
    }
    const rows = (await client.$queryRawUnsafe(
      `UPDATE "evidence_upload_sessions"
         SET "state" = 'COMPLETED',
             "completed_at_utc" = NOW(),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2 AND "state" <> 'COMPLETED'
         RETURNING "id", "team_id", "evidence_id", "actor_user_id", "state",
           "expected_part_count", "expected_total_bytes", "expected_sha256",
           "safe_note", "idempotency_key", "expires_at_utc",
           "completed_at_utc", "aborted_at_utc", "aborted_by_user_id",
           "abort_reason", "created_at_utc", "updated_at_utc"`,
      input.sessionId,
      input.teamId,
    )) as RawSession[];
    if (rows.length === 0) {
      // Race — another caller flipped it. Re-fetch.
      return await fetchSession(input.teamId, input.sessionId, client);
    }
    bump("upload_session_completed_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "upload_session_completed",
      severity: "INFO",
      details: {
        sessionId: input.sessionId,
        actorUserId: rows[0]!.actor_user_id,
      },
    });
    return { ok: true, session: projectSession(rows[0]!) };
  } catch {
    return { ok: false, reason: "service_unavailable" };
  }
}

async function fetchSession(
  teamId: string,
  sessionId: string,
  client: PrismaClient,
): Promise<CompleteSessionResult> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT "id", "team_id", "evidence_id", "actor_user_id", "state",
            "expected_part_count", "expected_total_bytes", "expected_sha256",
            "safe_note", "idempotency_key", "expires_at_utc",
            "completed_at_utc", "aborted_at_utc", "aborted_by_user_id",
            "abort_reason", "created_at_utc", "updated_at_utc"
       FROM "evidence_upload_sessions"
       WHERE "id" = $1 AND "team_id" = $2 LIMIT 1`,
    sessionId,
    teamId,
  )) as RawSession[];
  if (rows.length === 0) {
    return { ok: false, reason: "session_not_found" };
  }
  return { ok: true, session: projectSession(rows[0]!) };
}

// =============================================================================
// Abort session — operator/client cancellation
// =============================================================================

export type AbortSessionInput = {
  teamId: string;
  sessionId: string;
  actorUserId: string;
  reason: string;
};

/** Readability shim — an empty result set is the only failure this read has. */
function rows0Empty(rows: unknown[]): boolean {
  return rows.length === 0;
}

export async function abortUploadSession(
  input: AbortSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<{ ok: true; session: UploadSessionRow } | { ok: false; reason: UploadSessionDenialCode }> {
  try {
    // PHASE 13 §4 (2026-08-17) — A SESSION ABORT NOW CANCELS THE STORAGE
    // MULTIPART TOO, so it is sufficient on its own.
    //
    // The web client cancels in two legs — `multipart/abort` then
    // `sessions/:id/abort` — and the server was relying on the client to send
    // both. It does not always: the capture page initiates the multipart itself,
    // outside the uploader, and the uploader's "did I initiate" flag tracks only
    // its own call, so a cancel inside that window skipped the multipart leg
    // entirely. The S3 upload then stayed live, holding — and billing for — its
    // uploaded parts, with the session row marked ABORTED.
    //
    // A server-side lifecycle must not depend on a client remembering the order
    // of its own requests. When the session row records an upload id and storage
    // has not already been settled, this delegates to `abortStorageMultipart`,
    // which is the ONE implementation of "cancel at storage, then close the row"
    // and emits the single audit event for the cancel. Its result is re-read and
    // projected below.
    const withMultipart = await loadSessionWithMultipart(
      client,
      input.teamId,
      input.sessionId,
    );
    if (
      withMultipart &&
      withMultipart.multipart_upload_id &&
      !withMultipart.aborted_at_storage_utc &&
      withMultipart.state !== "COMPLETED"
    ) {
      const storage = await abortStorageMultipart(input, client);
      if (!storage.ok) {
        // Storage refused. The row is deliberately left non-terminal: a session
        // marked ABORTED over a multipart that is still live is exactly the
        // orphan this change exists to prevent, and the caller may retry.
        return { ok: false, reason: "service_unavailable" };
      }
      const after = (await client.$queryRawUnsafe(
        `SELECT "id", "team_id", "evidence_id", "actor_user_id", "state",
                "expected_part_count", "expected_total_bytes", "expected_sha256",
                "safe_note", "idempotency_key", "expires_at_utc",
                "completed_at_utc", "aborted_at_utc", "aborted_by_user_id",
                "abort_reason", "created_at_utc", "updated_at_utc"
           FROM "evidence_upload_sessions"
          WHERE "id" = $1 AND "team_id" = $2
          LIMIT 1`,
        input.sessionId,
        input.teamId,
      )) as RawSession[];
      if (rows0Empty(after)) return { ok: false, reason: "session_already_terminal" };
      return { ok: true, session: projectSession(after[0]!) };
    }

    const rows = (await client.$queryRawUnsafe(
      `UPDATE "evidence_upload_sessions"
         SET "state" = 'ABORTED',
             "aborted_at_utc" = NOW(),
             "aborted_by_user_id" = $3,
             "abort_reason" = $4,
             "updated_at_utc" = NOW()
         WHERE "id" = $1
           AND "team_id" = $2
           AND "state" NOT IN ('COMPLETED', 'ABORTED', 'EXPIRED')
         RETURNING "id", "team_id", "evidence_id", "actor_user_id", "state",
           "expected_part_count", "expected_total_bytes", "expected_sha256",
           "safe_note", "idempotency_key", "expires_at_utc",
           "completed_at_utc", "aborted_at_utc", "aborted_by_user_id",
           "abort_reason", "created_at_utc", "updated_at_utc"`,
      input.sessionId,
      input.teamId,
      input.actorUserId,
      input.reason.slice(0, 120),
    )) as RawSession[];
    if (rows.length === 0) {
      /**
       * PHASE 13 (NEW-079) — EXISTENCE BEFORE STATE. TWO CAUSES, TWO ANSWERS.
       *
       * The conditional UPDATE above affects zero rows for two entirely
       * different reasons, and this branch used to collapse them into one:
       *
       *   (a) there is no such session FOR THIS TENANT — it belongs to somebody
       *       else, or it does not exist at all;
       *   (b) the session is this tenant's and is already terminal.
       *
       * Answering `session_already_terminal` (409) in case (a) asserts the
       * LIFECYCLE STATE of a row the caller is not allowed to know exists. A
       * stranger who guessed or copied a session id learned that it is real and
       * that it has reached a terminal state — from a route that had already
       * refused them nothing, because `authorizeOrFail` only established their
       * rights over the team id THEY supplied, never over the session.
       *
       * The sibling route gets this right and is the contract to match:
       * `/multipart/abort` resolves the session through
       * `loadSessionWithMultipart(client, teamId, sessionId)` and answers
       * `session_not_found` → 404 with `sendDenial`'s bounded anti-enumeration
       * body, so "not yours" and "no such thing" are indistinguishable. This now
       * does the same, using the same tenant-scoped lookup.
       *
       * Case (b) still answers 409, because for the legitimate owner "already
       * terminal" is the honest and useful answer — and it is what makes a
       * repeated cancellation idempotent rather than a 404. No other denial
       * mapping changes.
       */
      const existsForTenant = await loadSessionWithMultipart(
        client,
        input.teamId,
        input.sessionId,
      );
      if (!existsForTenant) {
        return { ok: false, reason: "session_not_found" };
      }
      return { ok: false, reason: "session_already_terminal" };
    }
    bump("upload_session_aborted_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "upload_session_aborted",
      severity: "INFO",
      details: {
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        reason: input.reason.slice(0, 120),
      },
    });
    return { ok: true, session: projectSession(rows[0]!) };
  } catch {
    return { ok: false, reason: "service_unavailable" };
  }
}

// =============================================================================
// Reaper — sweep stale sessions
// =============================================================================

/**
 * Mark sessions that have expired without completing. Returns the count of rows
 * flipped. Best-effort — failures bump a metric.
 *
 * PHASE 13 §4 (2026-08-17) — BOUNDED, and armed.
 *
 * It is now called from `runMasterReconcile` (POST /v1/ops/reconcile), which
 * already runs its sibling `reapStaleMultipartUploads` from this same module:
 * that one releases the S3-side multipart uploads, this one closes the
 * database-side session rows, and having one of the pair armed and the other not
 * is how a session ends up with its storage released and its row still claiming
 * to be UPLOADING.
 *
 * The statement was previously unbounded — a single UPDATE over every expired
 * row in the table. Every other sweep on that reconcile tick takes a bounded
 * batch, and for good reason: the first tick after an outage is exactly when the
 * backlog is largest and exactly when a long-running write over a hot table is
 * least affordable. It now updates at most `limit` rows per call, selected by
 * the oldest expiry first, and the caller ticks again. The state predicate is
 * unchanged and stays in the WHERE, so a session that completed between the
 * select and the update is not clobbered.
 */
export const UPLOAD_SESSION_REAP_BATCH = 200;

export async function reapStaleUploadSessions(
  client: PrismaClient = defaultPrisma,
  limit: number = UPLOAD_SESSION_REAP_BATCH,
): Promise<{ reaped: number }> {
  try {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const result = await client.$executeRawUnsafe(
      `UPDATE "evidence_upload_sessions"
         SET "state" = 'EXPIRED',
             "updated_at_utc" = NOW()
       WHERE "id" IN (
         SELECT "id" FROM "evidence_upload_sessions"
          WHERE "state" IN ('INITIATED', 'UPLOADING', 'VERIFYING')
            AND "expires_at_utc" < NOW()
          ORDER BY "expires_at_utc" ASC
          LIMIT ${bounded}
       )
         AND "state" IN ('INITIATED', 'UPLOADING', 'VERIFYING')`,
    );
    bump("upload_session_expired_total");
    return { reaped: typeof result === "number" ? result : 0 };
  } catch {
    bump("upload_session_reap_failed_total");
    return { reaped: 0 };
  }
}

// =============================================================================
// Phase 30.7 — Custody-safe finalize gate
// =============================================================================

export type UploadSessionFinalizeGateResult =
  | {
      /**
       * `applies: false` → no resumable session exists for this
       * evidence. The legacy single-shot upload flow is in play and
       * the gate has nothing to enforce. The finalize handler should
       * proceed as before.
       */
      ok: true;
      applies: false;
    }
  | {
      /**
       * `applies: true` → EVERY resumable session bound to this
       * evidence is COMPLETED with every part VERIFIED. Finalize
       * may proceed. `sessionId` carries the FIRST verified session
       * (back-compat with single-session callers); `sessionIds`
       * carries the full list so audit / report-v2 / verification
       * package can enumerate them.
       *
       * Hard rule: this branch is taken ONLY when ALL sessions
       * pass — see Phase 30.11 ALL-sessions semantics. A single
       * COMPLETED session no longer wins on its own when other
       * sessions are still pending / aborted / expired / failed.
       */
      ok: true;
      applies: true;
      sessionId: string;
      sessionIds: ReadonlyArray<string>;
      completedAtUtc: string;
    }
  | {
      /**
       * At least one resumable session is NOT ready for finalize.
       * The reason code is bounded; the finalize handler should
       * refuse with a 409 (or 503 for `gate_unavailable`).
       * `sessionId` is the FIRST blocking session (deterministic:
       * created_at_utc ASC); `sessionState` is its server-side
       * state.
       */
      ok: false;
      reason: UploadSessionFinalizeGateCode;
      sessionId?: string;
      sessionState?: UploadSessionState;
    };

/**
 * The custody-safe finalize gate.
 *
 * Refuses evidence finalization when a resumable upload session
 * exists for this (team, evidence) pair but has NOT reached the
 * COMPLETED state with every part VERIFIED.
 *
 * Hard rules:
 *   - Backward compat: if NO session row exists for this evidence,
 *     the gate returns `applies: false`. Legacy single-shot uploads
 *     continue to finalize through the existing HEAD/SHA-256 path
 *     without any new gate.
 *   - Custody-safe: the gate runs INSIDE the finalize transaction
 *     when the caller passes the transaction client. That way the
 *     advisory-lock + finalize-row check + gate read all happen
 *     under a consistent DB snapshot — a session abort cannot race
 *     past the gate.
 *   - Idempotency: the gate is a pure read. It can be called any
 *     number of times safely. The existing `EvidenceStatus` short-
 *     circuit in `completeEvidence` ensures a retry on an already-
 *     SIGNED row returns the existing custody chain WITHOUT
 *     re-running the gate, so duplicate gate denials cannot tip a
 *     successful finalize back into a failure.
 *   - Multiple-session disambiguation: if more than one session
 *     exists (e.g. an aborted attempt followed by a fresh COMPLETED
 *     one), the COMPLETED session wins. The gate sorts by
 *     `created_at_utc DESC` and returns the first COMPLETED row it
 *     finds; if no COMPLETED row exists, it returns the latest
 *     non-terminal row's denial reason.
 *   - Fail-closed: any DB error returns `gate_unavailable` (the
 *     finalize handler must surface 503).
 */
export async function evaluateUploadSessionFinalizeGate(
  input: { teamId: string; evidenceId: string },
  client: PrismaClient = defaultPrisma,
): Promise<UploadSessionFinalizeGateResult> {
  // Phase 30.11 — ALL-sessions semantics.
  //
  // One Evidence may host multiple upload_sessions (e.g. a capture
  // session with two separate large files routed through the
  // resumable path). The gate now refuses finalize when ANY session
  // is not ready, instead of returning the first COMPLETED row it
  // finds. This is the central guarantee that lets the env flag be
  // flipped on without risking custody emission while uploads are
  // still pending.
  //
  // The deterministic "first blocking session" is the row with the
  // lowest created_at_utc so the operator UI surfaces sessions in
  // the order they were started (predictable, replayable).
  let rows: Array<{
    id: string;
    state: string;
    completed_at_utc: Date | null;
    aborted_at_utc: Date | null;
    expires_at_utc: Date;
    created_at_utc: Date;
  }>;
  try {
    rows = (await client.$queryRawUnsafe(
      `SELECT "id", "state", "completed_at_utc", "aborted_at_utc",
              "expires_at_utc", "created_at_utc"
         FROM "evidence_upload_sessions"
         WHERE "team_id" = $1 AND "evidence_id" = $2
         ORDER BY "created_at_utc" ASC`,
      input.teamId,
      input.evidenceId,
    )) as Array<{
      id: string;
      state: string;
      completed_at_utc: Date | null;
      aborted_at_utc: Date | null;
      expires_at_utc: Date;
      created_at_utc: Date;
    }>;
  } catch {
    bump("upload_session_finalize_gate_failed_total");
    return { ok: false, reason: "gate_unavailable" };
  }

  // Backward compat: no resumable session was ever created for this
  // evidence. The simple flow remains intact.
  if (rows.length === 0) {
    bump("upload_session_finalize_gate_no_session_total");
    return { ok: true, applies: false };
  }

  // Helper: map a session's terminal-failure / non-COMPLETED state
  // to its bounded denial reason. For FAILED state, the per-part
  // failure_reason determines whether to surface session_failed or
  // session_hash_mismatch (the latter is a distinct integrity
  // signal the UI should render with custody-careful wording).
  const reasonForState = async (
    row: (typeof rows)[number],
  ): Promise<UploadSessionFinalizeGateCode> => {
    const state = row.state as UploadSessionState;
    if (state === "ABORTED") return "session_aborted";
    if (state === "EXPIRED") return "session_expired";
    if (state === "FAILED") {
      // Check whether any part has failure_reason='hash_mismatch'.
      // If so, surface as a distinct denial code.
      try {
        const mismatch = (await client.$queryRawUnsafe(
          `SELECT 1
             FROM "evidence_upload_session_parts"
             WHERE "session_id" = $1 AND "team_id" = $2
               AND "failure_reason" = 'hash_mismatch'
             LIMIT 1`,
          row.id,
          input.teamId,
        )) as Array<unknown>;
        if (mismatch.length > 0) return "session_hash_mismatch";
      } catch {
        /* fall through to generic session_failed */
      }
      return "session_failed";
    }
    // INITIATED / UPLOADING / VERIFYING all collapse to the same
    // "still in progress" signal.
    return "session_not_completed";
  };

  // Scan ALL sessions. Any non-COMPLETED session = block.
  // For COMPLETED sessions, defense-in-depth verify every part is VERIFIED.
  const completedIds: string[] = [];
  const completedAtUtcs: string[] = [];
  for (const row of rows) {
    if (row.state !== "COMPLETED") {
      bump("upload_session_finalize_gate_denied_total");
      bump("mixed_material_finalize_blocked_total");
      const reason = await reasonForState(row);
      return {
        ok: false,
        reason,
        sessionId: row.id,
        sessionState: row.state as UploadSessionState,
      };
    }
    // COMPLETED — verify all parts VERIFIED.
    let pending: Array<unknown>;
    try {
      pending = (await client.$queryRawUnsafe(
        `SELECT 1
           FROM "evidence_upload_session_parts"
           WHERE "session_id" = $1 AND "team_id" = $2 AND "state" <> 'VERIFIED'
           LIMIT 1`,
        row.id,
        input.teamId,
      )) as Array<unknown>;
    } catch {
      bump("upload_session_finalize_gate_failed_total");
      return { ok: false, reason: "gate_unavailable" };
    }
    if (pending.length > 0) {
      bump("upload_session_finalize_gate_denied_total");
      bump("mixed_material_finalize_blocked_total");
      return {
        ok: false,
        reason: "session_pending_parts",
        sessionId: row.id,
        sessionState: row.state as UploadSessionState,
      };
    }
    completedIds.push(row.id);
    completedAtUtcs.push(
      row.completed_at_utc?.toISOString() ?? row.created_at_utc.toISOString(),
    );
  }

  // Every session passed.
  bump("upload_session_finalize_gate_allowed_total");
  bump("mixed_material_finalize_allowed_total");
  return {
    ok: true,
    applies: true,
    sessionId: completedIds[0]!,
    sessionIds: completedIds,
    completedAtUtc: completedAtUtcs[0]!,
  };
}

// =============================================================================
// Phase 30.8 — S3 native multipart lifecycle
// =============================================================================
//
// Bridges the upload-session state machine to the storage-multipart
// SDK wrapper. Every helper here is a thin orchestrator:
//
//   1. Load the session row (team-anchored).
//   2. Validate state is appropriate for the operation.
//   3. Call the storage-multipart helper.
//   4. Persist the result on the session row.
//   5. Bump metrics + emit SecurityEvent.
//
// The session state machine extends:
//   - `initiateStorageMultipart`: INITIATED → UPLOADING (and stores
//     multipart_upload_id + storage_bucket + storage_key).
//   - `presignStorageUploadPart`: presign-only; no state change.
//   - `completeStorageMultipart`: every part VERIFIED → call S3
//     CompleteMultipartUpload + HEAD + optional server-hash. Does
//     NOT flip session to COMPLETED — that still goes through
//     `completeUploadSession()` which has the same checks.
//   - `abortStorageMultipart`: ABORTED, S3 abort called.
//   - `reapStaleMultipartUploads`: per-expired-session abort sweep.

export const STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES = [
  ...UPLOAD_SESSION_DENIAL_CODES,
  // Plus storage-side reasons (re-exported here so route handlers
  // import one catalog).
  "storage_unavailable",
  "multipart_not_found",
  "invalid_part",
  "complete_failed",
  "head_failed",
  "configuration_missing",
  "multipart_already_initiated",
  "multipart_not_initiated",
  "missing_part_etag",
] as const;

export type StorageMultipartLifecycleDenialCode =
  (typeof STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES)[number];

type SessionWithMultipart = {
  id: string;
  team_id: string;
  evidence_id: string;
  state: string;
  expected_part_count: number;
  expected_sha256: string | null;
  multipart_upload_id: string | null;
  storage_bucket: string | null;
  storage_key: string | null;
  completed_at_storage_utc: Date | null;
  aborted_at_storage_utc: Date | null;
  // Phase 30.12 — bridge fields. Null when the session was created
  // without bridge metadata (older clients / API-key drivers that
  // don't need the EvidencePart link).
  target_part_index: number | null;
  original_file_name: string | null;
  expected_mime_type: string | null;
  bridged_evidence_part_id: string | null;
};

async function loadSessionWithMultipart(
  client: PrismaClient,
  teamId: string,
  sessionId: string,
): Promise<SessionWithMultipart | null> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT "id", "team_id", "evidence_id", "state",
            "expected_part_count", "expected_sha256",
            "multipart_upload_id", "storage_bucket", "storage_key",
            "completed_at_storage_utc", "aborted_at_storage_utc",
            "target_part_index", "original_file_name", "expected_mime_type",
            "bridged_evidence_part_id"
       FROM "evidence_upload_sessions"
       WHERE "id" = $1 AND "team_id" = $2
       LIMIT 1`,
    sessionId,
    teamId,
  )) as SessionWithMultipart[];
  return rows[0] ?? null;
}

// =============================================================================
// initiateStorageMultipart
// =============================================================================

export type InitiateStorageMultipartInput = {
  teamId: string;
  sessionId: string;
  contentType?: string | null;
};

export type InitiateStorageMultipartResult =
  | {
      ok: true;
      /** Storage location of the FINAL object (server-internal —
       *  routes MUST NOT project this). */
      storageBucket: string;
      storageKey: string;
    }
  | {
      ok: false;
      reason: StorageMultipartLifecycleDenialCode;
    };

/**
 * Bind a Phase 30 session to a real S3 multipart upload.
 *
 * IDEMPOTENT, AND IT SUCCEEDS ON THE RE-CALL. A session that already has a
 * `multipart_upload_id` returns `{ ok: true, ... }` carrying the EXISTING
 * storage location — it does not create a second S3 transaction, and it does not
 * refuse.
 *
 * PHASE 13 §4 (2026-08-17) — this docblock previously said the re-call returned
 * `multipart_already_initiated`. It never did, and the difference is not
 * cosmetic: the capture page initiates the multipart itself and then hands the
 * session to an uploader that initiates again, so the second call happens on the
 * ordinary path. Returning ok with the existing location is what makes that
 * harmless — the caller resumes part presigns against the upload that already
 * exists. A denial would have broken the capture flow, and a reader trusting the
 * old comment would have "fixed" the caller to handle a code the function does
 * not emit.
 */
export async function initiateStorageMultipart(
  input: InitiateStorageMultipartInput,
  client: PrismaClient = defaultPrisma,
): Promise<InitiateStorageMultipartResult> {
  const session = await loadSessionWithMultipart(
    client,
    input.teamId,
    input.sessionId,
  );
  if (!session) {
    return { ok: false, reason: "session_not_found" };
  }
  if (session.state !== "INITIATED" && session.state !== "UPLOADING") {
    return { ok: false, reason: "session_already_terminal" };
  }
  if (session.multipart_upload_id) {
    // Idempotent re-call — surface the existing storage location so
    // the caller can resume part presigns against it.
    if (!session.storage_bucket || !session.storage_key) {
      return { ok: false, reason: "configuration_missing" };
    }
    return {
      ok: true,
      storageBucket: session.storage_bucket,
      storageKey: session.storage_key,
    };
  }
  const storage = await initiateMultipartUpload({
    evidenceId: session.evidence_id,
    sessionId: session.id,
    contentType: input.contentType ?? null,
  });
  if (!storage.ok) {
    bump("multipart_initiated_failed_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "multipart_initiate_failed",
      severity: "WARNING",
      details: { sessionId: input.sessionId, reason: storage.reason },
    });
    return { ok: false, reason: storage.reason };
  }
  try {
    await client.$executeRawUnsafe(
      `UPDATE "evidence_upload_sessions"
         SET "state" = 'UPLOADING',
             "multipart_upload_id" = $3,
             "storage_bucket" = $4,
             "storage_key" = $5,
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2
           AND "state" IN ('INITIATED', 'UPLOADING')
           AND "multipart_upload_id" IS NULL`,
      input.sessionId,
      input.teamId,
      storage.multipartUploadId,
      storage.bucket,
      storage.key,
    );
  } catch {
    // The S3 multipart is now live but DB persist failed. Best-
    // effort abort on S3 so we don't leak a paid resource. Even if
    // this fails the reaper will eventually catch it.
    await abortMultipartUpload({
      bucket: storage.bucket,
      key: storage.key,
      multipartUploadId: storage.multipartUploadId,
    }).catch(() => null);
    return { ok: false, reason: "storage_unavailable" };
  }
  bump("multipart_initiated_total");
  return {
    ok: true,
    storageBucket: storage.bucket,
    storageKey: storage.key,
  };
}

// =============================================================================
// presignStorageUploadPart
// =============================================================================

export type PresignStorageUploadPartInput = {
  teamId: string;
  sessionId: string;
  /** 0-indexed, matches the session-parts schema. The S3 call uses
   *  1-indexed (partIndex + 1). */
  partIndex: number;
  expiresInSeconds?: number;
};

export type PresignStorageUploadPartResult =
  | {
      ok: true;
      uploadUrl: string;
      method: "PUT";
      expiresAt: string;
      partIndex: number;
    }
  | {
      ok: false;
      reason: StorageMultipartLifecycleDenialCode;
    };

/**
 * Generate a short-lived presigned PUT URL for one part. Does NOT
 * mark the part uploaded — that happens via `markPartUploaded` after
 * the client reports the ETag. Records the presign timestamp so
 * the operator surface can show "presigned 5min ago, no upload yet".
 */
export async function presignStorageUploadPart(
  input: PresignStorageUploadPartInput,
  client: PrismaClient = defaultPrisma,
): Promise<PresignStorageUploadPartResult> {
  if (
    !Number.isInteger(input.partIndex) ||
    input.partIndex < 0 ||
    input.partIndex > 9_999
  ) {
    return { ok: false, reason: "invalid_part_index" };
  }
  const session = await loadSessionWithMultipart(
    client,
    input.teamId,
    input.sessionId,
  );
  if (!session) {
    return { ok: false, reason: "session_not_found" };
  }
  if (!session.multipart_upload_id || !session.storage_bucket || !session.storage_key) {
    return { ok: false, reason: "multipart_not_initiated" };
  }
  if (session.state !== "UPLOADING") {
    return { ok: false, reason: "session_already_terminal" };
  }
  if (input.partIndex >= session.expected_part_count) {
    return { ok: false, reason: "invalid_part_index" };
  }
  const presign = await createPresignedPartUploadUrl({
    bucket: session.storage_bucket,
    key: session.storage_key,
    multipartUploadId: session.multipart_upload_id,
    partNumber: input.partIndex + 1,
    expiresInSeconds: input.expiresInSeconds,
  });
  if (!presign.ok) {
    return { ok: false, reason: presign.reason };
  }
  // Best-effort presign bookkeeping. A failure here doesn't break
  // the response — the URL is already minted.
  await client
    .$executeRawUnsafe(
      `UPDATE "evidence_upload_session_parts"
         SET "presigned_at_utc" = NOW(),
             "presign_expires_at_utc" = $4,
             "updated_at_utc" = NOW()
         WHERE "session_id" = $1 AND "team_id" = $2 AND "part_index" = $3`,
      input.sessionId,
      input.teamId,
      input.partIndex,
      new Date(presign.expiresAt),
    )
    .catch(() => null);
  bump("multipart_presign_part_total");
  return {
    ok: true,
    uploadUrl: presign.uploadUrl,
    method: "PUT",
    expiresAt: presign.expiresAt,
    partIndex: input.partIndex,
  };
}

// =============================================================================
// recordPartEtag — store ETag + size after client reports upload
// =============================================================================

export type RecordPartEtagInput = {
  teamId: string;
  sessionId: string;
  partIndex: number;
  /** S3-returned ETag from the UploadPartResponse. Storage metadata
   *  only — NOT a custody-grade integrity proof. */
  etag: string;
  partSizeBytes?: number | null;
};

export type RecordPartEtagResult =
  | { ok: true }
  | { ok: false; reason: StorageMultipartLifecycleDenialCode };

/**
 * Persist the ETag a client reports after uploading a single part.
 * The ETag is what `CompleteMultipartUpload` will reference; the
 * server does NOT trust it as a hash. The part-state transition to
 * `UPLOADED_UNVERIFIED` is delegated to the existing `markPartUploaded`
 * — this helper is for the storage-metadata write only.
 */
export async function recordPartEtag(
  input: RecordPartEtagInput,
  client: PrismaClient = defaultPrisma,
): Promise<RecordPartEtagResult> {
  if (!input.etag.trim()) {
    return { ok: false, reason: "missing_part_etag" };
  }
  if (
    input.partSizeBytes != null &&
    (input.partSizeBytes < 0 || !Number.isFinite(input.partSizeBytes))
  ) {
    return { ok: false, reason: "invalid_part" };
  }
  try {
    const count = (await client.$executeRawUnsafe(
      `UPDATE "evidence_upload_session_parts"
         SET "part_etag" = $4,
             "part_size_bytes" = COALESCE($5, "part_size_bytes"),
             "updated_at_utc" = NOW()
         WHERE "session_id" = $1 AND "team_id" = $2 AND "part_index" = $3`,
      input.sessionId,
      input.teamId,
      input.partIndex,
      input.etag,
      input.partSizeBytes ?? null,
    )) as unknown as number;
    if (count === 0) {
      return { ok: false, reason: "invalid_part_index" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "service_unavailable" };
  }
}

// =============================================================================
// completeStorageMultipart
// =============================================================================

export type CompleteStorageMultipartInput = {
  teamId: string;
  sessionId: string;
  /** If true, after CompleteMultipartUpload + HEAD the server will
   *  stream the final object through SHA-256 and compare to
   *  `expected_sha256`. Hash mismatch refuses the storage-complete
   *  AND flips the session to FAILED. */
  verifyHash: boolean;
};

export type CompleteStorageMultipartResult =
  | {
      ok: true;
      etag: string;
      contentLength: number;
      serverSha256: string | null;
    }
  | {
      ok: false;
      reason: StorageMultipartLifecycleDenialCode;
      missingEtags?: ReadonlyArray<number>;
    };

/**
 * Drive S3 CompleteMultipartUpload + HEAD + optional server-hash.
 *
 * Refuses to call S3 if any part is missing an ETag — that protects
 * against the brief's "missing parts cannot complete" rule.
 * Persists the resulting object metadata. Does NOT flip the session
 * to COMPLETED — the caller invokes `completeUploadSession()` AFTER
 * marking each part VERIFIED. That keeps the existing finalize-gate
 * contract intact.
 */
export async function completeStorageMultipart(
  input: CompleteStorageMultipartInput,
  client: PrismaClient = defaultPrisma,
): Promise<CompleteStorageMultipartResult> {
  const session = await loadSessionWithMultipart(
    client,
    input.teamId,
    input.sessionId,
  );
  if (!session) {
    return { ok: false, reason: "session_not_found" };
  }
  if (!session.multipart_upload_id || !session.storage_bucket || !session.storage_key) {
    return { ok: false, reason: "multipart_not_initiated" };
  }
  if (
    session.state === "COMPLETED" ||
    session.state === "ABORTED" ||
    session.state === "EXPIRED" ||
    session.state === "FAILED"
  ) {
    return { ok: false, reason: "session_already_terminal" };
  }
  // Pull every part — must all have an ETag.
  const parts = (await client.$queryRawUnsafe(
    `SELECT "part_index", "part_etag"
       FROM "evidence_upload_session_parts"
       WHERE "session_id" = $1 AND "team_id" = $2
       ORDER BY "part_index" ASC`,
    input.sessionId,
    input.teamId,
  )) as Array<{ part_index: number; part_etag: string | null }>;
  if (parts.length === 0) {
    return { ok: false, reason: "invalid_part_count" };
  }
  if (parts.length !== session.expected_part_count) {
    return {
      ok: false,
      reason: "completion_blocked_pending_parts",
    };
  }
  const missing = parts
    .filter((p) => !p.part_etag || !p.part_etag.trim())
    .map((p) => p.part_index);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "missing_part_etag",
      missingEtags: missing,
    };
  }
  const result = await completeMultipartUpload({
    bucket: session.storage_bucket,
    key: session.storage_key,
    multipartUploadId: session.multipart_upload_id,
    parts: parts.map((p) => ({
      partNumber: p.part_index + 1,
      etag: p.part_etag!,
    })),
  });
  if (!result.ok) {
    bump("multipart_complete_failed_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "multipart_complete_failed",
      severity: "WARNING",
      details: { sessionId: input.sessionId, reason: result.reason },
    });
    return { ok: false, reason: result.reason };
  }
  // HEAD the final object to confirm it exists + capture size.
  const head = await headCompletedObject({
    bucket: session.storage_bucket,
    key: session.storage_key,
  });
  if (!head.ok) {
    bump("multipart_head_failed_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "multipart_head_failed",
      severity: "WARNING",
      details: { sessionId: input.sessionId },
    });
    return { ok: false, reason: head.reason };
  }
  // Optional custody-grade hash check. We do this BEFORE persisting
  // completion so a hash mismatch surfaces immediately and the
  // session can be flipped FAILED.
  let serverSha256: string | null = null;
  if (input.verifyHash) {
    const verify = await verifyCompletedObject({
      bucket: session.storage_bucket,
      key: session.storage_key,
      expectedSha256: session.expected_sha256,
    });
    if (!verify.ok) {
      bump("multipart_verify_failed_total");
      if (verify.reason === "hash_mismatch") {
        safeEmitSecurityEvent({
          teamId: input.teamId,
          eventType: "multipart_hash_mismatch",
          severity: "WARNING",
          details: { sessionId: input.sessionId },
        });
        await client
          .$executeRawUnsafe(
            `UPDATE "evidence_upload_sessions"
               SET "state" = 'FAILED',
                   "updated_at_utc" = NOW()
               WHERE "id" = $1 AND "team_id" = $2`,
            input.sessionId,
            input.teamId,
          )
          .catch(() => null);
      }
      return { ok: false, reason: verify.reason };
    }
    serverSha256 = verify.serverSha256;
  }
  // Persist storage metadata. We do NOT flip session.state here;
  // the caller marks each part VERIFIED + invokes
  // completeUploadSession() which has its own atomic gate.
  await client.$executeRawUnsafe(
    `UPDATE "evidence_upload_sessions"
       SET "completed_object_etag" = $3,
           "completed_object_size" = $4,
           "completed_at_storage_utc" = NOW(),
           "updated_at_utc" = NOW()
       WHERE "id" = $1 AND "team_id" = $2`,
    input.sessionId,
    input.teamId,
    result.etag,
    head.contentLength,
  );

  // Phase 30.12 — when the caller asked for hash verification AND
  // we computed a whole-object SHA-256, mark every part VERIFIED
  // with that hash. The custody guarantee here is: the whole-object
  // SHA-256 matches the expected hash, therefore each chunk's
  // bytes (which combine into that object) are by definition
  // correct. The per-part VERIFIED transition is what
  // completeUploadSession's gate requires.
  if (input.verifyHash && serverSha256) {
    try {
      await client.$executeRawUnsafe(
        `UPDATE "evidence_upload_session_parts"
           SET "state" = 'VERIFIED',
               "server_sha256" = COALESCE("server_sha256", $3),
               "verified_at_utc" = COALESCE("verified_at_utc", NOW()),
               "failure_reason" = NULL,
               "updated_at_utc" = NOW()
           WHERE "session_id" = $1 AND "team_id" = $2
             AND "state" <> 'VERIFIED'`,
        input.sessionId,
        input.teamId,
        serverSha256,
      );
    } catch {
      /* part-level updates are best-effort here; the session row
       * already records completion. If parts don't flip, the
       * subsequent completeUploadSession() call will refuse, which
       * is the correct fail-closed posture. */
    }
  }

  // Phase 30.12 — upload-session → EvidencePart bridge.
  //
  // When the session was created with bridge metadata
  // (target_part_index + original_file_name set) AND a bridge row
  // has not yet been created, create the EvidencePart row that
  // points at this session's final S3 object. That way the legacy
  // consumers (completeEvidence's HEAD+SHA loop, report-v2,
  // verification package, public verify payload, search indexing)
  // automatically see the multipart material via the existing
  // EvidencePart contract — with ZERO regression to those
  // legally-sensitive surfaces.
  //
  // Idempotent: a repeat call observes bridged_evidence_part_id
  // already set and skips the create.
  //
  // Hard rules:
  //   - uploadedAtUtc on the bridged row stays NULL until the main
  //     completeEvidence transaction sets it atomically with the
  //     legacy parts (single server-clock `now` for every part on
  //     this Evidence row).
  //   - sha256 is the server-computed whole-object hash from
  //     verifyCompletedObject. NEVER ETag.
  //   - The row carries this session's final storage_bucket /
  //     storage_key — same object S3 holds.
  if (
    input.verifyHash &&
    serverSha256 &&
    session.target_part_index != null &&
    session.original_file_name &&
    !session.bridged_evidence_part_id
  ) {
    try {
      const partRow = await client.evidencePart.create({
        data: {
          evidenceId: session.evidence_id,
          partIndex: session.target_part_index,
          storageBucket: session.storage_bucket,
          storageKey: session.storage_key,
          originalFileName: session.original_file_name,
          sizeBytes: BigInt(head.contentLength),
          mimeType: session.expected_mime_type,
          sha256: serverSha256,
          // uploadedAtUtc: intentionally NULL — completeEvidence's
          // transaction sets this atomically alongside the legacy
          // parts. Custody invariant: no part is marked uploaded
          // until finalize.
        },
        select: { id: true },
      });
      await client.$executeRawUnsafe(
        `UPDATE "evidence_upload_sessions"
           SET "bridged_evidence_part_id" = $3,
               "updated_at_utc" = NOW()
           WHERE "id" = $1 AND "team_id" = $2
             AND "bridged_evidence_part_id" IS NULL`,
        input.sessionId,
        input.teamId,
        partRow.id,
      );
    } catch {
      /* Bridge creation is best-effort. Failure here doesn't break
       * the multipart-complete return — the storage side IS
       * complete. The capture page sees success; on next finalize
       * attempt the bridge can be re-attempted by re-calling
       * completeStorageMultipart. */
    }
  }

  bump("multipart_completed_total");
  return {
    ok: true,
    etag: result.etag,
    contentLength: head.contentLength,
    serverSha256,
  };
}

// =============================================================================
// abortStorageMultipart
// =============================================================================

export type AbortStorageMultipartInput = {
  teamId: string;
  sessionId: string;
  actorUserId: string;
  reason: string;
};

export type AbortStorageMultipartResult =
  | {
      ok: true;
      alreadyAbsent: boolean;
    }
  | {
      ok: false;
      reason: StorageMultipartLifecycleDenialCode;
    };

/**
 * Cancel a multipart upload at the storage layer and mark the session ABORTED.
 * Idempotent: a session that is already ABORTED just calls S3 abort once more
 * (S3 NoSuchUpload → success) and returns the existing terminal state.
 *
 * PHASE 13 §4 (2026-08-17) — IT NOW EMITS THE CANCEL AUDIT EVENT WHEN IT IS THE
 * LEG THAT CLOSES THE SESSION.
 *
 * The two cancel legs ran in a fixed order — `multipart/abort` first, then
 * `sessions/:id/abort` — and only the second one emitted
 * `upload_session_aborted`. But the first one had already written
 * `state = 'ABORTED'`, and the second leg's guarded UPDATE excludes ABORTED, so
 * it matched no row, returned `session_already_terminal`, and never reached its
 * audit emission or its metric. The consequence in an evidence-custody product
 * was that "who cancelled this upload, and when" could not be answered from the
 * audit log for ANY multipart cancel, and `upload_session_aborted_total`
 * under-counted every one of them.
 *
 * The emission is bound to the CLAIM rather than to the leg: the transition to
 * ABORTED is a guarded UPDATE that excludes ABORTED and returns its affected
 * row, so whichever leg wins performs the write and emits, the loser writes and
 * emits nothing, and a repeated cancel produces no second event. Exactly one
 * audit row and one metric increment per cancel, on every path.
 */
export async function abortStorageMultipart(
  input: AbortStorageMultipartInput,
  client: PrismaClient = defaultPrisma,
): Promise<AbortStorageMultipartResult> {
  const session = await loadSessionWithMultipart(
    client,
    input.teamId,
    input.sessionId,
  );
  if (!session) {
    return { ok: false, reason: "session_not_found" };
  }
  if (session.state === "COMPLETED") {
    return { ok: false, reason: "session_already_completed" };
  }
  // Server-side credentials only — never trust client-provided
  // bucket/key/uploadId. The session row is the source of truth.
  let alreadyAbsent = false;
  if (session.multipart_upload_id && session.storage_bucket && session.storage_key) {
    const result = await abortMultipartUpload({
      bucket: session.storage_bucket,
      key: session.storage_key,
      multipartUploadId: session.multipart_upload_id,
    });
    if (!result.ok) {
      bump("multipart_abort_failed_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "multipart_abort_failed",
        severity: "WARNING",
        details: { sessionId: input.sessionId, reason: result.reason },
      });
      return { ok: false, reason: result.reason };
    }
    alreadyAbsent = result.alreadyAbsent;
  }
  // THE CLAIM. `state NOT IN ('COMPLETED','EXPIRED','ABORTED')` is what makes
  // this a claim rather than an overwrite: exactly one caller can move the
  // session into ABORTED, and only that caller emits below.
  const claimed = (await client.$queryRawUnsafe(
    `UPDATE "evidence_upload_sessions"
       SET "state" = 'ABORTED',
           "aborted_at_utc" = COALESCE("aborted_at_utc", NOW()),
           "aborted_by_user_id" = COALESCE("aborted_by_user_id", $3),
           "abort_reason" = COALESCE("abort_reason", $4),
           "aborted_at_storage_utc" = NOW(),
           "updated_at_utc" = NOW()
       WHERE "id" = $1 AND "team_id" = $2
         AND "state" NOT IN ('COMPLETED', 'EXPIRED', 'ABORTED')
       RETURNING "id"`,
    input.sessionId,
    input.teamId,
    input.actorUserId,
    input.reason.slice(0, 120),
  )) as Array<{ id: string }>;

  if (claimed.length > 0) {
    bump("upload_session_aborted_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "upload_session_aborted",
      severity: "INFO",
      details: {
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        reason: input.reason.slice(0, 120),
      },
    });
  } else {
    // Already ABORTED by the other leg or an earlier attempt. No second audit
    // row — but the storage settlement stamp must still land, or the reaper
    // will keep re-selecting a multipart that is already gone.
    await client.$executeRawUnsafe(
      `UPDATE "evidence_upload_sessions"
         SET "aborted_at_storage_utc" = COALESCE("aborted_at_storage_utc", NOW()),
             "updated_at_utc" = NOW()
         WHERE "id" = $1 AND "team_id" = $2 AND "state" = 'ABORTED'`,
      input.sessionId,
      input.teamId,
    );
  }
  bump("multipart_aborted_total");
  return { ok: true, alreadyAbsent };
}

// =============================================================================
// reapStaleMultipartUploads
// =============================================================================

export type ReapStaleMultipartResult = {
  scanned: number;
  aborted: number;
  failed: number;
};

/**
 * Sweep sessions that hold a live S3 multipart upload which was never settled —
 * neither storage-completed nor storage-aborted. For each, call S3
 * AbortMultipartUpload and stamp the settlement. Tolerant of S3 NoSuchUpload
 * (already gone) — that is the idempotent success case.
 *
 * PHASE 13 §4 (2026-08-17) — TWO CORRECTIONS, both about which rows it can see
 * and what it is allowed to do to them.
 *
 *   1. It selected only sessions past `expires_at_utc`. A session ABORTED with a
 *      live multipart is not expired and never becomes so — the abort is
 *      terminal — so an orphaned upload created by a cancel that missed the
 *      storage leg was invisible to the only thing that could collect it, and
 *      stayed billed indefinitely. The predicate now also admits ABORTED rows
 *      whose storage settlement is missing, which is precisely that case.
 *
 *   2. It wrote `state = 'EXPIRED'` unconditionally. Applied to the rows just
 *      admitted that would REWRITE a deliberate operator cancel as an expiry,
 *      destroying `aborted_by_user_id` and `abort_reason` as the account of what
 *      happened. The state is now advanced only for a row that has not already
 *      reached a terminal state; a terminal row keeps its own, and only the
 *      storage settlement stamp is written.
 */
export async function reapStaleMultipartUploads(
  client: PrismaClient = defaultPrisma,
): Promise<ReapStaleMultipartResult> {
  let scanned = 0;
  let aborted = 0;
  let failed = 0;
  let rows: Array<{
    id: string;
    team_id: string;
    storage_bucket: string;
    storage_key: string;
    multipart_upload_id: string;
  }>;
  try {
    rows = (await client.$queryRawUnsafe(
      `SELECT "id", "team_id", "storage_bucket", "storage_key", "multipart_upload_id"
         FROM "evidence_upload_sessions"
         WHERE "multipart_upload_id" IS NOT NULL
           AND "completed_at_storage_utc" IS NULL
           AND "aborted_at_storage_utc" IS NULL
           AND ("expires_at_utc" < NOW() OR "state" = 'ABORTED')
         LIMIT 100`,
    )) as Array<{
      id: string;
      team_id: string;
      storage_bucket: string;
      storage_key: string;
      multipart_upload_id: string;
    }>;
  } catch {
    return { scanned: 0, aborted: 0, failed: 0 };
  }
  scanned = rows.length;
  for (const row of rows) {
    const result = await abortMultipartUpload({
      bucket: row.storage_bucket,
      key: row.storage_key,
      multipartUploadId: row.multipart_upload_id,
    });
    if (!result.ok) {
      failed += 1;
      bump("multipart_abort_failed_total");
      continue;
    }
    try {
      await client.$executeRawUnsafe(
        `UPDATE "evidence_upload_sessions"
           SET "state" = CASE
                 WHEN "state" IN ('ABORTED', 'COMPLETED', 'EXPIRED') THEN "state"
                 ELSE 'EXPIRED'
               END,
               "aborted_at_storage_utc" = NOW(),
               "updated_at_utc" = NOW()
           WHERE "id" = $1 AND "team_id" = $2`,
        row.id,
        row.team_id,
      );
      aborted += 1;
      bump("multipart_stale_cleanup_total");
    } catch {
      failed += 1;
    }
  }
  return { scanned, aborted, failed };
}

// Silence unused-import lint when callers don't reference
// StorageMultipartDenialCode directly.
export type { StorageMultipartDenialCode };
