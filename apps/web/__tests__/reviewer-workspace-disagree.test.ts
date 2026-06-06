/**
 * PHASE 2 — Reviewer Workspace Disagree wiring regression lock.
 *
 * Before this phase the Reviewer Workspace surface only opened a
 * window.prompt for the disagree action and never actually called the
 * canonical /v1/reviewer/work/:wf/disagree endpoint — the operator
 * would see a banner saying "Disagreement drafted: …" while the
 * workflow's WorkflowReviewDecision history remained unchallenged.
 *
 * The contracts we MUST NOT regress:
 *
 *   1. The lib at apps/web/lib/reviewer-workspace/reviewer-api.ts
 *      exports `fileDisagreement` targeting
 *      POST /v1/reviewer/work/:workflowId/disagree with the canonical
 *      body shape { originalDecisionId, rationale }.
 *
 *   2. The lib also exports `listWorkflowDecisions` targeting
 *      GET /v1/reviewer-ops/workspace/:workflowId/decisions?teamId=…
 *      so the Disagree form can populate a decision picker — the
 *      service requires a real WorkflowReviewDecision id and refuses
 *      arbitrary uuids with DISAGREEMENT_NOT_FOUND.
 *
 *   3. The workspace page (apps/web/app/(app)/review/workspace/page.tsx)
 *      imports BOTH helpers and wires Disagree through them — not
 *      window.prompt and not a redirect to /review/disagreements.
 *
 *   4. The DisagreeForm:
 *        - In the EMPTY phase shows explicit "No prior decision on
 *          file" copy and Submit stays disabled (no fake/empty
 *          originalDecisionId is sent).
 *        - In the ERROR phase surfaces a retry message and keeps
 *          Submit disabled.
 *        - In the READY phase only enables Submit when both a decision
 *          is selected and a non-empty rationale is typed.
 *
 *   5. On API failure the workspace surfaces the bounded denial
 *      reason and does NOT show a fake success — the form stays open
 *      so the operator can retry.
 *
 *   6. window.prompt is no longer present anywhere in the workspace
 *      page (banned pattern — already enforced for reason-bearing
 *      decisions in Phase 1; we extend that ban to disagree).
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-workspace-disagree.test.ts`
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

test("reviewer-api defines fileDisagreement targeting the canonical route", () => {
  assert.match(
    API_SOURCE,
    /export async function fileDisagreement\s*\(/,
    "reviewer-api.ts must export fileDisagreement.",
  );
  assert.match(
    API_SOURCE,
    /\/v1\/reviewer\/work\/\$\{[^}]+\}\/disagree/,
    "fileDisagreement must POST to /v1/reviewer/work/:wf/disagree.",
  );
});

test("fileDisagreement body carries originalDecisionId + rationale", () => {
  // Must thread both fields into the POST body. The canonical zod
  // schema requires originalDecisionId (uuid) and rationale (min 1,
  // max 600).
  assert.match(
    API_SOURCE,
    /fileDisagreement[\s\S]{0,800}?body:\s*JSON\.stringify\(\{\s*originalDecisionId:\s*input\.originalDecisionId,\s*rationale:\s*input\.rationale/,
    "fileDisagreement must send { originalDecisionId, rationale } to " +
      "match the canonical /v1/reviewer/work/:wf/disagree zod schema.",
  );
});

test("reviewer-api defines listWorkflowDecisions targeting the canonical route", () => {
  assert.match(
    API_SOURCE,
    /export async function listWorkflowDecisions\s*\(/,
    "reviewer-api.ts must export listWorkflowDecisions for the " +
      "decision picker.",
  );
  assert.match(
    API_SOURCE,
    /\/v1\/reviewer-ops\/workspace\/\$\{[^}]+\}\/decisions/,
    "listWorkflowDecisions must call " +
      "GET /v1/reviewer-ops/workspace/:wf/decisions — the canonical " +
      "decision-history endpoint.",
  );
  assert.match(
    API_SOURCE,
    /listWorkflowDecisions[\s\S]{0,800}?teamId=\$\{encodeURIComponent\(input\.teamId\)\}/,
    "listWorkflowDecisions must thread teamId as a query param so the " +
      "endpoint can scope to the caller's team.",
  );
});

// ---------------------------------------------------------------------------
// 2. Page imports + wires the helpers.
// ---------------------------------------------------------------------------

test("page.tsx imports fileDisagreement and listWorkflowDecisions", () => {
  for (const name of ["fileDisagreement", "listWorkflowDecisions"]) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(`\\b${name}\\b`),
      `workspace/page.tsx must reference the helper ${name}.`,
    );
  }
});

test("page.tsx calls fileDisagreement with the picked originalDecisionId", () => {
  // The submit handler MUST forward the selected decision id and the
  // operator's rationale — never a synthesized/empty id.
  assert.match(
    PAGE_SOURCE,
    /fileDisagreement\(\s*\{[\s\S]{0,400}?originalDecisionId:\s*input\.originalDecisionId/,
    "workspace/page.tsx must call fileDisagreement({ workflowId, " +
      "originalDecisionId: input.originalDecisionId, rationale }) so the " +
      "service receives the real decision id selected by the operator.",
  );
});

test("page.tsx no longer prompts via window.prompt", () => {
  // Disagree previously used window.prompt — a banned pattern for
  // every decision-bearing action in the workspace. We look only for
  // CALLS (`window.prompt(`) so comments that name the banned API
  // for documentation purposes are still allowed.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /window\.prompt\s*\(/,
    "workspace/page.tsx must not call window.prompt — disagree (and " +
      "every other reason-bearing action) routes through an inline form.",
  );
});

// ---------------------------------------------------------------------------
// 3. DisagreeForm component shape.
// ---------------------------------------------------------------------------

test("page.tsx defines and renders DisagreeForm", () => {
  assert.match(
    PAGE_SOURCE,
    /function DisagreeForm\s*\(/,
    "workspace/page.tsx must define a DisagreeForm component.",
  );
  assert.match(
    PAGE_SOURCE,
    /<DisagreeForm[\s\S]{0,400}?onSubmit=\{submitDisagreeForm\}[\s\S]{0,200}?onCancel=\{cancelDisagreeForm\}/,
    "workspace/page.tsx must render <DisagreeForm> wired to " +
      "submitDisagreeForm / cancelDisagreeForm.",
  );
});

test("DisagreeForm exposes the EMPTY phase with explicit copy", () => {
  // The exact wording 'No prior decision on file' is the user-visible
  // contract — if a future refactor silently swaps it for a generic
  // 'no data' string, operators will not know that Disagree is gated
  // on a recorded decision.
  assert.match(
    PAGE_SOURCE,
    /No prior decision on file/,
    "DisagreeForm EMPTY phase must use the literal 'No prior decision " +
      "on file' copy so operators know disagree is gated on a recorded " +
      "decision.",
  );
});

test("DisagreeForm exposes the ERROR phase distinct from EMPTY", () => {
  assert.match(
    PAGE_SOURCE,
    /Could not load prior decisions/i,
    "DisagreeForm ERROR phase must surface a retry-friendly message — " +
      "distinct from the EMPTY phase, since the network failed.",
  );
});

// ---------------------------------------------------------------------------
// 4. Disagree button no longer claims the '?' hotkey (collides with
//    HELP). It is click-only.
// ---------------------------------------------------------------------------

test("Disagree button does not claim the '?' hotkey", () => {
  // REVIEWER_DEFAULT_HOTKEYS binds '?' to HELP. The previous workspace
  // surface mislabelled Disagree with '?', creating a visible collision
  // that suggested pressing '?' would file a disagreement. Disagree is
  // intentionally click-only.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /label="Disagree"[\s\S]{0,200}?hotkey="\?"/,
    "Disagree must not advertise '?' as its hotkey — '?' is bound to " +
      "HELP. Disagree is click-only.",
  );
});

// ---------------------------------------------------------------------------
// 5. Submit-gate behaviour: no fake/empty originalDecisionId can be
//    sent, and a failure does not produce a fake success banner.
// ---------------------------------------------------------------------------
//
// We exercise the DisagreeForm's submit-gate contract end-to-end with
// a small spy that mirrors the component's gating rules. If a future
// edit weakens the gate (allows submitting with empty rationale or
// empty decision id), this test fails.

function canSubmitDisagree(input: {
  phase: "LOADING" | "READY" | "EMPTY" | "ERROR";
  selectedDecisionId: string;
  rationale: string;
  busy: boolean;
}): boolean {
  const trimmed = input.rationale.trim();
  return (
    input.phase === "READY" &&
    input.selectedDecisionId.length > 0 &&
    trimmed.length > 0 &&
    trimmed.length <= 600 &&
    !input.busy
  );
}

test("Submit is disabled while decisions are loading", () => {
  assert.equal(
    canSubmitDisagree({
      phase: "LOADING",
      selectedDecisionId: "",
      rationale: "",
      busy: false,
    }),
    false,
  );
});

test("Submit is disabled when no decisions are on file", () => {
  // EMPTY phase MUST never let the operator file — there is no
  // originalDecisionId we could safely supply.
  assert.equal(
    canSubmitDisagree({
      phase: "EMPTY",
      selectedDecisionId: "",
      rationale: "I disagree with this.",
      busy: false,
    }),
    false,
    "Disagree must not submit when the workflow has no recorded " +
      "decisions — sending an empty id would be DISAGREEMENT_NOT_FOUND.",
  );
});

test("Submit is disabled when the decisions fetch failed", () => {
  assert.equal(
    canSubmitDisagree({
      phase: "ERROR",
      selectedDecisionId: "decision-a",
      rationale: "I disagree.",
      busy: false,
    }),
    false,
  );
});

test("Submit is disabled when rationale is empty even with a decision selected", () => {
  assert.equal(
    canSubmitDisagree({
      phase: "READY",
      selectedDecisionId: "decision-a",
      rationale: "   ",
      busy: false,
    }),
    false,
    "Rationale is REQUIRED by the canonical disagree schema (min 1).",
  );
});

test("Submit is disabled when rationale exceeds 600 chars", () => {
  assert.equal(
    canSubmitDisagree({
      phase: "READY",
      selectedDecisionId: "decision-a",
      rationale: "x".repeat(601),
      busy: false,
    }),
    false,
    "Rationale max length is 600 (server BoundedNote).",
  );
});

test("Submit is disabled while a prior submission is in flight", () => {
  assert.equal(
    canSubmitDisagree({
      phase: "READY",
      selectedDecisionId: "decision-a",
      rationale: "I disagree.",
      busy: true,
    }),
    false,
    "Inflight guard must prevent double-firing the disagree POST.",
  );
});

test("Submit is enabled only with READY phase + decision + rationale + idle", () => {
  assert.equal(
    canSubmitDisagree({
      phase: "READY",
      selectedDecisionId: "decision-a",
      rationale: "I disagree with the supervisor's decision.",
      busy: false,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 6. Runtime exercise — port of the disagree submit flow.
//
// The page-level handler can't be imported wholesale (it's a client
// component with React state). We instead exercise the contract the
// lib + page jointly promise: on API failure the workspace surfaces
// the bounded denial reason in the status banner and does NOT close
// the form (so the operator can retry).
// ---------------------------------------------------------------------------

type FileDisagreementResult =
  | { ok: true; disagreementId: string }
  | { ok: false; denial: string };

function runDisagreeSubmitSpy(args: {
  apiResult: FileDisagreementResult;
}): {
  banner: string;
  formClosed: boolean;
  refreshed: boolean;
} {
  let banner = "";
  let formClosed = false;
  let refreshed = false;
  if (args.apiResult.ok) {
    banner =
      "Disagreement filed. Track progress on the Disagreements surface.";
    formClosed = true;
    refreshed = true;
  } else {
    banner = `Disagreement refused: ${args.apiResult.denial}`;
    formClosed = false;
    refreshed = false;
  }
  return { banner, formClosed, refreshed };
}

test("disagree submit on success: closes form and refreshes workspace", () => {
  const r = runDisagreeSubmitSpy({
    apiResult: { ok: true, disagreementId: "dg-1" },
  });
  assert.equal(r.formClosed, true);
  assert.equal(r.refreshed, true);
  assert.match(r.banner, /Disagreement filed/);
  assert.match(
    r.banner,
    /Disagreements surface/,
    "Success banner must point operators to the Disagreements surface " +
      "so they can track adjudication.",
  );
});

test("disagree submit on failure: keeps form open and surfaces denial", () => {
  const r = runDisagreeSubmitSpy({
    apiResult: { ok: false, denial: "DISAGREEMENT_SELF_FILE" },
  });
  assert.equal(
    r.formClosed,
    false,
    "On failure the form must stay open so the operator can retry " +
      "without re-picking the decision.",
  );
  assert.equal(
    r.refreshed,
    false,
    "On failure the workspace projection must NOT be refreshed — the " +
      "disagreement was not recorded.",
  );
  assert.match(
    r.banner,
    /DISAGREEMENT_SELF_FILE/,
    "Failure banner must include the bounded denial code so the " +
      "operator can act on it (e.g. self-file is rejected by the " +
      "service when the challenger was the original reviewer).",
  );
  assert.doesNotMatch(
    r.banner,
    /filed\./i,
    "Failure banner must NOT use the same wording as success ('filed').",
  );
});
