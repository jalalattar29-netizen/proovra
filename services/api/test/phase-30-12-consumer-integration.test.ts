/**
 * Phase 30.12 — Consumer integration completion tests.
 *
 * Six layers of coverage:
 *
 *   1. **Schema bridge** — SQL drift patch adds the columns +
 *      runtime schema-validation registers them at the right
 *      severity.
 *
 *   2. **Service: bridge metadata** — `createUploadSession` accepts
 *      the new `targetPartIndex` / `originalFileName` /
 *      `expectedMimeType` fields and persists them.
 *
 *   3. **Service: VERIFIED transition + EvidencePart bridge** —
 *      `completeStorageMultipart` (source-contract) marks all parts
 *      VERIFIED with the whole-object server SHA-256 when
 *      `verifyHash: true`, and creates the bridging EvidencePart
 *      row with the right fields (idempotent).
 *
 *   4. **Routes: pass-through** — web + API-key session-create
 *      bodies accept the bridge fields and forward them.
 *
 *   5. **Capture-page fork** — source-contract proves: legacy XHR
 *      path is untouched; resumable fork only engages when
 *      flag + teamId + large file; no silent fallback after
 *      resumable starts; no custody event creation client-side;
 *      no uploadedAt mutation client-side.
 *
 *   6. **Review & Sign readiness** — every resumable blocker kind
 *      produces a precise label + detail; flag-off (empty
 *      blockers) is a no-op; canFinalize flips when blockers exist.
 *
 *   7. **Observability** — the 2 new counters from the brief are
 *      registered + actually emitted by the manifest resolver.
 *
 *   8. **Anti-leak** — every new code path is anti-leak audited.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildSessionReadiness,
  type ResumableReviewSignBlocker,
} from "../../../apps/web/app/(app)/capture/_lib/session-readiness.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Schema bridge
// =============================================================================

describe("Phase 30.12 — bridge SQL drift patch", () => {
  const sql = readSource(
    "../../../services/api/sql/drift-patches/2026-05-19-evidence-upload-session-bridge.sql",
  );

  it("uses BEGIN/COMMIT for partial-state safety", () => {
    expect(sql).toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("adds 4 bridge columns to evidence_upload_sessions (idempotent)", () => {
    for (const col of [
      "target_part_index",
      "original_file_name",
      "expected_mime_type",
      "bridged_evidence_part_id",
    ]) {
      expect(sql).toMatch(
        new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"${col}"`, "i"),
      );
    }
  });

  it("declares the partIndex non-negative constraint via DO block (idempotent)", () => {
    expect(sql).toMatch(
      /DO \$\$[\s\S]*?evidence_upload_sessions_target_part_index_nonneg[\s\S]*?CHECK[\s\S]*?>= 0/,
    );
  });

  it("creates the bridged-part lookup index", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_bridged_part_idx"/,
    );
  });

  it("schema-validation registers each new column at the right severity", () => {
    const src = readSource(
      "../../../services/api/src/runtime/schema-validation.ts",
    );
    expect(src).toMatch(
      /column:\s*"target_part_index",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /column:\s*"original_file_name",\s*severity:\s*"critical"/,
    );
    expect(src).toMatch(
      /column:\s*"expected_mime_type",\s*severity:\s*"important"/,
    );
    expect(src).toMatch(
      /column:\s*"bridged_evidence_part_id",\s*severity:\s*"critical"/,
    );
  });
});

// =============================================================================
// PART 2 — Service: createUploadSession accepts bridge fields
// =============================================================================

describe("Phase 30.12 — createUploadSession bridge fields", () => {
  const src = readSource(
    "../../../services/api/src/services/uploads/upload-session.service.ts",
  );

  it("CreateSessionInput type declares the 3 bridge fields as optional", () => {
    expect(src).toMatch(
      /targetPartIndex\?:\s*number\s*\|\s*null/,
    );
    expect(src).toMatch(
      /originalFileName\?:\s*string\s*\|\s*null/,
    );
    expect(src).toMatch(
      /expectedMimeType\?:\s*string\s*\|\s*null/,
    );
  });

  it("INSERT carries the 3 bridge columns + bounded lengths", () => {
    const inserts =
      src.match(
        /INSERT INTO "evidence_upload_sessions"\s*\([\s\S]*?\)/g,
      ) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    const first = inserts[0]!;
    expect(first).toMatch(/"target_part_index"/);
    expect(first).toMatch(/"original_file_name"/);
    expect(first).toMatch(/"expected_mime_type"/);
  });

  it("originalFileName is sliced to 255 chars (DB constraint defense)", () => {
    expect(src).toMatch(/input\.originalFileName\?\.slice\(0,\s*255\)/);
  });

  it("expectedMimeType is sliced to 128 chars (DB constraint defense)", () => {
    expect(src).toMatch(/input\.expectedMimeType\?\.slice\(0,\s*128\)/);
  });

  it("invalid targetPartIndex returns bounded denial (invalid_part_index)", () => {
    expect(src).toMatch(
      /input\.targetPartIndex != null[\s\S]*?reason:\s*"invalid_part_index"/,
    );
  });
});

// =============================================================================
// PART 3 — completeStorageMultipart: VERIFIED + bridge
// =============================================================================

describe("Phase 30.12 — completeStorageMultipart bridge", () => {
  const src = readSource(
    "../../../services/api/src/services/uploads/upload-session.service.ts",
  );

  it("marks ALL parts VERIFIED with whole-object server SHA-256 when verifyHash", () => {
    expect(src).toMatch(
      /if\s*\(input\.verifyHash\s*&&\s*serverSha256\)[\s\S]*?UPDATE\s+"evidence_upload_session_parts"[\s\S]*?SET\s+"state"\s*=\s*'VERIFIED'/,
    );
  });

  it("VERIFIED update uses COALESCE so existing per-part sha256 is preserved", () => {
    expect(src).toMatch(
      /SET\s+"state"\s*=\s*'VERIFIED'[\s\S]*?"server_sha256"\s*=\s*COALESCE\("server_sha256"/,
    );
  });

  it("VERIFIED update clears failure_reason (idempotent recovery)", () => {
    expect(src).toMatch(
      /SET\s+"state"\s*=\s*'VERIFIED'[\s\S]*?"failure_reason"\s*=\s*NULL/,
    );
  });

  it("creates bridging EvidencePart row only when bridge metadata is present", () => {
    // The guard: verifyHash + serverSha256 + targetPartIndex set +
    // originalFileName set + not yet bridged.
    expect(src).toMatch(
      /input\.verifyHash[\s\S]*?serverSha256[\s\S]*?target_part_index != null[\s\S]*?original_file_name[\s\S]*?!session\.bridged_evidence_part_id/,
    );
  });

  it("bridging EvidencePart row sets sha256 from server-computed hash (NEVER ETag)", () => {
    const bridgeBlock = src.match(
      /client\.evidencePart\.create\([\s\S]*?select:\s*\{\s*id:\s*true\s*\}/,
    )?.[0];
    expect(bridgeBlock).toBeTruthy();
    expect(bridgeBlock!).toMatch(/sha256:\s*serverSha256/);
    // Must NOT use ETag as the hash.
    expect(bridgeBlock!).not.toMatch(/sha256:\s*result\.etag/);
    expect(bridgeBlock!).not.toMatch(/sha256:\s*\w*[Ee][Tt]ag/);
  });

  it("bridging EvidencePart row leaves uploadedAtUtc UNSET (server-clock contract)", () => {
    const bridgeBlock = src.match(
      /client\.evidencePart\.create\([\s\S]*?select:\s*\{\s*id:\s*true\s*\}/,
    )?.[0];
    expect(bridgeBlock).toBeTruthy();
    // Strip comments — the data block intentionally documents the
    // uploadedAtUtc absence, so the bare regex would false-positive.
    const noComments = bridgeBlock!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const dataBlock = noComments.match(/data:\s*\{[\s\S]*?\}/)?.[0] ?? "";
    // No `uploadedAtUtc:` assignment in the create data.
    expect(dataBlock).not.toMatch(/uploadedAtUtc\s*:/);
  });

  it("bridge persists bridged_evidence_part_id idempotently (no double-bridge on retry)", () => {
    expect(src).toMatch(
      /UPDATE\s+"evidence_upload_sessions"[\s\S]*?SET\s+"bridged_evidence_part_id"\s*=\s*\$3[\s\S]*?WHERE[\s\S]*?"bridged_evidence_part_id"\s+IS\s+NULL/,
    );
  });

  it("SessionWithMultipart includes bridge fields so the guard can read them", () => {
    expect(src).toMatch(
      /target_part_index:\s*number\s*\|\s*null[\s\S]*?original_file_name:\s*string\s*\|\s*null[\s\S]*?bridged_evidence_part_id:\s*string\s*\|\s*null/,
    );
  });
});

// =============================================================================
// PART 4 — Routes: bridge field pass-through
// =============================================================================

describe("Phase 30.12 — route bodies accept bridge fields", () => {
  it("web CreateSessionBodySchema accepts the bridge fields", () => {
    const src = readSource(
      "../../../services/api/src/routes/upload-sessions.routes.ts",
    );
    expect(src).toMatch(
      /targetPartIndex:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(9_999\)\.optional\(\)/,
    );
    expect(src).toMatch(
      /originalFileName:\s*z\.string\(\)\.min\(1\)\.max\(255\)\.optional\(\)/,
    );
    expect(src).toMatch(
      /expectedMimeType:\s*z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\)/,
    );
  });

  it("web create handler forwards the bridge fields to createUploadSession", () => {
    const src = readSource(
      "../../../services/api/src/routes/upload-sessions.routes.ts",
    );
    expect(src).toMatch(
      /createUploadSession\(\{[\s\S]*?targetPartIndex:\s*body\.targetPartIndex/,
    );
    expect(src).toMatch(/originalFileName:\s*body\.originalFileName/);
    expect(src).toMatch(/expectedMimeType:\s*body\.expectedMimeType/);
  });

  it("API-key CreateSessionBodySchema accepts the bridge fields", () => {
    const src = readSource(
      "../../../services/api/src/routes/integrations-uploads.routes.ts",
    );
    expect(src).toMatch(
      /targetPartIndex:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(9_999\)\.optional\(\)/,
    );
    expect(src).toMatch(
      /originalFileName:\s*z\.string\(\)\.min\(1\)\.max\(255\)\.optional\(\)/,
    );
    expect(src).toMatch(
      /expectedMimeType:\s*z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\)/,
    );
  });
});

// =============================================================================
// PART 5 — Capture-page fork source contract
// =============================================================================

describe("Phase 30.12 — capture-page fork", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
  );
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("imports routeFile + planChunks + UseResumableUploadsApi (type-only)", () => {
    expect(src).toMatch(
      /import\s*\{\s*routeFile\s*\}\s*from\s+"\.\.\/\.\.\/\.\.\/\.\.\/lib\/uploads\/feature-flag"/,
    );
    expect(src).toMatch(
      /import\s*\{\s*planChunks\s*\}\s*from\s+"\.\.\/\.\.\/\.\.\/\.\.\/lib\/uploads\/retry"/,
    );
    expect(src).toMatch(
      /import\s*type\s*\{\s*UseResumableUploadsApi\s*\}/,
    );
  });

  it("orchestrator accepts `resumable` as an optional parameter", () => {
    expect(src).toMatch(
      /resumable\?:\s*UseResumableUploadsApi\s*\|\s*null/,
    );
  });

  it("fork engages ONLY when all 4 conditions hold (resumable + enabled + teamId + size route)", () => {
    expect(src).toMatch(
      /if\s*\([\s\S]*?resumable\s*&&[\s\S]*?resumable\.enabled\s*&&[\s\S]*?evidenceTeamId\s*&&[\s\S]*?routeFile\([\s\S]*?\)\s*===\s*"resumable"/,
    );
  });

  it("fork runs BEFORE computeIntegrityFromBlob (legacy hash + presign never run for resumable items)", () => {
    const forkIdx = src.indexOf("runResumableItemUpload");
    const integrityIdx = src.indexOf("await computeIntegrityFromBlob(item.file)");
    expect(forkIdx).toBeGreaterThan(-1);
    expect(integrityIdx).toBeGreaterThan(-1);
    expect(forkIdx).toBeLessThan(integrityIdx);
  });

  it("fork does NOT silently fall back to legacy after resumable starts (non-negotiable 14)", () => {
    // The catch block throws — does NOT divert to the legacy path.
    expect(src).toMatch(
      /catch\s*\(err\)\s*\{[\s\S]*?throw err;/,
    );
  });

  it("runResumableItemUpload NEVER calls /v1/evidence/:id/complete (finalize stays at orchestrator level)", () => {
    // The helper's source must not call the evidence-complete endpoint.
    const helper = src.match(
      /async function runResumableItemUpload\([\s\S]*?\n\}/,
    )?.[0];
    expect(helper).toBeTruthy();
    expect(helper!).not.toMatch(/\/v1\/evidence\/[^"]*\/complete/);
  });

  it("runResumableItemUpload NEVER creates custody events (client-side custody forbidden)", () => {
    expect(noComments).not.toMatch(/appendCustody/);
    expect(noComments).not.toMatch(/CustodyEventType/);
  });

  it("runResumableItemUpload NEVER writes uploadedAt locally", () => {
    expect(noComments).not.toMatch(/uploadedAtUtc\s*[:=]\s*new Date/);
    expect(noComments).not.toMatch(/uploadedAtUtc\s*[:=]\s*Date\./);
  });

  it("runResumableItemUpload passes targetPartIndex + originalFileName + expectedMimeType", () => {
    expect(src).toMatch(/targetPartIndex:\s*index/);
    expect(src).toMatch(/originalFileName:\s*item\.relativePath\s*\|\|\s*item\.file\.name/);
    expect(src).toMatch(
      /expectedMimeType:\s*normalizeClientMimeType\(item\.mimeType\)/,
    );
  });

  it("runResumableItemUpload calls /multipart/complete with verifyHash:true (gate requirement)", () => {
    expect(src).toMatch(
      /\/multipart\/complete[\s\S]*?verifyHash:\s*true/,
    );
  });

  it("runResumableItemUpload calls /complete (session COMPLETED transition) AFTER /multipart/complete", () => {
    // Find the helper's start, search the entire source from there.
    const helperStart = src.indexOf(
      "async function runResumableItemUpload",
    );
    expect(helperStart).toBeGreaterThan(-1);
    const tail = src.slice(helperStart);
    const multipartCompleteIdx = tail.indexOf("/multipart/complete");
    const sessionCompleteIdx = tail.indexOf(
      "${sessionId}/complete",
      multipartCompleteIdx + 1,
    );
    expect(multipartCompleteIdx).toBeGreaterThan(-1);
    expect(sessionCompleteIdx).toBeGreaterThan(multipartCompleteIdx);
  });

  it("legacy XHR PUT path remains untouched (POST /v1/evidence/:id/parts + new XMLHttpRequest)", () => {
    expect(src).toMatch(/\/v1\/evidence\/\$\{evidenceId\}\/parts/);
    expect(src).toMatch(/new XMLHttpRequest\(\)/);
    expect(src).toMatch(/part\.upload\.putUrl/);
  });

  it("camera / audio / video / folder callbacks remain wired", () => {
    for (const cb of [
      "onCloseCaptureDevices",
      "onResetAudioRecorder",
      "selectedCollectionPlan",
      "planMode",
    ]) {
      expect(src, `legacy callback ${cb} removed`).toContain(cb);
    }
  });

  it("page.tsx passes `resumable` to the orchestrator", () => {
    const pageSrc = readSource(
      "../../../apps/web/app/(app)/capture/page.tsx",
    );
    expect(pageSrc).toMatch(/onSessionDiscarded:[\s\S]*?resumable,/);
  });

  it("page.tsx declares `resumable` BEFORE useCaptureSessionOrchestration", () => {
    const pageSrc = readSource(
      "../../../apps/web/app/(app)/capture/page.tsx",
    );
    const resumableIdx = pageSrc.indexOf("const resumable = useResumableUploads()");
    const orchestratorIdx = pageSrc.indexOf("} = useCaptureSessionOrchestration({");
    expect(resumableIdx).toBeGreaterThan(-1);
    expect(orchestratorIdx).toBeGreaterThan(-1);
    expect(resumableIdx).toBeLessThan(orchestratorIdx);
  });
});

// =============================================================================
// PART 6 — Review & Sign readiness wiring (behavioral)
// =============================================================================

describe("Phase 30.12 — Review & Sign readiness with resumable blockers", () => {
  it("empty blockers (flag off, default) = no-op", () => {
    const readiness = buildSessionReadiness({
      items: [
        {
          id: "item-1",
          file: new File(["x"], "x.txt"),
          mimeType: "text/plain",
          // The capture SessionItem shape requires several fields;
          // we only set what readiness inspects.
        } as never,
      ],
      selectedPlan: undefined,
      planMode: "FLEXIBLE",
      useLocation: false,
    });
    // Without any plan and just one item, readiness has no
    // blockers from the legacy side either.
    expect(readiness.blockers.length).toBe(0);
    expect(readiness.canFinalize).toBe(true);
  });

  it("one upload_in_progress blocker → canFinalize false + precise label", () => {
    const blockers: ReadonlyArray<ResumableReviewSignBlocker> = [
      { kind: "upload_in_progress", sessionId: "s-1" },
    ];
    const readiness = buildSessionReadiness({
      items: [],
      selectedPlan: undefined,
      planMode: "FLEXIBLE",
      useLocation: false,
      resumableBlockers: blockers,
    });
    expect(readiness.canFinalize).toBe(false);
    expect(
      readiness.blockers.find(
        (b) => b.code === "resumable_upload_in_progress",
      ),
    ).toBeDefined();
  });

  it("every blocker kind produces a distinct precise label (no generic disabled)", () => {
    const kinds: ReadonlyArray<ResumableReviewSignBlocker["kind"]> = [
      "upload_in_progress",
      "server_verification_pending",
      "hash_mismatch",
      "session_expired",
      "session_aborted",
      "needs_recovery",
      "failed_retryable",
    ];
    const labels = new Set<string>();
    for (const kind of kinds) {
      const readiness = buildSessionReadiness({
        items: [],
        selectedPlan: undefined,
        planMode: "FLEXIBLE",
        useLocation: false,
        resumableBlockers: [{ kind, sessionId: `s-${kind}` }],
      });
      const issue = readiness.blockers.find((b) =>
        b.code.startsWith("resumable_"),
      );
      expect(issue, `kind ${kind} missing issue`).toBeDefined();
      labels.add(issue!.label);
    }
    // 7 distinct labels for 7 distinct kinds.
    expect(labels.size).toBe(7);
  });

  it("hash_mismatch label uses custody-careful wording (file integrity)", () => {
    const readiness = buildSessionReadiness({
      items: [],
      selectedPlan: undefined,
      planMode: "FLEXIBLE",
      useLocation: false,
      resumableBlockers: [{ kind: "hash_mismatch", sessionId: "s-h" }],
    });
    const issue = readiness.blockers.find(
      (b) => b.code === "resumable_hash_mismatch",
    );
    expect(issue?.detail).toMatch(/hash|integrity/i);
  });
});

// =============================================================================
// PART 7 — Observability counters
// =============================================================================

describe("Phase 30.12 — observability", () => {
  const metricsSrc = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers the 2 new unified-manifest counters", () => {
    expect(metricsSrc).toContain('"unified_manifest_materials_total"');
    expect(metricsSrc).toContain('"unified_manifest_mixed_evidence_total"');
  });

  it("manifest resolver bumps the materials counter + mixed-evidence counter", () => {
    const src = readSource(
      "../../../services/api/src/services/uploads/unified-material-manifest.ts",
    );
    expect(src).toMatch(/bump\("unified_manifest_materials_total"/);
    expect(src).toMatch(
      /totals\.legacy > 0\s*&&\s*totals\.sessions > 0[\s\S]*?bump\("unified_manifest_mixed_evidence_total"\)/,
    );
  });
});

// =============================================================================
// PART 8 — Anti-leak invariants
// =============================================================================

describe("Phase 30.12 — anti-leak", () => {
  it("orchestrator helper NEVER projects storage internals or signed URLs", () => {
    const src = readSource(
      "../../../apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
    );
    const helper = src.match(
      /async function runResumableItemUpload\([\s\S]*?\n\}/,
    )?.[0];
    expect(helper).toBeTruthy();
    const noComments = helper!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
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
    ]) {
      expect(noComments, `orchestrator helper leaks ${banned}`).not.toContain(
        banned,
      );
    }
  });

  it("readiness blocker labels never expose sessionId / storage internals in the human label", () => {
    const kinds: ReadonlyArray<ResumableReviewSignBlocker["kind"]> = [
      "upload_in_progress",
      "server_verification_pending",
      "hash_mismatch",
      "session_expired",
      "session_aborted",
      "needs_recovery",
      "failed_retryable",
    ];
    for (const kind of kinds) {
      const readiness = buildSessionReadiness({
        items: [],
        selectedPlan: undefined,
        planMode: "FLEXIBLE",
        useLocation: false,
        resumableBlockers: [
          {
            kind,
            sessionId: "MUST-NOT-LEAK-INTO-LABEL",
          },
        ],
      });
      const issue = readiness.blockers.find((b) =>
        b.code.startsWith("resumable_"),
      )!;
      expect(issue.label).not.toContain("MUST-NOT-LEAK-INTO-LABEL");
      expect(issue.detail).not.toContain("MUST-NOT-LEAK-INTO-LABEL");
    }
  });

  it("createUploadSession service NEVER stores raw client timestamps as authoritative", () => {
    const src = readSource(
      "../../../services/api/src/services/uploads/upload-session.service.ts",
    );
    // The session row has uploaded_at_utc_client (audit-only) on
    // PARTS, never on the session itself. Sessions only have
    // completed_at_utc (server clock) + completed_at_storage_utc.
    expect(src).not.toMatch(
      /SET\s+"completed_at_utc"\s*=\s*\$\d/,
    );
  });
});
