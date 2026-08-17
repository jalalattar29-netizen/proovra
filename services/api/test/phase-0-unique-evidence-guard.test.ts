/**
 * PHASE 0 CORRECTIVE §2 — THE UNIQUE-EVIDENCE GUARD, DRIVEN ADVERSARIALLY.
 *
 * Why this file exists
 * ---------------------------------------------------------------------------
 * `UniqueAuditEvidenceLost` went from 1 to 0 during this pass. There are two
 * ways that could have happened. One is that the `testCallerCount` / `testOnly`
 * dimension was genuinely re-derived. The other is that somebody added
 * `uniqueDataResolution: { … }` to a record and moved on.
 *
 * From outside, those look identical: the counter reads zero either way. That
 * is precisely the shape of the defect this whole programme keeps finding —
 * a control that has never been observed refusing anything is a comment.
 *
 * So these cases MUTATE the retired register and re-derive the counter from the
 * real rule. A record whose unique data has no resolution must still be
 * counted; a resolution that names no artifact, or names one that is not on
 * disk, must not silence it. The rule is imported rather than restated,
 * because a restatement would only prove something about the copy.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// The governance evaluation walks the tree and shells out to git. It is
// legitimately slower than a unit test, and under a loaded full-suite run it
// exceeded vitest's 5s default — a flake in the gate that must be the reliable
// one. The cost is bounded and known, so the budget is stated explicitly.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const REPO = path.resolve(__dirname, "../../..");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const registry = require("../scripts/audit/engine/registry.mjs") as {
  RETIRED: ReadonlyArray<{
    path: string;
    lastConsumers: string[];
    decisionConsumers?: string[];
    semantics?: {
      fields: string[];
      derivation: string;
      authority: string;
      currentConsumers: number;
      decisionConsumers: number;
      reproducibleExactly: boolean;
    } | null;
    uniqueDataLost: string | null;
    uniqueDataResolution?: {
      option: string;
      artifact: string;
      exactReproduction?: boolean;
      replacementSemantics?: string;
      semanticDifference?: string;
      fieldsAccountedFor: string[];
    } | null;
  }>;
  DIAGNOSTICS: ReadonlyArray<{ path: string }>;
};

/**
 * THE RULE, in one place — and the distinction the previous pass did not make.
 *
 * `UniqueAuditEvidenceLost` counted two different events as one: deleting an
 * artifact a gate or a decision relied on, and retiring a noisy diagnostic that
 * nothing ever read. The first is a real loss; the second is housekeeping. A
 * counter that fires on both means "something was tidied", which is not worth
 * having.
 *
 * AUTHORITATIVE evidence is evidence that was ACTUALLY RELIED ON — by a gate at
 * the time of deletion (`lastConsumers`) or by a decision taken on its strength
 * (`decisionConsumers`). Both are recorded per row, so this is settled by the
 * record rather than by argument.
 */
type Retired = (typeof registry.RETIRED)[number];

const wasAuthoritative = (r: Retired): boolean =>
  r.lastConsumers.length > 0 || (r.decisionConsumers ?? []).length > 0;

const hasUsableResolution = (r: Retired): boolean => {
  const res = r.uniqueDataResolution;
  if (!res) return false;
  if (!res.artifact || res.artifact.length === 0) return false;
  // Requiring the artifact to be PRESENT is what stops a resolution from being
  // a promise.
  return existsSync(path.join(REPO, res.artifact));
};

/** Authoritative evidence, deleted, with nothing standing in its place. */
const isAuthoritativeLoss = (r: Retired): boolean =>
  r.uniqueDataLost !== null && wasAuthoritative(r) && !hasUsableResolution(r);

const countAuthoritativeLoss = (rows: readonly Retired[]) => rows.filter(isAuthoritativeLoss).length;

/**
 * A retirement record is COMPLETE when it says what the thing was, not merely
 * that it went. Without the semantics block a reader cannot tell whether the
 * deleted artifact was authoritative — which is the whole basis of the rule
 * above — and "it was only a diagnostic" becomes an assertion rather than a
 * record.
 */
