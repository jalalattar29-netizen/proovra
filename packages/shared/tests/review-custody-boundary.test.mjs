/**
 * REVIEW IS NOT FORENSIC CUSTODY (owner decision 2026-10-24) — the shared
 * contracts every writer, reader and artifact builder reads.
 *
 *   1. Taxonomy: only a verdict is REVIEW_DECISION_RECORDED; Reopen, In review,
 *      Close, claim, assignment and priority are not decisions.
 *   2. Historical REVIEW_DECISION_RECORDED rows are named by what they were.
 *   3. Classification: internal workflow rows are neither forensic nor access,
 *      never reportable, never a forensic-integrity change.
 *   4. The external projection keeps only position and hashes.
 *   5. Reportable reasons: grouped, explained, internal Review excluded; the
 *      seven confirmed events owe nothing; a mixed set counts only reportable.
 *   6. Workflow state and current-round decision are separate.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  REPORTABLE_CUSTODY_EVENT_TYPES,
  REVIEW_EVENT_AUDIT_ACTIONS,
  WITHHELD_CUSTODY_EVENT_TYPE,
  classifyCustodyEventType,
  classifyLegacyReviewCustody,
  classifyReviewWorkflowEvent,
  custodyEventLabel,
  deriveReportFreshness,
  isForensicIntegrityCustodyEventType,
  isInternalWorkflowCustodyEventType,
  isReviewDecisionEvent,
  legacyReviewDecisionFromStatus,
  presentReviewOutcome,
  projectCustodyEventForExternalArtifact,
  reportFreshnessChangeCopy,
  reportableCustodyReasonOf,
  reviewDecisionFromProjection,
  reviewWorkflowStateLabel,
  deriveDecisionProjection,
} from "../dist/index.js";

const ACTOR = "5e57a1e0-0000-4000-8000-00000000a11d";
/** The seven confirmed events (custody sequence 352…372). */
const CONFIRMED = ["REOPENED", "IN_REVIEW", "CLOSED", "REOPENED", "IN_REVIEW", "APPROVED_INTERNAL", "CLOSED"];

test("1 — taxonomy: only a verdict is a decision", () => {
  const code = (eventType, nextValue) => classifyReviewWorkflowEvent({ eventType, nextValue });
  assert.equal(code("REOPENED"), "REVIEW_REOPENED");
  assert.equal(code("CLOSED"), "REVIEW_CLOSED");
  assert.equal(code("REVIEW_STARTED", { status: "IN_REVIEW" }), "REVIEW_WORKFLOW_STATE_CHANGED");
  assert.equal(code("CLAIMED"), "REVIEW_CLAIMED");
  assert.equal(code("ASSIGNED"), "REVIEW_ASSIGNMENT_CHANGED");
  assert.equal(code("PRIORITY_CHANGED"), "REVIEW_PRIORITY_CHANGED");
  assert.equal(code("DECISION_LOGGED", { decision: "APPROVE" }), "REVIEW_DECISION_RECORDED");
  assert.equal(code("DECISION_LOGGED", { decision: "REJECT" }), "REVIEW_DECISION_RECORDED");
  assert.equal(code("DECISION_LOGGED", { decision: "REQUEST_INFO" }), "REVIEW_INFORMATION_REQUESTED");
  for (const notADecision of ["REVIEW_REOPENED", "REVIEW_CLOSED", "REVIEW_WORKFLOW_STATE_CHANGED", "REVIEW_CLAIMED", "REVIEW_ASSIGNMENT_CHANGED", "REVIEW_PRIORITY_CHANGED"]) {
    assert.equal(isReviewDecisionEvent(notADecision), false, notADecision);
  }
  // Every code has a tenant-audit action.
  for (const action of Object.values(REVIEW_EVENT_AUDIT_ACTIONS)) assert.match(action, /^review\./);
});

test("2 — historical REVIEW_DECISION_RECORDED rows are named for what they were (internal only)", () => {
  const legacy = CONFIRMED.map((status) => classifyLegacyReviewCustody({ status, actorUserId: ACTOR }));
  assert.deepEqual(legacy, [
    "REVIEW_REOPENED",
    "REVIEW_WORKFLOW_STATE_CHANGED",
    "REVIEW_CLOSED",
    "REVIEW_REOPENED",
    "REVIEW_WORKFLOW_STATE_CHANGED",
    "REVIEW_DECISION_RECORDED",
    "REVIEW_CLOSED",
  ]);
  // The internal label never calls Reopen / In review / Close a decision.
  assert.match(custodyEventLabel("REVIEW_DECISION_RECORDED", { status: "CLOSED" }), /^Review closed/);
  assert.match(custodyEventLabel("REVIEW_DECISION_RECORDED", { status: "REOPENED" }), /^Review reopened/);
  assert.doesNotMatch(custodyEventLabel("REVIEW_DECISION_RECORDED", { status: "IN_REVIEW" }), /decision/i);
});

