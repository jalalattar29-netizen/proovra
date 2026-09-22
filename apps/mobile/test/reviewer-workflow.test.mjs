/**
 * REVIEWER WORKFLOW — the state of the review.
 *
 * Fixtures are the envelopes the routes actually send: `toWorkflowSummary`
 * (reviewer-workflow.service.ts:14) for the summary and the `{ items }` map at
 * evidence.routes.ts:8360 for the events, with the actor object as
 * mapCollaborativeAuthor builds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const HERE = dirname(fileURLToPath(import.meta.url));

const compile = (file) =>
  ts.transpileModule(readFileSync(resolve(HERE, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const url = (file) => `data:text/javascript,${encodeURIComponent(compile(file))}`;

// A data-URL module cannot resolve a relative import, so each dependency is
// inlined as a nested data URL. The generated enums in particular are
// substituted FOR REAL: the point of generating them is that the values under
// test are the canonical ones.
const ENUMS_URL = url("../src/product/domain-enums.generated.ts");
const ENVELOPE_URL = url("../src/product/envelope.ts");
const DISPLAY_URL =
  "data:text/javascript," +
  encodeURIComponent(
    compile("../src/product/domain-display.ts").replace(
      /from ["']\.\/domain-enums\.generated["']/g,
      `from "${ENUMS_URL}"`,
    ),
  );

const src = readFileSync(resolve(HERE, "../src/product/reviewer-workflow.ts"), "utf8")
  .replace('from "./domain-display"', `from "${DISPLAY_URL}"`)
  .replace('from "./envelope"', `from "${ENVELOPE_URL}"`)
  .replace('from "./domain-enums.generated"', `from "${ENUMS_URL}"`);
const mod = await import(
  `data:text/javascript,${encodeURIComponent(
    ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )}`
);

const ACTOR = { id: "u-1", displayName: "Ada Lovelace", email: "ada@example.com" };

const SUMMARY = {
  available: true,
  workflow: {
    id: "wf-1",
    evidenceId: "ev-1",
    workspaceType: "TEAM",
    teamId: "t-1",
    status: "IN_REVIEW",
    priority: "HIGH",
    dueAt: "2026-09-30T17:00:00.000Z",
    lastReviewedAt: "2026-09-21T09:00:00.000Z",
    closedAt: null,
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-21T09:00:00.000Z",
    assignedTo: ACTOR,
    assignedBy: ACTOR,
  },
};

/* ------------------------------------------------------------- the paths */

test("the reviewer-workflow paths are the canonical ones", () => {
  assert.equal(mod.buildReviewerWorkflowPath("ev 1"), "/v1/evidence/ev%201/reviewer-workflow");
  assert.equal(
    mod.buildReviewerWorkflowEventsPath("ev-1"),
    "/v1/evidence/ev-1/reviewer-workflow/events",
  );
});

/* -------------------------------------------------------------- the rule */

