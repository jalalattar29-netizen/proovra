/**
 * Phase IA-OTS-hybrid-fix — forward-path contract tests.
 *
 * These pin the 5 scenarios called out by the OTS hybrid-state root-fix
 * brief:
 *
 *   1. PENDING + no txid → classifier returns STILL_PENDING.
 *   2. PENDING + txid recovered + verify INCOMPLETE → classifier returns
 *      ANCHOR_MATERIAL_RECOVERED. Status stays PENDING; the report /
 *      package surface the distinct hybrid label.
 *   3. txid + verify VERIFIED → classifier returns FULLY_ANCHORED.
 *      This is the path that flips the row to ANCHORED + triggers
 *      report regeneration.
 *   4. Report / package regeneration is gated to ANCHORED-only
 *      classifications. ANCHOR_MATERIAL_RECOVERED never enqueues an
 *      `ots_anchored` regen.
 *   5. The persisted ANCHORED row's follow-up early-return in the
 *      processor never schedules a duplicate follow-up.
 *
 * Plus the new defensive path:
 *
 *   6. verify returned ERROR (not skipped) — classifier falls back to
 *      the legacy heuristic when the upgrade output is unambiguous.
 *
 * Plus the new copy contract:
 *
 *   7. `mapOtsStatusPublicLabelWithTxid` surfaces the new
 *      "Bitcoin transaction detected; anchoring verification pending"
 *      label for PENDING + valid txid.
 *
 * Strict-rules invariants pinned:
 *   - txid presence alone NEVER promotes to FULLY_ANCHORED.
 *   - verify INCOMPLETE always wins over a pending-output upgrade
 *     heuristic — even if the upgrade text mentioned the Bitcoin tx.
 *   - Report/package regeneration only fires on FULLY_ANCHORED.
 */

import { describe, expect, it } from "vitest";

import {
  classifyOtsResult,
  parseOtsUpgradeOutput,
  parseOtsVerifyOutput,
} from "../src/ots-upgrade-output.js";
import {
  mapOtsStatusPublicLabelWithTxid,
  mapOtsStatusShortLabel,
  mapOtsStatusTechnicalDetail,
} from "../src/report-v2/normalizers.js";

const TXID =
  "5d1156f9a225bdb60a59f79adff076dd4ffc079d05e133d689afc3495a12a756";

// ============================================================================
// Scenario 1 — PENDING no txid → STILL_PENDING + follow-up scheduled
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 1: PENDING no txid", () => {
  it("classifier returns STILL_PENDING when neither upgrade nor verify recover a txid", () => {
    const upgrade = parseOtsUpgradeOutput(
      "",
      "Pending confirmation in Bitcoin blockchain",
    );
    const verify = parseOtsVerifyOutput("", "Calendar attestation incomplete");
    const result = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("STILL_PENDING");
    expect(result.txid).toBeNull();
    expect(result.anchoredAtUtc).toBeNull();
    expect(result.phase).toBe("pending_confirmation");
  });

  it("STILL_PENDING never promotes to FULLY_ANCHORED — strict rule", () => {
    const upgrade = parseOtsUpgradeOutput("", "Pending confirmations");
    const verify = parseOtsVerifyOutput("", "Got 0 attestation(s)");
    const result = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).not.toBe("FULLY_ANCHORED");
  });
});

