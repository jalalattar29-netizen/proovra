import test from "node:test";
import assert from "node:assert/strict";

// Phase 25.5 — Reviewer Operations Hardening shared-types contract tests.
//
// Coverage:
//   - SLA policy precedence: template > workspace > env > shared default
//   - SLA policy schema bounds (1..720 hours, .strict() rejects unknown keys)
//   - Reminder kind catalog membership + schema
//   - Bulk action catalog + bulk-input schema validation rules
//   - Bulk-input requires `note` for ESCALATE / PAUSE / REQUEST_INFO and
//     `assignedToUserId` for ASSIGN / REASSIGN (zod superRefine)
//   - Bulk hard cap (REVIEWER_OPS_BULK_MAX_ITEMS)
//   - Saved-view scope catalog
//   - SavedViewFilter schema bounds
//   - isReviewerInactive helper
//   - REVIEWER_OPS_BULK_HIGH_RISK_ACTIONS set membership
//   - High-risk Phase 25.5 step-up purposes are in the shared catalog

import {
  REVIEWER_OPS_BULK_ACTIONS,
  REVIEWER_OPS_BULK_HIGH_RISK_ACTIONS,
  REVIEWER_OPS_BULK_MAX_ITEMS,
  REVIEWER_OPS_DEFAULT_SLA_POLICY,
  REVIEWER_OPS_INACTIVITY_DEFAULT_HOURS,
  REVIEWER_OPS_REMINDER_KINDS,
  REVIEWER_OPS_REMINDER_STATUSES,
  REVIEWER_OPS_SAVED_VIEW_SCOPE,
  REVIEWER_OPS_SLA_POLICY_HOURS_MAX,
  REVIEWER_OPS_SLA_POLICY_HOURS_MIN,
  ReviewerOpsBulkActionSchema,
  ReviewerOpsBulkInputSchema,
  ReviewerOpsReminderKindSchema,
  ReviewerOpsSavedViewFilterSchema,
  ReviewerOpsSlaPolicySchema,
  SAVED_VIEW_SCOPES,
  SEARCH_SAVED_VIEW_SCOPE,
  STEP_UP_PURPOSES,
  isReviewerInactive,
  resolveReviewerOpsSlaPolicy,
} from "../dist/index.js";

const TEAM_ID = "00000000-0000-0000-0000-000000000000";
const USER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// -----------------------------------------------------------------------------
// SLA policy precedence
// -----------------------------------------------------------------------------

test("resolveReviewerOpsSlaPolicy falls through to shared defaults when nothing supplied", () => {
  const policy = resolveReviewerOpsSlaPolicy({});
  assert.deepEqual(policy, REVIEWER_OPS_DEFAULT_SLA_POLICY);
});

test("resolveReviewerOpsSlaPolicy: env defaults override shared defaults", () => {
  const policy = resolveReviewerOpsSlaPolicy({
    envDefaults: { assignmentHours: 12 },
  });
  assert.equal(policy.assignmentHours, 12);
  assert.equal(
    policy.firstReviewHours,
    REVIEWER_OPS_DEFAULT_SLA_POLICY.firstReviewHours,
  );
});

test("resolveReviewerOpsSlaPolicy: workspace overrides env", () => {
  const policy = resolveReviewerOpsSlaPolicy({
    envDefaults: { assignmentHours: 12 },
    workspaceOverride: { assignmentHours: 6 },
  });
  assert.equal(policy.assignmentHours, 6);
});

test("resolveReviewerOpsSlaPolicy: template overrides workspace + env", () => {
  const policy = resolveReviewerOpsSlaPolicy({
    envDefaults: { assignmentHours: 12 },
    workspaceOverride: { assignmentHours: 6 },
    templateOverride: { assignmentHours: 2 },
  });
  assert.equal(policy.assignmentHours, 2);
});

test("resolveReviewerOpsSlaPolicy: per-field precedence (workspace wins on one, template on another)", () => {
  const policy = resolveReviewerOpsSlaPolicy({
    envDefaults: { assignmentHours: 4, completionHours: 100 },
    workspaceOverride: { completionHours: 48 },
    templateOverride: { assignmentHours: 1 },
  });
  assert.equal(policy.assignmentHours, 1);
  assert.equal(policy.completionHours, 48);
});

// -----------------------------------------------------------------------------
// SLA policy schema
// -----------------------------------------------------------------------------

test("ReviewerOpsSlaPolicySchema accepts valid policy", () => {
  const r = ReviewerOpsSlaPolicySchema.safeParse({
    assignmentHours: 4,
    firstReviewHours: 24,
    completionHours: 72,
    escalationHours: 48,
    dueSoonHours: 6,
  });
  assert.equal(r.success, true);
});