const isRecordIncomplete = (r: Retired): string[] => {
  const missing: string[] = [];
  if (r.uniqueDataLost === null) return missing;
  if (!r.semantics) missing.push("semantics");
  else {
    if (!r.semantics.derivation) missing.push("semantics.derivation");
    if (!r.semantics.authority) missing.push("semantics.authority");
    if (typeof r.semantics.reproducibleExactly !== "boolean")
      missing.push("semantics.reproducibleExactly");
  }
  const res = r.uniqueDataResolution;
  if (res) {
    // A replacement that claims to be exact when the record says the old
    // metric is not reproducible is the specific overstatement this pass is
    // correcting.
    if (res.exactReproduction !== false && r.semantics?.reproducibleExactly === false)
      missing.push("resolution.exactReproduction must be false");
    if (!res.semanticDifference) missing.push("resolution.semanticDifference");
    if (!res.replacementSemantics) missing.push("resolution.replacementSemantics");
  }
  return missing;
};

const clone = (): Retired[] => JSON.parse(JSON.stringify(registry.RETIRED)) as Retired[];

describe("Phase 0 §2 — the deleted artifact's fields are accounted for", () => {
  it("no AUTHORITATIVE evidence was lost", () => {
    const lost = registry.RETIRED.filter(isAuthoritativeLoss).map((r) => r.path);
    expect(
      lost,
      `authoritative evidence deleted with nothing in its place:\n${lost.join("\n")}`,
    ).toEqual([]);
  });

  it("the deleted artifact is recorded as NON-authoritative, with the record to back it", () => {
    const record = registry.RETIRED.find((r) => r.path.includes("route-consumers.json"))!;
    expect(record.semantics?.authority).toBe("none");
    expect(record.semantics?.currentConsumers).toBe(0);
    expect(record.semantics?.decisionConsumers).toBe(0);
    expect(record.lastConsumers).toEqual([]);
    expect(record.decisionConsumers ?? []).toEqual([]);
    // The old metric was substring-based. Saying so is what makes the
    // replacement's difference legible rather than a discrepancy.
    expect(record.semantics?.derivation).toMatch(/substring/i);
    expect(record.semantics?.reproducibleExactly).toBe(false);
  });

  it("the replacement is NOT described as an exact re-derivation", () => {
    // The previous pass called it "re-derived", which implied the old numbers
    // could be reproduced. They cannot: reproducing them would mean rebuilding
    // the substring scanner Phase 0 retired.
    const record = registry.RETIRED.find((r) => r.path.includes("route-consumers.json"))!;
    expect(record.uniqueDataResolution?.exactReproduction).toBe(false);
    expect(record.uniqueDataResolution?.replacementSemantics).toMatch(/lower bound/i);
    expect(record.uniqueDataResolution?.semanticDifference).toMatch(/SUBSTRING|substring/);
  });

  it("every retirement record is complete", () => {
    const incomplete = registry.RETIRED.flatMap((r) =>
      isRecordIncomplete(r).map((m) => `${r.path}: missing ${m}`),
    );
    expect(incomplete, incomplete.join("\n")).toEqual([]);
  });

  it("both fields of the deleted route-consumers artifact are named", () => {
    const record = registry.RETIRED.find((r) => r.path.includes("route-consumers.json"));
    expect(record, "the deleted artifact must still be on the retired register").toBeTruthy();
    expect(record!.uniqueDataResolution?.fieldsAccountedFor.slice().sort()).toEqual([
      "testCallerCount",
      "testOnly",
    ]);
  });

  it("the re-derived diagnostic actually carries both fields, with values", () => {
    const diag = registry.DIAGNOSTICS[0]!;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const artifact = require(path.join(REPO, diag.path)) as {
      status: string;
      rows: Array<{ routeId: string; testCallerCount: number; testOnly: boolean }>;
      totals: { routes: number; routesWithAnyTestCaller: number; testOnlyRoutes: number };
    };
    expect(artifact.status).toMatch(/NOT A CURRENT AUTHORITY/);
    expect(artifact.rows.length).toBe(artifact.totals.routes);
    // Recovered, not stubbed. A file full of zeros would satisfy "the field
    // exists" while accounting for nothing — which is how the first attempt at
    // this diagnostic silently produced 0 test callers for 1085 routes because
    // suites live outside every tree root the analyzer walks.
    expect(
      artifact.totals.routesWithAnyTestCaller,
      "the diagnostic resolved no test callers at all — it is measuring nothing",
    ).toBeGreaterThan(0);
    for (const r of artifact.rows) {
      expect(typeof r.testCallerCount).toBe("number");
      expect(typeof r.testOnly).toBe("boolean");
      // A route cannot be test-only without a test caller.
      if (r.testOnly) expect(r.testCallerCount).toBeGreaterThan(0);
    }
  });

  it("no deleted artifact left an unresolved consumer behind", () => {
    const dangling = registry.RETIRED.filter((r) => r.lastConsumers.length > 0).map((r) => r.path);
    expect(dangling, `retired paths that still had consumers:\n${dangling.join("\n")}`).toEqual([]);
  });
});

