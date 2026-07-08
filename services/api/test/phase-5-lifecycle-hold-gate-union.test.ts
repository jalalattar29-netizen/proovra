/**
 * Phase 5 (Enterprise Governance) — Lifecycle hold-gate UNION regression.
 *
 * Two evidence-lifecycle stacks coexist by design (Option D — see
 * docs/architecture/lifecycle-domain-responsibilities.md):
 *
 *   - STACK A  Phase 4B  `services/api/src/services/lifecycle/*`
 *              models `LegalHold` / `RetentionPolicyConfig` /
 *              `DestructionRequest`. Surface-A "Lifecycle Operations"
 *              UI (POST /v1/lifecycle/legal-holds …) writes here.
 *
 *   - STACK B  Phase 27 `services/api/src/services/governance-lifecycle/*`
 *              models `EvidenceLegalHold` / `EvidenceRetentionPolicy` /
 *              `DestructionReview`. Surface-B "Governance Posture" +
 *              the worker-enforced lineage.
 *
 * Both stacks are ACTIVE (routes registered, UI callers, tests). Neither
 * is dead. This suite locks the SCOPE-E fix + the canonical map:
 *
 *   1. The DIRECT evidence delete/archive gate
 *      (`governance.service.ts#isUnderActiveLegalHold`, consumed by
 *      `canDeleteEvidence` → `runDestructiveActionGate` →
 *      `DELETE /v1/evidence/:id`) now blocks on a hold placed through
 *      EITHER stack — the `EvidenceLegalHold` model OR the Phase 4B
 *      `LegalHold` model (EVIDENCE / WORKSPACE / ORGANIZATION / CASE
 *      scope). Before the fix a 4B EVIDENCE-scoped hold placed through
 *      the live Surface-A UI did NOT block a direct delete.
 *
 *   2. The union is STRICTLY ADDITIVE — it only ever adds a block, never
 *      removes one. A record with no hold in either model is still
 *      deletable.
 *
 *   3. Canonical-stack lock — source-scan proving the two hold entry
 *      points enforce the same hold-model union and carry the
 *      cross-stack pointer comments, so the two engines are never left
 *      silently diverging.
 *
 * No real DB — controllable Prisma stubs, matching the phase-4b pattern.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isUnderActiveLegalHold,
  canDeleteEvidence,
  canArchiveEvidence,
} from "../src/services/governance.service.js";
import { isUnderLegalHold } from "../src/services/lifecycle/legal-hold.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Prisma stub — models the two hold tables + the evidence lookup the
// union check performs. `holds` describes which model has an ACTIVE hold.
// ---------------------------------------------------------------------------

type HoldFixture = {
  /** Active EvidenceLegalHold on this evidence (Stack B per-record). */
  evidenceLegalHold?: boolean;
  /** Active 4B LegalHold rows (Stack A). Each row is { kind, scopeTargetId }. */
  legalHold4B?: Array<{ kind: string; scopeTargetId: string | null }>;
  /** Evidence row context for scope resolution. */
  evidence?: { teamId: string | null; caseId: string | null } | null;
  /** Simulate an absent `legal_holds` table (older environment). */
  legalHoldTableMissing?: boolean;
};

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "33333333-3333-4333-8333-333333333333";

function makeStub(fx: HoldFixture) {
  const evidenceRow =
    fx.evidence === undefined
      ? { teamId: TEAM_ID, caseId: null }
      : fx.evidence;

  return {
    evidenceLegalHold: {
      findFirst: async () => (fx.evidenceLegalHold ? { id: "elh-1" } : null),
      findMany: async () => [],
    },
    caseLegalHold: {
      findFirst: async () => null,
    },
    evidence: {
      findUnique: async () => evidenceRow,
      findFirst: async () => evidenceRow,
    },
    legalHold: {
      findFirst: async (args: {
        where: { teamId: string; state: string; OR: Array<Record<string, unknown>> };
      }) => {
        if (fx.legalHoldTableMissing) {
          throw Object.assign(new Error("P2021"), { code: "P2021" });
        }
        const rows = fx.legalHold4B ?? [];
        // Match the OR clauses the production query builds.
        for (const clause of args.where.OR) {
          for (const row of rows) {
            if (row.kind !== clause.kind) continue;
            // ORGANIZATION has no scopeTargetId constraint.
            if (clause.kind === "ORGANIZATION") return { id: "lh4b-org" };
            if (row.scopeTargetId === (clause as { scopeTargetId?: string }).scopeTargetId) {
              return { id: `lh4b-${row.kind}` };
            }
          }
        }
        return null;
      },
      findMany: async () => [],
    },
  } as never;
}