test("3 — internal workflow rows are not forensic, not access, not reportable, not an integrity change", () => {
  assert.equal(isInternalWorkflowCustodyEventType("REVIEW_DECISION_RECORDED"), true);
  assert.equal(classifyCustodyEventType("REVIEW_DECISION_RECORDED"), "withheld");
  assert.equal(classifyCustodyEventType(WITHHELD_CUSTODY_EVENT_TYPE), "withheld");
  assert.equal(isForensicIntegrityCustodyEventType("REVIEW_DECISION_RECORDED"), false);
  assert.equal(REPORTABLE_CUSTODY_EVENT_TYPES.includes("REVIEW_DECISION_RECORDED"), false);
  assert.equal(reportableCustodyReasonOf("REVIEW_DECISION_RECORDED"), null);
  // Issuance bookkeeping and access are never reportable either.
  for (const t of ["REPORT_GENERATED", "VERIFICATION_PACKAGE_GENERATED", "REPORT_PDF_SIGNED", "REPORT_DOWNLOADED", "VERIFY_VIEWED", "EVIDENCE_VIEWED"]) {
    assert.equal(reportableCustodyReasonOf(t), null, t);
  }
  assert.equal(classifyCustodyEventType("LEGAL_HOLD_PLACED"), "forensic");
});

test("4 — the external projection keeps position and hashes only", () => {
  const row = { sequence: 352, atUtc: "2026-10-23T10:00:00.000Z", eventType: "REVIEW_DECISION_RECORDED", payload: { status: "REOPENED", actorUserId: ACTOR }, prevEventHash: "a".repeat(64), eventHash: "b".repeat(64) };
  const out = projectCustodyEventForExternalArtifact(row);
  assert.deepEqual(out, { sequence: 352, atUtc: row.atUtc, prevEventHash: row.prevEventHash, eventHash: row.eventHash, eventType: WITHHELD_CUSTODY_EVENT_TYPE, payload: null });
  assert.equal(JSON.stringify(out).includes(ACTOR), false);
  assert.equal(JSON.stringify(out).includes("REOPENED"), false);
  // The stored row is untouched; any other row passes through unchanged.
  assert.equal(row.payload.actorUserId, ACTOR);
  const hold = { sequence: 9, eventType: "LEGAL_HOLD_PLACED", payload: { reason: "x" } };
  assert.equal(projectCustodyEventForExternalArtifact(hold), hold);
});

test("5 — reportable reasons: grouped and explained; Review owes nothing; a mixed set counts only the reportable subset", () => {
  const base = {
    reportVersion: 4,
    reportGeneratedAtUtc: "2026-10-20T10:00:00.000Z",
    tsa: { status: "STAMPED", validatedAtUtc: null },
    ots: { state: "PENDING", anchoredAtUtc: null, reportState: "PENDING" },
    integrity: { lastVerifiedAtUtc: null, reportLastVerifiedAtUtc: null },
  };
  // The seven confirmed Review events reach no group: nothing is owed.
  const groupsFrom = (types) => {
    const m = new Map();
    for (const t of types) {
      const reason = reportableCustodyReasonOf(t);
      if (!reason) continue;
      const g = m.get(reason) ?? { reason, count: 0, firstAtUtc: "2026-10-21T00:00:00.000Z", latestAtUtc: "2026-10-22T00:00:00.000Z" };
      g.count += 1;
      m.set(reason, g);
    }
    return [...m.values()];
  };
  const onlyReview = deriveReportFreshness({ ...base, custodyAfterReport: { groups: groupsFrom(CONFIRMED.map(() => "REVIEW_DECISION_RECORDED")) } });
  assert.equal(onlyReview.hasNewerFacts, false);
  assert.deepEqual(onlyReview.changes, []);

  const mixed = deriveReportFreshness({
    ...base,
    custodyAfterReport: { groups: groupsFrom([...CONFIRMED.map(() => "REVIEW_DECISION_RECORDED"), "LEGAL_HOLD_PLACED", "LEGAL_HOLD_RELEASED", "STORAGE_PROTECTION_UNAVAILABLE", "REPORT_GENERATED"]) },
  });
  assert.deepEqual(mixed.changes.map((c) => [c.reason, c.count]), [["LEGAL_HOLD", 2], ["STORAGE_PROTECTION", 1]]);
  assert.equal(reportFreshnessChangeCopy(mixed.changes[0], 4), "2 legal-hold changes were recorded after report v4.");
  assert.equal(reportFreshnessChangeCopy(mixed.changes[1], 4), "A storage-protection change was recorded after report v4.");
  // The copy never carries a payload, an id or an event code.
  for (const c of mixed.changes) assert.doesNotMatch(reportFreshnessChangeCopy(c, 4), /[A-Z]{3,}_[A-Z]|[0-9a-f]{8}-/);
  // OTS / TSA reasons.
  assert.equal(reportFreshnessChangeCopy({ code: "OTS_CHAIN_VERIFIED_AFTER_REPORT", atUtc: null }, 4).startsWith("Bitcoin verification completed after report v4"), true);
  assert.equal(reportFreshnessChangeCopy({ code: "TSA_VALIDATED_AFTER_REPORT", atUtc: null }, 4), "Trusted timestamp validation completed after report v4.");
});

