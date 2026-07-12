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
  return { legalHold: { findFirst } } as never;
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
      caseId: "case-1",
    });
    expect(held).toBe(true);
    const where = findFirst.mock.calls[0][0].where;
    expect(where.teamId).toBe("team-1");
    expect(where.state).toBe("ACTIVE");
    // OR clause must include all four scopes when caseId is present.
    const kinds = (where.OR as Array<{ kind: string }>).map((c) => c.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["EVIDENCE", "WORKSPACE", "ORGANIZATION", "CASE"]),
    );
  });

  it("returns false when no matching 4B hold exists", async () => {
    findFirst.mockResolvedValue(null);
    expect(
      await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
        evidenceId: "ev-1",
        teamId: "team-1",
        caseId: null,
      }),
    ).toBe(false);
  });

  it("short-circuits for personal-scope evidence (no teamId) without querying", async () => {
    const held = await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
      evidenceId: "ev-1",
      teamId: null,
      caseId: null,
    });
    expect(held).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("omits the CASE clause when the evidence has no case", async () => {
    findFirst.mockResolvedValue(null);
    await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
      evidenceId: "ev-1",
      teamId: "team-1",
      caseId: null,
    });
    const kinds = (findFirst.mock.calls[0][0].where.OR as Array<{ kind: string }>).map(
      (c) => c.kind,
    );
    expect(kinds).not.toContain("CASE");
  });

  it("degrades to false (fail-open on 4B only) if the legal_holds table is absent", async () => {
    findFirst.mockRejectedValue(new Error("relation legal_holds does not exist"));
    expect(
      await hasActiveLifecycleLegalHold(makePrisma(findFirst), {
        evidenceId: "ev-1",
        teamId: "team-1",
        caseId: null,
      }),
    ).toBe(false);
  });
});

describe("Phase R6 — both worker destruction stages consult the 4B hold (source contract)", () => {
  it("retention-reconciliation scheduler calls hasActiveLifecycleLegalHold", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/governance/retention-reconciliation.worker.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toContain("hasActiveLifecycleLegalHold");
  });

  it("destruction-orchestrator executor folds the 4B hold into hasActiveDirectHold", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/governance/destruction-orchestrator.worker.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toContain("hasActiveLifecycleLegalHold");
    expect(src).toMatch(/hasActiveDirectHold:\s*Boolean\(directHold\)\s*\|\|\s*has4BHold/);
  });
});
