/**
 * Phase 30.11 — Unified evidence model bridge tests.
 *
 * Six layers of coverage:
 *
 *   1. **Bounded vocabulary** — the strengthened gate's denial
 *      catalog includes every code the brief listed, plus the new
 *      mixed-material codes.
 *
 *   2. **Strengthened finalize gate (behavioral)** — drives the
 *      `evaluateUploadSessionFinalizeGate` against a stubbed
 *      PrismaClient through every multi-session scenario the brief
 *      called out: one COMPLETED + one UPLOADING blocks;
 *      one COMPLETED + one ABORTED blocks; ALL COMPLETED with all
 *      parts VERIFIED allows. Verifies the result type carries
 *      `sessionIds` (the full list) when allowing.
 *
 *   3. **Unified manifest** — source-contract assertions plus a
 *      behavioral test on `projectForPublic()` that proves the
 *      `storageMetadata` is stripped from every session material.
 *
 *   4. **Custody-safety** — manifest source NEVER projects
 *      storage_key / multipart_upload_id / signedUrl / private notes
 *      / legal notes / raw GPS. ETag is in storageMetadata only and
 *      that field is stripped by projectForPublic.
 *
 *   5. **Metric catalog** — the 6 new counters from the brief are
 *      registered.
 *
 *   6. **Backward compat** — existing single-session gate callers
 *      still see `gate.sessionId` (string) + `gate.reason` shapes.
 *      No EvidencePart semantics changed.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  UPLOAD_SESSION_FINALIZE_GATE_CODES,
  evaluateUploadSessionFinalizeGate,
  type UploadSessionFinalizeGateCode,
} from "../src/services/uploads/upload-session.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PrismaClient stub — replays canned $queryRawUnsafe responses in order
// =============================================================================

type StubRow = Record<string, unknown>;
type StubResponse = StubRow[] | (() => StubRow[]) | Error;

function makeStubClient(responses: StubResponse[]) {
  let i = 0;
  return {
    $queryRawUnsafe: async () => {
      const r = responses[i++];
      if (r === undefined) {
        throw new Error(`stub_exhausted_after_${i}`);
      }
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r() : r;
    },
  } as unknown as Parameters<typeof evaluateUploadSessionFinalizeGate>[1];
}

const TEAM = "00000000-0000-0000-0000-000000000001";
const EVIDENCE = "00000000-0000-0000-0000-000000000002";
const SESSION_A = "11111111-1111-1111-1111-111111111111";
const SESSION_B = "22222222-2222-2222-2222-222222222222";

function row(
  id: string,
  state: string,
  createdSecondsAgo: number,
): StubRow {
  return {
    id,
    state,
    completed_at_utc: state === "COMPLETED" ? new Date() : null,
    aborted_at_utc: state === "ABORTED" ? new Date() : null,
    expires_at_utc: new Date(Date.now() + 60_000),
    created_at_utc: new Date(Date.now() - createdSecondsAgo * 1000),
  };
}

// =============================================================================
// PART 1 — Bounded denial vocabulary
// =============================================================================

describe("Phase 30.11 — strengthened gate denial vocabulary", () => {
  it("includes every code the brief listed (single-session + mixed)", () => {
    for (const required of [
      "session_not_completed",
      "session_pending_parts",
      "session_aborted",
      "session_expired",
      "session_failed",
      "session_hash_mismatch",
      "gate_unavailable",
      "mixed_material_incomplete",
      "no_verified_materials",
    ] as ReadonlyArray<UploadSessionFinalizeGateCode>) {
      expect(UPLOAD_SESSION_FINALIZE_GATE_CODES).toContain(required);
    }
  });

  it("every code is bounded snake_case (no PII / no free-text)", () => {
    for (const code of UPLOAD_SESSION_FINALIZE_GATE_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });
});

// =============================================================================
// PART 2 — Strengthened gate (behavioral)
// =============================================================================

describe("Phase 30.11 — ALL-sessions finalize gate", () => {
  it("no sessions → applies: false (legacy backward compat preserved)", async () => {
    const client = makeStubClient([[]]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.applies).toBe(false);
  });

  it("ONE COMPLETED + all parts VERIFIED → allow + sessionIds list", async () => {
    const client = makeStubClient([
      // Session list query
      [row(SESSION_A, "COMPLETED", 10)],
      // Per-part pending-check for SESSION_A → empty (all VERIFIED)
      [],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.applies) {
      expect(result.sessionId).toBe(SESSION_A);
      expect(result.sessionIds).toEqual([SESSION_A]);
    } else {
      throw new Error("expected applies:true single-session allow");
    }
  });

  it("TWO COMPLETED, all parts VERIFIED for both → allow + both sessionIds", async () => {
    const client = makeStubClient([
      [row(SESSION_A, "COMPLETED", 20), row(SESSION_B, "COMPLETED", 10)],
      [], // SESSION_A pending check → empty
      [], // SESSION_B pending check → empty
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.applies) {
      expect(result.sessionIds).toEqual([SESSION_A, SESSION_B]);
      // First session by created_at_utc ASC is returned as sessionId.
      expect(result.sessionId).toBe(SESSION_A);
    } else {
      throw new Error("expected applies:true multi-session allow");
    }
  });

  it("ONE COMPLETED + ONE UPLOADING → block session_not_completed (the UPLOADING one)", async () => {
    // Order matters: created_at_utc ASC. SESSION_A (older) UPLOADING
    // should be the first blocker.
    const client = makeStubClient([
      [row(SESSION_A, "UPLOADING", 30), row(SESSION_B, "COMPLETED", 10)],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_not_completed");
      expect(result.sessionId).toBe(SESSION_A);
      expect(result.sessionState).toBe("UPLOADING");
    }
  });

  it("ONE COMPLETED + ONE ABORTED → block session_aborted (the ABORTED one, older)", async () => {
    const client = makeStubClient([
      [row(SESSION_A, "ABORTED", 30), row(SESSION_B, "COMPLETED", 10)],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_aborted");
      expect(result.sessionId).toBe(SESSION_A);
    }
  });

  it("ONE COMPLETED + ONE EXPIRED → block session_expired", async () => {
    const client = makeStubClient([
      [row(SESSION_A, "EXPIRED", 30), row(SESSION_B, "COMPLETED", 10)],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_expired");
  });

  it("ONE COMPLETED + ONE FAILED (generic) → block session_failed", async () => {
    const client = makeStubClient([
      [row(SESSION_A, "FAILED", 30), row(SESSION_B, "COMPLETED", 10)],
      // hash-mismatch check for FAILED session → empty (no hash_mismatch part)
      [],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_failed");
      expect(result.sessionId).toBe(SESSION_A);
    }
  });

  it("FAILED session with a hash_mismatch part → block session_hash_mismatch (distinct integrity signal)", async () => {
    const client = makeStubClient([
      [row(SESSION_A, "FAILED", 30)],
      // hash-mismatch check for FAILED session → 1 row found
      [{ ok: 1 }],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_hash_mismatch");
      expect(result.sessionId).toBe(SESSION_A);
    }
  });

  it("COMPLETED but a non-VERIFIED part exists → block session_pending_parts (defense in depth)", async () => {
    const client = makeStubClient([
      [row(SESSION_A, "COMPLETED", 10)],
      // pending-check returns 1 row → block
      [{ ok: 1 }],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_pending_parts");
      expect(result.sessionId).toBe(SESSION_A);
    }
  });

  it("DB error on session lookup → fail-closed gate_unavailable", async () => {
    const client = makeStubClient([new Error("db_outage")]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gate_unavailable");
  });

  it("DB error on per-part pending check → fail-closed gate_unavailable", async () => {
    const client = makeStubClient([
      [row(SESSION_A, "COMPLETED", 10)],
      new Error("db_outage"),
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gate_unavailable");
  });

  it("THREE sessions: COMPLETED + COMPLETED + UPLOADING → block on the UPLOADING (deterministic)", async () => {
    const SESSION_C = "33333333-3333-3333-3333-333333333333";
    const client = makeStubClient([
      [
        row(SESSION_A, "COMPLETED", 50),
        row(SESSION_B, "UPLOADING", 30),
        row(SESSION_C, "COMPLETED", 10),
      ],
      // SESSION_A pending → empty
      [],
      // (SESSION_B is not COMPLETED so its parts aren't checked)
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_not_completed");
      expect(result.sessionId).toBe(SESSION_B);
    }
  });
});

// =============================================================================
// PARTS 3 & 4 — Unified material manifest — REMOVED (LEGACY-003)
// =============================================================================

/**
 * Phase 30.11 introduced `unified-material-manifest.ts` and this file asserted
 * its bounded kind/verification catalogs and proved that `projectForPublic()`
 * strips storage metadata (etag, bucket, key, multipart id) from the public
 * projection.
 *
 * LEGACY-003 (2026-08-15) REMOVED that module: zero production importers, zero
 * DB writes, zero queue or event ownership — only these tests read it. The
 * unified material model it described is served by the canonical
 * `packages/shared/src/canonical-evidence-materials.ts`.
 *
 * The stripping assertions are NOT re-homed onto the canonical module, and that
 * is deliberate rather than an omission: the canonical module has its own
 * vocabulary and its own projection, so re-pointing these expectations at it
 * would assert a contract it never agreed to and would read as coverage that
 * was never written. What remains is the invariant the removal creates.
 */
