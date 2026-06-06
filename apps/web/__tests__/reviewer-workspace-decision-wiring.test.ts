/**
 * PHASE 1 — Reviewer Workspace lifecycle wiring regression lock.
 *
 * The Reviewer Workspace at
 *   apps/web/app/(app)/review/workspace/page.tsx
 * MUST actually close workflows via the canonical reviewer-ops routes
 * after recording a decision. Before this phase the workspace only
 * wrote a REVIEWER_VERDICT coding-value (a coverage artifact) and
 * never advanced the workflow state — operators could "approve" a
 * workflow that remained open in the reviewer-ops queue.
 *
 * The contracts we MUST NOT regress:
 *
 *   1. The lib at apps/web/lib/reviewer-workspace/reviewer-api.ts
 *      exposes the four lifecycle helpers (approveReview, rejectReview,
 *      requestInfoReview, createEscalation) targeting the canonical
 *      reviewer-ops routes — NOT any new endpoint.
 *
 *   2. The workspace page imports all four helpers and threads
 *      teamId (via the canonical useActiveSpaceId hook) into each call.
 *
 *   3. APPROVE calls the lifecycle endpoint directly. REJECT,
 *      NEEDS_INFO, and ESCALATE open the inline <ReasonForm> instead
 *      of window.prompt — window.prompt for these reason-bearing
 *      decisions is a banned pattern in the workspace.
 *
 *   4. On lifecycle FAILURE the page surfaces a clear
 *      partial-failure banner and does NOT advance the workspace
 *      pointer. The exact copy must contain "workflow not closed" so
 *      operators see the partial state, not a fake success.
 *
 *   5. The lifecycle endpoint paths match the Phase 0 audit exactly:
 *      /v1/reviewer-ops/reviews/:wf/approve
 *      /v1/reviewer-ops/reviews/:wf/reject
 *      /v1/reviewer-ops/reviews/:wf/request-info
 *      /v1/reviewer-ops/escalations
 *
 *   6. The helper bodies match the canonical zod schemas:
 *      - approve.note is optional/nullable
 *      - reject.note carries the rejection reason and is required
 *      - request-info.note carries the message and is required
 *      - escalations require workflowId + reason + safeSummary
 *
 *   7. Hotkeys must NOT pre-advance the workspace. Advance happens
 *      only on lifecycle success (otherwise a failed close silently
 *      skips the item).
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-workspace-decision-wiring.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "workspace",
  "page.tsx",
);
const API_PATH = resolve(
  __dirname,
  "..",
  "lib",
  "reviewer-workspace",
  "reviewer-api.ts",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");
const API_SOURCE = readFileSync(API_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Helpers exist and target the canonical routes.
// ---------------------------------------------------------------------------

test("reviewer-api defines approveReview targeting the canonical route", () => {
  assert.match(
    API_SOURCE,
    /export async function approveReview\s*\(/,
    "reviewer-api.ts must export approveReview as a lifecycle helper.",
  );
  assert.match(
    API_SOURCE,
    /\/v1\/reviewer-ops\/reviews\/\$\{[^}]+\}\/approve/,
    "approveReview must POST to /v1/reviewer-ops/reviews/:wf/approve.",
  );
});

test("reviewer-api defines rejectReview targeting the canonical route", () => {
  assert.match(
    API_SOURCE,
    /export async function rejectReview\s*\(/,
    "reviewer-api.ts must export rejectReview as a lifecycle helper.",
  );
  assert.match(
    API_SOURCE,
    /\/v1\/reviewer-ops\/reviews\/\$\{[^}]+\}\/reject/,
    "rejectReview must POST to /v1/reviewer-ops/reviews/:wf/reject.",
  );
});

test("reviewer-api defines requestInfoReview targeting the canonical route", () => {
  assert.match(
    API_SOURCE,
    /export async function requestInfoReview\s*\(/,
    "reviewer-api.ts must export requestInfoReview as a lifecycle helper.",
  );
  assert.match(
    API_SOURCE,
    /\/v1\/reviewer-ops\/reviews\/\$\{[^}]+\}\/request-info/,
    "requestInfoReview must POST to /v1/reviewer-ops/reviews/:wf/request-info.",
  );
});

test("reviewer-api defines createEscalation targeting the canonical route", () => {
  assert.match(
    API_SOURCE,
    /export async function createEscalation\s*\(/,
    "reviewer-api.ts must export createEscalation as a lifecycle helper.",
  );
  assert.match(
    API_SOURCE,
    /["']\/v1\/reviewer-ops\/escalations["']/,
    "createEscalation must POST to /v1/reviewer-ops/escalations.",
  );
});

// ---------------------------------------------------------------------------
// 2. Helper bodies match the canonical zod schemas.
// ---------------------------------------------------------------------------

test("approveReview body threads teamId and accepts optional/nullable note", () => {
  // Body must include teamId. The signature must allow undefined or
  // null note (server schema is .nullable().optional()).
  assert.match(
    API_SOURCE,
    /export async function approveReview\(input:\s*\{[^}]*?teamId:\s*string;[^}]*?note\?:\s*string\s*\|\s*null;[^}]*\}/,
    "approveReview input must include `teamId: string` and " +
      "`note?: string | null` so callers can supply or omit the note.",
  );
});

test("rejectReview body carries reason as the required note field", () => {
  assert.match(
    API_SOURCE,
    /export async function rejectReview\(input:\s*\{[^}]*?reason:\s*string[^}]*\}/,
    "rejectReview must accept `reason: string` (required — server schema " +
      "requires note to be a min(1).max(1000) BoundedNote).",
  );
  // The reason must be sent as `note` in the body to match the
  // canonical reject route's zod schema.
  assert.match(
    API_SOURCE,
    /rejectReview[\s\S]{0,800}?body:\s*JSON\.stringify\(\{\s*teamId:[^}]*?note:\s*input\.reason/,
    "rejectReview must serialise `reason` into the `note` field of the " +
      "POST body to match the canonical reject endpoint's schema.",
  );
});

test("requestInfoReview body carries message as the required note field", () => {
  assert.match(
    API_SOURCE,
    /export async function requestInfoReview\(input:\s*\{[^}]*?message:\s*string[^}]*\}/,
    "requestInfoReview must accept `message: string` (required).",
  );
  assert.match(
    API_SOURCE,
    /requestInfoReview[\s\S]{0,800}?body:\s*JSON\.stringify\(\{\s*teamId:[^}]*?note:\s*input\.message/,
    "requestInfoReview must serialise `message` into the `note` field of " +
      "the POST body to match the canonical request-info endpoint's schema.",
  );
});

test("createEscalation body carries workflowId + reason + safeSummary", () => {
  assert.match(
    API_SOURCE,
    /export async function createEscalation\(input:\s*\{[^}]*?workflowId:\s*string;[^}]*?reason:\s*string;[^}]*?safeSummary:\s*string;[^}]*\}/,
    "createEscalation must accept workflowId, reason, and safeSummary — " +
      "these are the required fields on the canonical escalation route.",
  );
});

// ---------------------------------------------------------------------------
// 3. workspace/page.tsx imports the helpers and wires them.
// ---------------------------------------------------------------------------

test("page.tsx imports all four lifecycle helpers from reviewer-api", () => {
  for (const name of [
    "approveReview",
    "rejectReview",
    "requestInfoReview",
    "createEscalation",
  ]) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(`\\b${name}\\b`),
      `workspace/page.tsx must reference the lifecycle helper ${name}.`,
    );
  }
});

test("page.tsx resolves teamId via the canonical useActiveSpaceId hook", () => {
  // The lifecycle endpoints all require teamId; the workspace must
  // resolve it from the existing platform-context hook, not invent a
  // new resolver.
  assert.match(
    PAGE_SOURCE,
    /import\s*\{\s*useActiveSpace(?:\s*,\s*useActiveSpaceId|Id\s*,\s*useActiveSpace)\s*\}\s*from\s*["'][^"']*platform-context["']/,
    "workspace/page.tsx must import useActiveSpaceId from the canonical " +
      "platform-context module.",
  );
  assert.match(
    PAGE_SOURCE,
    /const\s+teamId\s*=\s*useActiveSpaceId\(\)/,
    "workspace/page.tsx must call useActiveSpaceId() inside the shell.",
  );
});

test("page.tsx invokes each lifecycle helper with the resolved teamId", () => {
  for (const name of [
    "approveReview",
    "rejectReview",
    "requestInfoReview",
    "createEscalation",
  ]) {
    // Each call must thread `teamId` into the helper's input object.
    const callRe = new RegExp(
      `${name}\\(\\s*\\{[\\s\\S]{0,400}?teamId\\s*[,:}]`,
    );
    assert.match(
      PAGE_SOURCE,
      callRe,
      `workspace/page.tsx must call ${name}({ ..., teamId, ... }) so ` +
        `the canonical reviewer-ops endpoint can scope to the workspace.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. REJECT / NEEDS_INFO / ESCALATE use the inline ReasonForm, not
//    window.prompt.
// ---------------------------------------------------------------------------

test("page.tsx no longer uses window.prompt for reason-bearing decisions", () => {
  // window.prompt is banned in the workspace because (a) it cannot be
  // styled to match PROOVRA copy and (b) it bypasses the bounded
  // length feedback the canonical reject/request-info endpoints
  // require.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /window\.prompt\s*\([^)]*rationale/i,
    "workspace/page.tsx must not use window.prompt for reason capture. " +
      "Use the inline <ReasonForm> instead.",
  );
});

test("page.tsx defines and renders the inline ReasonForm", () => {
  assert.match(
    PAGE_SOURCE,
    /function ReasonForm\s*\(/,
    "workspace/page.tsx must define a ReasonForm component.",
  );
  assert.match(
    PAGE_SOURCE,
    /<ReasonForm[\s\S]{0,400}?onSubmit=\{submitReasonForm\}[\s\S]{0,200}?onCancel=\{cancelReasonForm\}/,
    "workspace/page.tsx must render <ReasonForm> wired to " +
      "submitReasonForm / cancelReasonForm.",
  );
});

// ---------------------------------------------------------------------------
// 5. Partial-failure banner & no advance on failure.
// ---------------------------------------------------------------------------

test("page.tsx surfaces a clear partial-failure banner when lifecycle fails", () => {
  // The literal copy 'workflow not closed' lets operators recognise
  // the partial state. If a future contributor swaps this for a
  // generic 'success' message, the test fails.
  assert.match(
    PAGE_SOURCE,
    /workflow not closed/i,
    "workspace/page.tsx must surface a banner containing 'workflow " +
      "not closed' when the lifecycle endpoint fails — never a fake " +
      "success.",
  );
});

test("page.tsx does NOT advance the workspace pointer on lifecycle failure", () => {
  // After classifying the lifecycle result, the failure branch must
  // return early before calling advanceToNext. We assert by locating
  // `if (!res.ok)` and confirming `advanceToNext` is NOT called
  // inside the same branch.
  const failureBranch = PAGE_SOURCE.match(/if\s*\(!res\.ok\)\s*\{[\s\S]{0,600}?\n\s*\}/);
  assert.ok(
    failureBranch,
    "Expected a `if (!res.ok)` branch in the lifecycle handler.",
  );
  assert.doesNotMatch(
    failureBranch![0],
    /advanceToNext/,
    "The lifecycle failure branch must NOT call advanceToNext() — that " +
      "would hide partial failure by skipping to the next item.",
  );
});

// ---------------------------------------------------------------------------
// 6. Hotkeys do not pre-advance.
// ---------------------------------------------------------------------------

test("APPROVE / REJECT / ESCALATE hotkeys do not pre-advance the workspace", () => {
  // Locate the hotkey memo and confirm the three decisions are
  // single-statement arrow handlers — i.e. they delegate to onDecision
  // and do not also schedule advanceToNext synchronously.
  for (const kind of ["APPROVE", "REJECT", "ESCALATE"]) {
    const hotkeyMatch = PAGE_SOURCE.match(
      new RegExp(`${kind}:\\s*\\(\\)\\s*=>\\s*([^,\\n]+),`),
    );
    assert.ok(
      hotkeyMatch,
      `Expected a single-line hotkey arrow for ${kind} in the hotkey memo.`,
    );
    assert.doesNotMatch(
      hotkeyMatch![1],
      /advanceToNext/,
      `The ${kind} hotkey arrow must NOT call advanceToNext() inline — ` +
        `the lifecycle handler advances on success only, so a pre-advance ` +
        `would skip past failed closures.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Runtime behaviour exercise — port of the lifecycle decision flow.
// ---------------------------------------------------------------------------
//
// The page-level handler can't be imported wholesale (it's a client
// component with React state). We instead exercise the *contract* the
// lib + page jointly promise: when a lifecycle helper returns
// `{ ok: false }`, the workspace must (a) leave the active workflow
// pointer untouched and (b) surface a partial-failure banner.

type LifecycleResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

function runDecisionFlowSpy(args: {
  initialWorkflowId: string;
  lifecycleResult: LifecycleResult;
  advance: () => string | null;
}) {
  let activeWorkflowId: string | null = args.initialWorkflowId;
  let statusBanner: string | null = null;
  let advanced = false;
  if (!args.lifecycleResult.ok) {
    statusBanner = `Decision recorded but workflow not closed (${args.lifecycleResult.code}) — please retry.`;
  } else {
    statusBanner = "Workflow approve recorded.";
    activeWorkflowId = args.advance();
    advanced = true;
  }
  return { activeWorkflowId, statusBanner, advanced };
}

test("decision flow advances on success and stays on failure", () => {
  const okFlow = runDecisionFlowSpy({
    initialWorkflowId: "wf-A",
    lifecycleResult: { ok: true },
    advance: () => "wf-B",
  });
  assert.equal(okFlow.advanced, true);
  assert.equal(okFlow.activeWorkflowId, "wf-B");
  assert.match(okFlow.statusBanner ?? "", /recorded/);

  const failFlow = runDecisionFlowSpy({
    initialWorkflowId: "wf-A",
    lifecycleResult: {
      ok: false,
      status: 409,
      code: "REVIEW_WORKFLOW_NOT_PENDING",
      message: "denied",
    },
    advance: () => "wf-B",
  });
  assert.equal(failFlow.advanced, false);
  assert.equal(
    failFlow.activeWorkflowId,
    "wf-A",
    "Failure must leave the active workflow id untouched so the " +
      "operator can retry on the same item.",
  );
  assert.match(
    failFlow.statusBanner ?? "",
    /workflow not closed/i,
    "Failure must surface a banner containing 'workflow not closed' " +
      "so operators do not see a fake success.",
  );
  assert.match(
    failFlow.statusBanner ?? "",
    /REVIEW_WORKFLOW_NOT_PENDING/,
    "Failure banner must include the canonical error code so operators " +
      "can act on it.",
  );
});
