/**
 * NEW WEB AGAINST THE DEPLOYED API (2026-09-29).
 *
 * A push to main builds the web on Vercel immediately; the API and worker are
 * deployed separately and later. Until then this web client reads responses
 * from the API at 1a86485c. These payloads are that API's shapes, taken from
 * its source, and every assertion is on the new client's own decision:
 *
 *   * Verify: the old API may send no `anchorClaim` and no `anchorCheck`. The
 *     badge is then derived by the shared resolver, and it never claims more
 *     than the stored fields support — a txid alone is NOT "verified".
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

test("Verify: an old-API ANCHORED record with a txid but no claim/check is not shown as chain-verified", () => {
  const badge = otsTone({
    anchorClaim: null,
    anchorCheck: null,
    status: "ANCHORED",
    anchoredAtUtc: "2026-09-01T00:00:00.000Z",
    proofPresent: true,
    bitcoinTxid: TXID,
  });
  assert.notEqual(badge.tone, "success");
  assert.equal(badge.label, "ANCHORED · CHAIN NOT CHECKED");
});

test("Verify: an old-API ANCHORED record with NO txid is never shown as anchored-and-verified", () => {
  const badge = otsTone({ status: "ANCHORED", anchoredAtUtc: "2026-09-01T00:00:00.000Z", bitcoinTxid: null });
  assert.notEqual(badge.tone, "success");
});

test("Verify: the old API's own claim, when it sends one, is honoured as sent", () => {
  assert.equal(otsTone({ anchorClaim: "PENDING", status: "ANCHORED", bitcoinTxid: TXID }).label, "PENDING");
  assert.equal(otsTone({ anchorClaim: "VERIFIED", status: "ANCHORED", bitcoinTxid: TXID }).tone, "success");
});

test("Verify: PENDING / FAILED / nothing read the same without the new fields", () => {
  assert.equal(otsTone({ status: "PENDING" }).label, "PENDING");
  assert.equal(otsTone({ status: "FAILED" }).label, "FAILED");
  assert.equal(otsTone({ status: null }).label, "Unavailable");
});

test("Notes: an old-API output with no terminalReasonCode reads its reason's own copy", () => {
  for (const reason of ["ESCALATED_TO_OPERATOR", "IN_PROGRESS", "NOT_INCLUDED", "LEGAL_HOLD_ACTIVE"] as const) {
    const oldOutput = { actionUnavailableReason: reason } as never;
    assert.equal(outputNoteCopy(oldOutput), outputUnavailableReasonCopy(reason));
    assert.equal(outputNoteShort(oldOutput), outputUnavailableReasonShort(reason));
  }
});