describe("Phase 0 §3 — the guard separates AUTHORITATIVE loss from housekeeping", () => {
  /** 1 — authoritative evidence deleted → FAIL. */
  it("1 — deleting evidence a GATE relied on counts as loss", () => {
    const rows = clone();
    const r = rows.find((x) => x.uniqueDataLost !== null)!;
    r.lastConsumers = ["services/api/test/some-gate.test.ts"];
    r.uniqueDataResolution = null;
    expect(
      countAuthoritativeLoss(rows),
      "an artifact a gate was reading was deleted and the guard did not fire",
    ).toBeGreaterThan(0);
  });

  it("1b — deleting evidence a DECISION relied on counts as loss", () => {
    const rows = clone();
    const r = rows.find((x) => x.uniqueDataLost !== null)!;
    r.decisionConsumers = ["FINAL-001 disposition"];
    r.uniqueDataResolution = null;
    expect(countAuthoritativeLoss(rows)).toBeGreaterThan(0);
  });

  /** 2 — non-authoritative unused diagnostic, complete record → PASS. */
  it("2 — retiring an UNUSED, non-authoritative diagnostic with a complete record is NOT loss", () => {
    expect(
      countAuthoritativeLoss(registry.RETIRED),
      "housekeeping is being counted as evidence loss",
    ).toBe(0);
    const record = registry.RETIRED.find((r) => r.path.includes("route-consumers.json"))!;
    expect(isRecordIncomplete(record)).toEqual([]);
  });

  /** 3 — diagnostic retired WITHOUT a semantic description → FAIL. */
  it("3 — a retirement with no semantics block is an incomplete record", () => {
    const rows = clone();
    const r = rows.find((x) => x.uniqueDataLost !== null)!;
    r.semantics = null;
    expect(
      isRecordIncomplete(r),
      "a retirement that does not say what the thing WAS was accepted",
    ).toContain("semantics");
  });

  /** 4 — replacement falsely called exact → FAIL. */
  it("4 — claiming the replacement is an EXACT reproduction is refused", () => {
    const rows = clone();
    const r = rows.find((x) => x.uniqueDataResolution)!;
    r.uniqueDataResolution!.exactReproduction = true;
    expect(
      isRecordIncomplete(r),
      "the replacement was allowed to claim exactness while the old metric is recorded as unreproducible",
    ).toContain("resolution.exactReproduction must be false");
  });

  it("4b — dropping the semantic-difference note is refused", () => {
    const rows = clone();
    const r = rows.find((x) => x.uniqueDataResolution)!;
    r.uniqueDataResolution!.semanticDifference = "";
    expect(isRecordIncomplete(r)).toContain("resolution.semanticDifference");
  });

  /** 5 — replacement credited as a current authority → FAIL. */
  it("5 — the replacement diagnostic is never credited as a current authority", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { evaluateGovernance } = require("../scripts/audit/engine/governance.mjs") as {
      evaluateGovernance: () => { counters: Record<string, number> };
    };
    const c = evaluateGovernance().counters;
    expect(c.HistoricalDiagnosticCreditedAsAuthority).toBe(0);
    expect(c.DiagnosticsReadAsAuthority).toBe(0);
    // And it must not be counted toward product closure: closure reads the
    // facts artifact's undisposed count and the ledger's open ids, neither of
    // which the diagnostic contributes to.
    const facts = JSON.parse(
      readFileSync(path.join(REPO, "audit-output/current/architecture-facts.json"), "utf8"),
    ) as { facts: Record<string, unknown> };
    expect(Object.keys(facts.facts)).not.toContain("testCallers");
  });

  it("a resolution naming an artifact that is NOT on disk does not silence an authoritative loss", () => {
    const rows = clone();
    const r = rows.find((x) => x.uniqueDataResolution)!;
    r.lastConsumers = ["services/api/test/some-gate.test.ts"];
    r.uniqueDataResolution!.artifact = "audit-output/diagnostics/never-generated.json";
    expect(countAuthoritativeLoss(rows)).toBeGreaterThan(0);
  });

  it("a record that never had unique data is not counted as losing any", () => {
    // The mirror case. A guard that fires on everything is as useless as one
    // that fires on nothing, and it teaches people to delete the guard.
    const rows = clone();
    for (const r of rows) {
      r.uniqueDataLost = null;
      r.uniqueDataResolution = null;
    }
    expect(countAuthoritativeLoss(rows)).toBe(0);
  });
});
