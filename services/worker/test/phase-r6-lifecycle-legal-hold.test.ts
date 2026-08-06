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

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasActiveLifecycleLegalHold } from "../src/governance/lifecycle-legal-hold.js";

function makePrisma(findFirst: ReturnType<typeof vi.fn>) {
  // PHASE 12 POINT 3 — ONE canonical delegate.
  return { evidenceLegalHold: { findFirst } } as never;
}

describe("Phase R6 — hasActiveLifecycleLegalHold (F39)", () => {
  let findFirst: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    findFirst = vi.fn();
  });

  it("returns true when an active 4B hold matches (EVIDENCE/WORKSPACE/ORG/CASE)", async () => {
    findFirst.mockResolvedValue({ id: "hold-1" });
    const held = await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
      evidenceId: "ev-1",
      teamId: "team-1",
      caseIds: ["case-1"],
    });
    expect(held).toBe(true);
    const where = findFirst.mock.calls[0][0].where;
    expect(where.teamId).toBe("team-1");
    expect(where.status).toBe("ACTIVE");
    // Every scope must be covered when a case is linked. A canonical WORKSPACE
    // row carries no target columns (the query is already teamId-anchored),
    // and the historical clause is what makes an unresolvable ACTIVE hold fail
    // closed instead of silently missing.
    const scopes = (where.OR as Array<{ scope?: string; historical?: boolean }>).map(
      (c) => c.scope ?? (c.historical ? "HISTORICAL" : "?"),
    );
    expect(scopes).toEqual(
      expect.arrayContaining(["EVIDENCE", "WORKSPACE", "CASE", "HISTORICAL"]),
    );
  });

  it("returns false when no matching 4B hold exists", async () => {
    findFirst.mockResolvedValue(null);
    expect(
      await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
        evidenceId: "ev-1",
        teamId: "team-1",
        caseIds: [],
      }),
    ).toBe(false);
  });

  it("short-circuits for personal-scope evidence (no teamId) without querying", async () => {
    const held = await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
      evidenceId: "ev-1",
      teamId: null,
      caseIds: [],
    });
    expect(held).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("omits the CASE clause when the evidence has no case", async () => {
    findFirst.mockResolvedValue(null);
    await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
      evidenceId: "ev-1",
      teamId: "team-1",
      caseIds: [],
    });
    const scopes = (
      findFirst.mock.calls[0][0].where.OR as Array<{ scope?: string }>
    ).map((c) => c.scope);
    expect(scopes).not.toContain("CASE");
  });

  it("FAILS CLOSED when the canonical hold table cannot be read", async () => {
    // The optional-store allowance is gone with the store. One table means a
    // read failure can never be reported as "nothing is held".
    findFirst.mockRejectedValue(new Error("relation evidence_legal_holds does not exist"));
    await expect(
      hasActiveLifecycleLegalHold(makePrisma(findFirst), {
        evidenceId: "ev-1",
        teamId: "team-1",
        caseIds: [],
      }),
    ).rejects.toThrow();
  });

  it("PHASE 12B WAVE 0.3 — a TRANSIENT DB error FAILS CLOSED (rethrows; destruction run aborts)", async () => {
    // A connection loss / timeout during the 4B query must NEVER be read as
    // "no hold" — that would destroy evidence under an active legal hold.
    findFirst.mockRejectedValue(
      Object.assign(new Error("connection reset"), { code: "P1001" }),
    );
    await expect(
      hasActiveLifecycleLegalHold(makePrisma(findFirst), {
        evidenceId: "ev-1",
        teamId: "team-1",
        caseIds: [],
      }),
    ).rejects.toThrow("connection reset");
  });

  it("PHASE 12 POINT 3 — Prisma P2021 on the canonical table FAILS CLOSED", async () => {
    findFirst.mockRejectedValue(
      Object.assign(new Error("prisma table missing"), { code: "P2021" }),
    );
    await expect(
      hasActiveLifecycleLegalHold(makePrisma(findFirst), {
        evidenceId: "ev-1",
        teamId: "team-1",
        caseIds: [],
      }),
    ).rejects.toThrow();
  });
});

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