// ===========================================================================
// 1. Delete gate blocks on Stack B (EvidenceLegalHold) — unchanged behaviour
// ===========================================================================

describe("Phase 5 — delete gate honours the Stack B EvidenceLegalHold model", () => {
  it("blocks when an ACTIVE EvidenceLegalHold exists", async () => {
    const client = makeStub({ evidenceLegalHold: true });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("does not block when no hold exists in either model", async () => {
    const client = makeStub({ evidenceLegalHold: false, legalHold4B: [] });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(false);
  });
});

// ===========================================================================
// 2. SCOPE-E FIX — delete gate now blocks on Stack A (4B LegalHold)
// ===========================================================================

describe("Phase 5 — SCOPE-E: delete gate now honours the Stack A 4B LegalHold model", () => {
  it("blocks on a 4B EVIDENCE-scoped hold (the live Surface-A UI path)", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      legalHold4B: [{ kind: "EVIDENCE", scopeTargetId: EVIDENCE_ID }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("blocks on a 4B WORKSPACE-scoped hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      legalHold4B: [{ kind: "WORKSPACE", scopeTargetId: TEAM_ID }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("blocks on a 4B ORGANIZATION-scoped hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      legalHold4B: [{ kind: "ORGANIZATION", scopeTargetId: null }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("blocks on a 4B CASE-scoped hold when the evidence belongs to that case", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      evidence: { teamId: TEAM_ID, caseId: CASE_ID },
      legalHold4B: [{ kind: "CASE", scopeTargetId: CASE_ID }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("does NOT block on a 4B EVIDENCE hold scoped to a DIFFERENT evidence", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      legalHold4B: [{ kind: "EVIDENCE", scopeTargetId: "99999999-9999-4999-8999-999999999999" }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(false);
  });
});

// ===========================================================================
// 3. Union is fail-open ONLY for a missing 4B table (never breaks delete),
//    and the Stack B check still runs fail-closed regardless.
// ===========================================================================

describe("Phase 5 — union tolerates a missing 4B legal_holds table", () => {
  it("degrades to the Stack B result when the 4B table is absent", async () => {
    // 4B table missing, but an EvidenceLegalHold exists → still blocked.
    const blocked = makeStub({ evidenceLegalHold: true, legalHoldTableMissing: true });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, blocked)).toBe(true);

    // 4B table missing, no EvidenceLegalHold → not blocked (no crash).
    const clear = makeStub({ evidenceLegalHold: false, legalHoldTableMissing: true });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, clear)).toBe(false);
  });

  it("does not block when the evidence has no resolvable teamId", async () => {
    // Personal-scope orphan — 4B WORKSPACE/ORG scope cannot apply.
    const client = makeStub({
      evidenceLegalHold: false,
      evidence: { teamId: null, caseId: null },
      legalHold4B: [{ kind: "ORGANIZATION", scopeTargetId: null }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(false);
  });
});

// ===========================================================================
// 4. canDeleteEvidence / canArchiveEvidence propagate the union block
// ===========================================================================

describe("Phase 5 — deletion + archive decisions block on a 4B hold", () => {
  const permissivePolicy = {
    evidenceDeletionMode: "ALLOWED",
  } as never;

  it("canDeleteEvidence is blocked_by_legal_hold on a 4B EVIDENCE hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      legalHold4B: [{ kind: "EVIDENCE", scopeTargetId: EVIDENCE_ID }],
    });
    const decision = await canDeleteEvidence({
      role: "ADMIN",
      evidence: { id: EVIDENCE_ID, teamId: TEAM_ID, retentionUntilUtc: null },
      policy: permissivePolicy,
      client,
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toBe("blocked_by_legal_hold");
  });

  it("canArchiveEvidence is blocked_by_legal_hold on a 4B WORKSPACE hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      legalHold4B: [{ kind: "WORKSPACE", scopeTargetId: TEAM_ID }],
    });
    const decision = await canArchiveEvidence({
      role: "ADMIN",
      evidence: { id: EVIDENCE_ID, teamId: TEAM_ID },
      policy: permissivePolicy,
      client,
    });
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toBe("blocked_by_legal_hold");
  });

  it("canDeleteEvidence still ALLOWS when no hold exists in either model", async () => {
    const client = makeStub({ evidenceLegalHold: false, legalHold4B: [] });
    const decision = await canDeleteEvidence({
      role: "ADMIN",
      evidence: { id: EVIDENCE_ID, teamId: TEAM_ID, retentionUntilUtc: null },
      policy: permissivePolicy,
      client,
    });
    expect(decision.allowed).toBe(true);
  });
});

// ===========================================================================
// 5. The 4B canonical isUnderLegalHold already consulted both models —
//    this is the reference the delete gate is now aligned with.
// ===========================================================================

describe("Phase 5 — 4B canonical isUnderLegalHold consults both hold models", () => {
  it("reports underHold with source 4B for a 4B EVIDENCE hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      legalHold4B: [{ kind: "EVIDENCE", scopeTargetId: EVIDENCE_ID }],
    });
    // isUnderLegalHold builds its own legalHold.findMany query; give it one.
    const c = {
      ...(client as Record<string, unknown>),
      legalHold: {
        findMany: async () => [{ id: "lh4b-EVIDENCE" }],
        findFirst: async () => null,
      },
      evidenceLegalHold: { findFirst: async () => null },
      caseLegalHold: { findFirst: async () => null },
      evidence: { findUnique: async () => ({ caseId: null }) },
    } as never;
    const res = await isUnderLegalHold({ prisma: c, teamId: TEAM_ID, evidenceId: EVIDENCE_ID });
    expect(res.underHold).toBe(true);
    expect(res.sources).toContain("4B");
  });
});

