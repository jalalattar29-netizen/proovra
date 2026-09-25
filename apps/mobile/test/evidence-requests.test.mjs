/**
 * GUARD — native evidence-requests projection (Master Program §8, E). Parses the
 * authenticated list/detail shape defensively and maps status → an honest tone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/evidence-requests.ts"), "utf8")
  .replace(/^import type .*$/m, "")
  .replace(/^import \{ humanizeEnum \}.*$/m, "function humanizeEnum(v){return v.charAt(0)+v.slice(1).toLowerCase().replace(/_/g,' ');}");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

test("parses the list, dropping rows without an id", () => {
  const items = mod.parseEvidenceRequestList({
    requests: [
      { id: "r1", title: "Send photos", status: "OPEN", dueAtUtc: "2026-09-20T00:00:00Z" },
      { title: "no id" },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Send photos");
});

test("parses detail with deliverables; null when no request", () => {
  const d = mod.parseEvidenceRequestDetail({
    request: {
      id: "r1", title: "Send photos", status: "IN_PROGRESS", instructions: "Please upload",
      deliverables: [
        { id: "d1", title: "Front photo", required: true, status: "PENDING", fulfilledCount: 0 },
        { title: "bad" },
      ],
    },
  });
  assert.equal(d.instructions, "Please upload");
  assert.equal(d.deliverables.length, 1);
  assert.equal(d.deliverables[0].required, true);
  assert.equal(mod.parseEvidenceRequestDetail({}), null);
});

test("every status maps to a legal tone; unknown → neutral", () => {
  for (const st of mod.EVIDENCE_REQUEST_STATUSES) {
    const d = mod.requestStatusDisplay(st);
    assert.ok(TONES.has(d.tone), `${st} → ${d.tone}`);
    assert.ok(d.label.length > 0);
  }
  assert.equal(mod.requestStatusDisplay("FULFILLED").tone, "verified");
  assert.equal(mod.requestStatusDisplay("SOMETHING_NEW").tone, "neutral");
});

/* ---------------------------------------------------------------- workflow */

/**
 * The state machine is the SERVER'S. This names which transitions to OFFER
 * from the status it reported — it does not decide whether one is permitted,
 * because a client that believed otherwise would be a second state machine
 * drifting quietly out of step with the first.
 *
 * What it prevents is the other failure: offering "Send" on a request
 * cancelled last week, which produces a refusal the user cannot act on and
 * makes the surface look broken rather than the action look wrong.
 */
test("a terminal request offers no transitions at all", () => {
  assert.deepEqual(mod.availableRequestTransitions("CANCELLED"), []);
  assert.deepEqual(mod.availableRequestTransitions("CLOSED"), []);
});

test("only an unsent request can be sent", () => {
  assert.ok(mod.availableRequestTransitions("DRAFT").includes("send"));
  assert.ok(mod.availableRequestTransitions("OPEN").includes("send"));
  // Re-sending a delivered request is a different act with its own route.
  assert.equal(mod.availableRequestTransitions("SENT").includes("send"), false);
  assert.equal(mod.availableRequestTransitions("FULFILLED").includes("send"), false);
});

test("asking for more is offered only once something has come back", () => {
  assert.ok(mod.availableRequestTransitions("RESPONSE_RECEIVED").includes("needs-more-info"));
  assert.ok(mod.availableRequestTransitions("PARTIALLY_FULFILLED").includes("needs-more-info"));
  assert.equal(mod.availableRequestTransitions("DRAFT").includes("needs-more-info"), false);
});

test("a draft is cancelled, not closed", () => {
  // Closing is for a request that has run its course; a draft never ran.
  const draft = mod.availableRequestTransitions("DRAFT");
  assert.ok(draft.includes("cancel"));
  assert.equal(draft.includes("close"), false);
});

test("cancel and close each say what they do, and they differ", () => {
  // Both END a request and neither can be undone, so a user who picks the
  // wrong one cannot recover — the difference must not be left to two
  // similar-looking words.
  const cancel = mod.requestTransitionConsequence("cancel");
  const close = mod.requestTransitionConsequence("close");
  assert.notEqual(cancel, close);
  assert.match(cancel, /withdrawn|no longer contribute/i);
  assert.match(close, /completed|stops accepting/i);
  // Both reassure that received material survives.
  assert.match(cancel, /already received is kept/i);
  assert.match(close, /already received is kept/i);

  assert.equal(mod.requestTransitionIsDestructive("cancel"), true);
  assert.equal(mod.requestTransitionIsDestructive("close"), false);
});

test("the transition body carries the note only when there is one", () => {
  assert.deepEqual(mod.buildTransitionBody(""), {});
  assert.deepEqual(mod.buildTransitionBody("   "), {});
  assert.deepEqual(mod.buildTransitionBody("  because  "), { reviewerNote: "because" });
  // Bounded at the route's own limit rather than rejected at send time.
  assert.equal(mod.buildTransitionBody("x".repeat(5000)).reviewerNote.length, 4000);
});

