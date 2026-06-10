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
 *   3. The upgrade processor runs `ots upgrade` THEN `ots verify`, then
 *      feeds BOTH outputs through `classifyOtsResult`.
 *   4. FULLY_ANCHORED → writes ANCHORED + enqueueReportJob with
 *      `regenerateReason: "ots_anchored"` — IN the same prisma.$transaction.
 *   5. ANCHOR_MATERIAL_RECOVERED → keeps PENDING + persists the txid
 *      + emits a custody event whose payload exposes
 *      `classification: "ANCHOR_MATERIAL_RECOVERED"` AND re-enqueues
 *      a follow-up via the stable jobId.
 *   6. STILL_PENDING → re-enqueues the follow-up, NO report regen.
 *   7. The global attempt budget bounds infinite retries and transitions
 *      to FAILED + OperationalIncident when exhausted.
 *
 * This test does NOT mock the worker — it pins the source contract so a
 * refactor cannot quietly bypass the bounded classifier or drop the
 * regen call. The pure-function classifier tests in
 * ots-classification.test.ts already cover the classifier semantics; this
 * file pins the WIRING — that the processor actually uses it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyOtsResult,
  parseOtsUpgradeOutput,
  parseOtsVerifyOutput,
} from "../src/ots-upgrade-output.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ============================================================================
// 1. Initial OTS create + enqueue — processor.ts
// ============================================================================