describe("Phase 30.11 — unified material manifest stays removed", () => {
  it("the manifest module is not back on disk", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../../../services/api/src/services/uploads/unified-material-manifest.ts",
            import.meta.url,
          ),
        ),
      ),
      "unified-material-manifest.ts is REMOVED (LEGACY-003) and must not return",
    ).toBe(false);
  });
});

// =============================================================================
// PART 5 — Metric catalog
// =============================================================================

describe("Phase 30.11 — observability counters", () => {
  const metricsSrc = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers the 6 new counters from the brief", () => {
    for (const m of [
      "mixed_material_finalize_allowed_total",
      "mixed_material_finalize_blocked_total",
      "capture_resumable_selected_total",
      "capture_resumable_completed_total",
      "capture_resumable_failed_total",
      "capture_resumable_recovered_total",
    ]) {
      expect(metricsSrc, `counter ${m} missing`).toContain(`"${m}"`);
    }
  });

  it("gate bumps both `upload_session_finalize_gate_*` AND `mixed_material_finalize_*` for symmetry", () => {
    const gateSrc = readSource(
      "../../../services/api/src/services/uploads/upload-session.service.ts",
    );
    // Allow path bumps both counters.
    expect(gateSrc).toMatch(
      /upload_session_finalize_gate_allowed_total[\s\S]*?mixed_material_finalize_allowed_total/,
    );
    // Block path bumps both counters.
    expect(gateSrc).toMatch(
      /upload_session_finalize_gate_denied_total[\s\S]*?mixed_material_finalize_blocked_total/,
    );
  });
});