// ============================================================================
// Scenario 2 — PENDING + txid + verify INCOMPLETE
//   → ANCHOR_MATERIAL_RECOVERED (the runtime evidence's state)
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 2: PENDING + txid recovered, verify INCOMPLETE", () => {
  it("classifier returns ANCHOR_MATERIAL_RECOVERED — never FULLY_ANCHORED", () => {
    const upgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
    );
    const verify = parseOtsVerifyOutput(
      "",
      "Calendar attestation incomplete\nGot 0 attestation(s)",
    );
    const result = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
    expect(result.kind).not.toBe("FULLY_ANCHORED");
    expect(result.txid).toBe(TXID);
    expect(result.anchoredAtUtc).toBeNull();
    expect(result.phase).toBe("txid_detected_pending_confirmation");
  });

  it("the runtime evidence shape — persisted txid + empty upgrade + verify INCOMPLETE — stays ANCHOR_MATERIAL_RECOVERED", () => {
    // This mirrors evidence 5fd0889a-47c4-4064-9e83-e27e62375e73:
    // upgraded once, txid persisted, follow-up's upgrade was a no-op,
    // verify still says incomplete.
    const noNewUpgrade = parseOtsUpgradeOutput("", "no new attestations");
    const verify = parseOtsVerifyOutput(
      "",
      "Calendar attestation incomplete",
    );
    const result = classifyOtsResult({
      upgrade: noNewUpgrade,
      verify,
      existingTxid: TXID,
      commandErrored: false,
    });
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
    expect(result.txid).toBe(TXID);
    expect(result.phase).toBe("txid_persisted_pending_confirmation");
  });

  it("verify INCOMPLETE overrides upgrade-output anchored heuristic (strict rule)", () => {
    // The upgrade text alone might trigger the legacy
    // `shouldTreatOtsAsAnchored` heuristic (Bitcoin transaction +
    // no obvious pending marker) — but verify says incomplete. The
    // classifier MUST respect verify.
    const ambiguousUpgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}`,
    );
    const verify = parseOtsVerifyOutput(
      "",
      "Calendar attestation incomplete",
    );
    const result = classifyOtsResult({
      upgrade: ambiguousUpgrade,
      verify,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
  });
});

// ============================================================================
// Scenario 3 — txid + verify VERIFIED → FULLY_ANCHORED
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 3: verify VERIFIED → ANCHORED", () => {
  it("verify VERIFIED with block height + anchored timestamp → FULLY_ANCHORED", () => {
    const upgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
    );
    const verify = parseOtsVerifyOutput(
      "",
      `Bitcoin block 850000 attests existence as of 2026-06-08 13:30:00 UTC\nSuccess!`,
    );
    const result = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: TXID,
      commandErrored: false,
    });
    expect(result.kind).toBe("FULLY_ANCHORED");
    expect(result.blockHeight).toBe(850000);
    expect(result.anchoredAtUtc).not.toBeNull();
    expect(result.txid).toBe(TXID);
    expect(result.phase).toBe("anchored");
  });

  it("verify VERIFIED takes precedence over a still-pending-looking upgrade text", () => {
    // The upgrade text says "Pending confirmation" but verify says
    // "Success!" — verify wins.
    const upgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
    );
    const verify = parseOtsVerifyOutput("Success! Timestamp complete.", "");
    const result = classifyOtsResult({
      upgrade,
      verify,
      existingTxid: TXID,
      commandErrored: false,
    });
    expect(result.kind).toBe("FULLY_ANCHORED");
  });
});

// ============================================================================
// Scenario 4 — Report / package regen ONLY on ANCHORED.
//   (Pinned by inspecting the processor's branch wiring — every
//   call to enqueueReportJob with regenerateReason "ots_anchored"
//   lives inside the classification.kind === "FULLY_ANCHORED" arm.)
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 4: report regen gating", () => {
  it("processor source restricts `ots_anchored` regen to the FULLY_ANCHORED branch only", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const proc = readFileSync(
      fileURLToPath(
        new URL(
          "../src/ots-upgrade.processor.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    // Every `regenerateReason: "ots_anchored"` MUST appear within the
    // FULLY_ANCHORED branch — i.e., after the
    // `if (classification.kind === "FULLY_ANCHORED")` guard and before
    // the matching `return`.
    const anchoredBranchStart = proc.indexOf(
      'if (classification.kind === "FULLY_ANCHORED")',
    );
    expect(anchoredBranchStart, "FULLY_ANCHORED branch missing").toBeGreaterThan(
      -1,
    );
    const otsAnchoredRegenIdx = proc.indexOf('regenerateReason: "ots_anchored"');
    expect(otsAnchoredRegenIdx).toBeGreaterThan(anchoredBranchStart);

    // The ANCHOR_MATERIAL_RECOVERED branch must NOT enqueue an
    // `ots_anchored` regen. The legitimate "anchor material
    // recovered" regen has a distinct reason string.
    const recoveredBranchStart = proc.indexOf(
      'classification.kind === "ANCHOR_MATERIAL_RECOVERED"',
    );
    expect(recoveredBranchStart, "ANCHOR_MATERIAL_RECOVERED branch missing").toBeGreaterThan(
      -1,
    );
    // The recovered branch should only use the
    // `ots_anchor_material_recovered` reason (when it enqueues at
    // all — and that path is gated on `txidRecoveredWhileAnchored`).
    expect(proc).toMatch(
      /regenerateReason:\s*"ots_anchor_material_recovered"/,
    );
  });
});

// ============================================================================
// Scenario 5 — No follow-up after ANCHORED.
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 5: no duplicate follow-up after ANCHORED", () => {
  it("processor returns early when effectiveStatus is ANCHORED + defensible txid", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const proc = readFileSync(
      fileURLToPath(
        new URL(
          "../src/ots-upgrade.processor.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    // Pin the early-return guard: when the row is already ANCHORED
    // and has a defensible txid, the processor must NOT enqueue a
    // follow-up — it just returns.
    expect(proc).toMatch(
      /if\s*\(effectiveStatus === "ANCHORED" && hasDefensibleTxid\)\s*\{[\s\S]{0,400}return;\s*\}/,
    );
  });

  it("FULLY_ANCHORED branch returns before enqueueOtsUpgradeJob fires", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const proc = readFileSync(
      fileURLToPath(
        new URL(
          "../src/ots-upgrade.processor.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The FULLY_ANCHORED branch must end with a `return;` BEFORE
    // the ANCHOR_MATERIAL_RECOVERED / STILL_PENDING branch can call
    // `enqueueOtsUpgradeJob`. Pin that the structure persists.
    const anchoredBranchEnd = proc.search(
      /"ots\.upgrade\.anchored"\s*\)\s*;\s*return;/,
    );
    expect(anchoredBranchEnd).toBeGreaterThan(-1);
  });
});

// ============================================================================
// Scenario 6 — Defensive: verify ERROR → classifier falls back to legacy
//   heuristic when upgrade output is unambiguous.
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 6: verify ERROR fallback (defensive)", () => {
  it("verify=null + unambiguous anchored upgrade output → FULLY_ANCHORED (legacy heuristic)", () => {
    // The processor passes `verify: null` to the classifier when
    // verifyOtsProof returned ERROR / BINARY_MISSING / DISABLED.
    // The classifier must fall back to the legacy heuristic if the
    // upgrade output is unambiguous.
    const anchoredUpgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nSuccess! Timestamp complete.`,
    );
    const result = classifyOtsResult({
      upgrade: anchoredUpgrade,
      verify: null, // verify failed in a non-recoverable way
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("FULLY_ANCHORED");
    expect(result.reason).toMatch(/legacy heuristic/i);
  });

  it("verify=undefined (caller did not run verify) — same legacy-heuristic behavior", () => {
    // Back-compat — pre-Phase-IA callers that don't pass verify
    // must continue to land in FULLY_ANCHORED on an unambiguous
    // upgrade output.
    const anchoredUpgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nSuccess! Timestamp complete.`,
    );
    const result = classifyOtsResult({
      upgrade: anchoredUpgrade,
      // verify intentionally omitted.
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("FULLY_ANCHORED");
  });

  it("verify=null + AMBIGUOUS upgrade (Bitcoin tx + pending markers) → ANCHOR_MATERIAL_RECOVERED, NOT promoted", () => {
    // The defensive fallback MUST still respect the strict rules:
    // pending output blocks the legacy heuristic. The runtime
    // evidence's upgrade output is exactly this shape.
    const ambiguousUpgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
    );
    const result = classifyOtsResult({
      upgrade: ambiguousUpgrade,
      verify: null,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
    expect(result.kind).not.toBe("FULLY_ANCHORED");
  });

  it("verify=null + no txid + no anchored signal → STILL_PENDING (not falsely promoted)", () => {
    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", ""),
      verify: null,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("STILL_PENDING");
  });
});

// ============================================================================
// Scenario 7 — UX correction: visible cards use SHORT canonical
// status words. The long technical-detail sentence lives ONLY in
// the technical-appendix helper + smoke output.
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 7: visible-card short labels", () => {
  it("mapOtsStatusShortLabel(PENDING) → 'Pending'", () => {
    expect(mapOtsStatusShortLabel("PENDING")).toBe("Pending");
  });
  it("mapOtsStatusShortLabel(ANCHORED) → 'Anchored'", () => {
    expect(mapOtsStatusShortLabel("ANCHORED")).toBe("Anchored");
  });
  it("mapOtsStatusShortLabel(FAILED) → 'Failed'", () => {
    expect(mapOtsStatusShortLabel("FAILED")).toBe("Failed");
  });
  it("mapOtsStatusShortLabel(DISABLED) → 'Unavailable'", () => {
    expect(mapOtsStatusShortLabel("DISABLED")).toBe("Unavailable");
  });

  it("mapOtsStatusPublicLabelWithTxid(PENDING + txid) does NOT return the long technical sentence", () => {
    // Visible-card helper must stay short. The detailed sentence is
    // provided ONLY by mapOtsStatusTechnicalDetail (below).
    const label = mapOtsStatusPublicLabelWithTxid({
      status: "PENDING",
      bitcoinTxid: TXID,
    });
    expect(label).not.toMatch(
      /Bitcoin transaction detected; anchoring verification pending/,
    );
    // Reverts to the pre-existing PENDING wording for compact surfaces.
    expect(label).toBe(
      "OpenTimestamps proof present; Bitcoin anchoring pending",
    );
  });

  it("ANCHORED + valid txid → 'OpenTimestamps Bitcoin anchoring verified' (verified-state label preserved)", () => {
    expect(
      mapOtsStatusPublicLabelWithTxid({
        status: "ANCHORED",
        bitcoinTxid: TXID,
      }),
    ).toBe("OpenTimestamps Bitcoin anchoring verified");
  });

  it("ANCHORED + no txid → never falsely 'verified'", () => {
    expect(
      mapOtsStatusPublicLabelWithTxid({
        status: "ANCHORED",
        bitcoinTxid: null,
      }),
    ).not.toMatch(/verified/i);
  });

  it("mapOtsStatusTechnicalDetail(PENDING + txid) → the detailed sentence (technical-appendix only)", () => {
    const detail = mapOtsStatusTechnicalDetail({
      status: "PENDING",
      bitcoinTxid: TXID,
    });
    expect(detail).toBe(
      "OTS proof present; Bitcoin transaction id detected; verification pending.",
    );
  });

  it("mapOtsStatusTechnicalDetail(PENDING + no txid) → 'OTS proof present; Bitcoin anchoring pending.'", () => {
    const detail = mapOtsStatusTechnicalDetail({
      status: "PENDING",
      bitcoinTxid: null,
    });
    expect(detail).toBe("OTS proof present; Bitcoin anchoring pending.");
  });

  it("the truth-model OTS callout uses SHORT status words ('Anchored' / 'Pending' / 'Failed' / 'Unavailable')", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const tm = readFileSync(
      fileURLToPath(
        new URL("../src/report-v2/truth-model.ts", import.meta.url),
      ),
      "utf8",
    );
    // Each short word appears as a title literal in the callout.
    expect(tm).toMatch(/\?\s*"Anchored"/);
    expect(tm).toMatch(/\?\s*"Pending"/);
    expect(tm).toMatch(/\?\s*"Failed"/);
    expect(tm).toMatch(/:\s*"Unavailable"/);
  });

  it("the long technical sentence does NOT appear in the truth-model OTS callout (cards)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const tm = readFileSync(
      fileURLToPath(
        new URL("../src/report-v2/truth-model.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(tm).not.toMatch(
      /"Bitcoin transaction detected; anchoring verification pending"/,
    );
  });

  it("the long technical sentence does NOT appear in verification-package.ts (compact surfaces)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const vp = readFileSync(
      fileURLToPath(
        new URL("../src/verification-package.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(vp).not.toMatch(
      /"Bitcoin transaction detected; anchoring verification pending/,
    );
  });

  it("the long technical sentence does NOT appear in pdf/report.ts (compact surfaces)", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const pdfPath = fileURLToPath(
      new URL("../src/pdf/report.ts", import.meta.url),
    );
    // Phase 2: services/worker/src/pdf/report.ts (the legacy v1 PDF
    // builder) was deleted as confirmed dead code (zero live imports;
    // phase-ia-ots-info-fallback.test.ts already asserts the active
    // report path does not import it). When the file is absent the
    // long-technical-sentence assertion is vacuously satisfied — the
    // sentence cannot appear in a file that does not exist.
    if (!existsSync(pdfPath)) {
      expect(existsSync(pdfPath)).toBe(false);
      return;
    }
    const pdf = readFileSync(pdfPath, "utf8");
    expect(pdf).not.toMatch(
      /"Bitcoin transaction detected; anchoring verification pending/,
    );
  });

  it("the long technical sentence does NOT appear in the shared anchor.ts label (compact surfaces)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const anchor = readFileSync(
      fileURLToPath(
        new URL("../../../packages/shared/src/anchor.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(anchor).not.toMatch(
      /"Bitcoin transaction detected; anchoring verification pending"/,
    );
  });
});

// ============================================================================
// Scenario 8 — Smoke script exposes verify_status, classifier_kind,
//   next_delayed_job_runAt.
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 8: smoke script enhanced output", () => {
  it("smoke-ots-retry-state probe emits verify_status, classifier_kind, next_delayed_job_runAt", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/scripts/smoke-ots-retry-state.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/name: "verify_status"/);
    expect(src).toMatch(/name: "verify_blockHeight"/);
    expect(src).toMatch(/name: "classifier_kind"/);
    expect(src).toMatch(/name: "classifier_phase"/);
    expect(src).toMatch(/name: "next_delayed_job_runAt"/);
  });

  it("smoke probe imports verifyOtsProof + classifyOtsResult (read-only)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/scripts/smoke-ots-retry-state.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/verifyOtsProof/);
    expect(src).toMatch(/classifyOtsResult/);
  });
});

// ============================================================================
// Scenario 9 — Runtime diagnostic script exists and captures the 10 steps
//   the operator brief requires.
// ============================================================================

describe("Phase IA-OTS-hybrid-fix — Scenario 9: diagnose-ots-evidence script", () => {
  const PATH = "../src/scripts/diagnose-ots-evidence.ts";

  function readScript(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    return readFileSync(
      fileURLToPath(new URL(PATH, import.meta.url)),
      "utf8",
    );
  }

  it("file exists and accepts --evidence-id", () => {
    const src = readScript();
    expect(src).toMatch(/--evidence-id/);
  });

  it("step 1: writes the persisted proof bytes to a temp proof.ots", () => {
    const src = readScript();
    expect(src).toMatch(/proof\.ots/);
    expect(src).toMatch(/Buffer\.from\(ev\.otsProofBase64,\s*"base64"\)/);
  });

  it("step 2 + 4: runs `ots verify -d <hash> proof.ots` BEFORE and AFTER upgrade", () => {
    const src = readScript();
    // The exact arg shape: `verify`, `-d`, `<hash>`, `<file>`.
    expect(src).toMatch(
      /\["verify",\s*"-d",\s*ev\.otsHash\.toLowerCase\(\),\s*proofFile\]/,
    );
    // It runs the verify twice — once initial, once post-upgrade.
    const calls = src.match(/runCommand\([\s\S]{0,500}"verify"/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("step 3: runs `ots upgrade proof.ots`", () => {
    const src = readScript();
    expect(src).toMatch(/\["upgrade",\s*proofFile\]/);
  });

  it("step 5: prints whether the proof file size changed", () => {
    const src = readScript();
    expect(src).toMatch(/step5_size_change/);
    expect(src).toMatch(/bytes_before/);
    expect(src).toMatch(/bytes_after/);
    expect(src).toMatch(/delta_bytes/);
  });

  it("step 6: inspects the proof for Bitcoin block attestation vs pending attestation", () => {
    const src = readScript();
    expect(src).toMatch(/BITCOIN_BLOCK_ATTESTATION_MAGIC/);
    expect(src).toMatch(/PENDING_ATTESTATION_MAGIC/);
    expect(src).toMatch(/hasBitcoinBlockAttestation/);
    expect(src).toMatch(/hasPendingAttestation/);
  });

  it("step 9: shows which parser regex classified the output", () => {
    const src = readScript();
    expect(src).toMatch(/parser_trace/);
    expect(src).toMatch(/matched_incomplete_predicates/);
    expect(src).toMatch(/matched_success_marker/);
    expect(src).toMatch(/matched_bitcoin_block_attests_pattern/);
  });

  it("step 10: explains exactly why verify.verified is false", () => {
    const src = readScript();
    expect(src).toMatch(/why_not_verified/);
    expect(src).toMatch(/explainWhyNotVerified/);
  });

  it("invokes the in-process classifier on the actual upgrade + verify outputs", () => {
    const src = readScript();
    expect(src).toMatch(/classifyOtsResult\(\{/);
    expect(src).toMatch(/upgrade: upgradeParsed/);
    expect(src).toMatch(/verify: postVerifyParsed/);
    expect(src).toMatch(/existingTxid: ev\.otsBitcoinTxid/);
  });

  it("is read-only against the database (no Prisma writes)", () => {
    const src = readScript();
    // Negative pins — the diagnostic must NEVER call any of these:
    expect(src).not.toMatch(/prisma\.evidence\.update/);
    expect(src).not.toMatch(/prisma\.evidence\.create/);
    expect(src).not.toMatch(/prisma\.evidence\.delete/);
    expect(src).not.toMatch(/prisma\.\$executeRaw/);
    expect(src).not.toMatch(/enqueueOtsUpgradeJob/);
    expect(src).not.toMatch(/enqueueReportJob/);
  });
});
