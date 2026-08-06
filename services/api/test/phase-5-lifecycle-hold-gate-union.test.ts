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
  /**
   * Canonical hold rows. Post-cutover every hold — whichever store it
   * originally came from — is a row here with an explicit scope.
   */
  canonicalHolds?: Array<{
    scope: "EVIDENCE" | "CASE" | "WORKSPACE";
    evidenceId?: string | null;
    caseId?: string | null;
    historical?: boolean;
  }>;
  /** Evidence row context for scope resolution. */
  evidence?: { teamId: string | null; caseId: string | null } | null;
  /** Simulate an absent `legal_holds` table (older environment). */
  legalHoldTableMissing?: boolean;
};

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "33333333-3333-4333-8333-333333333333";

function makeStub(fx: HoldFixture) {
  const fixtureEvidence =
    fx.evidence === undefined
      ? { teamId: TEAM_ID, caseId: null }
      : fx.evidence;
  // Track 1B closure — the service reads case linkage via the canonical
  // `caseLinks` relation / CaseEvidenceLink table; the fixture's single
  // caseId is projected into both shapes.
  const caseLinks = fixtureEvidence?.caseId
    ? [{ caseId: fixtureEvidence.caseId }]
    : [];
  const evidenceRow =
    fixtureEvidence === null
      ? null
      : { teamId: fixtureEvidence.teamId, caseLinks };

  return {
    // PHASE 12B CLUSTER 8 — the gate now runs through the ONE effective-hold
    // evaluator, which reads with `findMany` and distinguishes the
    // evidence-direct clause (pre-canonical columns only) from the
    // scope-aware clause (`scope` / `historical`).
    // PHASE 12 POINT 3 — ONE canonical delegate. Clause A of the evaluator
    // asks for evidence-direct rows; clause B asks for scope-aware rows
    // (CASE / WORKSPACE / historical). Both are answered from the same
    // fixture set, which is exactly how production now behaves.
    evidenceLegalHold: {
      findFirst: async () => (fx.evidenceLegalHold ? { id: "elh-1" } : null),
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        matchCanonicalHolds(args?.where ?? {}),
    },
    caseEvidenceLink: {
      findMany: async () => caseLinks,
      findFirst: async () => caseLinks[0] ?? null,
    },
    evidence: {
      findUnique: async () => evidenceRow,
      findFirst: async () => evidenceRow,
    },
  } as never;

  /**
   * Answers a canonical evaluator query from the fixture's hold set.
   *
   * The scope filter is the whole point: a CASE row must NOT satisfy an
   * evidence-direct probe, a WORKSPACE row carries NO target columns (so it
   * can never be matched by echoing an id back), and a historical row is
   * matched only by the historical clause — which is what makes an
   * unresolvable ACTIVE hold fail closed instead of silently disappearing.
   */
  function matchCanonicalHolds(
    where: Record<string, unknown>,
  ): Array<{ id: string; scope: string }> {
    if (fx.legalHoldTableMissing) {
      throw Object.assign(new Error("P2021"), { code: "P2021" });
    }
    const rows = [
      ...(fx.evidenceLegalHold ? [{ scope: "EVIDENCE" as const, evidenceId: EVIDENCE_ID }] : []),
      ...(fx.canonicalHolds ?? []),
    ];
    const clauses = Array.isArray(where.OR)
      ? (where.OR as Array<Record<string, unknown>>)
      : [where];
    const out: Array<{ id: string; scope: string }> = [];
    for (const clause of clauses) {
      for (const row of rows) {
        if (row.historical) {
          if (clause.historical === true) out.push({ id: `clh-${row.scope}`, scope: row.scope });
          continue;
        }
        if (clause.historical === true) continue;
        if (clause.scope !== undefined && clause.scope !== row.scope) continue;
        if (clause.scope === undefined && where.scope === undefined && !clause.evidenceId) continue;
        if (clause.evidenceId !== undefined && clause.evidenceId !== row.evidenceId) continue;
        if (clause.caseId !== undefined) {
          const want = clause.caseId as { in?: string[] } | string;
          const ids = typeof want === "string" ? [want] : (want.in ?? []);
          if (!row.caseId || !ids.includes(row.caseId)) continue;
        }
        out.push({ id: `clh-${row.scope}`, scope: row.scope });
      }
    }
    return out;
  }
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
    const client = makeStub({ evidenceLegalHold: false, canonicalHolds: [] });
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
      canonicalHolds: [{ scope: "EVIDENCE", evidenceId: EVIDENCE_ID }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("blocks on a 4B WORKSPACE-scoped hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      canonicalHolds: [{ scope: "WORKSPACE" }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("blocks on a 4B ORGANIZATION-scoped hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      canonicalHolds: [{ scope: "WORKSPACE" }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("blocks on a 4B CASE-scoped hold when the evidence belongs to that case", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      evidence: { teamId: TEAM_ID, caseId: CASE_ID },
      canonicalHolds: [{ scope: "CASE", caseId: CASE_ID }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(true);
  });

  it("does NOT block on a 4B EVIDENCE hold scoped to a DIFFERENT evidence", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      canonicalHolds: [{ scope: "EVIDENCE", evidenceId: "99999999-9999-4999-8999-999999999999" }],
    });
    expect(await isUnderActiveLegalHold(EVIDENCE_ID, client)).toBe(false);
  });
});

// ===========================================================================
// 3. Union is fail-open ONLY for a missing 4B table (never breaks delete),
//    and the Stack B check still runs fail-closed regardless.
// ===========================================================================

