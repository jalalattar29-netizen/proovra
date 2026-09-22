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

test("a failed delivery names itself", () => {
  const [d] = mod.parseRequestDeliveries({
    deliveries: [{ id: "d1", status: "FAILED", failureReason: "mailbox full" }],
  });
  assert.equal(d.failureReason, "mailbox full");
  assert.equal(mod.deliveryTone("FAILED"), "risk");
  assert.equal(mod.deliveryTone("DELIVERED"), "verified");
  assert.equal(mod.deliveryTone("QUEUED"), "pending");
});

test("history reads newest first", () => {
  const events = mod.parseRequestEvents({
    events: [
      { id: "e1", eventType: "CREATED", occurredAtUtc: "2026-09-01T00:00:00.000Z" },
      { id: "e3", eventType: "CLOSED", occurredAtUtc: "2026-09-03T00:00:00.000Z" },
      { id: "e2", eventType: "SENT", occurredAtUtc: "2026-09-02T00:00:00.000Z" },
      { eventType: "orphan" },
    ],
  });
  assert.deepEqual(events.map((e) => e.id), ["e3", "e2", "e1"]);
});
