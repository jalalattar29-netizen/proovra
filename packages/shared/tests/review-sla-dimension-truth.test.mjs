import test from "node:test";
import assert from "node:assert/strict";

// Stage C (team remediation 2026-11-24) — SLA, escalation and count truth.
// T-043, T-044, T-045, T-046, T-048, T-049, T-051, T-052 (units), T-168.
//
// The production fixture (REVIEW-SUBSYSTEM §9.1, inspector 8e8db933…): a review
// assigned and started 29 Oct, stamped by the open-review sweep ~8 Nov (so
// assignment due 8 Nov, first review 9 Nov, escalation 10 Nov, completion
// 11 Nov), no decision recorded, an escalation open; read on 24 Nov.

import {
  computeReviewerOpsSlaSnapshot,
  deriveLifecycleState,
  formatReviewCount,
  governingReviewDeadline,
  presentReviewSlaDimensions,
  reviewSlaDimensionOutcome,
  reviewSlaInputFromRow,
  rollupReviewerOpsSlaState,
  selectGoverningEscalation,
  storedReviewSlaStatus,
  REVIEW_COUNT_DEFINITIONS,
  REVIEW_ESCALATED_STATUS_LABEL,
} from "../dist/index.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const ASSIGNED = new Date("2026-10-29T10:00:00.000Z");
const STAMP = new Date("2026-11-08T09:00:00.000Z");
const h = (d, hours) => new Date(d.getTime() + hours * 3600_000);

const productionRow = {
  assignedAtUtc: ASSIGNED,
  lastReviewedAt: ASSIGNED, // Start review wrote it
  firstDecidedAtUtc: null, // no decision recorded
  assignmentDueAtUtc: h(STAMP, 4),
  firstResponseDueAtUtc: h(STAMP, 24),
  escalationDueAtUtc: h(STAMP, 48),
  completionDueAtUtc: h(STAMP, 72),
  escalatedAtUtc: h(STAMP, 49),
  slaDueSoonHours: 6,
};

function presented(row, opts = {}) {
  return computeReviewerOpsSlaSnapshot(reviewSlaInputFromRow(row, { nowUtc: NOW, ...opts }));
}

test("T-043: a completed dimension carries the completion time, not the deadline", () => {
  const snaps = presented(productionRow, { hasOpenEscalation: true });
  const a = snaps.find((s) => s.dimension === "ASSIGNMENT");
  assert.equal(a.state, "COMPLETED");
  assert.equal(a.completedAtUtc, ASSIGNED.toISOString());
  assert.notEqual(a.completedAtUtc, a.dueAtUtc);
  const out = reviewSlaDimensionOutcome(a);
  assert.equal(out.kind, "met");
  assert.equal(out.completedAtUtc, ASSIGNED.toISOString());
});

test("T-043: a fact that came after its deadline is 'missed', never 'met'", () => {
  const due = new Date("2026-11-02T00:00:00.000Z");
  const done = new Date("2026-11-05T00:00:00.000Z");
  const [a] = presented({ assignmentDueAtUtc: due, assignedAtUtc: done });
  assert.equal(a.metOnTime, false);
  const out = reviewSlaDimensionOutcome(a);
  assert.equal(out.kind, "missed");
  assert.equal(out.lateByMs, 3 * 86400_000);
});

test("T-044 / T-168: Start is not a first review; the first decision is", () => {
  const snaps = presented(productionRow);
  const fr = snaps.find((s) => s.dimension === "FIRST_REVIEW");
  assert.notEqual(fr.state, "COMPLETED");
  assert.equal(fr.state, "BREACHED");
  assert.equal(fr.completedAtUtc, null);
  const decided = presented({ ...productionRow, firstDecidedAtUtc: h(STAMP, 2) });
  const fr2 = decided.find((s) => s.dimension === "FIRST_REVIEW");
  assert.equal(fr2.state, "COMPLETED");
  assert.equal(fr2.metOnTime, true);
});

test("T-045 / T-168: escalation is not an SLA state and is never 'Met'", () => {
  const snaps = presented(productionRow, { hasOpenEscalation: true });
  assert.ok(snaps.every((s) => s.state !== "ESCALATED"));
  // The escalation trigger is not presented as a deadline.
  assert.ok(presentReviewSlaDimensions(snaps).every((s) => s.dimension !== "ESCALATION"));
});