test("the workflow paths are the canonical ones", () => {
  assert.equal(mod.buildRequestTransitionPath("r1", "send"), "/v1/evidence-requests/r1/send");
  assert.equal(mod.buildRequestDeliveriesPath("r1"), "/v1/evidence-requests/r1/deliveries");
  assert.equal(mod.buildRequestEventsPath("r1"), "/v1/evidence-requests/r1/events");
  assert.equal(mod.buildRequestAssignPath("r1"), "/v1/evidence-requests/r1/assign");
});

test("a failed delivery names itself, in the server's real row shape", () => {
  // evidence-requests.routes.ts sends { id, eventType, status, errorCode, retryCount,
  // lastAttemptAtUtc, retryable }; this test used to feed failureReason, never sent.
  const [d] = mod.parseRequestDeliveries({
    deliveries: [{ id: "d1", eventType: "REQUEST_SENT", status: "FAILED", errorCode: "mailbox_full", retryCount: 2, lastAttemptAtUtc: "2026-09-24T09:00:00.000Z", retryable: true }],
  });
  assert.equal(d.errorCode, "mailbox_full");
  assert.equal(d.statusLabel, "Failed");
  assert.equal(d.retryable, true);
  assert.equal(mod.deliveryAttemptLine(d, () => "24 Sep"), "request sent · last attempt 24 Sep · 2 retries");
  assert.equal(mod.buildRequestDeliveryRetryPath("r1", "d1"), "/v1/evidence-requests/r1/deliveries/d1/retry");
  assert.equal(mod.deliveryTone("FAILED"), "risk");
  assert.equal(mod.deliveryTone("DELIVERED"), "verified");
  assert.equal(mod.deliveryTone("QUEUED"), "pending");
});

test("history reads newest first, from the server's createdAt; the note is payload.reason", () => {
  // listEvidenceRequestEvents sends { id, eventType, actorUserId, payload, createdAt }.
  const events = mod.parseRequestEvents({
    events: [
      { id: "e1", eventType: "CREATED", actorUserId: "u-1", payload: null, createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "e3", eventType: "DELIVERABLE_REJECTED", actorUserId: "u-2", payload: { deliverableId: "d1", reason: "Blurry photo" }, createdAt: "2026-09-03T00:00:00.000Z" },
      { id: "e2", eventType: "SENT", actorUserId: null, payload: null, createdAt: "2026-09-02T00:00:00.000Z" },
      { eventType: "orphan" },
    ],
  });
  assert.deepEqual(events.map((e) => e.id), ["e3", "e2", "e1"]);
  assert.equal(events[0].note, "Blurry photo", "the only recorded free text was never shown");
  assert.equal(events[0].actorUserId, "u-2");
});

// ---------------------------------------------------------------------------
// PER-RESPONSE REVIEW — the reviewer's decision on ONE submission
// ---------------------------------------------------------------------------

test("detail carries the submissions, dropping rows without an id", () => {
  const d = mod.parseEvidenceRequestDetail({
    request: {
      id: "r1", title: "Send photos", status: "RESPONSE_RECEIVED",
      responses: [
        {
          id: "p1", status: "RECEIVED", submittedAtUtc: "2026-09-20T10:00:00.000Z",
          submittedByExternalLabel: "Witness A", responseEvidenceId: "e1", reviewerNote: null,
        },
        { status: "RECEIVED" },
      ],
    },
  });
  assert.equal(d.responses.length, 1);
  assert.equal(d.responses[0].submittedByExternalLabel, "Witness A");
  assert.equal(d.responses[0].reviewerNote, null);
});

test("a request with no submissions reads as none, not as a broken shape", () => {
  const d = mod.parseEvidenceRequestDetail({ request: { id: "r1", title: "t", status: "OPEN" } });
  assert.deepEqual(d.responses, []);
});

test("an anonymous submission is labelled as a contributor, not given a name", () => {
  // An anonymous source HAS no name. Inventing one as an identity rather than
  // as an absence is the kind of small lie a custody surface cannot afford.
  assert.equal(
    mod.responseContributorLabel({ id: "p1", status: "RECEIVED", submittedByExternalLabel: null }),
    "External contributor", // web page.tsx:646
  );
  assert.equal(
    mod.responseContributorLabel({ id: "p1", status: "RECEIVED", submittedByExternalLabel: "Ana" }),
    "Ana",
  );
});

test("the decision vocabulary is the route's own enum", () => {
  // evidence-requests.routes.ts:581 — z.enum([...]). A native paraphrase here
  // would be refused by the route at the moment the reviewer acted.
  assert.deepEqual(mod.RESPONSE_REVIEW_DECISIONS, [
    "UNDER_REVIEW", "ACCEPTED", "NEEDS_MORE_INFO", "REJECTED",
  ]);
});

