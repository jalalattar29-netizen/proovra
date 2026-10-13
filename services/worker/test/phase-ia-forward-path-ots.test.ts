/**
 * Phase IA-forward-path-OTS — deterministic forward-path test.
 *
 * Pins the NEW EVIDENCE OTS forward path so it cannot regress without
 * tripping these assertions:
 *
 *   1. Initial OTS creation (processor.ts) calls `createOpenTimestamp`
 *      and writes the proof bytes to the Evidence row.
 *   2. After the initial proof lands, `enqueueOtsUpgradeJob` is called
 *      so the upgrade loop runs automatically.
 *   3. The upgrade processor runs `ots upgrade` and decides on the bytes it
 *      leaves through the one OTS authority (resolveOtsAnchoring): ANCHORED
 *      requests the downstream version decision, PENDING re-enqueues the
 *      follow-up, a defect is FAILED with a bounded code (2026-10-13).
 *
 * This test does NOT mock the worker — it pins the source contract; the
 * behaviour is run in ots-upgrade-processor.behaviour.test.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { enclosingSource } from "../../../scripts/source-contract/index.mjs";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ============================================================================
// 1. Initial OTS create + enqueue — processor.ts
// ============================================================================

/**
 * REWRITTEN — OTS INTEGRITY DECOUPLING.
 *
 * This block pinned the initial stamp INSIDE the report processor: that it
 * imported `createOpenTimestamp`, called it during the run, and enqueued the
 * follow-up through a `scheduleOtsUpgrade` gate. Every one of those assertions
 * was an accurate description of the code and a description of the defect.
 *
 * Stamping from the report job meant a record only ever reached the calendar
 * if its plan included reports. A Free record has no report job, so it never
 * obtained an anchor — while Pricing lists OpenTimestamps under "Every plan
 * includes". The proof was also created and then discarded whenever the
 * entitlement gate refused a few lines later.
 *
 * The forward path still exists and is still pinned; it just belongs to the
 * integrity lifecycle now. What follows asserts the same property — a new
 * record gets stamped, and the follow-up ladder is scheduled — at its new and
 * correct owner, plus the ABSENCE that makes the decoupling real.
 */
describe("OTS forward path — initial create belongs to the integrity lifecycle", () => {
  const PROCESSOR = readSource("../src/processor.ts");
  const LIFECYCLE = readSource("../src/ots-lifecycle.ts");
  const UPGRADE = readSource("../src/ots-upgrade.processor.ts");

  it("the lifecycle module is the one caller of createOpenTimestamp", () => {
    expect(LIFECYCLE).toMatch(
      /import\s*\{\s*createOpenTimestamp[\s\S]{0,200}from\s*["']\.\/ots\.service\.js["']/,
    );
    expect(LIFECYCLE).toMatch(/createOpenTimestamp\(\s*\{/);
  });

  it("it stamps the finalized canonical fingerprint, not a report-shaped input", () => {
    // The stamped content must be the record's own stable digest, so the proof
    // means something without reference to any artifact built from it.
    expect(LIFECYCLE).toMatch(
      /content:\s*Buffer\.from\(evidence\.fingerprintCanonicalJson/,
    );
    // And it declines rather than inventing one when finalization has not
    // produced that digest yet.
    expect(LIFECYCLE).toMatch(/if\s*\(!evidence\.fingerprintCanonicalJson\)/);
  });

  it("the upgrade processor initializes when a record has no proof yet", () => {
    // The old code returned "skipped_missing_proof" here — a dead end for
    // exactly the records that had never been stamped.
    // The whole `if (!evidence.otsProofBase64) { … }` statement.
    const block = enclosingSource(UPGRADE, "if (!evidence.otsProofBase64)", "statement", {
      fileName: "ots-upgrade.processor.ts",
    });
    expect(block).toMatch(/ensureEvidenceOtsInitialized\(\{/);
    expect(block).toMatch(/enqueueOtsUpgradeJob\(evidenceId,/);
  });

  it("the REPORT processor no longer creates, writes or schedules OTS", () => {
    /*
     * The decoupling, stated as an absence. A disabled or conditional copy
     * left in the report job would be a second writer waiting to be switched
     * back on, so none of these may appear in it at all.
     *
     * Comments are stripped first: this file's own explanation of what was
     * removed names those symbols, and prose must not satisfy or break a rule.
     */
    const code = PROCESSOR.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^[ \t]*\/\/.*$/gm,
      "",
    );
    expect(code).not.toMatch(/createOpenTimestamp/);
    expect(code).not.toMatch(/buildOtsEvidenceUpdateData/);
    expect(code).not.toMatch(/enqueueOtsUpgrade(Job|Retry)/);
    expect(code).not.toMatch(/scheduleOtsUpgrade/);
  });

  it("the report reads the record's stored OTS state instead", () => {
    // `prepareReportArtifacts` took an `otsResult` the job had just produced
    // and preferred it over the row. With no stamp of its own to prefer, the
    // projection is the row — one source, and re-runnable.
    // Since 2026-10-08 the row is mapped by ONE function (reportLifecycleFields)
    // — when the payload is prepared AND again from the run's render snapshot.
    const MAPPING = readSource("../src/output-verification.ts");
    expect(MAPPING).toMatch(/otsProofBase64:\s*row\.otsProofBase64\s*\?\?\s*null/);
    expect(MAPPING).toMatch(/otsStatus:\s*row\.otsStatus\s*\?\?\s*null/);
    expect(PROCESSOR).toMatch(/\.\.\.reportLifecycleFields\(evidence as /);
    expect(PROCESSOR).toMatch(/\.\.\.reportLifecycleFields\(renderSnapshot\.lifecycle, renderSnapshot\.custody\)/);
  });
});

// ============================================================================
// 2. Upgrade processor — the executed proof decides (2026-10-13)
// ============================================================================

describe("upgrade processor — the state comes from the executed proof", () => {
  const UP = readSource("../src/ots-upgrade.processor.ts");

  it("runs `ots upgrade` and decides on the bytes it leaves, through the one authority", () => {
    expect(UP).toMatch(/execFileAsync\(resolveOtsBin\(\), \["upgrade", file\]/);
    expect(UP).toMatch(/resolveOtsAnchoring\(\{/);
    expect(UP).toMatch(/decideOtsTransition\(snapshot, observation, observedAt\)/);
  });

  it("no `ots info`, `ots verify`, chain verifier, Bitcoin node or output classifier remains", () => {
    expect(UP).not.toMatch(/getOtsProofInfo|verifyOtsProof|classifyOtsResult|parseOtsUpgradeOutput|ots-chain-verifier|chainRecheckDue|OTS_BITCOIN_NODE_URL|OTS_CHAIN_VERIFIER/);
  });

  it("ANCHORED requests the downstream version decision; nothing else does", () => {
    const calls = UP.match(/requestAnchoredReportVersion\(/g) ?? [];
    // the definition, the terminal re-ask, and the transition
    expect(calls.length).toBe(3);
    expect(UP).toMatch(/if \(transition\.status === "ANCHORED"\) \{\s*await requestAnchoredReportVersion\(/);
    expect(UP).not.toMatch(/enqueueReportGenerationRequest|enqueueReportJob/);
  });

  it("only a PENDING outcome schedules the follow-up", () => {
    expect(UP).toMatch(/if \(transition\.status === "PENDING"\) \{[\s\S]{0,300}enqueueOtsUpgradeJob\(evidenceId,/);
  });
});
