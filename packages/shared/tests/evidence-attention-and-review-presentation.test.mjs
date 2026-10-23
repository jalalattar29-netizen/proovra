/**
 * Evidence ID page authorities (2026-10-23) — proofs.
 *
 *   1. classifyEvidenceAttention: every fact the page states is classified by
 *      CODE into exactly one category; the reported record (no flagged issue,
 *      imported upload, old file timestamp, no case, review not started) has
 *      ONE recommended action and no warning.
 *   2. projectReviewWorkflowActions: the buttons a viewer may press follow the
 *      shared stage matrix and every refusal the review routes make.
 *   3. summarizeReviewWorkflowEvents: creation's four automatic events read as
 *      one entry, no enum and no identifier reaches a reader, nothing stored is
 *      dropped.
 *   4. presentEvidenceProtection: the legal-hold / retention truth table.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyEvidenceAttention,
  isEvidenceReviewerAlertCode,
  projectReviewWorkflowActions,
  summarizeReviewWorkflowEvents,
  reviewAssigneeLabel,
  reviewStatusLabel,
  reviewWorkflowEventLabel,
  presentEvidenceProtection,
} from "../dist/index.js";

const NONE_SOURCE = { importedUpload: false, oldLastModified: false, screenshotLikeDetected: false, genericMime: false };
const base = (over = {}) => ({
  alerts: [],
  source: NONE_SOURCE,
  caseAssignment: { assigned: true, policy: "OPTIONAL", viewerCanAssign: true },
  review: { applicable: false, notStarted: false, viewerCanStart: false },
  ...over,
});
const byCode = (a) => Object.fromEntries(a.items.map((i) => [i.code, i]));

// ---------------------------------------------------------------------------
// 1. Attention
// ---------------------------------------------------------------------------

test("the reported record: one recommended action, no warning, benign facts out of the strip", () => {
  const a = classifyEvidenceAttention(
    base({
      alerts: [{ code: "NO_FLAGGED_ISSUES", label: "No flagged issues", detail: "…" }],
      source: { ...NONE_SOURCE, importedUpload: true, oldLastModified: true },
      caseAssignment: { assigned: false, policy: "OPTIONAL", viewerCanAssign: true },
      review: { applicable: true, notStarted: true, viewerCanStart: true },
    }),
  );
  const c = byCode(a);
  assert.equal(a.headline, "ACTION_RECOMMENDED");
  assert.equal(c.NO_FLAGGED_ISSUES.category, "HEALTHY");
  assert.equal(c.IMPORTED_UPLOAD.category, "INFORMATIONAL");
  assert.equal(c.IMPORTED_UPLOAD.placement, "PROVENANCE");
  assert.equal(c.FILE_TIMESTAMP_NOTE.category, "ADVISORY");
  assert.equal(c.FILE_TIMESTAMP_NOTE.placement, "SIGNAL");
  assert.doesNotMatch(c.FILE_TIMESTAMP_NOTE.detail, /manipulat(ed|ion) (was|is) (found|detected)/i);
  // Optional case → metadata, never an attention item.
  assert.equal(c.CASE_UNASSIGNED.category, "INFORMATIONAL");
  assert.equal(c.CASE_UNASSIGNED.action, null);
  assert.equal(c.REVIEW_NOT_STARTED.category, "ACTION_RECOMMENDED");
  assert.equal(c.REVIEW_NOT_STARTED.action, "START_REVIEW");
  const strip = a.items.filter((i) => i.placement === "ATTENTION");
  assert.deepEqual(strip.map((i) => i.code), ["REVIEW_NOT_STARTED"]);
  assert.ok(a.items.every((i) => i.tone !== "warning" && i.tone !== "destructive"));
});

test("nothing actionable → NO_ACTION headline", () => {
  const a = classifyEvidenceAttention(base({ alerts: [{ code: "NO_FLAGGED_ISSUES", label: "x", detail: "y" }] }));
  assert.equal(a.headline, "NO_ACTION");
  assert.equal(a.items.filter((i) => i.placement === "ATTENTION").length, 0);
});

test("review not started is offered only when review applies AND the viewer can act", () => {
  for (const [applicable, viewerCanStart] of [[false, true], [true, false], [false, false]]) {
    const a = classifyEvidenceAttention(base({ review: { applicable, notStarted: true, viewerCanStart } }));
    assert.equal(byCode(a).REVIEW_NOT_STARTED, undefined, `${applicable}/${viewerCanStart}`);
  }
});

test("case policy decides the category; a viewer who cannot assign gets no action", () => {
  const cat = (policy, viewerCanAssign) =>
    byCode(classifyEvidenceAttention(base({ caseAssignment: { assigned: false, policy, viewerCanAssign } }))).CASE_UNASSIGNED;
  assert.equal(cat("OPTIONAL", true).category, "INFORMATIONAL");
  assert.equal(cat("RECOMMENDED", true).category, "ACTION_RECOMMENDED");
  assert.equal(cat("REQUIRED", true).category, "ACTION_REQUIRED");
  assert.equal(cat("REQUIRED", false).category, "INFORMATIONAL");
  assert.equal(cat("REQUIRED", false).action, null);
});

test("integrity failures are required and outrank everything; eligible outputs are recommended", () => {
  const a = classifyEvidenceAttention(
    base({
      alerts: [
        { code: "REPORT_ELIGIBLE_NOT_GENERATED", label: "Report — not generated yet", detail: "…" },
        { code: "OTS_FAILED", label: "OTS failed", detail: "…" },
        { code: "CUSTODY_CHAIN_ISSUE", label: "Custody chain issue", detail: "…" },
      ],
    }),
  );
  assert.equal(a.headline, "ACTION_REQUIRED");
  assert.deepEqual(a.items.map((i) => i.code), ["CUSTODY_CHAIN_ISSUE", "OTS_FAILED", "REPORT_ELIGIBLE_NOT_GENERATED"]);
  assert.equal(byCode(a).REPORT_ELIGIBLE_NOT_GENERATED.action, "OPEN_ARTIFACTS");
});

test("every alert code is classified; unknown strings are not codes", () => {
  for (const code of ["TRASH_RETENTION_ACTIVE", "PACKAGE_BLOCKED", "REPORT_QUEUED", "STORAGE_PROTECTION_UNCONFIRMED"]) {
    assert.ok(isEvidenceReviewerAlertCode(code), code);
  }
  assert.equal(isEvidenceReviewerAlertCode("Review ready"), false);
});

// ---------------------------------------------------------------------------
// 2. Available actions
// ---------------------------------------------------------------------------

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const actions = (over) =>
  Object.fromEntries(
    projectReviewWorkflowActions({
      dbStatus: "NOT_STARTED",
      assignedToUserId: null,
      viewerUserId: ME,
      viewerMayReview: true,
      hasWorkspace: true,
      verdictRecorded: false,
      ...over,
    }).map((a) => [a.action, a]),
  );

test("not started, unassigned: Claim, Escalate and Close only", () => {
  const a = actions({});
  assert.deepEqual(
    Object.values(a).filter((x) => x.enabled).map((x) => x.action),
    ["CLAIM", "ESCALATE", "CLOSE"],
  );
  assert.equal(a.APPROVE_INTERNAL.blockedBy, "NOT_FROM_STAGE");
  assert.equal(a.ESCALATE.requiresNote, true);
});

test("claim: yours → ALREADY_YOURS; someone else's → OWNED_BY_SOMEONE_ELSE", () => {
  assert.equal(actions({ dbStatus: "ASSIGNED", assignedToUserId: ME }).CLAIM.blockedBy, "ALREADY_YOURS");
  assert.equal(actions({ dbStatus: "ASSIGNED", assignedToUserId: OTHER }).CLAIM.blockedBy, "OWNED_BY_SOMEONE_ELSE");
});

test("in review: verdicts enabled until one is recorded", () => {
  assert.equal(actions({ dbStatus: "IN_REVIEW", assignedToUserId: ME }).APPROVE_INTERNAL.enabled, true);
  const after = actions({ dbStatus: "IN_REVIEW", assignedToUserId: ME, verdictRecorded: true });
  assert.equal(after.APPROVE_INTERNAL.blockedBy, "VERDICT_RECORDED");
  assert.equal(after.REJECT_INSUFFICIENT.blockedBy, "VERDICT_RECORDED");
});

test("closed: only Reopen; reopened: no Reopen, no Close (the server refuses both)", () => {
  const closed = actions({ dbStatus: "CLOSED", assignedToUserId: ME, verdictRecorded: true });
  assert.deepEqual(Object.values(closed).filter((x) => x.enabled).map((x) => x.action), ["REOPEN"]);
  const reopened = actions({ dbStatus: "REOPENED", assignedToUserId: ME, verdictRecorded: true });
  assert.equal(reopened.REOPEN.enabled, false);
  assert.equal(reopened.CLOSE.enabled, false);
  assert.equal(reopened.ESCALATE.enabled, true);
});

test("escalated: Escalate is not offered again", () => {
  assert.equal(actions({ dbStatus: "ESCALATED", assignedToUserId: ME }).ESCALATE.enabled, false);
});

test("no permission / no workspace / no workflow block everything", () => {
  for (const over of [{ viewerMayReview: false }, { hasWorkspace: false }, { dbStatus: null }]) {
    assert.ok(Object.values(actions(over)).every((x) => !x.enabled), JSON.stringify(over));
  }
  assert.equal(actions({ viewerMayReview: false }).CLAIM.blockedBy, "NOT_PERMITTED");
});

// ---------------------------------------------------------------------------
// 3. History
// ---------------------------------------------------------------------------

test("creation's four automatic events read as ONE entry; nothing stored is dropped", () => {
  const t = "2026-10-20T10:00:00.000Z";
  const owner = { id: OTHER, displayName: null, email: null };
  const events = [
    { id: "e1", eventType: "CREATED", createdAt: t, actor: owner, note: null },
    { id: "e2", eventType: "UNASSIGNED", createdAt: t, actor: owner, note: null },
    { id: "e3", eventType: "STATUS_CHANGED", createdAt: t, actor: owner, note: null },
    { id: "e4", eventType: "PRIORITY_CHANGED", createdAt: t, actor: owner, note: null },
    { id: "e5", eventType: "CLAIMED", createdAt: "2026-10-21T09:00:00.000Z", actor: { id: ME, displayName: "Dana", email: null }, note: null },
    { id: "e6", eventType: "ESCALATED", createdAt: "2026-10-21T10:00:00.000Z", actor: null, note: "Needs counsel" },
  ];
  const h = summarizeReviewWorkflowEvents(events, ME);
  assert.equal(h.length, 3);
  assert.deepEqual(h.map((e) => e.label), ["Escalated", "Review claimed", "Review workflow created"]);
  assert.deepEqual(h[2].eventIds.sort(), ["e1", "e2", "e3", "e4"]);
  assert.equal(h[2].origin, "SYSTEM");
  assert.equal(h[1].actorLabel, "You");
  assert.equal(h[0].actorLabel, "Former workspace member");
  assert.equal(h.flatMap((e) => e.eventIds).length, events.length);
  for (const e of h) {
    assert.doesNotMatch(e.label, /^[A-Z_]+$/);
    assert.doesNotMatch(e.actorLabel, /[0-9a-f]{8}/);
  }
});

test("labels: no enum, no identifier", () => {
  assert.equal(reviewStatusLabel("NOT_STARTED"), "Not started");
  assert.equal(reviewStatusLabel("NEEDS_INFO"), "More information requested");
  assert.equal(reviewWorkflowEventLabel("SOMETHING_NEW"), "Workflow updated");
  assert.equal(reviewAssigneeLabel({ id: OTHER, displayName: null, email: null }, ME), "Workspace member");
  assert.equal(reviewAssigneeLabel(null, ME), "Unassigned");
});

// ---------------------------------------------------------------------------
// 4. Legal hold / retention truth table
// ---------------------------------------------------------------------------

const fmt = (iso) => iso.slice(0, 10);
const NOW = new Date("2026-10-23T00:00:00.000Z");
const lc = (over) => ({
  productState: "ACTIVE",
  legalHold: false,
  legalHoldState: "NONE",
  appRetentionUntilUtc: null,
  objectLockRetainUntilUtc: null,
  effectiveRetentionUntilUtc: null,
  ...over,
});

test("legal hold: ACTIVE / NONE / UNAVAILABLE / list-row boolean / missing projection", () => {
  const p = (over) => presentEvidenceProtection(lc(over), fmt, NOW).legalHold;
  assert.equal(p({ legalHold: true, legalHoldState: "ACTIVE" }).state, "recorded");
  assert.match(p({ legalHold: true, legalHoldState: "ACTIVE" }).value, /^Active legal hold/);
  assert.equal(p({}).state, "not-applicable");
  assert.match(p({}).value, /^No active legal hold/);
  // Fail-closed boolean, but the read FAILED: never "active", never "none".
  const failed = p({ legalHold: true, legalHoldState: "UNAVAILABLE" });
  assert.equal(failed.state, "unavailable");
  assert.doesNotMatch(failed.value, /^Active|^No active/);
  assert.equal(p({ legalHold: true, legalHoldState: undefined }).state, "recorded");
  assert.equal(presentEvidenceProtection(null, fmt, NOW).legalHold.state, "unavailable");
});

test("retention: lock only / policy only / both / none / ended / destroyed — never 'unprotected'", () => {
  const r = (over) => presentEvidenceProtection(lc(over), fmt, NOW).retention;
  const lockOnly = r({ objectLockRetainUntilUtc: "2034-10-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" });
  assert.equal(lockOnly.state, "recorded");
  assert.equal(lockOnly.value, "Retained until 2034-10-01 (storage lock until 2034-10-01)");
  const policyOnly = r({ appRetentionUntilUtc: "2027-01-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2027-01-01T00:00:00.000Z" });
  assert.equal(policyOnly.value, "Retained until 2027-01-01 (workspace policy until 2027-01-01)");
  const both = r({
    appRetentionUntilUtc: "2027-01-01T00:00:00.000Z",
    objectLockRetainUntilUtc: "2034-10-01T00:00:00.000Z",
    effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z",
  });
  assert.match(both.value, /^Retained until 2034-10-01 \(workspace policy until 2027-01-01; storage lock until 2034-10-01\)$/);
  const none = r({});
  assert.equal(none.state, "not-applicable");
  assert.doesNotMatch(none.value, /unprotected|not protected|unavailable/i);
  assert.match(r({ objectLockRetainUntilUtc: "2020-01-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2020-01-01T00:00:00.000Z" }).value, /^Retention ended/);
  for (const productState of ["ARCHIVED", "TRASHED"]) {
    assert.equal(r({ productState, objectLockRetainUntilUtc: "2034-10-01T00:00:00.000Z", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" }).state, "recorded");
  }
  assert.equal(r({ productState: "DESTROYED", effectiveRetentionUntilUtc: "2034-10-01T00:00:00.000Z" }).state, "not-applicable");
});
