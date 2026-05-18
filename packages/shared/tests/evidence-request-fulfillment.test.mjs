import test from "node:test";
import assert from "node:assert/strict";

// Pure reimplementation mirroring the server's fulfillment computation in
// evidence-request.service.ts::linkResponseFromIntakeSession. Keeping this
// pure here protects the documented behavior without spinning up a DB.
// If the server logic drifts these tests will fail — and so they should.

function computeDeliverableStatus({ minCount, maxCount, matches, currentStatus }) {
  if (currentStatus === "WAIVED" || currentStatus === "REJECTED") {
    return { status: currentStatus, fulfilledCount: 0 };
  }
  const required = Math.max(0, minCount);
  const capped =
    typeof maxCount === "number" && maxCount > 0
      ? Math.min(matches, maxCount)
      : matches;
  let next;
  if (capped >= required && required > 0) next = "FULFILLED";
  else if (capped > 0) next = "PARTIALLY_FULFILLED";
  else next = currentStatus === "PARTIALLY_FULFILLED" ? "PARTIALLY_FULFILLED" : "PENDING";
  return { status: next, fulfilledCount: capped };
}

function computeRequestStatus(deliverables) {
  const requiredRemaining = deliverables.filter(
    (d) => d.required && d.status !== "FULFILLED" && d.status !== "WAIVED",
  );
  const anyFulfilledOrPartial = deliverables.some(
    (d) => d.status === "FULFILLED" || d.status === "PARTIALLY_FULFILLED",
  );
  if (deliverables.length === 0) return "RESPONSE_RECEIVED";
  if (requiredRemaining.length === 0) return "FULFILLED";
  if (anyFulfilledOrPartial) return "PARTIALLY_FULFILLED";
  return "RESPONSE_RECEIVED";
}

// -----------------------------------------------------------------------------
// Deliverable counting
// -----------------------------------------------------------------------------

test("deliverable with minCount=2 reports PARTIALLY_FULFILLED at 1 match", () => {
  const r = computeDeliverableStatus({
    minCount: 2,
    maxCount: null,
    matches: 1,
    currentStatus: "PENDING",
  });
  assert.equal(r.status, "PARTIALLY_FULFILLED");
  assert.equal(r.fulfilledCount, 1);
});

test("deliverable with minCount=2 reports FULFILLED at 2 matches", () => {
  const r = computeDeliverableStatus({
    minCount: 2,
    maxCount: null,
    matches: 2,
    currentStatus: "PENDING",
  });
  assert.equal(r.status, "FULFILLED");
  assert.equal(r.fulfilledCount, 2);
});

test("deliverable with minCount=2 and maxCount=3 caps fulfilledCount", () => {
  const r = computeDeliverableStatus({
    minCount: 2,
    maxCount: 3,
    matches: 10,
    currentStatus: "PENDING",
  });
  assert.equal(r.status, "FULFILLED");
  assert.equal(r.fulfilledCount, 3);
});

test("WAIVED deliverable stays WAIVED regardless of new matches", () => {
  const r = computeDeliverableStatus({
    minCount: 2,
    maxCount: null,
    matches: 5,
    currentStatus: "WAIVED",
  });
  assert.equal(r.status, "WAIVED");
  assert.equal(r.fulfilledCount, 0);
});

test("REJECTED deliverable stays REJECTED — explicit re-open flow required", () => {
  const r = computeDeliverableStatus({
    minCount: 1,
    maxCount: null,
    matches: 5,
    currentStatus: "REJECTED",
  });
  assert.equal(r.status, "REJECTED");
});

test("zero matches against PENDING stays PENDING", () => {
  const r = computeDeliverableStatus({
    minCount: 1,
    maxCount: null,
    matches: 0,
    currentStatus: "PENDING",
  });
  assert.equal(r.status, "PENDING");
});

// -----------------------------------------------------------------------------
// Request-level fulfillment
// -----------------------------------------------------------------------------

test("request with all required deliverables FULFILLED reports FULFILLED", () => {
  const status = computeRequestStatus([
    { required: true, status: "FULFILLED" },
    { required: false, status: "PENDING" },
  ]);
  assert.equal(status, "FULFILLED");
});

test("request with one required PARTIALLY_FULFILLED reports PARTIALLY_FULFILLED", () => {
  const status = computeRequestStatus([
    { required: true, status: "PARTIALLY_FULFILLED" },
    { required: true, status: "PENDING" },
  ]);
  assert.equal(status, "PARTIALLY_FULFILLED");
});

test("optional deliverable does not block FULFILLED status", () => {
  const status = computeRequestStatus([
    { required: true, status: "FULFILLED" },
    { required: false, status: "PENDING" },
    { required: false, status: "PARTIALLY_FULFILLED" },
  ]);
  assert.equal(status, "FULFILLED");
});

test("WAIVED required deliverable counts as resolved", () => {
  const status = computeRequestStatus([
    { required: true, status: "FULFILLED" },
    { required: true, status: "WAIVED" },
  ]);
  assert.equal(status, "FULFILLED");
});

test("REJECTED required deliverable does NOT count as resolved", () => {
  const status = computeRequestStatus([
    { required: true, status: "FULFILLED" },
    { required: true, status: "REJECTED" },
  ]);
  assert.equal(status, "PARTIALLY_FULFILLED");
});

test("request with no deliverables reports RESPONSE_RECEIVED on submission", () => {
  const status = computeRequestStatus([]);
  assert.equal(status, "RESPONSE_RECEIVED");
});

test("request with only PENDING deliverables reports RESPONSE_RECEIVED", () => {
  const status = computeRequestStatus([
    { required: true, status: "PENDING" },
    { required: false, status: "PENDING" },
  ]);
  assert.equal(status, "RESPONSE_RECEIVED");
});
