/**
 * Phase IA-OTS-hybrid — contract tests.
 *
 * Pins the deterministic state classification + the verify-output
 * parser. The hybrid-state bug (PENDING + bitcoin txid + no
 * anchored_at_utc) is exactly the scenario `classifyOtsResult`
 * must classify as ANCHOR_MATERIAL_RECOVERED and never as
 * FULLY_ANCHORED.
 */

import { describe, expect, it } from "vitest";

import {
  classifyOtsResult,
  parseOtsUpgradeOutput,
  parseOtsVerifyOutput,
} from "../src/ots-upgrade-output.js";

const TXID =
  "b367efcc123f735aab11a5bdf4a3980bcc0ca413148d123cda8b419a9f6b57ed";

// =============================================================================
// parseOtsVerifyOutput
// =============================================================================

describe("parseOtsVerifyOutput", () => {
  it("recognizes a successful verify with block height + anchored date", () => {
    const out = parseOtsVerifyOutput(
      `Got 1 attestation(s) from https://a.pool.opentimestamps.org\nBitcoin block 850000 attests existence as of 2026-06-08 13:30:00 UTC\nSuccess! Bitcoin block 850000 attests existence`,
    );
    expect(out.verified).toBe(true);
    expect(out.incompleteOutput).toBe(false);
    expect(out.blockHeight).toBe(850000);
    expect(out.anchoredAtUtc).not.toBeNull();
  });

  it("treats 'success!' alone (no block line) as verified", () => {
    const out = parseOtsVerifyOutput("Success! Timestamp complete.");
    expect(out.verified).toBe(true);
  });

  it("does NOT mark verified when output explicitly says incomplete", () => {
    const out = parseOtsVerifyOutput(
      "",
      `Calendar attestation incomplete\nGot 0 attestation(s)`,
    );
    expect(out.verified).toBe(false);
    expect(out.incompleteOutput).toBe(true);
  });

  it("does NOT mark verified on pending-confirmations output", () => {
    const out = parseOtsVerifyOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmations: 3/6`,
    );
    expect(out.verified).toBe(false);
    expect(out.incompleteOutput).toBe(true);
  });

  it("does NOT extract a fake block height on incomplete output", () => {
    const out = parseOtsVerifyOutput("", "Calendar attestation incomplete");
    expect(out.blockHeight).toBeNull();
    expect(out.anchoredAtUtc).toBeNull();
  });
});

// =============================================================================
// classifyOtsResult — the hybrid-state bug
// =============================================================================

describe("classifyOtsResult — hybrid state safeguards", () => {
  const PENDING_UPGRADE_WITH_TXID = parseOtsUpgradeOutput(
    "",
    `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
  );

  it("PENDING + recovered txid + verify INCOMPLETE → ANCHOR_MATERIAL_RECOVERED (not anchored)", () => {
    const verify = parseOtsVerifyOutput(
      "",
      "Calendar attestation incomplete\nGot 0 attestation(s)",
    );
    const result = classifyOtsResult({
      upgrade: PENDING_UPGRADE_WITH_TXID,
      verify,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
    expect(result.txid).toBe(TXID);
    expect(result.anchoredAtUtc).toBeNull();
    expect(result.phase).toBe("txid_detected_pending_confirmation");
  });

  it("the production hybrid evidence (PENDING + persisted txid + verify INCOMPLETE) → ANCHOR_MATERIAL_RECOVERED", () => {
    // Mirrors evidence 57f89e0d-78a1-4c87-9387-4a866dc07b7c: the txid
    // was persisted by an earlier upgrade, current verify still says
    // incomplete (block confirmations not yet sufficient).
    const noTxidUpgrade = parseOtsUpgradeOutput("", "no new attestations");
    const verify = parseOtsVerifyOutput(
      "",
      "Calendar attestation incomplete",
    );
    const result = classifyOtsResult({
      upgrade: noTxidUpgrade,
      verify,
      existingTxid: TXID,
      commandErrored: false,
    });
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
    expect(result.txid).toBe(TXID);
    expect(result.phase).toBe("txid_persisted_pending_confirmation");
  });

  it("verify VERIFIED → FULLY_ANCHORED (with block height + anchored timestamp)", () => {
    const verify = parseOtsVerifyOutput(
      "",
      `Bitcoin block 850000 attests existence as of 2026-06-08 13:30:00 UTC\nSuccess!`,
    );
    const result = classifyOtsResult({
      upgrade: PENDING_UPGRADE_WITH_TXID,
      verify,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("FULLY_ANCHORED");
    expect(result.blockHeight).toBe(850000);
    expect(result.anchoredAtUtc).not.toBeNull();
    expect(result.txid).toBe(TXID);
  });

  it("no txid + no verify + no anchored signal → STILL_PENDING", () => {
    const pendingOnly = parseOtsUpgradeOutput("", "Pending confirmations");
    const result = classifyOtsResult({
      upgrade: pendingOnly,
      verify: parseOtsVerifyOutput("", "Calendar attestation incomplete"),
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("STILL_PENDING");
    expect(result.txid).toBeNull();
  });

  it("hard command error + no verify success → FAILED", () => {
    const failedUpgrade = parseOtsUpgradeOutput("", "Fatal: corrupt proof");
    const result = classifyOtsResult({
      upgrade: failedUpgrade,
      verify: null,
      existingTxid: null,
      commandErrored: true,
      mergedErrorText: "Fatal: corrupt proof",
    });
    expect(result.kind).toBe("FAILED");
  });

  it("transient-looking error (timeout) is NOT FAILED — falls through to pending", () => {
    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", ""),
      verify: null,
      existingTxid: null,
      commandErrored: true,
      mergedErrorText: "Connection timed out",
    });
    expect(result.kind).not.toBe("FAILED");
    expect(result.kind).toBe("STILL_PENDING");
  });

  it("back-compat: verify omitted + legacy 'anchored' upgrade output → FULLY_ANCHORED via heuristic", () => {
    const anchoredUpgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nSuccess! Timestamp complete.`,
    );
    const result = classifyOtsResult({
      upgrade: anchoredUpgrade,
      // verify is undefined — caller did NOT run it.
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("FULLY_ANCHORED");
    expect(result.reason).toMatch(/legacy heuristic/);
  });

  it("verify INCOMPLETE overrides ambiguous upgrade output — never promotes to FULLY_ANCHORED", () => {
    // Upgrade output mentions "bitcoin transaction" (legacy heuristic
    // would have flagged this as anchored) — verify says incomplete.
    // Classifier must respect verify.
    const ambiguousUpgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmations: 4/6`,
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
    expect(result.kind).not.toBe("FULLY_ANCHORED");
  });

  it("the strict-rules invariant: txid presence alone NEVER promotes to FULLY_ANCHORED", () => {
    // Even with a persisted txid AND legacy anchored heuristic, if
    // verify says INCOMPLETE the classifier must keep it as
    // ANCHOR_MATERIAL_RECOVERED. This pins the user's invariant: "Do
    // NOT mark ANCHORED just because txid exists in DB."
    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", `Bitcoin transaction: ${TXID}`),
      verify: parseOtsVerifyOutput("", "Calendar attestation incomplete"),
      existingTxid: TXID,
      commandErrored: false,
    });
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
  });
});

// =============================================================================
// Sanity: existing parser semantics are preserved
// =============================================================================

describe("legacy parseOtsUpgradeOutput / shouldTreatOtsAsAnchored unchanged", () => {
  it("legacy parser still extracts txid from `Bitcoin transaction:` line", () => {
    const out = parseOtsUpgradeOutput("", `Bitcoin transaction: ${TXID}`);
    expect(out.txid).toBe(TXID);
    expect(out.anchoredOutput).toBe(true);
  });

  it("legacy parser still flags pending output", () => {
    const out = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
    );
    expect(out.txid).toBe(TXID);
    expect(out.pendingOutput).toBe(true);
  });
});
