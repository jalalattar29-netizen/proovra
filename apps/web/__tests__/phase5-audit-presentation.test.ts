/**
 * PHASE 5 §10 — WHAT AN OPERATOR IS TOLD ABOUT AN AUDIT ROW.
 *
 * These are the exact defects this module was written to remove, pinned so
 * they cannot come back:
 *
 *   - a bare UUID, or the literal "public/system", in the actor cell;
 *   - a row with NO recorded outcome painted as a green success;
 *   - a refused request rendered as "ACTIVE → ACTIVE", which reads as a
 *     successful no-op rather than as a request that was turned down;
 *   - an arbitrary JSON dump in the detail panel.
 *
 * The functions are pure, so this is the whole behaviour — there is no
 * rendering path that can reach a different answer.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  humaniseResourceType,
  presentAction,
  presentActor,
  presentMetadata,
  presentOutcome,
  presentTarget,
  presentTransition,
} from "../lib/audit/auditPresentation";

const UUID = "0adf0000-0000-4000-8000-000000000001";

test("the actor cell never shows a bare identifier as if it were a name", () => {
  const withSnapshot = presentActor({
    actorType: "HUMAN",
    actorDisplay: "Jalal Attar",
    actorAuthority: "PLATFORM_ADMIN",
    userId: UUID,
  });
  assert.equal(withSnapshot.name, "Jalal Attar");
  assert.equal(withSnapshot.kind, "Person");
  assert.equal(withSnapshot.unknown, false);
  // The reference is short and marked, never the raw identifier alone.
  assert.ok(withSnapshot.reference && withSnapshot.reference.startsWith("User "));
  assert.ok(!withSnapshot.reference!.includes(UUID));

  /*
    PHASE 7 — AND THE WHOLE ID IS REACHABLE, ON THE HOVER.

    Six characters of tail tell two rows apart; they cannot answer "which user
    is this?". The full value existed nowhere on the page, so an operator
    correlating an audit row against a person had nothing to correlate with,
    and the composition sweep — which separates an honestly repeated column
    from one whose truncation hides a difference by comparing each cell's
    title — reported `/admin/audit`'s Actor column on a page where all
    twenty-five rows genuinely were the same actor.
  */
  assert.equal(withSnapshot.referenceFull, UUID);
});

test("an authority name is already whole, so it offers nothing to reveal", () => {
  // A title repeating the text beside it is noise on every row.
  const worker = presentActor({ actorType: "WORKER", actorAuthority: "worker:report" });
  assert.equal(worker.reference, "worker:report");
  assert.equal(worker.referenceFull, null);

  // A human's reference IS shortened, even when an authority exists.
  const human = presentActor({
    actorType: "HUMAN",
    actorDisplay: "Jalal Attar",
    actorAuthority: "PLATFORM_ADMIN",
    userId: UUID,
  });
  assert.equal(human.referenceFull, UUID);
});

/**
 * PHASE 7 — SCREAMING_CASE WAS STILL SCREAMING.
 *
 * The humaniser replaced separators and capitalised the first letter, which is
 * right for a lower-case key and did nothing at all for an upper-case one.
 * `/admin/billing` rendered "WORKSPACE_OPERATIONS · SUCCEEDED" as "WORKSPACE
 * OPERATIONS · SUCCEEDED", twenty-five times, in bold.
 *
 * The two shapes that must NOT change are as load-bearing as the fix: mixed
 * case, because "Evidenceid" is worse than "evidenceId"; and a short all-caps
 * run, because "Tsa" is not a word and not the name of anything this product
 * has. Every row below is a real value from this codebase.
 */