// =============================================================================
// PART 6 — Backward compat with existing single-session callers
// =============================================================================

describe("Phase 30.11 — backward compat with completeEvidence", () => {
  const completeSrc = readSource(
    "../../../services/api/src/services/evidence-complete.service.ts",
  );

  it("evidence-complete.service.ts still reads gate.reason + gate.sessionId", () => {
    expect(completeSrc).toMatch(/gate\.reason/);
    expect(completeSrc).toMatch(/gate\.sessionId/);
  });

  it("the gate still throws UPLOAD_SESSION_GATE: error with bounded reason on block", () => {
    expect(completeSrc).toMatch(
      /new Error\(`UPLOAD_SESSION_GATE:\$\{gate\.reason\}`\)/,
    );
  });

  it("existing EvidencePart finalize logic is untouched (legacy invariant)", () => {
    // The finalize updateMany still gates on CREATED/UPLOADING → SIGNED.
    expect(completeSrc).toMatch(
      /status:\s*\{\s*in:\s*\[EvidenceStatus\.CREATED,\s*EvidenceStatus\.UPLOADING\]/,
    );
    // The custody event is still emitted inside the tx after finalize.
    expect(completeSrc).toMatch(
      /tx\.evidence\.updateMany[\s\S]*?appendCustodyEventTx\(tx,[\s\S]*?UPLOAD_COMPLETED/,
    );
  });
});
