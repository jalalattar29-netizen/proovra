/** AUD-32 (2026-10-20) — the presentation contract comparison. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PRESENTATION_CONTRACT_HEADER, PRESENTATION_CONTRACT_VERSION, presentationContractSkew } from "../dist/index.js";

test("the header name and a positive integer version", () => {
  assert.equal(PRESENTATION_CONTRACT_HEADER, "x-proovra-contract");
  assert.ok(Number.isInteger(PRESENTATION_CONTRACT_VERSION) && PRESENTATION_CONTRACT_VERSION >= 1);
});

test("a newer served contract means the client is older; equal is current", () => {
  assert.equal(presentationContractSkew(String(PRESENTATION_CONTRACT_VERSION)), "CURRENT");
  assert.equal(presentationContractSkew(String(PRESENTATION_CONTRACT_VERSION + 1)), "CLIENT_OLDER");
  assert.equal(presentationContractSkew("1", 3), "CLIENT_NEWER");
});

test("an absent or malformed value decides nothing", () => {
  for (const v of [null, undefined, "", "x", "0", "-1", "1.5"]) assert.equal(presentationContractSkew(v), "UNKNOWN");
});