test("the humaniser lowers a shouted word and leaves an acronym alone", () => {
  const cases: Array<[string, string]> = [
    // Lower-case keys — the original behaviour, unchanged.
    ["support_access_grant", "Support access grant"],
    ["case.status.changed", "Case status changed"],
    // Shouted words and keys.
    ["WORKSPACE_OPERATIONS", "Workspace operations"],
    ["SUCCEEDED", "Succeeded"],
    ["FAILED", "Failed"],
    ["ACTIVE", "Active"],
    ["PLATFORM_ADMIN", "Platform admin"],
    // Acronyms this product uses in prose.
    ["TSA", "TSA"],
    ["DLQ", "DLQ"],
    ["SCIM", "SCIM"],
    ["MFA", "MFA"],
    // Mixed case is already readable.
    ["evidenceId", "EvidenceId"],
    ["Evidence", "Evidence"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(humaniseResourceType(input), expected, `for ${input}`);
  }
  assert.equal(humaniseResourceType(null), null);
  assert.equal(humaniseResourceType("   "), null);
});

test("a target's reference and its scope both reveal the id they shortened", () => {
  const WORKSPACE = "0adf0000-0000-4000-8000-0000000000b1";
  const target = presentTarget({
    resourceType: "support_access_grant",
    resourceId: UUID,
    workspaceId: WORKSPACE,
  });
  assert.equal(target.referenceFull, UUID);
  assert.equal(target.scopeFull, WORKSPACE);
  assert.ok(!target.reference!.includes(UUID), "the visible form stays short");

  // The platform scope is not a shortened id and must not claim to be one.
  const platform = presentTarget({ resourceType: "runbook", resourceId: null });
  assert.equal(platform.scope, "Platform-wide");
  assert.equal(platform.scopeFull, null);
  assert.equal(platform.referenceFull, null);
});

test("an automated actor is named by what it is, not left blank", () => {
  const worker = presentActor({ actorType: "WORKER", actorAuthority: "worker:report" });
  assert.equal(worker.name, "Background worker");
  assert.equal(worker.reference, "worker:report");
  assert.equal(worker.unknown, false);

  const service = presentActor({ actorType: "SERVICE", actorAuthority: "service:billing" });
  assert.equal(service.name, "Automated service");

  const support = presentActor({
    actorType: "SUPPORT_CONTEXT",
    actorDisplay: "Jalal Attar",
    userId: UUID,
  });
  assert.equal(support.kind, "Support access");
  assert.equal(support.name, "Jalal Attar", "the staff identity must survive presentation");
});

test("a record that does not know its actor says so, and is marked as unknown", () => {
  const legacy = presentActor({ actorType: "UNKNOWN_LEGACY", userId: null });
  assert.equal(legacy.name, "Unknown legacy actor");
  assert.equal(legacy.unknown, true, "an unknown actor must be styleable as absent");
  assert.equal(legacy.reference, null);

  // The old code produced the literal "public/system" here. Nothing does now.
  assert.ok(!legacy.name.includes("public/system"));
  assert.ok(!legacy.name.includes("SYSTEM"));

  // A human whose snapshot predates the contract is identifiable, just unnamed.
  const unnamed = presentActor({ actorType: "HUMAN", userId: UUID });
  assert.equal(unnamed.name, "Unnamed operator");
  assert.equal(unnamed.unknown, false);
});

test("absence of an outcome is never shown as success", () => {
  const missing = presentOutcome(null);
  assert.equal(missing.label, "Not recorded");
  assert.equal(missing.tone, "neutral");
  assert.equal(missing.unknown, true);

  assert.equal(presentOutcome("").label, "Not recorded");
  assert.notEqual(presentOutcome(null).tone, "success");
});

test("every canonical outcome has its own word and its own tone", () => {
  assert.deepEqual(
    ["success", "completed", "queued", "denied", "error", "no_op", "partial"].map(
      (o) => presentOutcome(o).label,
    ),
    ["Succeeded", "Completed", "Queued", "Refused", "Failed", "No change", "Partly applied"],
  );
  // Queued must not read as done — that is the whole point of the value.
  assert.notEqual(presentOutcome("queued").tone, "success");
  assert.equal(presentOutcome("completed").tone, "success");
  assert.equal(presentOutcome("error").tone, "danger");
  assert.equal(presentOutcome("denied").tone, "warning");
});

test("an unrecognised outcome is shown verbatim, not mapped to something reassuring", () => {
  const drifted = presentOutcome("weird_new_value");
  assert.equal(drifted.label, "weird_new_value");
  assert.notEqual(drifted.tone, "success");
});

test("a refused request does not read as a successful no-op", () => {
  const refused = presentTransition({
    previousState: "ACTIVE",
    requestedState: "SUSPENDED",
    resultingState: null,
  });
  assert.equal(refused!.text, "ACTIVE; requested SUSPENDED, not applied");
  assert.equal(refused!.changed, false);
  assert.ok(!refused!.text.includes("→"), "a refusal must not be drawn as a transition");

  const applied = presentTransition({
    previousState: "ACTIVE",
    requestedState: "REVOKED",
    resultingState: "REVOKED",
  });
  assert.equal(applied!.text, "ACTIVE → REVOKED");
  assert.equal(applied!.changed, true);

  const idempotent = presentTransition({
    previousState: "REVOKED",
    requestedState: "REVOKED",
    resultingState: "REVOKED",
  });
  assert.equal(idempotent!.text, "REVOKED (unchanged)");
  assert.equal(idempotent!.changed, false);

  assert.equal(presentTransition({}), null, "a row with no states must render nothing");
});

test("the target carries its tenant scope, and platform scope is explicit", () => {
  const workspaceScoped = presentTarget({
    targetDisplay: "Acme Legal",
    resourceType: "organization",
    resourceId: UUID,
    workspaceId: "0adf0000-0000-4000-8000-0000000000b1",
  });
  assert.equal(workspaceScoped.name, "Acme Legal");
  assert.equal(workspaceScoped.kind, "Organization");
  assert.ok(workspaceScoped.scope.startsWith("Workspace "));

  const platform = presentTarget({ resourceType: "queue", resourceId: "reports" });
  assert.equal(platform.scope, "Platform-wide", "an unscoped row must say so, not go blank");
  assert.equal(platform.name, "Queue");

  const nothing = presentTarget({});
  assert.equal(nothing.name, "No specific target");
});

test("metadata is an allowlist: unknown keys are counted, never printed", () => {
  const presented = presentMetadata({
    correlationId: "abc-123",
    denialReason: "step_up_required",
    // None of these are on the allowlist. Each is exactly the kind of value
    // that must not reach a screen because nobody decided it should.
    rawProviderResponse: { token: "secret-value" },
    stackTrace: "Error: at /srv/app/internal/path.js:41",
    someNewKeyNobodyReviewed: "surprise",
  });

  const flat = JSON.stringify(presented.entries);
  assert.ok(flat.includes("abc-123"), "an allowlisted key must be shown");
  assert.ok(flat.includes("step_up_required"));
  assert.ok(!flat.includes("secret-value"), "a non-allowlisted payload reached the view");
  assert.ok(!flat.includes("/srv/app"), "an internal path reached the view");
  assert.ok(!flat.includes("surprise"), "an unreviewed key reached the view");

  assert.equal(presented.withheldCount, 3, "withheld fields must be counted, not silently dropped");
});

test("a nested object under an allowlisted key is still withheld", () => {
  // The allowlist names a KEY; it cannot vouch for an arbitrary object placed
  // under that key later.
  const presented = presentMetadata({ capability: { nested: "payload" } });
  assert.deepEqual(presented.entries, []);
  assert.equal(presented.withheldCount, 1);
});

test("an action code becomes operator language without losing the code", () => {
  assert.equal(presentAction("identity.support_access.revoked"), "Support access revoked");
  assert.equal(presentAction("platform.queue.replay_requested"), "Queue replay requested");
  assert.equal(presentAction("admin.organization.suspend"), "Organization suspend");
  // A code with no dots is capitalised, not mangled — "Login" is a sentence
  // fragment an operator reads; it is not a different event from "login".
  assert.equal(presentAction("login"), "Login");
});
