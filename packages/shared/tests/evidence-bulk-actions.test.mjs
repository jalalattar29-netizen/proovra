/**
 * The `POST /v1/evidence/bulk` request contract.
 *
 * This module is the ONE definition the browser builds against and the API
 * validates with, so its edges are pinned here rather than in either consumer:
 *
 *   - `caseId` is optional and NOT nullable — the drift that made every
 *     Archive from the Evidence Library fail with a 400 before a single record
 *     was examined;
 *   - an action that TARGETS a case must name one;
 *   - every action that does not is accepted without the key at all;
 *   - the id bound and the action vocabulary are stated once.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_BULK_ACTIONS,
  EVIDENCE_BULK_MAX_IDS,
  EvidenceBulkRequestSchema,
  buildEvidenceBulkRequest,
  evidenceBulkActionRequiresCase,
} from "../dist/index.js";

const ID = "00000000-0000-4000-8000-000000000001";
const CASE_ID = "00000000-0000-4000-8000-0000000000aa";

const issues = (payload) => {
  const parsed = EvidenceBulkRequestSchema.safeParse(payload);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}:${i.code}`);
};

// ---------------------------------------------------------------------------
// An action that targets a case must name one
// ---------------------------------------------------------------------------

test("ADD_TO_CASE without a caseId is rejected by the contract", () => {
  assert.deepEqual(issues({ action: "ADD_TO_CASE", evidenceIds: [ID] }), ["caseId:custom"]);
});

test("ADD_TO_CASE is accepted ONLY with a valid uuid", () => {
  assert.deepEqual(issues({ action: "ADD_TO_CASE", evidenceIds: [ID], caseId: CASE_ID }), []);
  // Everything that is not one.
  for (const bad of ["", "not-a-uuid", "1234", `${CASE_ID} `]) {
    assert.notDeepEqual(
      issues({ action: "ADD_TO_CASE", evidenceIds: [ID], caseId: bad }),
      [],
      `caseId ${JSON.stringify(bad)} must be rejected`,
    );
  }
  // And null is still not a word this contract knows.
  assert.deepEqual(issues({ action: "ADD_TO_CASE", evidenceIds: [ID], caseId: null }), [
    "caseId:invalid_type",
  ]);
});

// ---------------------------------------------------------------------------
// Every other action needs no case at all
// ---------------------------------------------------------------------------

test("ARCHIVE and every non-case action are accepted with no caseId key", () => {
  for (const action of EVIDENCE_BULK_ACTIONS) {
    if (evidenceBulkActionRequiresCase(action)) continue;
    assert.deepEqual(
      issues({ action, evidenceIds: [ID] }),
      [],
      `${action} must be accepted without a caseId`,
    );
  }
  // The one the Evidence Library sends most, stated explicitly.
  assert.deepEqual(issues({ action: "ARCHIVE", evidenceIds: [ID] }), []);
});

test("`caseId: null` is refused for every action — the payload that broke Archive", () => {
  for (const action of EVIDENCE_BULK_ACTIONS) {
    assert.deepEqual(
      issues({ action, evidenceIds: [ID], caseId: null }),
      ["caseId:invalid_type"],
      `${action} with caseId: null must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// The builder the browser uses cannot express those shapes
// ---------------------------------------------------------------------------

test("the client builder omits an absent case rather than sending null", () => {
  for (const caseId of [null, undefined, "", "   "]) {
    const body = buildEvidenceBulkRequest({ action: "ARCHIVE", evidenceIds: [ID], caseId });
    assert.deepEqual(Object.keys(body).sort(), ["action", "evidenceIds"]);
    assert.deepEqual(issues(body), []);
  }
});

test("the client builder carries a real case, and de-duplicates ids in order", () => {
  const body = buildEvidenceBulkRequest({
    action: "ADD_TO_CASE",
    evidenceIds: [ID, ID, CASE_ID],
    caseId: CASE_ID,
  });
  assert.deepEqual(body.evidenceIds, [ID, CASE_ID]);
  assert.equal(body.caseId, CASE_ID);
  assert.deepEqual(issues(body), []);
});

// ---------------------------------------------------------------------------
// Bounds and vocabulary
// ---------------------------------------------------------------------------

test("the id bound is stated once and enforced", () => {
  assert.equal(EVIDENCE_BULK_MAX_IDS, 100);
  const many = Array.from({ length: EVIDENCE_BULK_MAX_IDS + 1 }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  assert.notDeepEqual(issues({ action: "ARCHIVE", evidenceIds: many }), []);
  assert.deepEqual(issues({ action: "ARCHIVE", evidenceIds: many.slice(0, EVIDENCE_BULK_MAX_IDS) }), []);
  // An empty selection is not a request.
  assert.notDeepEqual(issues({ action: "ARCHIVE", evidenceIds: [] }), []);
});

test("the action vocabulary is upper-case and closed", () => {
  for (const action of EVIDENCE_BULK_ACTIONS) {
    assert.equal(action, action.toUpperCase());
  }
  assert.notDeepEqual(issues({ action: "archive", evidenceIds: [ID] }), []);
  assert.notDeepEqual(issues({ action: "TAG", evidenceIds: [ID] }), []);
});
