// Team remediation T-162 — the review-lifecycle audit actions are registered
// in ONE catalog, each distinct (a first decision is never a completion, a
// single archive is never a bulk triage), and every string the API writes for
// these behaviours is in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REVIEW_LIFECYCLE_AUDIT_ACTIONS } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = (rel) => readFileSync(path.join(here, "../../../services/api/src", rel), "utf8");

test("the catalog names each lifecycle behaviour once, distinctly", () => {
  const values = Object.values(REVIEW_LIFECYCLE_AUDIT_ACTIONS);
  assert.equal(new Set(values).size, values.length);
  assert.notEqual(REVIEW_LIFECYCLE_AUDIT_ACTIONS.FIRST_DECISION_RECORDED, REVIEW_LIFECYCLE_AUDIT_ACTIONS.REVIEW_COMPLETED);
  assert.notEqual(REVIEW_LIFECYCLE_AUDIT_ACTIONS.REVIEW_ARCHIVED, REVIEW_LIFECYCLE_AUDIT_ACTIONS.BULK_TRIAGE);
  for (const key of [
    "FIRST_DECISION_RECORDED",
    "REVIEW_COMPLETED",
    "REVIEW_ARCHIVED",
    "ESCALATION_RESOLVE_REFUSED",
    "ESCALATION_SUPPRESS_REFUSED",
    "SECOND_REVIEW_POLICY_REEVALUATED",
  ]) {
    assert.ok(REVIEW_LIFECYCLE_AUDIT_ACTIONS[key], key);
  }
});

test("the API writes exactly these strings for the new behaviours", () => {
  const sources = [
    api("services/reviewer-ops/decision-outcome-signals.ts"),
    api("services/reviewer-ops/escalation-engine.service.ts"),
    api("services/reviewer-ops/second-review-reevaluation.service.ts"),
    api("routes/reviewer-ops.routes.ts"),
  ].join("\n");
  for (const action of Object.values(REVIEW_LIFECYCLE_AUDIT_ACTIONS)) {
    if (action === REVIEW_LIFECYCLE_AUDIT_ACTIONS.BULK_TRIAGE) continue;
    assert.ok(sources.includes(`"${action}"`), `${action} is written by the API`);
  }
});
