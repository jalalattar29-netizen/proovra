/**
 * Mobile ↔ web parity for the Review WORKFLOW STATE and the current-round
 * DECISION (2026-10-24).
 *
 * The mobile record copied the web's label map verbatim — including
 * CLOSED → "Not accepted" — and showed the raw stored status as a badge. Both
 * now read the ONE shared presenter for the workflow state and the server's
 * decisionLabel for the decision: Approve then Close is Closed · Approved,
 * exactly as the web says it.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let ER;
let SHARED;
before(async () => {
  ER = await loadModule("src/product/evidence-record.ts");
  SHARED = await import("@proovra/shared");
});

test("every stored status reads exactly as the web's shared presenter; a closed review never reads 'Not accepted'", () => {
  for (const status of ["NOT_STARTED", "QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO", "RESPONSE_RECEIVED", "APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "ESCALATED", "REOPENED", "CLOSED", null]) {
    assert.equal(ER.formatReviewerStatusLabel(status), SHARED.reviewWorkflowStateLabel(status), String(status));
  }
  assert.equal(ER.formatReviewerStatusLabel("CLOSED"), "Closed");
  assert.notEqual(ER.formatReviewerStatusLabel("CLOSED"), "Not accepted");
});

test("the record view carries the server's decision, separate from the status", () => {
  const view = ER.projectRecord({
    evidence: { id: "ev-1", status: "REPORTED" },
    reviewWorkflow: { status: "CLOSED", priority: "NORMAL", decision: "APPROVED", decisionLabel: "Approved" },
  });
  assert.equal(view.workflow.status, "CLOSED");
  assert.equal(view.workflow.decisionLabel, "Approved");
  // No decision from the server reads as no decision — never inferred from the status.
  const none = ER.projectRecord({ evidence: { id: "ev-1" }, reviewWorkflow: { status: "CLOSED" } });
  assert.equal(none.workflow.decisionLabel, "No decision");
});

test("the record rail shows the workflow state and the decision — never the raw stored enum (audit P2-5)", async () => {
  const { loadWithProviders, renderInProviders, React } = await import("./support/render.mjs");
  const Sections = await loadWithProviders("src/ui/evidence-record-sections.tsx");
  const record = ER.projectRecord({
    evidence: { id: "ev-1", status: "REPORTED" },
    reviewWorkflow: { status: "CLOSED", priority: "NORMAL", decision: "APPROVED", decisionLabel: "Approved" },
  });
  const r = await renderInProviders(
    Sections,
    React.createElement(Sections.EvidenceRecordRail, { signals: [], record, publicVerification: null, shareUrl: null }),
  );
  assert.equal(r.byLabel("Closed").length, 1, "the state badge reads the shared presenter's label");
  assert.equal(r.byLabel("Decision: Approved").length, 1, "the decision badge reads the server's label");
  for (const raw of ["CLOSED", "APPROVED INTERNAL", "APPROVED_INTERNAL"]) {
    assert.equal(r.byLabel(raw).length, 0, raw);
    assert.ok(!r.hasText(raw), raw);
  }
});