test("a verdict is never offered as something to select", () => {
  // `status` carries routing states AND verdict states, and only the decision
  // authority may produce a verdict (review-status-vocabulary.ts). A picker
  // offering one would be offering to forge it.
  for (const verdict of ["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "NEEDS_INFO"]) {
    assert.equal(mod.isVerdictStatus(verdict), true, `${verdict} is a verdict`);
    assert.ok(
      !mod.ROUTING_WORKFLOW_STATUSES.includes(verdict),
      `${verdict} must not be offered`,
    );
  }
  assert.equal(mod.isVerdictStatus("IN_REVIEW"), false);
  assert.equal(mod.isVerdictStatus(null), false);
  assert.equal(mod.isVerdictStatus(undefined), false);
});

test("the routing list is derived by subtraction, not typed out", () => {
  // Written out by hand, it would be a second list — and the day a state is
  // added to the schema the two would disagree about which kind it is.
  assert.ok(mod.ROUTING_WORKFLOW_STATUSES.includes("NOT_STARTED"));
  assert.ok(mod.ROUTING_WORKFLOW_STATUSES.includes("IN_REVIEW"));
  assert.ok(mod.ROUTING_WORKFLOW_STATUSES.includes("CLOSED"));
  assert.equal(mod.ROUTING_WORKFLOW_STATUSES.length, 12 - 3);
  assert.equal(mod.WORKFLOW_PRIORITIES.length, 4);
});

test("the verdict note explains the distinction in words the reviewer reads", () => {
  assert.match(mod.VERDICT_STATUS_NOTE, /recorded review decision/);
  assert.match(mod.VERDICT_STATUS_NOTE, /not set directly/);
});

/* -------------------------------------------------------------- the read */

test("the summary is read out of the envelope the route sends", () => {
  const w = mod.parseReviewerWorkflow(SUMMARY);
  assert.equal(w.status, "IN_REVIEW");
  assert.equal(w.priority, "HIGH");
  assert.equal(w.dueAtIso, "2026-09-30T17:00:00.000Z");
  assert.equal(w.lastReviewedAtIso, "2026-09-21T09:00:00.000Z");
  assert.equal(w.closedAtIso, null);
  assert.equal(w.assignedToLabel, "Ada Lovelace");
});

test("no workflow yet is a real answer, distinct from not started", () => {
  // `available: false` means the record has no workflow ROW. "Not started" is
  // a status a row can hold. They are different things to say about a record.
  assert.equal(mod.parseReviewerWorkflow({ available: false, workflow: null }), null);
  assert.equal(mod.parseReviewerWorkflow({}), null);
  const started = mod.parseReviewerWorkflow({
    available: true,
    workflow: { status: "NOT_STARTED" },
  });
  assert.equal(started.status, "NOT_STARTED");
});

test("an unassigned review is unassigned, never a raw user id", () => {
  const w = mod.parseReviewerWorkflow({
    available: true,
    workflow: { status: "QUEUED", assignedTo: { id: "u-9", displayName: null, email: null } },
  });
  assert.equal(w.assignedToLabel, null);
  assert.equal(w.assignedToUserId, "u-9");
});

test("the event feed is read from its items envelope", () => {
  const events = mod.parseReviewerWorkflowEvents({
    items: [
      {
        id: "e-1",
        eventType: "STATUS_CHANGED",
        note: "Moved to review",
        previousValue: { status: "QUEUED" },
        nextValue: { status: "IN_REVIEW" },
        createdAt: "2026-09-21T09:00:00.000Z",
        actor: ACTOR,
      },
      { eventType: "NOISE" },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "STATUS_CHANGED");
  assert.equal(events[0].actorLabel, "Ada Lovelace");
  assert.equal(mod.workflowEventLabel("STATUS_CHANGED"), "Status Changed");
});

test("an unreadable event envelope refuses rather than reporting no history", () => {
  assert.deepEqual(mod.parseReviewerWorkflowEvents({ items: [] }), []);
  for (const bad of [null, { events: [] }, 7]) {
    assert.throws(() => mod.parseReviewerWorkflowEvents(bad), /Unreadable list response/);
  }
});

/* ------------------------------------------------------------- the write */

test("only what CHANGED is sent", () => {
  // Re-sending the current status would append an event saying it was set, on
  // the one feed whose purpose is to be an accurate account of what was done.
  const current = mod.parseReviewerWorkflow(SUMMARY);
  assert.deepEqual(
    mod.buildWorkflowUpdateBody({ status: "IN_REVIEW", priority: "HIGH", note: "", current }),
    {},
  );
  assert.equal(
    mod.workflowUpdateIsEmpty(
      mod.buildWorkflowUpdateBody({ status: "IN_REVIEW", priority: "HIGH", note: "", current }),
    ),
    true,
  );
  assert.deepEqual(
    mod.buildWorkflowUpdateBody({ status: "ESCALATED", priority: "HIGH", note: " looks bad ", current }),
    { status: "ESCALATED", note: "looks bad" },
  );
});

test("asking to set a verdict is refused, not quietly dropped", () => {
  // A caller asking for one has misunderstood something, and swallowing it
  // would hide that from whoever wrote the surface.
  const current = mod.parseReviewerWorkflow(SUMMARY);
  assert.throws(
    () => mod.buildWorkflowUpdateBody({ status: "APPROVED_INTERNAL", current }),
    /produced by a review decision/,
  );
});

test("the note bound is the route's own", () => {
  assert.equal(mod.WORKFLOW_NOTE_MAX, 1000);
  assert.match(mod.validateWorkflowNote("x".repeat(1001)), /1000/);
  assert.equal(mod.validateWorkflowNote("fine"), null);
});