test("6 — workflow state and current-round decision are separate; Close never becomes a verdict", () => {
  // Approve then Close.
  assert.deepEqual(presentReviewOutcome({ dbStatus: "CLOSED", decision: "APPROVED" }), {
    workflowState: "CLOSED",
    workflowStateLabel: "Closed",
    decision: "APPROVED",
    decisionLabel: "Approved",
  });
  // Reject then Close; Close without a verdict.
  assert.equal(presentReviewOutcome({ dbStatus: "CLOSED", decision: "NOT_ACCEPTED" }).decisionLabel, "Not accepted");
  assert.equal(presentReviewOutcome({ dbStatus: "CLOSED", decision: null }).decisionLabel, "No decision");
  // A stage a verdict produced reads "Decided", never the verdict itself.
  assert.equal(reviewWorkflowStateLabel("APPROVED_INTERNAL"), "Decided");
  assert.equal(reviewWorkflowStateLabel("CLOSED"), "Closed");
  assert.doesNotMatch(reviewWorkflowStateLabel("CLOSED"), /accepted/i);
  // Legacy: only a verdict status carries a decision; CLOSED / REOPENED never.
  assert.equal(legacyReviewDecisionFromStatus("CLOSED"), "NO_DECISION");
  assert.equal(legacyReviewDecisionFromStatus("REOPENED"), "NO_DECISION");
  assert.equal(legacyReviewDecisionFromStatus("APPROVED_INTERNAL"), "APPROVED");
  assert.equal(legacyReviewDecisionFromStatus("REJECTED_INSUFFICIENT"), "NOT_ACCEPTED");
  // From the authority's own projection: unresolved is never a decision.
  const rows = (...d) => d.map(([stage, decision, reviewerUserId]) => ({ stage, decision, reviewerUserId }));
  assert.equal(reviewDecisionFromProjection(deriveDecisionProjection(rows(["FIRST", "APPROVE", "a"]), false)), "APPROVED");
  assert.equal(reviewDecisionFromProjection(deriveDecisionProjection(rows(["FIRST", "APPROVE", "a"]), true)), "NO_DECISION");
  assert.equal(reviewDecisionFromProjection(deriveDecisionProjection(rows(["FIRST", "APPROVE", "a"], ["SECOND", "REJECT", "b"]), true)), "NO_DECISION");
  assert.equal(reviewDecisionFromProjection(deriveDecisionProjection(rows(["FIRST", "REQUEST_INFO", "a"]), false)), "NO_DECISION");
  assert.equal(reviewDecisionFromProjection(deriveDecisionProjection(rows(["FIRST", "REJECT", "a"]), false)), "NOT_ACCEPTED");
});

test("7 — ONE OTS owed rule (update card and the worker's automatic version): only a verification the report did not state", async () => {
  const { otsChainVerifiedAfterReport } = await import("../dist/index.js");
  const live = { verification: "CHAIN_VERIFIED", proofSha256: "aa", blockHash: "bb" };
  assert.equal(otsChainVerifiedAfterReport({ ...live, reportVerification: "PENDING" }), true);
  assert.equal(otsChainVerifiedAfterReport({ ...live, reportVerification: "CHAIN_VERIFIED", reportProofSha256: "AA", reportBlockHash: "BB" }), false);
  // Stated a DIFFERENT proof or block (re-anchor): owed.
  assert.equal(otsChainVerifiedAfterReport({ ...live, reportVerification: "CHAIN_VERIFIED", reportProofSha256: "aa", reportBlockHash: "cc" }), true);
  // Not verified now: never owed.
  assert.equal(otsChainVerifiedAfterReport({ verification: "ATTESTATION_RECORDED", reportVerification: "PENDING" }), false);
  // Identity unknown now: the verification alone decides.
  assert.equal(otsChainVerifiedAfterReport({ verification: "CHAIN_VERIFIED", reportVerification: "CHAIN_VERIFIED" }), false);
});