test("ReviewerOpsSlaPolicySchema rejects out-of-bounds values", () => {
  assert.equal(
    ReviewerOpsSlaPolicySchema.safeParse({ assignmentHours: 0 }).success,
    false,
  );
  assert.equal(
    ReviewerOpsSlaPolicySchema.safeParse({
      assignmentHours: REVIEWER_OPS_SLA_POLICY_HOURS_MAX + 1,
    }).success,
    false,
  );
  assert.equal(
    ReviewerOpsSlaPolicySchema.safeParse({
      assignmentHours: REVIEWER_OPS_SLA_POLICY_HOURS_MIN,
    }).success,
    true,
  );
});

test("ReviewerOpsSlaPolicySchema rejects unknown keys (.strict)", () => {
  const r = ReviewerOpsSlaPolicySchema.safeParse({
    assignmentHours: 4,
    randomKey: 99,
  });
  assert.equal(r.success, false);
});

// -----------------------------------------------------------------------------
// Reminder kinds
// -----------------------------------------------------------------------------

test("REVIEWER_OPS_REMINDER_KINDS covers the brief", () => {
  for (const k of [
    "DUE_SOON",
    "ESCALATION_WARNING",
    "REVIEWER_INACTIVE",
    "REASSIGNMENT_SUGGESTION",
  ]) {
    assert.equal(REVIEWER_OPS_REMINDER_KINDS.includes(k), true);
    assert.equal(ReviewerOpsReminderKindSchema.safeParse(k).success, true);
  }
});

test("REVIEWER_OPS_REMINDER_STATUSES covers the lifecycle", () => {
  for (const s of ["SCHEDULED", "DELIVERED", "SUPPRESSED", "FAILED"]) {
    assert.equal(REVIEWER_OPS_REMINDER_STATUSES.includes(s), true);
  }
});

// -----------------------------------------------------------------------------
// Bulk action catalog + input schema
// -----------------------------------------------------------------------------

test("REVIEWER_OPS_BULK_ACTIONS catalog complete", () => {
  for (const a of [
    "ASSIGN",
    "REASSIGN",
    "ESCALATE",
    "PAUSE",
    "REQUEST_INFO",
    "CLOSE",
    "PRIORITY_HIGH",
    "PRIORITY_NORMAL",
    "PRIORITY_URGENT",
  ]) {
    assert.equal(REVIEWER_OPS_BULK_ACTIONS.includes(a), true);
    assert.equal(ReviewerOpsBulkActionSchema.safeParse(a).success, true);
  }
});

test("ReviewerOpsBulkInputSchema requires assignedToUserId for ASSIGN", () => {
  const r = ReviewerOpsBulkInputSchema.safeParse({
    teamId: TEAM_ID,
    workflowIds: [USER_ID],
    action: "ASSIGN",
  });
  assert.equal(r.success, false);
});

test("ReviewerOpsBulkInputSchema accepts ASSIGN with assignedToUserId", () => {
  const r = ReviewerOpsBulkInputSchema.safeParse({
    teamId: TEAM_ID,
    workflowIds: [USER_ID],
    action: "ASSIGN",
    assignedToUserId: USER_ID,
  });
  assert.equal(r.success, true);
});

test("ReviewerOpsBulkInputSchema requires note for ESCALATE", () => {
  const r = ReviewerOpsBulkInputSchema.safeParse({
    teamId: TEAM_ID,
    workflowIds: [USER_ID],
    action: "ESCALATE",
  });
  assert.equal(r.success, false);
});

test("ReviewerOpsBulkInputSchema requires note for PAUSE + REQUEST_INFO", () => {
  for (const action of ["PAUSE", "REQUEST_INFO"]) {
    const r = ReviewerOpsBulkInputSchema.safeParse({
      teamId: TEAM_ID,
      workflowIds: [USER_ID],
      action,
    });
    assert.equal(r.success, false, `expected ${action} to require note`);
  }
});

test("ReviewerOpsBulkInputSchema accepts ESCALATE/PAUSE/REQUEST_INFO with note", () => {
  for (const action of ["ESCALATE", "PAUSE", "REQUEST_INFO"]) {
    const r = ReviewerOpsBulkInputSchema.safeParse({
      teamId: TEAM_ID,
      workflowIds: [USER_ID],
      action,
      note: "operator note",
    });
    assert.equal(r.success, true);
  }
});

test("ReviewerOpsBulkInputSchema enforces hard cap on workflowIds", () => {
  const ids = Array.from({ length: REVIEWER_OPS_BULK_MAX_ITEMS + 1 }, () => USER_ID);
  const r = ReviewerOpsBulkInputSchema.safeParse({
    teamId: TEAM_ID,
    workflowIds: ids,
    action: "CLOSE",
  });
  assert.equal(r.success, false);
});

test("ReviewerOpsBulkInputSchema accepts priority actions without note or assignee", () => {
  const r = ReviewerOpsBulkInputSchema.safeParse({
    teamId: TEAM_ID,
    workflowIds: [USER_ID],
    action: "PRIORITY_HIGH",
  });
  assert.equal(r.success, true);
});