// ===========================================================================
// 6. Canonical-stack LOCK — source-scan proving the two entry points are
//    aligned and pointer-commented (no silent divergence).
// ===========================================================================

describe("Phase 5 — canonical-stack lock: both hold entry points consult the 4B model", () => {
  const governanceSrc = readSrc("services/governance.service.ts");
  const lifecycleHoldSrc = readSrc("services/lifecycle/legal-hold.service.ts");

  it("the direct delete gate consults the 4B LegalHold model + all four scopes", () => {
    // The union block was added to isUnderActiveLegalHold.
    const fnIdx = governanceSrc.indexOf("export async function isUnderActiveLegalHold");
    expect(fnIdx).toBeGreaterThan(0);
    const fn = governanceSrc.slice(fnIdx, fnIdx + 2600);
    expect(fn).toContain("client.legalHold.findFirst");
    expect(fn).toContain('kind: "EVIDENCE"');
    expect(fn).toContain('kind: "WORKSPACE"');
    expect(fn).toContain('kind: "ORGANIZATION"');
    expect(fn).toContain('kind: "CASE"');
    // Fail-tolerant on a missing 4B table.
    expect(fn).toMatch(/try\s*\{/);
    expect(fn).toContain("SCOPE-E");
  });

  it("the delete gate still consults the Stack B EvidenceLegalHold model first (unchanged)", () => {
    const fnIdx = governanceSrc.indexOf("export async function isUnderActiveLegalHold");
    const fn = governanceSrc.slice(fnIdx, fnIdx + 2600);
    expect(fn).toContain("client.evidenceLegalHold.findFirst");
  });

  it("the 4B canonical isUnderLegalHold carries the cross-stack lock-step pointer", () => {
    expect(lifecycleHoldSrc).toContain("isUnderActiveLegalHold");
    expect(lifecycleHoldSrc).toMatch(/lock-step|SCOPE-E|cross-stack/i);
  });
});
