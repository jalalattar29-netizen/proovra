/**
 * AUD-27 (2026-10-20) — THE SUMMARY TONE IS THE SERVER'S, DECIDED FROM EVERY
 * MATRIX ROW. Characterization (before): the page recomputed a tone from the
 * trust decision, which does not see the package rows — green beside a FAILED
 * package seal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVerificationMatrix, parseVerificationMatrix, verificationMatrixTone } from "../dist/index.js";

test("danger when any row failed; success only when every row is verified or not applicable", () => {
  assert.equal(verificationMatrixTone([{ status: "VERIFIED" }, { status: "FAILED" }]), "danger");
  assert.equal(verificationMatrixTone([{ status: "VERIFIED" }, { status: "NOT_APPLICABLE" }]), "success");
  assert.equal(verificationMatrixTone([{ status: "VERIFIED" }, { status: "NOT_CHECKED" }]), "warning");
  assert.equal(verificationMatrixTone([]), "warning");
});

test("a FAILED package seal makes the built matrix danger, and the tone survives the wire", () => {
  const m = buildVerificationMatrix({ signals: [], identity: null, acquisitionMode: null, packageSeal: { kind: "FAILED" }, publication: { kind: "DOCUMENT" } });
  assert.equal(m.tone, "danger");
  assert.equal(parseVerificationMatrix(JSON.parse(JSON.stringify(m))).tone, "danger");
});