describe("Phase 12 Point 3 — the canonical store is NOT optional", () => {
  it("FAILS CLOSED when the canonical hold table cannot be queried", async () => {
    // Before the cutover an absent OPTIONAL legacy table was allowed to
    // degrade to 'no 4B hold'. There is now exactly one hold store, so a
    // query failure against it can never be read as 'nothing is held' —
    // that would make held evidence destructible. It must propagate.
    const broken = makeStub({ evidenceLegalHold: false, legalHoldTableMissing: true });
    await expect(isUnderActiveLegalHold(EVIDENCE_ID, broken)).rejects.toThrow();
  });

  it("does not block when the evidence has no resolvable teamId", async () => {
    // Personal-scope orphan — 4B WORKSPACE/ORG scope cannot apply.
    const client = makeStub({
      evidenceLegalHold: false,
      evidence: { teamId: null, caseId: null },
      canonicalHolds: [{ scope: "WORKSPACE" }],
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
      canonicalHolds: [{ scope: "EVIDENCE", evidenceId: EVIDENCE_ID }],
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
      canonicalHolds: [{ scope: "WORKSPACE" }],
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
    const client = makeStub({ evidenceLegalHold: false, canonicalHolds: [] });
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
  it("reports underHold for an EVIDENCE-scoped canonical hold", async () => {
    const client = makeStub({
      evidenceLegalHold: false,
      canonicalHolds: [{ scope: "EVIDENCE", evidenceId: EVIDENCE_ID }],
    });
    // PHASE 12B CLUSTER 8 — isUnderLegalHold now delegates to the ONE
    // effective-hold evaluator, which reads every store with `findMany`.
    // PHASE 12 POINT 3 — the evaluator reads ONE store. The hold is an
    // evidence-direct canonical row, so the reported source is
    // EVIDENCE_LEGAL_HOLD.
    const c = {
      ...(client as Record<string, unknown>),
      caseEvidenceLink: { findMany: async () => [] },
      evidence: { findUnique: async () => ({ teamId: TEAM_ID, caseLinks: [] }) },
    } as never;
    const res = await isUnderLegalHold({ prisma: c, teamId: TEAM_ID, evidenceId: EVIDENCE_ID });
    expect(res.underHold).toBe(true);
    // `isUnderLegalHold` reports the CANONICAL stack as '4A'. The retired
    // scope-generic store was '4B'; it can no longer appear at all.
    expect(res.sources).toContain("4A");
    expect(res.sources).not.toContain("4B");
  });
});

// ===========================================================================
// 6. Canonical-stack LOCK — source-scan proving the two entry points are
//    aligned and pointer-commented (no silent divergence).
// ===========================================================================

describe("Phase 5 — canonical-stack lock: both hold entry points consult the 4B model", () => {
  const governanceSrc = readSrc("services/governance.service.ts");
  const lifecycleHoldSrc = readSrc("services/lifecycle/legal-hold.service.ts");

  // PHASE 12B CLUSTER 8 — the hand-rolled union in isUnderActiveLegalHold is
  // gone: the gate now DELEGATES to the ONE effective-hold evaluator
  // (services/governance/effective-legal-hold.ts), which reads all THREE
  // stores and only degrades on a genuinely-absent relation. The lock moves
  // with it — assert the delegation plus the evaluator's own scope coverage.
  it("the direct delete gate delegates to the ONE effective-hold evaluator", () => {
    const fnIdx = governanceSrc.indexOf("export async function isUnderActiveLegalHold");
    expect(fnIdx).toBeGreaterThan(0);
    const fn = governanceSrc.slice(fnIdx, fnIdx + 2600);
    expect(fn).toContain("evaluateEffectiveLegalHold(");
    // No private per-store union may survive inside the gate.
    expect(fn).not.toContain("client.legalHold.findFirst");
  });

  it("the ONE evaluator covers every scope, in the ONE canonical store", () => {
    const evaluator = readSrc("services/governance/effective-legal-hold.ts");
    // PHASE 12 POINT 3 — the legacy `kind`-shaped clauses retired with their
    // stores. Scope coverage is now proven by the canonical vocabulary plus
    // the historical clause that makes an unresolvable hold fail closed.
    expect(evaluator).toContain('scope: "EVIDENCE"');
    expect(evaluator).toContain('scope: "CASE"');
    expect(evaluator).toContain('scope: "WORKSPACE"');
    expect(evaluator).toContain("historical");
    expect(evaluator).toContain("prisma.evidenceLegalHold.findMany");
    // No second store may reappear.
    expect(evaluator).not.toContain("prisma.caseLegalHold.");
    expect(evaluator).not.toContain("prisma.legalHold.");
  });

  it("the evaluator FAILS CLOSED — only an absent relation may degrade", () => {
    const evaluator = readSrc("services/governance/effective-legal-hold.ts");
    expect(evaluator).toContain("isAbsentRelationError");
    expect(evaluator).toMatch(/P2021/);
    expect(evaluator).toMatch(/P2022/);
    expect(evaluator).toMatch(/throw err;/);
  });

  it("the evidence-direct clause is never degradable", () => {
    const evaluator = readSrc("services/governance/effective-legal-hold.ts");
    const idx = evaluator.indexOf("---- Clause A");
    const clauseA = evaluator.slice(idx, evaluator.indexOf("---- Clause B"));
    expect(idx).toBeGreaterThan(0);
    expect(clauseA).not.toContain("tolerateAbsentRelation");
  });

  it("the 4B canonical isUnderLegalHold carries the cross-stack lock-step pointer", () => {
    expect(lifecycleHoldSrc).toContain("isUnderActiveLegalHold");
    expect(lifecycleHoldSrc).toMatch(/lock-step|SCOPE-E|cross-stack/i);
  });
});
