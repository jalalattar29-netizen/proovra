/**
 * NEW WEB AGAINST THE DEPLOYED API (2026-09-29).
 *
 * A push to main builds the web on Vercel immediately; the API and worker are
 * deployed separately and later. Until then this web client reads responses
 * from the API at 1a86485c. These payloads are that API's shapes, taken from
 * its source, and every assertion is on the new client's own decision:
 *
 *   * Verify (2026-10-13): the Bitcoin anchoring badge reads ONLY the server's
 *     `state` (readOtsAnchoringView). An old API's status string, txid or
 *     claim is never re-derived into a state: it reads as Unavailable.
 *   * Evidence Detail / Reports notes: the old API sends no
 *     `terminalReasonCode`; the note falls back to the reason's own copy, so
 *     no row is left blank and none invents the unreadable-original story.
 *   * Recovery request: the new client adds `output` to the regenerate body.
 *     Exercised against the deployed API's own code (see the release notes
 *     of this change); not restated here as a fixture.
 *   * Reports row: covered by the render suite ("even if a stale API
 *     advertises one"), whose fixture carries the old API's
 *     CREATE_NEW_VERSION on a complete pair.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  outputNoteCopy,
  outputNoteShort,
  outputUnavailableReasonCopy,
  outputUnavailableReasonShort,
} from "@proovra/shared";

import { otsTone } from "../components/verify-v2/_helpers";

const TXID = "a".repeat(64);

test("Verify: an old-API OTS object (status string, txid, no state) reads as Unavailable — never anchored", () => {
  const badge = otsTone({
    anchorClaim: "VERIFIED",
    anchorCheck: "BITCOIN_VERIFIED",
    status: "ANCHORED",
    effectiveStatus: "ANCHORED",
    anchoredAtUtc: "2026-09-01T00:00:00.000Z",
    proofPresent: true,
    bitcoinTxid: TXID,
  });
  assert.notEqual(badge.tone, "success");
  assert.equal(badge.label, "Bitcoin anchoring unavailable");
});

test("Verify: an ANCHORED state without a chain check is a neutral 'Bitcoin attestation recorded' — never success", () => {
  const badge = otsTone({ state: "ANCHORED", bitcoinTxid: TXID });
  assert.equal(badge.tone, "neutral");
  assert.equal(badge.label, "Bitcoin attestation recorded");
  // A CHAIN_VERIFIED claim without its chain fact is not believed.
  assert.deepEqual(otsTone({ state: "ANCHORED", verification: "CHAIN_VERIFIED", bitcoinTxid: TXID }), {
    label: "Bitcoin attestation recorded",
    tone: "neutral",
  });
});

test("Verify: only CHAIN_VERIFIED with a coherent chain fact is the success badge; CHAIN_FAILED is danger", () => {
  const chain = { status: "VERIFIED", blockHeight: 812345, blockHash: "f".repeat(64), confirmations: 7, minConfirmations: 6, checkedAtUtc: "2026-09-02T00:00:00Z" };
  assert.deepEqual(otsTone({ state: "ANCHORED", verification: "CHAIN_VERIFIED", chain }), {
    label: "Independently verified against the Bitcoin main chain",
    tone: "success",
  });
  assert.deepEqual(otsTone({ state: "ANCHORED", verification: "CHAIN_FAILED", chain: { ...chain, status: "FAILED", failureCode: "ROOT_MISMATCH" } }), {
    label: "Bitcoin verification failed",
    tone: "danger",
  });
  assert.deepEqual(otsTone({ state: "ANCHORED", verification: "CHAIN_UNAVAILABLE", chain: { ...chain, status: "UNAVAILABLE" } }), {
    label: "Bitcoin verification temporarily unavailable",
    tone: "neutral",
  });
});

test("Verify: PENDING / FAILED / NOT_REQUESTED / unknown / nothing read from the server's state", () => {
  assert.deepEqual(otsTone({ state: "PENDING" }), { label: "OpenTimestamps proof pending", tone: "neutral" });
  assert.deepEqual(otsTone({ state: "FAILED" }), { label: "Bitcoin anchoring failed", tone: "danger" });
  assert.deepEqual(otsTone({ state: "NOT_REQUESTED" }), { label: "Not requested", tone: "neutral" });
  assert.deepEqual(otsTone({ state: "CHAIN_VERIFIED" }), { label: "Bitcoin anchoring unavailable", tone: "neutral" });
  assert.deepEqual(otsTone(null), { label: "Bitcoin anchoring unavailable", tone: "neutral" });
});

test("Notes: an old-API output with no terminalReasonCode reads its reason's own copy", () => {
  for (const reason of ["ESCALATED_TO_OPERATOR", "IN_PROGRESS", "NOT_INCLUDED", "LEGAL_HOLD_ACTIVE"] as const) {
    const oldOutput = { actionUnavailableReason: reason } as never;
    assert.equal(outputNoteCopy(oldOutput), outputUnavailableReasonCopy(reason));
    assert.equal(outputNoteShort(oldOutput), outputUnavailableReasonShort(reason));
  }
});

/*
 * (2026-10-15) Independent Bitcoin-chain verification is back as ONE shared
 * vocabulary (ots-anchoring.ts: "Attestation recorded", "Independently
 * verified against the Bitcoin main chain", OTS_CHAIN_VERIFIED_AFTER_REPORT),
 * so those words are no longer retired. What stays retired is the rest of the
 * 2026-10-13 removal list, plus the "anchored after report" freshness code
 * the chain-verified one replaced.
 */
test("Web source carries none of the removed OpenTimestamps vocabulary (2026-10-13 / 2026-10-15)", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const RETIRED =
    /Bitcoin anchoring verified|chain-verified|proof still being prepared|OTS_ANCHORED_AFTER_REPORT|resolveOtsTruth|OTS_TRUTH_|resolveOtsAnchorClaim|otsClaimBadge|parseOtsAnchorClaim|OTS_PROOF_STATUS_LABELS|resolveEffectiveOtsStatus\(|anchorClaim|truthState/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".generated.ts") && RETIRED.test(readFileSync(full, "utf8"))) {
        offenders.push(full.slice(root.length + 1));
      }
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(join(root, dir));
  assert.deepEqual(offenders, []);
});
