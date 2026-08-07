/**
 * PHASE 12 — POINT 5, BOUNDED UNIT 1: the family-proof gate.
 *
 * `QueueFamiliesBehaviorallyProven` is DERIVED here, never assigned. The number
 * this gate prints is the number that may be reported, and it is computed from
 * four independent facts:
 *
 *   1. the REGISTRY — which runtime units exist, and in which family;
 *   2. the MANIFEST — which behavioural case identifiers each unit requires;
 *   3. the SUITE FILES — which state-machine suites exist on disk, by content;
 *   4. the PROVEN-CASES ARTIFACT — which case identifiers actually EXECUTED.
 *
 * WHY (4) WAS ADDED, AND WHAT IT CAUGHT
 * ---------------------------------------------------------------------------
 * The first version of this gate credited a family when its suite FILE existed
 * and every registered unit was MAPPED. Those are both properties of source,
 * not of execution, and the difference was not academic: `reports_packages`
 * was credited as PROVEN while one of its two units,
 * `ExchangePackageBuilderSweep`, had never been driven by anything. It was
 * mapped, its family's suite existed, and the suite proved a different unit.
 *
 * That is also the origin of the 29-versus-30 discrepancy in the prior
 * report — see the conservation test below, which now derives the number
 * rather than restating it.
 *
 * A family now counts as proven only when EVERY registered unit in it has
 * EVERY manifest case recorded as executed, by a suite whose current bytes
 * match the bytes that recorded it.
 *
 * WHY THE MANIFEST CANNOT PROVE ITSELF
 * ---------------------------------------------------------------------------
 * The manifest is hand-written, so on its own it would be a claim. The gate
 * cross-checks it against the registry in BOTH directions: a registered unit
 * missing from the manifest fails, and a manifest entry naming a unit the
 * registry does not have fails. Family assignments are compared too, so a unit
 * cannot be credited under a family it does not belong to.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_WORK_REGISTRY,
  QUEUE_FAMILIES,
  type WorkName,
} from "@proovra/shared";

import {
  COMMON_CASES,
  FAMILY_COVERAGE,
  INAPPLICABLE_REASONS,
  NON_WAIVABLE_CASES,
  PROVEN_CASES_ARTIFACT,
  allRequiredCases,
  findFamiliesWithoutSuite,
  findFamilyMismatches,
  findInvalidInapplicableReasons,
  findMissingCommonCases,
  findNonWaivableWaivers,
  findPhantomUnits,
  findUncoveredUnits,
  manifestUnitCount,
  proofBindingHash,
  registeredUnitCount,
  type ProvenCasesArtifact,
  type ProvenSuiteRecord,
} from "./point5/family-coverage-manifest.js";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

// ===========================================================================
// Reading execution evidence
// ===========================================================================

/**
 * Every case identifier that actually ran, across all fresh suites.
 *
 * A suite's record is DISCARDED — not merely flagged — when the file that
 * wrote it is missing or has changed since. That is the whole freshness
 * guarantee: credit follows the bytes that earned it.
 */
function executedCases(): Set<string> {
  const out = new Set<string>();
  for (const [, record] of freshSuiteRecords()) {
    for (const c of record.cases ?? []) out.add(c);
  }
  return out;
}

function readArtifact(): ProvenCasesArtifact | null {
  const artifactPath = resolve(REPO, PROVEN_CASES_ARTIFACT);
  if (!existsSync(artifactPath)) return null;
  try {
    return JSON.parse(readFileSync(artifactPath, "utf8")) as ProvenCasesArtifact;
  } catch {
    return null;
  }
}

/**
 * Suite records that are FRESH — on four counts, not one.
 *
 * The SHA was the original guarantee and it only covers the suite's own bytes.
 * Three more are needed before a record may be believed, and each closes a way
 * an artifact could be green while the proof behind it was not:
 *
 *   RUN ID       a record with none cannot have come from a proof run;
 *   ONE RUN      every record must carry the SAME id, so a green artifact
 *                cannot be stitched together from several partial runs;
 *   BINDING      the record must have been computed against the CURRENT
 *                registry and manifest — otherwise an artifact written before
 *                a unit was added still credits a topology that has moved on.
 *
 * Anything failing one of these is DISCARDED rather than flagged, exactly as a
 * changed SHA already was: credit follows the run that earned it.
 */
