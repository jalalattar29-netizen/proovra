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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UPLOAD_SESSION_FINALIZE_GATE_CODES, evaluateUploadSessionFinalizeGate, } from "../src/services/uploads/upload-session.service.js";
import { UNIFIED_MATERIAL_KINDS, UNIFIED_MATERIAL_VERIFICATION_STATES, projectForPublic, } from "../src/services/uploads/unified-material-manifest.js";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
function makeStubClient(responses) {
    let i = 0;
    return {
        $queryRawUnsafe: async (..._args) => {
            const r = responses[i++];
            if (r === undefined) {
                throw new Error(`stub_exhausted_after_${i}`);
            }
            if (r instanceof Error)
                throw r;
            return typeof r === "function" ? r() : r;
        },
    };
}
const TEAM = "00000000-0000-0000-0000-000000000001";
const EVIDENCE = "00000000-0000-0000-0000-000000000002";
const SESSION_A = "11111111-1111-1111-1111-111111111111";
const SESSION_B = "22222222-2222-2222-2222-222222222222";
function row(id, state, createdSecondsAgo) {
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
        ]) {
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
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(true);
        if (result.ok)
            expect(result.applies).toBe(false);
    });
    it("ONE COMPLETED + all parts VERIFIED → allow + sessionIds list", async () => {
        const client = makeStubClient([
            // Session list query
            [row(SESSION_A, "COMPLETED", 10)],
            // Per-part pending-check for SESSION_A → empty (all VERIFIED)
            [],
        ]);
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(true);
        if (result.ok && result.applies) {
            expect(result.sessionId).toBe(SESSION_A);
            expect(result.sessionIds).toEqual([SESSION_A]);
        }
        else {
            throw new Error("expected applies:true single-session allow");
        }
    });
    it("TWO COMPLETED, all parts VERIFIED for both → allow + both sessionIds", async () => {
        const client = makeStubClient([
            [row(SESSION_A, "COMPLETED", 20), row(SESSION_B, "COMPLETED", 10)],
            [], // SESSION_A pending check → empty
            [], // SESSION_B pending check → empty
        ]);
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(true);
        if (result.ok && result.applies) {
            expect(result.sessionIds).toEqual([SESSION_A, SESSION_B]);
            // First session by created_at_utc ASC is returned as sessionId.
            expect(result.sessionId).toBe(SESSION_A);
        }
        else {
            throw new Error("expected applies:true multi-session allow");
        }
    });
    it("ONE COMPLETED + ONE UPLOADING → block session_not_completed (the UPLOADING one)", async () => {
        // Order matters: created_at_utc ASC. SESSION_A (older) UPLOADING
        // should be the first blocker.
        const client = makeStubClient([
            [row(SESSION_A, "UPLOADING", 30), row(SESSION_B, "COMPLETED", 10)],
        ]);
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
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
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
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
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.reason).toBe("session_expired");
    });
    it("ONE COMPLETED + ONE FAILED (generic) → block session_failed", async () => {
        const client = makeStubClient([
            [row(SESSION_A, "FAILED", 30), row(SESSION_B, "COMPLETED", 10)],
            // hash-mismatch check for FAILED session → empty (no hash_mismatch part)
            [],
        ]);
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
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
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
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
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("session_pending_parts");
            expect(result.sessionId).toBe(SESSION_A);
        }
    });
    it("DB error on session lookup → fail-closed gate_unavailable", async () => {
        const client = makeStubClient([new Error("db_outage")]);
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.reason).toBe("gate_unavailable");
    });
    it("DB error on per-part pending check → fail-closed gate_unavailable", async () => {
        const client = makeStubClient([
            [row(SESSION_A, "COMPLETED", 10)],
            new Error("db_outage"),
        ]);
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.reason).toBe("gate_unavailable");
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
        const result = await evaluateUploadSessionFinalizeGate({ teamId: TEAM, evidenceId: EVIDENCE }, client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe("session_not_completed");
            expect(result.sessionId).toBe(SESSION_B);
        }
    });
});
// =============================================================================
// PART 3 — Unified material manifest source contract
// =============================================================================
describe("Phase 30.11 — unified material manifest", () => {
    const src = readSource("../../../services/api/src/services/uploads/unified-material-manifest.ts");
    const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    it("UNIFIED_MATERIAL_KINDS catalogues LEGACY_PART + UPLOAD_SESSION", () => {
        expect([...UNIFIED_MATERIAL_KINDS]).toEqual([
            "LEGACY_PART",
            "UPLOAD_SESSION",
        ]);
    });
    it("UNIFIED_MATERIAL_VERIFICATION_STATES is bounded UPPER_SNAKE_CASE", () => {
        for (const s of UNIFIED_MATERIAL_VERIFICATION_STATES) {
            expect(s).toMatch(/^[A-Z][A-Z_]+$/);
        }
        expect([...UNIFIED_MATERIAL_VERIFICATION_STATES]).toEqual([
            "PENDING",
            "VERIFIED",
            "FAILED",
            "MISSING",
        ]);
    });
    it("manifest NEVER projects storage_key / storage_bucket / multipart_upload_id / signed URLs", () => {
        for (const banned of [
            "storageBucket",
            "storage_bucket",
            "storageKey",
            "storage_key",
            "multipartUploadId",
            "multipart_upload_id",
            "signed_url",
            "signedUrl",
            "presignedUrl",
            "uploadUrl",
        ]) {
            expect(noComments, `manifest leaks ${banned}`).not.toContain(banned);
        }
    });
    it("manifest NEVER projects private notes / legal notes / raw GPS", () => {
        for (const banned of [
            "privateReviewerNote",
            "legalNoteBody",
            "raw_gps",
            "gpsCoordinates",
            "privateNote",
        ]) {
            expect(noComments, `manifest leaks ${banned}`).not.toContain(banned);
        }
    });
    it("manifest helper is read-only (no writes / no S3 calls)", () => {
        expect(noComments).not.toMatch(/\$executeRaw/);
        expect(noComments).not.toMatch(/\.create\(/);
        expect(noComments).not.toMatch(/\.update\(/);
        expect(noComments).not.toMatch(/\.delete\(/);
        expect(noComments).not.toMatch(/CreateMultipartUploadCommand/);
        expect(noComments).not.toMatch(/UploadPartCommand/);
    });
    it("ETag stored only inside session storageMetadata — never on legacy parts", () => {
        // Confirm there's exactly one mention of ETag in the source,
        // inside the UnifiedSessionMaterial shape's storageMetadata.
        const etagRefs = noComments.match(/etag/g) ?? [];
        // At least one occurrence in the UPLOAD_SESSION shape; legacy
        // shape has none.
        expect(etagRefs.length).toBeGreaterThan(0);
        expect(noComments).toMatch(/UnifiedSessionMaterial[\s\S]*?storageMetadata[\s\S]*?etag/);
        // The LEGACY_PART projection helper must not include any etag
        // assignment.
        const legacyFn = src.match(/async function loadLegacyMaterials\([\s\S]*?^\}/m)?.[0];
        expect(legacyFn).toBeTruthy();
        expect(legacyFn).not.toMatch(/etag/i);
    });
    it("ETag is never assigned to a sha256-named variable (custody-safety)", () => {
        expect(noComments).not.toMatch(/sha256\w*\s*[:=]\s*\w*etag/i);
        expect(noComments).not.toMatch(/serverSha256\s*[:=]\s*\w*etag/i);
    });
    it("session verification states map to bounded vocabulary", () => {
        const fn = src.match(/function sessionVerificationState\([\s\S]*?\n\}/)?.[0];
        expect(fn).toBeTruthy();
        // COMPLETED → VERIFIED is the load-bearing assertion.
        expect(fn).toMatch(/case "COMPLETED":[\s\S]*?return "VERIFIED"/);
        // Terminal failure states → FAILED.
        expect(fn).toMatch(/case "ABORTED":[\s\S]*?case "EXPIRED":[\s\S]*?case "FAILED":[\s\S]*?return "FAILED"/);
    });
});
// =============================================================================
// PART 4 — projectForPublic strips internal storage metadata
// =============================================================================
describe("Phase 30.11 — projectForPublic", () => {
    it("strips storageMetadata from session materials; legacy parts untouched", () => {
        const manifest = {
            evidenceId: EVIDENCE,
            teamId: TEAM,
            totals: {
                materials: 2,
                legacy: 1,
                sessions: 1,
                verified: 1,
                pending: 1,
                failed: 0,
                missing: 0,
            },
            materials: [
                {
                    kind: "LEGACY_PART",
                    materialId: "part-1",
                    partIndex: 0,
                    filename: "evidence.jpg",
                    mimeType: "image/jpeg",
                    sizeBytes: 1024,
                    sha256: "a".repeat(64),
                    uploadedAtUtc: "2026-05-19T12:00:00Z",
                    verification: "VERIFIED",
                },
                {
                    kind: "UPLOAD_SESSION",
                    materialId: "session-1",
                    safeNote: null,
                    filename: null,
                    mimeType: null,
                    sizeBytes: 500_000_000,
                    expectedSha256: "b".repeat(64),
                    serverSha256: null,
                    completedAtUtc: null,
                    verification: "PENDING",
                    storageMetadata: {
                        etag: "etag-secret",
                        contentLengthBytes: 500_000_000,
                        completedAtStorageUtc: null,
                    },
                },
            ],
        };
        const projected = projectForPublic(manifest);
        expect(projected.materials).toHaveLength(2);
        const legacy = projected.materials[0];
        const session = projected.materials[1];
        expect(legacy.kind).toBe("LEGACY_PART");
        expect(session.kind).toBe("UPLOAD_SESSION");
        if (session.kind === "UPLOAD_SESSION") {
            expect(session.storageMetadata).toBeNull();
        }
        // The legacy material's sha256 (public-safe custody hash) is
        // preserved.
        if (legacy.kind === "LEGACY_PART") {
            expect(legacy.sha256).toBe("a".repeat(64));
        }
        // Defensive: serialising the projection must not contain the
        // private etag string anywhere.
        expect(JSON.stringify(projected)).not.toContain("etag-secret");
    });
});
// =============================================================================
// PART 5 — Metric catalog
// =============================================================================
describe("Phase 30.11 — observability counters", () => {
    const metricsSrc = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");
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
        const gateSrc = readSource("../../../services/api/src/services/uploads/upload-session.service.ts");
        // Allow path bumps both counters.
        expect(gateSrc).toMatch(/upload_session_finalize_gate_allowed_total[\s\S]*?mixed_material_finalize_allowed_total/);
        // Block path bumps both counters.
        expect(gateSrc).toMatch(/upload_session_finalize_gate_denied_total[\s\S]*?mixed_material_finalize_blocked_total/);
    });
});
// =============================================================================
// PART 6 — Backward compat with existing single-session callers
// =============================================================================
describe("Phase 30.11 — backward compat with completeEvidence", () => {
    const completeSrc = readSource("../../../services/api/src/services/evidence-complete.service.ts");
    it("evidence-complete.service.ts still reads gate.reason + gate.sessionId", () => {
        expect(completeSrc).toMatch(/gate\.reason/);
        expect(completeSrc).toMatch(/gate\.sessionId/);
    });
    it("the gate still throws UPLOAD_SESSION_GATE: error with bounded reason on block", () => {
        expect(completeSrc).toMatch(/new Error\(`UPLOAD_SESSION_GATE:\$\{gate\.reason\}`\)/);
    });
    it("existing EvidencePart finalize logic is untouched (legacy invariant)", () => {
        // The finalize updateMany still gates on CREATED/UPLOADING → SIGNED.
        expect(completeSrc).toMatch(/status:\s*\{\s*in:\s*\[EvidenceStatus\.CREATED,\s*EvidenceStatus\.UPLOADING\]/);
        // The custody event is still emitted inside the tx after finalize.
        expect(completeSrc).toMatch(/tx\.evidence\.updateMany[\s\S]*?appendCustodyEventTx\(tx,[\s\S]*?UPLOAD_COMPLETED/);
    });
});