test("the decision already recorded is not offered again", () => {
  // Re-recording it writes a fresh reviewedAtUtc and a timeline event saying
  // a reviewer decided something they had already decided.
  assert.ok(!mod.availableResponseDecisions("ACCEPTED").includes("ACCEPTED"));
  assert.equal(mod.availableResponseDecisions("ACCEPTED").length, 3);
  // A submission nobody has judged yet is offered all four.
  assert.equal(mod.availableResponseDecisions("RECEIVED").length, 4);
});

test("the review path names the request AND the response, both encoded", () => {
  assert.equal(
    mod.buildResponseReviewPath("r 1", "p/1"),
    "/v1/evidence-requests/r%201/responses/p%2F1/review",
  );
});

test("an empty note is sent as null, not as an empty string", () => {
  // The field is .nullable().optional(); "" would overwrite a note a previous
  // reviewer left with a note that says nothing.
  assert.deepEqual(mod.buildResponseReviewBody({ status: "ACCEPTED", reviewerNote: "   " }), {
    status: "ACCEPTED", reviewerNote: null,
  });
  assert.deepEqual(mod.buildResponseReviewBody({ status: "REJECTED" }), {
    status: "REJECTED", reviewerNote: null,
  });
  assert.deepEqual(mod.buildResponseReviewBody({ status: "ACCEPTED", reviewerNote: " ok " }), {
    status: "ACCEPTED", reviewerNote: "ok",
  });
});

test("the body never sends notifyContributor", () => {
  // It makes the server send an SMS to an external contributor under the
  // reviewer's name. That needs a deliberate control, not a default.
  const body = mod.buildResponseReviewBody({ status: "REJECTED", reviewerNote: "no" });
  assert.deepEqual(Object.keys(body).sort(), ["reviewerNote", "status"]);
});

test("a note longer than the route accepts is refused before it is sent", () => {
  assert.equal(mod.validateResponseReviewerNote("x".repeat(4000)), null);
  assert.match(mod.validateResponseReviewerNote("x".repeat(4001)), /4000/);
  // And a note that slips through is bounded rather than rejected by the route.
  assert.equal(
    mod.buildResponseReviewBody({ status: "ACCEPTED", reviewerNote: "x".repeat(5000) }).reviewerNote.length,
    4000,
  );
});

test("acceptance is stated as admission to review, not as verification", () => {
  const { label, tone } = mod.responseStatusDisplay("ACCEPTED");
  assert.equal(label, "Accepted for internal review");
  assert.equal(tone, "verified");
  assert.match(mod.responseDecisionConsequence("ACCEPTED"), /not that its contents are verified/);
  assert.equal(mod.responseStatusDisplay("REJECTED").tone, "risk");
  assert.equal(mod.responseStatusDisplay(null).label, "Unknown");
  // An unknown status is shown, not hidden.
  assert.equal(mod.responseStatusDisplay("SOMETHING_NEW").tone, "neutral");
});

test("rejection is the destructive one, and says what it does not do", () => {
  assert.equal(mod.responseDecisionIsDestructive("REJECTED"), true);
  assert.equal(mod.responseDecisionIsDestructive("ACCEPTED"), false);
  // What was sent is KEPT — rejection judges the submission, not the record.
  assert.match(mod.responseDecisionConsequence("REJECTED"), /kept and stays on the record/);
  for (const d of mod.RESPONSE_REVIEW_DECISIONS) {
    assert.ok(mod.responseDecisionLabel(d).length > 0);
    assert.ok(mod.responseDecisionConsequence(d).length > 0);
  }
});

test("needs-more-info is offered exactly where the shared state machine allows it", () => {
  // packages/shared/src/evidence-request.ts:83-104 — IN_PROGRESS cannot move
  // to NEEDS_MORE_INFO; FULFILLED can.
  assert.equal(mod.availableRequestTransitions("IN_PROGRESS").includes("needs-more-info"), false);
  assert.ok(mod.availableRequestTransitions("FULFILLED").includes("needs-more-info"));
  // …and it, cancel and close are refused without a note (service.ts:475).
  assert.ok(mod.transitionRequiresNote("cancel") && mod.transitionRequiresNote("close") && mod.transitionRequiresNote("needs-more-info"));
  assert.equal(mod.transitionRequiresNote("send"), false);
});

test("completion mirrors the backend predicate (page.tsx:351-363)", () => {
  const c = mod.requestCompletion([
    { required: true, status: "FULFILLED" },
    { required: true, status: "PENDING" },
    { required: false, status: "WAIVED" },
    { required: false, status: "PENDING" },
  ]);
  assert.deepEqual(c, { requiredFulfilled: 1, requiredTotal: 2, optionalFulfilled: 1, optionalTotal: 2, completionPercent: 50, reviewReady: false });
  assert.equal(mod.requestCompletion([]).reviewReady, true);
});