function freshSuiteRecords(): Array<[string, ProvenSuiteRecord]> {
  const artifact = readArtifact();
  if (!artifact) return [];

  const binding = proofBindingHash();
  const candidates: Array<[string, ProvenSuiteRecord]> = [];
  for (const [suite, record] of Object.entries(artifact.suites ?? {})) {
    const suiteAbs = resolve(REPO, "services/api", suite);
    if (!existsSync(suiteAbs)) continue;
    const sha = createHash("sha256").update(readFileSync(suiteAbs)).digest("hex");
    if (sha !== record.sha256) continue;
    if (!record.runId?.trim()) continue;
    if (record.binding !== binding) continue;
    candidates.push([suite, record]);
  }

  // One run, or none. A mixture is not "mostly fresh" — it is an artifact
  // assembled from runs that never saw the same tree, and no subset of it can
  // be trusted to describe a single state.
  const runIds = new Set(candidates.map(([, r]) => r.runId));
  if (runIds.size > 1) return [];
  return candidates;
}

/** Registered units with no executed success case, as `family/workName`. */
function unitsWithoutExecutedProof(): string[] {
  const proven = executedCases();
  const out: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) {
      const missing = u.cases.filter((c) => !proven.has(c));
      if (missing.length > 0) out.push(`${f.family}/${u.workName}`);
    }
  }
  return out.sort();
}

/** Families where every registered unit has every manifest case executed. */
function provenFamilies(): string[] {
  const registeredByFamily = new Map<string, Set<WorkName>>();
  for (const e of CANONICAL_WORK_REGISTRY) {
    const s = registeredByFamily.get(e.family) ?? new Set<WorkName>();
    s.add(e.workName);
    registeredByFamily.set(e.family, s);
  }
  const provenCases = executedCases();

  const proven: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    const required = registeredByFamily.get(f.family) ?? new Set<WorkName>();
    if (required.size === 0) continue;

    const mapped = new Set(f.units.map((u) => u.workName));
    const allMapped = [...required].every((w) => mapped.has(w));
    if (!allMapped) continue;

    const allExecuted = f.units.every((u) =>
      u.cases.every((c) => provenCases.has(c)),
    );
    if (allExecuted) proven.push(f.family);
  }
  return proven.sort();
}

