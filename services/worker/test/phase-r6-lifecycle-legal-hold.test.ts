/**
 * Phase R6 — Phase-4B legal-hold enforcement on the automated destruction
 * pipeline (finding F39).
 *
 * A hold placed via the live `/lifecycle/legal-holds` UI writes only the
 * Phase-4B `legalHold` table (scope-level), never an `EvidenceLegalHold`
 * row or an `Evidence.lifecycleState` change. Both worker stages
 * (retention-reconciliation scheduler + destruction-orchestrator executor)
 * previously checked only the 4A models, so such evidence could be
 * automatically destroyed despite an active legal hold. `hasActiveLifecycleLegalHold`
 * closes that, mirroring the 4B portion of the canonical API-side
 * `isUnderLegalHold`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";


// LEGACY-003 (2026-08-15) — the behavioural suite that stood here exercised
// `hasActiveLifecycleLegalHold` from src/governance/lifecycle-legal-hold.ts.
// That module was REMOVED: it had zero production importers, and its own
// successor says why — src/governance/effective-legal-hold.ts records that the
// worker lifecycle gate read ONLY `legal_holds`, while the canonical union
// evaluator reads the evidence-direct, workspace and case stores together.
//
// Nothing that runs in production lost a check. The destruction orchestrator
// calls `evaluateEffectiveLegalHold`, which is a STRICT SUPERSET of the removed
// predicate and carries the same fail-closed rule, and it is covered
// behaviourally by the API family suites (including the live
// point5/family-retention-destruction integration). The source contract below
// — that BOTH worker destruction stages consult that evaluator — is the
// load-bearing assertion in this file and is deliberately left untouched.

// PHASE 12B CLUSTER 8 — both stages now consult the 4B store through THE ONE
// union evaluator (src/governance/effective-legal-hold.ts) instead of calling
// `hasActiveLifecycleLegalHold` directly. The evaluator is a STRICT SUPERSET:
// it reads the 4B store AND the evidence-direct store AND the case store, in
// one place, with the same fail-closed rule this suite pins above.
describe("Phase R6 — both worker destruction stages consult the 4B hold (source contract)", () => {
  const evaluator = readFileSync(
    fileURLToPath(new URL("../src/governance/effective-legal-hold.ts", import.meta.url)),
    "utf8",
  );

  it("the ONE evaluator reads the ONE canonical store, all scopes", () => {
    expect(evaluator).toContain("prisma.evidenceLegalHold.findMany");
    expect(evaluator).toContain('scope: "EVIDENCE"');
    expect(evaluator).toContain('scope: "CASE"');
    expect(evaluator).toContain('scope: "WORKSPACE"');
    expect(evaluator).toContain("historical");
    // No retired store may reappear in the worker evaluator either.
    expect(evaluator).not.toContain("prisma.legalHold.");
    expect(evaluator).not.toContain("prisma.caseLegalHold.");
  });

  it("retention-reconciliation scheduler consults the union evaluator", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/governance/retention-reconciliation.worker.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toContain("evaluateEffectiveLegalHold(prisma");
    expect(src).toMatch(/if \(effectiveHold\.held\)/);
  });

  it("destruction-orchestrator executor folds every hold family into its gate", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/governance/destruction-orchestrator.worker.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toContain("evaluateEffectiveLegalHold(prisma");
    expect(src).toMatch(/hasActiveDirectHold:\s*hasNonCaseScopedHold/);
    expect(src).toMatch(/hasActiveCaseHold:\s*hasCaseScopedHold/);
  });

  it("the worker copy is byte-identical to the api copy (no drift)", () => {
    const api = readFileSync(
      fileURLToPath(
        new URL(
          "../../api/src/services/governance/effective-legal-hold.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(evaluator).toBe(api);
  });
});