describe("Phase IA-forward-path-OTS — initial create + enqueue", () => {
  const PROCESSOR = readSource("../src/processor.ts");

  it("imports createOpenTimestamp from ots.service", () => {
    expect(PROCESSOR).toMatch(
      /import\s*\{\s*createOpenTimestamp[\s\S]{0,200}from\s*["']\.\/ots\.service\.js["']/,
    );
  });

  it("imports enqueueOtsUpgradeJob from queue.js", () => {
    expect(PROCESSOR).toMatch(
      /import\s*\{[\s\S]{0,400}enqueueOtsUpgradeJob[\s\S]{0,400}from\s*["']\.\/queue\.js["']/,
    );
  });

  it("calls createOpenTimestamp during the report processor run", () => {
    expect(PROCESSOR).toMatch(/createOpenTimestamp\(\s*\{/);
  });

  it("uses scheduleOtsUpgrade gate to enqueue the upgrade follow-up", () => {
    // The processor consults `scheduleOtsUpgrade` to decide whether to
    // enqueue the follow-up; that decision flows back through finalize
    // and is read at the top-level scope.
    expect(PROCESSOR).toMatch(/scheduleOtsUpgrade\s*=\s*true/);
    expect(PROCESSOR).toMatch(
      /if\s*\(\s*!finalized\.skipped\s*&&\s*finalized\.scheduleOtsUpgrade\s*\)/,
    );
  });

  it("calls the OTS upgrade enqueue inside that gate (NOT outside)", () => {
    // The gate calls `enqueueOtsUpgradeRetry`, a thin wrapper around
    // `enqueueOtsUpgradeJob` (see processor.ts:~1703). Pin either name
    // so a refactor that drops the wrapper is still caught.
    const gateIdx = PROCESSOR.indexOf("finalized.scheduleOtsUpgrade");
    expect(gateIdx).toBeGreaterThan(-1);
    const block = PROCESSOR.slice(gateIdx, gateIdx + 600);
    expect(block).toMatch(/enqueueOtsUpgrade(Retry|Job)\(/);
  });

  it("enqueueOtsUpgradeRetry wrapper calls enqueueOtsUpgradeJob", () => {
    // The wrapper exists for retry-context wrapping but it MUST land
    // on enqueueOtsUpgradeJob so the BullMQ follow-up is registered.
    expect(PROCESSOR).toMatch(
      /async function enqueueOtsUpgradeRetry\([\s\S]{0,200}enqueueOtsUpgradeJob\(/,
    );
  });
});

// ============================================================================
// 2. Upgrade processor — verify + classify wiring
// ============================================================================

describe("Phase IA-forward-path-OTS — upgrade processor wires verify + classifier", () => {
  const UP = readSource("../src/ots-upgrade.processor.ts");

  it("imports verifyOtsProof from ots.service", () => {
    expect(UP).toMatch(
      /import\s*\{[\s\S]{0,200}verifyOtsProof[\s\S]{0,200}from\s*["']\.\/ots\.service\.js["']/,
    );
  });

  it("imports classifyOtsResult from ots-upgrade-output", () => {
    expect(UP).toMatch(
      /import\s*\{[\s\S]{0,200}classifyOtsResult[\s\S]{0,200}from\s*["']\.\/ots-upgrade-output\.js["']/,
    );
  });

  it("runs ots upgrade THEN ots verify in the upgrade attempt", () => {
    // upgrade subprocess executes first, then verify is awaited.
    const upgradeIdx = UP.indexOf('execFileAsync(resolveOtsBin(), ["upgrade"');
    const verifyIdx = UP.indexOf("verifyOtsProof({");
    expect(upgradeIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(upgradeIdx);
  });

  it("feeds BOTH parser outputs through classifyOtsResult", () => {
    expect(UP).toMatch(
      /classifyOtsResult\(\{[\s\S]{0,400}upgrade:\s*parsedUpgrade[\s\S]{0,400}verify[\s\S]{0,400}existingTxid[\s\S]{0,400}commandErrored/,
    );
  });

  it("FULLY_ANCHORED branch writes ANCHORED + enqueueReportJob ots_anchored", () => {
    const idx = UP.indexOf('if (classification.kind === "FULLY_ANCHORED")');
    expect(idx).toBeGreaterThan(-1);
    // Phase IA-OTS-info-fallback — slice widened from 2500→5000 to
    // accommodate the additional custody-payload fields the info
    // probe adds (`infoStatus`, `infoFileHashMatches`,
    // `infoBlockHeights`).
    const block = UP.slice(idx, idx + 5000);
    expect(block).toMatch(/status:\s*"ANCHORED"/);
    expect(block).toMatch(/enqueueReportJob\(evidenceId,\s*\{/);
    expect(block).toMatch(/regenerateReason:\s*"ots_anchored"/);
    expect(block).toMatch(/forceRegenerate:\s*true/);
  });

  it("FULLY_ANCHORED branch writes ANCHORED + custody event inside the SAME transaction", () => {
    const idx = UP.indexOf('if (classification.kind === "FULLY_ANCHORED")');
    const block = UP.slice(idx, idx + 5000);
    expect(block).toMatch(
      /prisma\.\$transaction\(async \(tx\) => \{[\s\S]{0,1200}tx\.evidence\.update[\s\S]{0,1500}appendCustodyEventTx\(tx,/,
    );
  });

  it("FULLY_ANCHORED custody event payload exposes verifyConfirmed + completionSource", () => {
    const idx = UP.indexOf('if (classification.kind === "FULLY_ANCHORED")');
    const block = UP.slice(idx, idx + 5000);
    // Phase IA-OTS-info-fallback — `verifyConfirmed` now means
    // "verify succeeded" (verify?.verified === true), not just
    // "verify ran". `completionSource` now has 3 values:
    // `ots_info_no_verify_available` (info-confirms branch),
    // `ots_verify` (verify-confirms branch), `ots_upgrade_heuristic`
    // (legacy fallback).
    expect(block).toMatch(/verifyConfirmed:\s*verify\?\.\s*verified === true/);
    expect(block).toMatch(/"ots_info_no_verify_available"/);
    expect(block).toMatch(/"ots_verify"/);
    expect(block).toMatch(/"ots_upgrade_heuristic"/);
  });

  it("ANCHOR_MATERIAL_RECOVERED / STILL_PENDING branch keeps PENDING + records classification", () => {
    const idx = UP.indexOf('classification.kind === "ANCHOR_MATERIAL_RECOVERED"');
    expect(idx).toBeGreaterThan(-1);
    const block = UP.slice(idx, idx + 4000);
    // Status stays PENDING (or preserved-ANCHORED for the legacy
    // anchored-no-public-receipt case).
    expect(block).toMatch(/status:\s*shouldPreserveAnchoredState\s*\?\s*"ANCHORED"\s*:\s*"PENDING"/);
    // Custody event carries the classifier kind for forensics.
    expect(block).toMatch(/classification:\s*classification\.kind/);
    expect(block).toMatch(/classifierPhase:\s*classification\.phase/);
    expect(block).toMatch(/classifierReason:\s*classification\.reason/);
  });

  it("PENDING branch re-enqueues follow-up with a STABLE jobId (no counter reset)", () => {
    // The stable jobId is the production fix that keeps BullMQ's
    // `attempts` ceiling enforced across re-enqueues.
    expect(UP).toMatch(/buildFollowUpJobId\(evidenceId\)/);
    expect(UP).toMatch(/enqueueOtsUpgradeJob\(evidenceId,\s*\{/);
    expect(UP).toMatch(/delayMs:\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it("PENDING branch does NOT enqueue a report regen (no false ANCHORED truth)", () => {
    // The ONLY enqueueReportJob calls in the upgrade processor are
    // gated on FULLY_ANCHORED or txidRecoveredWhileAnchored (which is
    // the legacy already-ANCHORED-but-no-txid case). Pin both arms so
    // a refactor cannot add a stray regen on bare PENDING.
    const regenSites = UP.match(/enqueueReportJob\(evidenceId,/g) ?? [];
    expect(regenSites.length).toBe(2);
    const firstIdx = UP.indexOf("enqueueReportJob(evidenceId");
    const beforeFirst = UP.slice(0, firstIdx);
    expect(beforeFirst).toMatch(
      /classification\.kind === "FULLY_ANCHORED"[\s\S]{0,3000}$/,
    );
  });

  it("global budget exhaustion writes FAILED + records OperationalIncident", () => {
    const idx = UP.indexOf("isOtsGlobalBudgetExhausted");
    expect(idx).toBeGreaterThan(-1);
    // Scan FORWARD from the call site for the exhausted branch — the
    // declaration of isOtsGlobalBudgetExhausted appears earlier in the
    // file so we want the LAST occurrence (the call inside the
    // PENDING-else branch).
    const callIdx = UP.lastIndexOf("isOtsGlobalBudgetExhausted({");
    expect(callIdx).toBeGreaterThan(-1);
    const block = UP.slice(callIdx, callIdx + 2500);
    expect(block).toMatch(/status:\s*"FAILED"/);
    expect(block).toMatch(/failureReason:\s*"OTS_GLOBAL_BUDGET_EXHAUSTED"/);
    expect(block).toMatch(/recordWorkerIncident\(/);
    expect(block).toMatch(/severity:\s*"CRITICAL"/);
  });
});

// ============================================================================
// 3. End-to-end classifier — FULLY_ANCHORED is gated on verify
// ============================================================================

describe("Phase IA-forward-path-OTS — classifier promotes ONLY on verify success", () => {
  it("verify SUCCESS → FULLY_ANCHORED with anchoredAtUtc + blockHeight", () => {
    const upgradeStdout =
      "Bitcoin transaction id: 0000000000000000000000000000000000000000000000000000000000000001\n";
    const verifyStdout =
      "Success! Bitcoin block 800000 attests existence as of 2026-06-08 13:30:00 UTC\n";
    const upgrade = parseOtsUpgradeOutput(upgradeStdout, "");
    const verify = parseOtsVerifyOutput(verifyStdout, "");
    const cls = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: null,
      commandErrored: false,
      mergedErrorText: null,
    });
    expect(cls.kind).toBe("FULLY_ANCHORED");
    expect(cls.blockHeight).toBe(800000);
    expect(cls.anchoredAtUtc).not.toBeNull();
    expect(cls.phase).toBe("anchored");
  });

  it("verify INCOMPLETE + txid in upgrade → ANCHOR_MATERIAL_RECOVERED (NOT anchored)", () => {
    const upgradeStdout =
      "Bitcoin transaction: 0000000000000000000000000000000000000000000000000000000000000001\nPending confirmation in Bitcoin blockchain\n";
    const verifyStdout = "Calendar attestation incomplete\nGot 0 attestation(s)\n";
    const upgrade = parseOtsUpgradeOutput(upgradeStdout, "");
    const verify = parseOtsVerifyOutput(verifyStdout, "");
    const cls = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: null,
      commandErrored: false,
      mergedErrorText: null,
    });
    expect(cls.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
    expect(cls.txid).toBe(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(cls.phase).toBe("txid_detected_pending_confirmation");
  });

  it("no txid + no verify success → STILL_PENDING (no report regen)", () => {
    const upgradeStdout = "Pending confirmations\n";
    const verifyStdout = "Calendar attestation incomplete\n";
    const upgrade = parseOtsUpgradeOutput(upgradeStdout, "");
    const verify = parseOtsVerifyOutput(verifyStdout, "");
    const cls = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: null,
      commandErrored: false,
      mergedErrorText: null,
    });
    expect(cls.kind).toBe("STILL_PENDING");
    expect(cls.txid).toBeNull();
  });

  it("upgrade reports anchored heuristic with NO verify → FULLY_ANCHORED (legacy fallback)", () => {
    // When the worker cannot run verify (no hash), the legacy heuristic
    // is honored as a back-compat fallback. Pin the call shape: verify
    // is `undefined`, NOT `null`.
    const upgradeStdout = "Success! Timestamp complete\n";
    const upgrade = parseOtsUpgradeOutput(upgradeStdout, "");
    const cls = classifyOtsResult({
      upgrade,
      // verify omitted intentionally
      existingTxid: null,
      commandErrored: false,
      mergedErrorText: null,
    });
    expect(cls.kind).toBe("FULLY_ANCHORED");
  });

  it("hard command error with no pending-like text → FAILED (NOT marked anchored)", () => {
    const upgrade = parseOtsUpgradeOutput("", "");
    const cls = classifyOtsResult({
      upgrade,
      verify: null,
      existingTxid: null,
      commandErrored: true,
      mergedErrorText: "Segmentation fault (core dumped)",
    });
    expect(cls.kind).toBe("FAILED");
  });

  it("pending-like error (timeout) does NOT promote to FAILED", () => {
    const upgrade = parseOtsUpgradeOutput("", "");
    const cls = classifyOtsResult({
      upgrade,
      verify: null,
      existingTxid: null,
      commandErrored: true,
      mergedErrorText: "calendar request timed out",
    });
    // Timeout-like errors do not flag the proof as definitively FAILED;
    // the proof keeps trying on the follow-up.
    expect(cls.kind).not.toBe("FAILED");
  });
});