test("T-045: an escalation opened on a review due in 3 d reads due in 3 d, not overdue", () => {
  const row = {
    assignedAtUtc: h(NOW, -2),
    completionDueAtUtc: h(NOW, 72),
    // The escalation trigger passed (that is why it was escalated) but the
    // review's own deadline has not.
    escalationDueAtUtc: h(NOW, -1),
    escalatedAtUtc: null,
  };
  const snaps = presented(row, { hasOpenEscalation: true });
  assert.equal(rollupReviewerOpsSlaState(snaps), "HEALTHY");
  const g = governingReviewDeadline(snaps);
  assert.equal(g.kind, "open");
  assert.equal(g.dimension.dimension, "COMPLETION");
  assert.equal(reviewSlaDimensionOutcome(g.dimension).kind, "open");
});

test("T-046: a dimension with no deadline is omitted from what is presented", () => {
  const snaps = presented({ completionDueAtUtc: h(NOW, 10) });
  const shown = presentReviewSlaDimensions(snaps).map((s) => s.dimension);
  assert.deepEqual(shown, ["COMPLETION"]);
});

test("T-048: the governing deadline is the earliest NOT completed dimension", () => {
  const snaps = presented({
    assignmentDueAtUtc: h(NOW, -400),
    assignedAtUtc: h(NOW, -410),
    completionDueAtUtc: h(NOW, 20),
  });
  const g = governingReviewDeadline(snaps);
  assert.equal(g.kind, "open");
  assert.equal(g.dimension.dimension, "COMPLETION");
  const allDone = presented({ assignmentDueAtUtc: h(NOW, 1), assignedAtUtc: h(NOW, -1) });
  assert.deepEqual(governingReviewDeadline(allDone), { kind: "all_met", missed: 0 });
  assert.deepEqual(governingReviewDeadline(presented({})), { kind: "none" });
});

test("stored slaStatus semantics are unchanged (CONSUMER-MAP M12)", () => {
  // Started, undecided, first-review deadline passed: the stored reading still
  // counts the first touch (and the escalation trigger), as before stage C.
  const row = {
    lastReviewedAt: h(NOW, -30),
    firstResponseDueAtUtc: h(NOW, -5),
    completionDueAtUtc: h(NOW, 40),
  };
  assert.equal(storedReviewSlaStatus(row, { nowUtc: NOW }), "ON_TRACK");
  const trigger = { escalationDueAtUtc: h(NOW, -1), completionDueAtUtc: h(NOW, 40) };
  assert.equal(storedReviewSlaStatus(trigger, { nowUtc: NOW }), "BREACHED");
});

test("T-051: a finished review with a lingering escalation keeps its finished state", () => {
  assert.equal(deriveLifecycleState("REJECTED_INSUFFICIENT", true), "REJECTED");
  assert.equal(deriveLifecycleState("CLOSED", true), "ARCHIVED");
  assert.equal(deriveLifecycleState("IN_REVIEW", true), "ESCALATED");
});

test("T-049: the selector picks the highest active severity and counts the active ones", () => {
  // ADD-SECURITY Q5.2: E1 HIGH acknowledged (older), E2 WARNING open (newer).
  const rows = [
    { id: "e1", severity: "HIGH", status: "ACKNOWLEDGED", createdAt: "2026-11-01T00:00:00Z" },
    { id: "e2", severity: "WARNING", status: "OPEN", createdAt: "2026-11-10T00:00:00Z" },
    { id: "e0", severity: "CRITICAL", status: "RESOLVED", createdAt: "2026-11-11T00:00:00Z" },
  ];
  const sel = selectGoverningEscalation(rows);
  assert.equal(sel.top.id, "e1");
  assert.equal(sel.activeCount, 2);
  // Resolving the lower one does not hide the higher one.
  const after = selectGoverningEscalation([rows[0], { ...rows[1], status: "RESOLVED" }]);
  assert.equal(after.top.id, "e1");
  assert.equal(after.activeCount, 1);
  assert.deepEqual(selectGoverningEscalation([]), { top: null, activeCount: 0 });
});

test("T-052: units are named; reviews and escalations are different measures", () => {
  assert.equal(formatReviewCount(1, "reviews"), "1 review");
  assert.equal(formatReviewCount(2, "escalations"), "2 escalations");
  assert.equal(REVIEW_COUNT_DEFINITIONS.escalatedReviews.unit, "reviews");
  assert.equal(REVIEW_COUNT_DEFINITIONS.activeEscalations.unit, "escalations");
});

test("T-057: the ESCALATED status label never says 'manual decision'", () => {
  assert.doesNotMatch(REVIEW_ESCALATED_STATUS_LABEL, /manual decision/i);
});