test("ReviewerOpsBulkInputSchema rejects unknown action", () => {
  const r = ReviewerOpsBulkInputSchema.safeParse({
    teamId: TEAM_ID,
    workflowIds: [USER_ID],
    action: "DELETE_FOREVER",
  });
  assert.equal(r.success, false);
});

test("REVIEWER_OPS_BULK_HIGH_RISK_ACTIONS contains ESCALATE / CLOSE / PRIORITY_URGENT", () => {
  for (const a of ["ESCALATE", "CLOSE", "PRIORITY_URGENT"]) {
    assert.equal(REVIEWER_OPS_BULK_HIGH_RISK_ACTIONS.has(a), true);
  }
  // ASSIGN is NOT high-risk (operator routine).
  assert.equal(REVIEWER_OPS_BULK_HIGH_RISK_ACTIONS.has("ASSIGN"), false);
});

// -----------------------------------------------------------------------------
// Saved view scope
// -----------------------------------------------------------------------------

test("SAVED_VIEW_SCOPES enumerates SEARCH + REVIEWER_OPS", () => {
  assert.equal(SAVED_VIEW_SCOPES.length, 2);
  assert.equal(SAVED_VIEW_SCOPES.includes(SEARCH_SAVED_VIEW_SCOPE), true);
  assert.equal(SAVED_VIEW_SCOPES.includes(REVIEWER_OPS_SAVED_VIEW_SCOPE), true);
});

test("ReviewerOpsSavedViewFilterSchema accepts a minimal valid filter", () => {
  const r = ReviewerOpsSavedViewFilterSchema.safeParse({ teamId: TEAM_ID });
  assert.equal(r.success, true);
});

test("ReviewerOpsSavedViewFilterSchema accepts a fully-populated filter", () => {
  const r = ReviewerOpsSavedViewFilterSchema.safeParse({
    teamId: TEAM_ID,
    queue: "OVERDUE",
    slaStates: ["BREACHED", "DUE_SOON"],
    lifecycleStates: ["IN_REVIEW", "ESCALATED"],
    onlyMine: true,
    priority: "HIGH",
    sortBy: "SLA_URGENCY",
  });
  assert.equal(r.success, true);
});

test("ReviewerOpsSavedViewFilterSchema rejects unknown keys (.strict)", () => {
  const r = ReviewerOpsSavedViewFilterSchema.safeParse({
    teamId: TEAM_ID,
    bogus: 1,
  });
  assert.equal(r.success, false);
});

// -----------------------------------------------------------------------------
// Inactivity helper
// -----------------------------------------------------------------------------

test("isReviewerInactive returns false when no anchor (never touched + never assigned)", () => {
  const result = isReviewerInactive({
    nowUtc: new Date("2026-05-18T12:00:00Z"),
    lastReviewedAtUtc: null,
    assignedAtUtc: null,
  });
  assert.equal(result, false);
});

test("isReviewerInactive uses assignedAtUtc when lastReviewedAt is null", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const stale = new Date(now.getTime() - 200 * 3600_000); // 200h ago
  assert.equal(
    isReviewerInactive({
      nowUtc: now,
      lastReviewedAtUtc: null,
      assignedAtUtc: stale,
      thresholdHours: 24,
    }),
    true,
  );
});

test("isReviewerInactive prefers lastReviewedAt over assignedAtUtc", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const stale = new Date(now.getTime() - 200 * 3600_000);
  const recent = new Date(now.getTime() - 1 * 3600_000); // 1h ago
  assert.equal(
    isReviewerInactive({
      nowUtc: now,
      lastReviewedAtUtc: recent,
      assignedAtUtc: stale,
      thresholdHours: 24,
    }),
    false,
  );
});

test("isReviewerInactive default threshold matches catalog", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  // Just-under-default: should be active.
  const justInside = new Date(
    now.getTime() -
      (REVIEWER_OPS_INACTIVITY_DEFAULT_HOURS - 1) * 3600_000,
  );
  assert.equal(
    isReviewerInactive({
      nowUtc: now,
      lastReviewedAtUtc: justInside,
      assignedAtUtc: null,
    }),
    false,
  );
  const justOutside = new Date(
    now.getTime() -
      (REVIEWER_OPS_INACTIVITY_DEFAULT_HOURS + 1) * 3600_000,
  );
  assert.equal(
    isReviewerInactive({
      nowUtc: now,
      lastReviewedAtUtc: justOutside,
      assignedAtUtc: null,
    }),
    true,
  );
});

// -----------------------------------------------------------------------------
// Phase 25.5 step-up purposes registered in the shared catalog
// -----------------------------------------------------------------------------

test("Phase 25.5 step-up purposes are catalogued", () => {
  for (const p of [
    "REVIEWER_OPS_REJECT",
    "REVIEWER_OPS_ESCALATION_RESOLVE",
    "REVIEWER_OPS_BULK_ACTION",
  ]) {
    assert.equal(
      STEP_UP_PURPOSES.includes(p),
      true,
      `step-up purpose ${p} should be registered`,
    );
  }
});
