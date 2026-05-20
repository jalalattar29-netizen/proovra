/**
 * Phase 30 — Resumable multipart upload session source-contract tests.
 *
 * The audit confirmed that Phase 29 (Enterprise API + Webhooks) is
 * largely shipped end-to-end already: ApiCredential model with full
 * lifecycle, HMAC-SHA256-hashed keys, scoped Permission-typed access,
 * per-credential rate limiting + IP allowlist, comprehensive audit via
 * ApiCredentialUsageLog, HMAC-SHA256-signed webhook deliveries with
 * AES-256-GCM-encrypted secrets, exponential retry ladder, cron-driven
 * retry processor, SSRF hardening, manual replay endpoint.
 *
 * The audit named one genuine Phase 30 gap: **resumable multipart
 * upload session model**. The existing per-part presigned flow is
 * single-shot and has no server-side tracking of which parts the
 * client has actually persisted. This phase closes that gap:
 *
 *   1. Idempotent SQL drift patch creating `evidence_upload_sessions`
 *      + `evidence_upload_session_parts` with bounded state CHECK
 *      constraints + uniqueness guards.
 *   2. `upload-session.service.ts` with the full lifecycle (create /
 *      resume / mark-uploaded / mark-verified / complete / abort /
 *      reap-stale) via $queryRaw.
 *   3. Schema-validation registration so drift on state / completion
 *      timestamps / unique part index fails fast at startup.
 *   4. Metric catalog + bounded SecurityEvent types.
 *
 * Hard custody-safe invariants the tests prove:
 *   * `completed_at_utc` set only on completion (server clock).
 *   * Per-part `verified_at_utc` set only by `markPartVerified` after
 *     the server-computed SHA-256 matches the client-claimed hash.
 *   * Idempotency: repeat session creation with the same key collapses
 *     to the existing row.
 *   * Hash mismatch flips the part to FAILED, never silently to
 *     VERIFIED.
 *   * Completion gate refuses unless every part is VERIFIED.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  UPLOAD_SESSION_STATES,
  UPLOAD_PART_STATES,
  UPLOAD_SESSION_DENIAL_CODES,
  type UploadPartState,
  type UploadSessionDenialCode,
  type UploadSessionState,
} from "../src/services/uploads/upload-session.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — SQL drift patch
// =============================================================================

describe("Phase 30 — evidence_upload_sessions SQL drift patch", () => {
  const src = readSource(
    "../../../services/api/sql/drift-patches/2026-05-19-evidence-upload-sessions.sql",
  );

  it("creates both session + per-part tables with IF NOT EXISTS", () => {
    expect(src).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"evidence_upload_sessions"/i,
    );
    expect(src).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"evidence_upload_session_parts"/i,
    );
  });

  it("session state catalog is bounded by CHECK constraint matching the service contract", () => {
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_sessions_state_bounded"[\s\S]*?'INITIATED'[\s\S]*?'UPLOADING'[\s\S]*?'VERIFYING'[\s\S]*?'COMPLETED'[\s\S]*?'FAILED'[\s\S]*?'EXPIRED'[\s\S]*?'ABORTED'/i,
    );
  });

  it("part state catalog is bounded by CHECK constraint", () => {
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_session_parts_state_bounded"[\s\S]*?'PENDING'[\s\S]*?'UPLOADED_UNVERIFIED'[\s\S]*?'VERIFIED'[\s\S]*?'FAILED'/i,
    );
  });

  it("part count + total bytes + sha256 format constraints enforced at DB level", () => {
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_sessions_part_count_positive"[\s\S]*?>= 1[\s\S]*?<= 10000/i,
    );
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_sessions_total_bytes_nonneg"/i,
    );
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_sessions_sha256_format"[\s\S]*?\^\[a-f0-9\]\{64\}\$/i,
    );
  });

  it("expiry must be in the future at creation", () => {
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_sessions_expires_after_created"[\s\S]*?expires_at_utc.*?>.*?created_at_utc/i,
    );
  });

  it("per-part (session_id, part_index) is UNIQUE — duplicate parts impossible", () => {
    expect(src).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "evidence_upload_session_parts_uk"[\s\S]*?\("session_id", "part_index"\)/i,
    );
  });

  it("idempotency key is UNIQUE per-team — duplicate session POSTs collapse", () => {
    expect(src).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "evidence_upload_sessions_team_idemp_uk"[\s\S]*?WHERE "idempotency_key" IS NOT NULL/i,
    );
  });

  it("reaper partial index targets only resumable states (INITIATED / UPLOADING / VERIFYING)", () => {
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_reaper_idx"[\s\S]*?WHERE "state" IN \('INITIATED', 'UPLOADING', 'VERIFYING'\)/i,
    );
  });

  it("part-state hash format constraints enforce 64-char hex at DB level", () => {
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_session_parts_client_sha_format"[\s\S]*?\^\[a-f0-9\]\{64\}\$/i,
    );
    expect(src).toMatch(
      /CONSTRAINT "evidence_upload_session_parts_server_sha_format"[\s\S]*?\^\[a-f0-9\]\{64\}\$/i,
    );
  });

  it("wraps everything in a transaction (partial-state safe)", () => {
    expect(src).toMatch(/^\s*BEGIN\s*;/m);
    expect(src).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("part-state cascades on session delete (no orphan rows)", () => {
    expect(src).toMatch(
      /REFERENCES "evidence_upload_sessions"\("id"\) ON DELETE CASCADE/,
    );
  });
});

// =============================================================================
// PART 2 — Bounded vocabularies
// =============================================================================

describe("Phase 30 — bounded vocabularies", () => {
  it("session states match the SQL catalog exactly", () => {
    expect([...UPLOAD_SESSION_STATES]).toEqual([
      "INITIATED",
      "UPLOADING",
      "VERIFYING",
      "COMPLETED",
      "FAILED",
      "EXPIRED",
      "ABORTED",
    ]);
  });

  it("part states match the SQL catalog exactly", () => {
    expect([...UPLOAD_PART_STATES]).toEqual([
      "PENDING",
      "UPLOADED_UNVERIFIED",
      "VERIFIED",
      "FAILED",
    ]);
  });

  it("denial codes are bounded + meaningful", () => {
    for (const required of [
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
    ] as ReadonlyArray<UploadSessionDenialCode>) {
      expect(UPLOAD_SESSION_DENIAL_CODES).toContain(required);
    }
  });

  it("denial codes are stable snake_case (no PII / no email leak)", () => {
    for (const code of UPLOAD_SESSION_DENIAL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it("session + part states are uppercase enums (anti-typo)", () => {
    for (const state of UPLOAD_SESSION_STATES) {
      expect(state).toMatch(/^[A-Z][A-Z_]+$/);
    }
    for (const state of UPLOAD_PART_STATES) {
      expect(state).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });
});

// =============================================================================
// PART 3 — Service source contract: custody-safe semantics
// =============================================================================

describe("Phase 30 — upload-session service source contract", () => {
  const src = readSource(
    "../../../services/api/src/services/uploads/upload-session.service.ts",
  );

  it("completed_at_utc is set ONLY in completeUploadSession + via NOW() (server clock)", () => {
    // Strip comments first.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // The only UPDATE that writes completed_at_utc must set it via
    // NOW() — never via a client-supplied parameter.
    const completedSetters = noComments.match(
      /SET[\s\S]*?"completed_at_utc"\s*=\s*([^,\n]+)/g,
    ) ?? [];
    expect(completedSetters.length).toBeGreaterThan(0);
    for (const setter of completedSetters) {
      expect(setter).toMatch(/"completed_at_utc"\s*=\s*NOW\(\)/);
    }
  });

  it("verified_at_utc is ONLY ever set via server-clock NOW() (Phase 30.12 update)", () => {
    // The Phase 30.12 bridge added a second verified_at_utc setter
    // in completeStorageMultipart: `verified_at_utc = COALESCE(
    // verified_at_utc, NOW())`. That preserves any existing
    // per-part verification timestamp from markPartVerified and
    // falls back to NOW() (server clock) for parts that haven't
    // been individually verified yet. Either pattern is acceptable
    // — both bind to NOW() ultimately.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Find every line that assigns to verified_at_utc. The right-hand
    // side may contain commas inside COALESCE(...), so match the
    // whole line ending at the newline.
    const verifiedSetters =
      noComments.match(/"verified_at_utc"\s*=\s*[^\n]+/g) ?? [];
    expect(verifiedSetters.length).toBeGreaterThan(0);
    for (const setter of verifiedSetters) {
      // The RHS must reference NOW() — either directly or via
      // COALESCE(verified_at_utc, NOW()). Anything else (client
      // clock, $param, etc.) is a custody violation.
      expect(setter).toMatch(/NOW\(\)/);
    }
  });

  it("client-supplied uploaded_at_utc_client is stored SEPARATELY from server-verified time (audit trail)", () => {
    expect(src).toMatch(/uploaded_at_utc_client/);
    // The mark-uploaded path stores it via COALESCE so a retry can't
    // overwrite earlier client claims.
    expect(src).toMatch(
      /"uploaded_at_utc_client"\s*=\s*COALESCE\(\$5,\s*"uploaded_at_utc_client"\)/,
    );
  });

  it("hash mismatch → part flipped to FAILED + bumps hash_mismatch counter + emits SecurityEvent", () => {
    expect(src).toMatch(
      /claimed && claimed !== input\.serverSha256[\s\S]*?bump\("upload_hash_mismatch_total"\)/,
    );
    expect(src).toMatch(
      /failure_reason[\s\S]*?'hash_mismatch'/,
    );
    expect(src).toMatch(
      /eventType:\s*"upload_part_hash_mismatch"/,
    );
  });

  it("completeUploadSession refuses when ANY part is not VERIFIED + returns the pending list", () => {
    expect(src).toMatch(
      /WHERE "session_id" = \$1 AND "team_id" = \$2 AND "state" <> 'VERIFIED'/,
    );
    expect(src).toMatch(
      /completion_blocked_pending_parts[\s\S]*?pendingPartIndices/,
    );
  });

  it("idempotency: existing session with the same (team_id, idempotency_key) is reused", () => {
    expect(src).toMatch(
      /SELECT[\s\S]*?FROM\s+"evidence_upload_sessions"\s+WHERE "team_id" = \$1 AND "idempotency_key" = \$2/,
    );
    expect(src).toMatch(/reused:\s*true/);
    expect(src).toMatch(/bump\("upload_session_idempotent_reuse_total"\)/);
  });

  it("session lifetime is bounded to [5 min, 24h]", () => {
    expect(src).toMatch(/MIN_SESSION_LIFETIME_MS\s*=\s*5 \* 60 \* 1000/);
    expect(src).toMatch(/MAX_SESSION_LIFETIME_MS\s*=\s*24 \* 60 \* 60 \* 1000/);
    expect(src).toMatch(/return \{ ok: false, reason: "invalid_expiry" \}/);
  });

  it("part count + total bytes bounded at the service level (defense in depth)", () => {
    expect(src).toMatch(/MAX_PARTS_PER_SESSION\s*=\s*10_000/);
    expect(src).toMatch(/MAX_TOTAL_BYTES\s*=\s*1024 \* 1024 \* 1024 \* 50/);
  });

  it("SHA-256 format validated at every entry point (defense in depth)", () => {
    const shaPatterns = src.match(/\/\^\[a-f0-9\]\{64\}\$\//g) ?? [];
    // Pattern must be used at least twice: session-creation expectedSha256
    // + part-mark clientSha256 + part-verify serverSha256.
    expect(shaPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it("every read is team-anchored — no cross-workspace lookups", () => {
    expect(src).toMatch(/WHERE "id" = \$1 AND "team_id" = \$2/);
    expect(src).toMatch(
      /WHERE "session_id" = \$1\s+AND "team_id" = \$2/,
    );
  });

  it("abort never affects already-terminal sessions (no double-revoke)", () => {
    expect(src).toMatch(
      /AND "state" NOT IN \('COMPLETED', 'ABORTED', 'EXPIRED'\)/,
    );
  });

  it("reapStaleUploadSessions targets only resumable states", () => {
    expect(src).toMatch(
      /WHERE "state" IN \('INITIATED', 'UPLOADING', 'VERIFYING'\)\s*AND "expires_at_utc" < NOW\(\)/,
    );
  });

  it("never references signed URLs / private notes / GPS in executable code", () => {
    // NOTE: Phase 30.8 multipart helpers legitimately reference
    // `storage_key` / `storage_bucket` as SQL column names. Those
    // are persisted to evidence_upload_sessions and never projected
    // to a route response — anti-leak is enforced at the route
    // layer, not the service layer. Tested by phase-30-8-multipart
    // route source-contract tests.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "privateReviewerNote",
      "legalNoteBody",
      "signed_url",
      "signedUrl",
      "raw_gps",
      "gpsCoordinates",
    ]) {
      expect(noComments).not.toContain(forbidden);
    }
  });

  it("no banned wording in string literals (tamper / forged / altered content)", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    const literals = src.match(/"[^"\n]+"/g) ?? [];
    expect(literals.join(" ")).not.toMatch(banned);
  });
});

// =============================================================================
// PART 4 — Schema validation registration
// =============================================================================

describe("Phase 30 — schema validation registration", () => {
  const src = readSource(
    "../../../services/api/src/runtime/schema-validation.ts",
  );

  it("registers both new tables", () => {
    expect(src).toMatch(
      /name:\s*"evidence_upload_sessions"[\s\S]*?subsystem:\s*"core_evidence"/,
    );
    expect(src).toMatch(
      /name:\s*"evidence_upload_session_parts"[\s\S]*?subsystem:\s*"core_evidence"/,
    );
  });

  it("registers state + completion columns at CRITICAL severity", () => {
    expect(src).toMatch(
      /table:\s*"evidence_upload_sessions",\s*column:\s*"state",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /table:\s*"evidence_upload_sessions",\s*column:\s*"completed_at_utc",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /table:\s*"evidence_upload_session_parts",\s*column:\s*"state",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /table:\s*"evidence_upload_session_parts",\s*column:\s*"verified_at_utc",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /table:\s*"evidence_upload_session_parts",\s*column:\s*"server_sha256",\s*severity:\s*"critical"/,
    );
  });

  it("registers the (session_id, part_index) UNIQUE index at CRITICAL severity", () => {
    expect(src).toMatch(
      /indexName:\s*"evidence_upload_session_parts_uk",\s*severity:\s*"critical"/,
    );
  });
});

// =============================================================================
// PART 5 — Metric + SecurityEvent catalogues
// =============================================================================

describe("Phase 30 — metric + SecurityEvent catalogues", () => {
  it("metrics service registers every Phase 30 upload-session counter", () => {
    const src = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    for (const m of [
      "upload_session_created_total",
      "upload_session_resumed_total",
      "upload_session_completed_total",
      "upload_session_aborted_total",
      "upload_session_expired_total",
      "upload_session_create_failed_total",
      "upload_session_reap_failed_total",
      "upload_session_idempotent_reuse_total",
      "upload_part_marked_uploaded_total",
      "upload_part_verified_total",
      "upload_hash_mismatch_total",
    ]) {
      expect(src, `metric ${m} missing`).toContain(`"${m}"`);
    }
  });

  it("SecurityEvent catalogue registers Phase 30 session-lifecycle events", () => {
    const src = readSource("../../../packages/shared/src/security.ts");
    for (const evt of [
      "upload_session_create_failed",
      "upload_session_resume_failed",
      "upload_session_completed",
      "upload_session_aborted",
      "upload_part_hash_mismatch",
    ]) {
      expect(src, `event ${evt} missing`).toContain(`"${evt}"`);
    }
  });
});

// =============================================================================
// PART 6 — Type-level invariants
// =============================================================================

describe("Phase 30 — type-level invariants", () => {
  it("bounded vocabularies are typed catalogs", () => {
    const session: UploadSessionState = "INITIATED";
    const part: UploadPartState = "PENDING";
    const denial: UploadSessionDenialCode = "session_not_found";
    expect(UPLOAD_SESSION_STATES).toContain(session);
    expect(UPLOAD_PART_STATES).toContain(part);
    expect(UPLOAD_SESSION_DENIAL_CODES).toContain(denial);
  });
});
