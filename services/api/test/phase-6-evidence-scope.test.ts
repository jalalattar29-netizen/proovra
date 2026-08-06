/**
 * PHASE 6 §9 (2026-07-22) — evidence scope/custody closure pins.
 *
 * §9.3/§9.6 — bulk ADD_TO_CASE runs the SAME canonical cross-team
 *   attach gate as the single-record path, BEFORE the teamId-stamping
 *   update. (Pre-fix, the bulk branch silently transferred evidence
 *   across tenants for dual-workspace members.)
 *
 * §9.7 — the evidence-purge worker re-asserts ALL THREE legal-hold
 *   families (evidence 4A, case 4A, lifecycle 4B) before hard-deleting,
 *   matching the destruction orchestrator's execute-time re-check.
 *
 * §9.2 — upload→finalize binding invariants confirmed by audit are
 *   pinned: session creation guards evidence ownership; storage keys
 *   are server-derived UUID paths; finalize derives teamId from the
 *   evidence ROW (never the request).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("Phase 6 §9.3/§9.6 — bulk ADD_TO_CASE cross-team gate", () => {
  const src = read("src/routes/evidence.routes.ts");

  it("the bulk branch runs evaluateCrossTeamAttach BEFORE the canonical attach", () => {
    const branch = src.indexOf('case "ADD_TO_CASE": {');
    expect(branch).toBeGreaterThan(-1);
    const slice = src.slice(branch, branch + 3500);
    const gateIdx = slice.indexOf("evaluateCrossTeamAttach({");
    // Track 1B — the direct `evidence.update({ caseId, teamId })` stamp
    // was replaced by the CANONICAL case-evidence authority
    // (attachEvidenceToCase), which re-validates workspace equality and
    // dual-writes the legacy caseId mirror atomically. The gate must
    // still run (and audit) BEFORE the attach call.
    const attachIdx = slice.indexOf("attachEvidenceToCase({");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(attachIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(attachIdx);
    // Blocked attempts are audited with the canonical event kind.
    expect(slice).toContain("CROSS_TEAM_ATTACH_BLOCKED");
  });

  it("bulk and single-record paths share ONE gate source", () => {
    expect(src).toContain(
      'import { evaluateCrossTeamAttach } from "../services/cases/case-permission.service.js"',
    );
    const cases = read("src/routes/cases.routes.ts");
    expect(cases).toContain("evaluateCrossTeamAttach");
  });
});

describe("Phase 6 §9.7 — purge worker legal-hold re-check", () => {
  const worker = read("../worker/src/processor.ts");

  it("every hold family is re-checked before purge deletion (one store)", () => {
    const fn = worker.indexOf("export async function processPurgeDeletedEvidence");
    expect(fn).toBeGreaterThan(-1);
    const body = worker.slice(fn, fn + 9000);
    // PHASE 12B CLUSTER 8 — the three hand-rolled per-store lookups are
    // replaced by ONE union evaluator that reads all three stores and FAILS
    // CLOSED. The families are still all covered; the coverage now lives in
    // services/worker/src/governance/effective-legal-hold.ts.
    expect(body).toMatch(/evaluateEffectiveLegalHold\(prisma/);
    const evaluator = read("../worker/src/governance/effective-legal-hold.ts");
    // PHASE 12 POINT 3 — one store, every scope. Coverage is proven by the
    // canonical scope vocabulary plus the historical clause that makes an
    // unresolvable ACTIVE hold fail closed.
    expect(evaluator).toMatch(/prisma\.evidenceLegalHold\.findMany/);
    expect(evaluator).toMatch(/scope: "EVIDENCE"/);
    expect(evaluator).toMatch(/scope: "CASE"/);
    expect(evaluator).toMatch(/scope: "WORKSPACE"/);
    expect(evaluator).toMatch(/historical/);
    // No retired store may reappear.
    expect(evaluator).not.toMatch(/prisma\.caseLegalHold\./);
    expect(evaluator).not.toMatch(/prisma\.legalHold\./);
    // Hold ordering: the checks precede the storage-delete section.
    const holdIdx = body.indexOf("evaluateEffectiveLegalHold(prisma");
    const retentionIdx = body.indexOf(
      "storageObjectLockRetainUntilUtc;",
    );
    expect(holdIdx).toBeGreaterThan(-1);
    expect(holdIdx).toBeLessThan(retentionIdx);
    // A held purge reschedules (nothing orphaned; hold release resumes).
    expect(body).toMatch(
      /rescheduled because evidence is under an active legal hold/,
    );
  });
});

describe("Phase 6 §9.2 — upload→finalize binding invariants (audit pins)", () => {
  it("upload-session creation guards target-evidence ownership (IDOR)", () => {
    const svc = read("src/services/uploads/upload-session.service.ts");
    expect(svc).toContain("evidence_not_found");
    // Finalize gate scans sessions and fails closed on unverified parts.
    expect(svc).toMatch(/VERIFIED/);
  });

  it("storage keys are server-derived UUID paths (no client component)", () => {
    const storage = read("src/services/uploads/storage-multipart.ts");
    expect(storage).toMatch(/evidence\/\$\{/);
    expect(storage).toMatch(/multipart/);
  });

  it("finalize derives teamId from the evidence row, never the request body", () => {
    const complete = read("src/services/evidence-complete.service.ts");
    expect(complete).toMatch(/teamId:\s*evidence\.teamId/);
  });
});