describe("Point 5 — family behavioural proof gate", () => {
  it("the manifest covers every registered runtime unit", () => {
    // Directionality matters: a unit added to the registry later must fail
    // here rather than quietly inherit its family's existing credit.
    const uncovered = findUncoveredUnits();
    expect(uncovered, `unmapped registered units:\n${uncovered.join("\n")}`).toEqual(
      [],
    );
  });

  it("the manifest names no unit the registry does not have", () => {
    const phantom = findPhantomUnits();
    expect(phantom, phantom.join("\n")).toEqual([]);
  });

  it("no unit is credited under the wrong family", () => {
    const mismatched = findFamilyMismatches();
    expect(mismatched, mismatched.join("\n")).toEqual([]);
  });

  it("every family appears in the manifest", () => {
    const missing = findFamiliesWithoutSuite();
    expect(missing, missing.join(", ")).toEqual([]);
    expect(FAMILY_COVERAGE).toHaveLength(QUEUE_FAMILIES.length);
  });

  it("every unit declares the common cases, or waives one with a valid reason", () => {
    const missing = findMissingCommonCases();
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("inapplicability reasons come from the CLOSED set", () => {
    const invalid = findInvalidInapplicableReasons();
    expect(invalid, invalid.join("\n")).toEqual([]);
    // The set stays small on purpose; widening it is how a security case gets
    // waived by a sentence.
    expect(INAPPLICABLE_REASONS.length).toBeLessThanOrEqual(6);
  });

  it("no unit waives a NON-WAIVABLE case", () => {
    // Tenancy, concurrency and idempotency are not negotiable. A unit that
    // cannot satisfy one has a production defect, not an exemption.
    const waivers = findNonWaivableWaivers();
    expect(waivers, waivers.join("\n")).toEqual([]);
    for (const c of NON_WAIVABLE_CASES) {
      expect(COMMON_CASES).toContain(c);
    }
  });

  it("every manifest executor path exists on disk", () => {
    // The manifest named `services/api/src/services/marketing/demo-request.service.ts`
    // for an entire pass. There is no `marketing/` directory. A unit whose
    // executor cannot be located is a unit nobody checked, and the case list
    // beside it is decoration.
    const missing: string[] = [];
    for (const f of FAMILY_COVERAGE) {
      for (const u of f.units) {
        if (!existsSync(resolve(REPO, u.executor))) {
          missing.push(`${u.workName}: ${u.executor}`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("case identifiers are unique — no unit can be credited by another's proof", () => {
    const all = allRequiredCases();
    const dupes = all.filter((c, i) => all.indexOf(c) !== i);
    expect([...new Set(dupes)], dupes.join(", ")).toEqual([]);
  });

  /**
   * CONSERVATION.
   *
   * The prior report said "30 of the 34 registered units remain" and then
   * listed six families summing to 29. Both halves were arithmetically fine
   * and one unit fell between them: `ExchangePackageBuilderSweep` sits in
   * `reports_packages`, a family the old gate had already credited, so it
   * appeared in neither the proven column nor the six-family remainder.
   *
   * The fix is not a corrected sentence. It is this assertion: proven units
   * plus unproven units must equal the registered total, computed from the
   * registry, so no unit can be lost between two hand-written lists again.
   */
  it("units are conserved: proven + unproven === registered === manifest", () => {
    const registered = registeredUnitCount();
    expect(manifestUnitCount(), "manifest unit count").toBe(registered);

    const unproven = unitsWithoutExecutedProof();
    const proven = registered - unproven.length;

    expect(proven + unproven.length, "conservation").toBe(registered);
    // PHASE 12 POINT 5 — this was the literal 32, and it moved twice: 34 -> 32
    // when `ExtractOcr`/`ExtractTranscript` were removed as duplicate no-op
    // authorities, and 32 -> 33 when ARCH-005 registered
    // `AutomationDispatchSweep`. Both times the literal had to be edited by
    // hand, which is the same maintenance-by-hand this programme keeps
    // removing. It is now an identity: the manifest must cover exactly the
    // registry's processing units, no more and no fewer.
    expect(registered, "registry processing-unit count").toBe(
      CANONICAL_WORK_REGISTRY.filter((e) => e.transport !== "bullmq_dlq").length,
    );
  });

  /**
   * THE METRIC.
   *
   * Reported as a computed value with the unproven families named, so the
   * number in any report can be checked against this output rather than taken
   * on trust. It is asserted to MATCH the current honest state; raising the
   * expectation without doing the work fails immediately.
   */
  it("QueueFamiliesBehaviorallyProven is derived, and the unproven families are named", () => {
    const proven = provenFamilies();
    const unproven = QUEUE_FAMILIES.filter((f) => !proven.includes(f)).sort();

    expect(proven.length + unproven.length).toBe(9);

    // Pinned to the CURRENT honest state. Raising this without doing the work
    // fails immediately, and finishing a family fails it too — which is
    // correct: the number in any report must be edited here, deliberately,
    // against a run that actually produced it.
    // All nine. Every entry was moved by a green run that produced the
    // artifact this gate reads; none was edited to make a report read better.
    expect(proven, `proven: ${proven.join(", ")}`).toEqual([
      "evidence_finalization",
      "intelligence_operations",
      "invite_delivery",
      "notifications",
      "reconciliation",
      "redaction",
      "reports_packages",
      "retention_destruction",
      "webhooks_providers",
    ]);
    expect(unproven, `unproven: ${unproven.join(", ")}`).toEqual([]);
  });

  it("POINT 5 CLOSURE requires 9/9, and it is MET", () => {
    // The closure condition, written as an executable statement rather than a
    // sentence in a document. It read `false` from the day it was written and
    // is inverted here, by hand, against the run that produced the artifact —
    // which was the point: nobody could report closure without changing this
    // line, and changing it without the run fails immediately.
    const closed = provenFamilies().length === 9;
    expect(closed, "Point 5 family closure").toBe(true);
    // Closure means every UNIT, not merely every family. A family with
    // partially-covered units could not have been credited above, but stating
    // it here makes the stronger claim the one under test.
    expect(unitsWithoutExecutedProof()).toEqual([]);
  });

  it("units with an EXECUTED behavioural case are counted, not assumed", () => {
    // The check that separates "a suite file exists" from "this unit was
    // driven". `ExchangePackageBuilderSweep` was credited by the former for
    // an entire pass while nothing had ever executed it — it is in the list
    // below, where it belongs, rather than silently inside a proven family.
    const unproven = unitsWithoutExecutedProof();
    const proven = registeredUnitCount() - unproven.length;

    // PHASE 12 POINT 5 — 32 of 32.
    //
    // The registered total fell from 34 when `ExtractOcr` and
    // `ExtractTranscript` were removed as duplicate no-op authorities. The
    // proven count then reached the total in two steps: 15 -> 20 with
    // intelligence & operations, and 20 -> 32 with the twelve reconciliation
    // units.
    //
    // Stated against `registeredUnitCount()` rather than as a second literal,
    // so a unit added to the registry without a proof moves this immediately.
    expect(proven, "units with executed Layer-B proof").toBe(
      registeredUnitCount(),
    );
    expect(unproven, `units mapped but never executed:\n${unproven.join("\n")}`)
      .toEqual([]);
    // The unit the old suite-existence rule silently credited now has its own
    // suite and its own executed cases, so it no longer appears here.
    expect(unproven).not.toContain(
      "reports_packages/ExchangePackageBuilderSweep",
    );
  });

  it("a family is NOT credited by the contract matrix alone", () => {
    // The 176-case contract matrix covers all nine families for payload
    // behaviour. That is deliberately not sufficient here: it proves what a
    // decoder refuses, not what a claim, a terminal write or a reconciler
    // does. The artifact is only ever written by state-machine suites, so
    // contract coverage cannot reach this gate's evidence at all.
    const artifactPath = resolve(REPO, PROVEN_CASES_ARTIFACT);
    expect(
      existsSync(artifactPath),
      "the proven-cases artifact must exist; run the integration project",
    ).toBe(true);
    const artifact = JSON.parse(
      readFileSync(artifactPath, "utf8"),
    ) as ProvenCasesArtifact;
    for (const suite of Object.keys(artifact.suites ?? {})) {
      expect(suite, "only state-machine suites may write proof").toMatch(
        /\.integration\.test\.ts$/,
      );
    }
  });

  it("every recorded proof carries a run id, and they all name ONE run", () => {
    // The predicate the SHA cannot supply. Without it an artifact written
    // weeks ago hash-matches an unedited suite forever, and the gate is green
    // without the integration project having run at all.
    const artifact = readArtifact();
    expect(artifact, "the proven-cases artifact must exist").not.toBeNull();
    const records = Object.entries(artifact!.suites ?? {});
    expect(records.length).toBeGreaterThan(0);

    const missingRunId = records
      .filter(([, r]) => !r.runId?.trim())
      .map(([s]) => s);
    expect(
      missingRunId,
      `records with no run id (cannot have come from a proof run):\n${missingRunId.join("\n")}`,
    ).toEqual([]);

    const runIds = [...new Set(records.map(([, r]) => r.runId))];
    expect(
      runIds,
      `proof stitched from ${runIds.length} runs: ${runIds.join(", ")}`,
    ).toHaveLength(1);
  });

  it("every recorded proof is BOUND to the current registry and manifest", () => {
    // A run id says the records came from one run. This says that run was
    // measuring the topology that exists NOW — so an artifact produced before
    // a unit was added, removed or re-mapped is stale, not merely old.
    const artifact = readArtifact();
    expect(artifact).not.toBeNull();
    const binding = proofBindingHash();
    const drifted = Object.entries(artifact!.suites ?? {})
      .filter(([, r]) => r.binding !== binding)
      .map(([s, r]) => `${s}: bound to ${String(r.binding).slice(0, 12)}…, current is ${binding.slice(0, 12)}…`);
    expect(
      drifted,
      `proof predates the current registry/manifest; re-run the integration project:\n${drifted.join("\n")}`,
    ).toEqual([]);
  });

  it("a stale or edited suite loses its credit", () => {
    // The freshness rule, asserted rather than described: every suite record
    // in the artifact must hash-match the file on disk right now.
    const artifactPath = resolve(REPO, PROVEN_CASES_ARTIFACT);
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(
      readFileSync(artifactPath, "utf8"),
    ) as ProvenCasesArtifact;
    const stale: string[] = [];
    for (const [suite, record] of Object.entries(artifact.suites ?? {})) {
      const suiteAbs = resolve(REPO, "services/api", suite);
      if (!existsSync(suiteAbs)) {
        stale.push(`${suite}: file missing`);
        continue;
      }
      const sha = createHash("sha256")
        .update(readFileSync(suiteAbs))
        .digest("hex");
      if (sha !== record.sha256) {
        stale.push(`${suite}: changed since it was proven`);
      }
    }
    expect(
      stale,
      `re-run the integration project:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
