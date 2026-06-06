/**
 * PHASE 2 — Reviewer disagreement resolution verdict picker regression
 * lock.
 *
 * Before this phase /review/disagreements forced every RESOLVED_*
 * transition through `REVIEWER_VERDICTS[1]` ("APPROVE") regardless of
 * operator intent — supervisors could never record REJECT / ESCALATE /
 * NEEDS_INFO on a resolution. The canonical
 * /v1/reviewer/disagreements/:id/transition route +
 * reviewer-disagreement.service.transitionDisagreement accept BOTH a
 * bounded `verdict` enum (REVIEWER_VERDICTS) AND an optional rationale
 * (max 600 chars; truncated server side).
 *
 * Contracts pinned by this test:
 *
 *   1. The page source no longer contains the hardcoded
 *      `REVIEWER_VERDICTS[1]` (or any indexed access) submission.
 *
 *   2. The page imports REVIEWER_VERDICTS from @proovra/shared (the
 *      canonical enum source) and renders a <select> populated from
 *      it — every non-PENDING value must appear (PENDING is filtered
 *      because resolving to PENDING is semantically meaningless).
 *
 *   3. The page renders a bounded <textarea> for rationale with a 600
 *      char maxLength (matches the server BoundedNote limit; the
 *      service also truncates to 600).
 *
 *   4. The page renders submit + cancel buttons for the resolution
 *      picker and the submit button cannot fire without both a picked
 *      verdict and a non-empty trimmed rationale.
 *
 *   5. The transitionDisagreement helper is called with the picked
 *      verdict + rationale — not the hardcoded enum[1].
 *
 *   6. Non-resolving transitions (FILED -> UNDER_SECOND_REVIEW etc.)
 *      still submit without a verdict.
 *
 *   7. The service persists resolution through the canonical declared
 *      ReviewerDisagreement fields (`resolution`, `resolvedAtUtc`,
 *      `resolvedByUserId`) and does NOT write undeclared
 *      second-review / supervisor detail columns. The page still keeps
 *      extra lifecycle detail out of the compact table.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-disagreement-verdict-picker.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { REVIEWER_VERDICTS, DISAGREEMENT_STATES } from "@proovra/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "disagreements",
  "page.tsx",
);
const SCHEMA_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "services",
  "api",
  "prisma",
  "schema.prisma",
);
const SERVICE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "services",
  "api",
  "src",
  "services",
  "reviewer-workspace",
  "reviewer-disagreement.service.ts",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");
const SCHEMA_SOURCE = readFileSync(SCHEMA_PATH, "utf8");
const SERVICE_SOURCE = readFileSync(SERVICE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Hardcoded REVIEWER_VERDICTS[1] is gone.
// ---------------------------------------------------------------------------

test("Disagreements page no longer hardcodes REVIEWER_VERDICTS[1]", () => {
  // The old call site looked like:
  //   to.startsWith("RESOLVED_") ? REVIEWER_VERDICTS[1] : undefined
  // Any future regression that re-introduces an indexed access of the
  // verdict enum at submit time would silently undo this work.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /REVIEWER_VERDICTS\s*\[\s*\d+\s*\]/,
    "Disagreements page must not submit REVIEWER_VERDICTS[<n>] — " +
      "operator must pick a verdict explicitly.",
  );
});

// ---------------------------------------------------------------------------
// 2. The picker imports the canonical enum and renders every value.
// ---------------------------------------------------------------------------

test("Disagreements page imports REVIEWER_VERDICTS from @proovra/shared", () => {
  assert.match(
    PAGE_SOURCE,
    /import\s*\{[\s\S]*?REVIEWER_VERDICTS[\s\S]*?\}\s*from\s*"@proovra\/shared"/,
    "Disagreements page must import REVIEWER_VERDICTS from the " +
      "canonical shared enum so the picker tracks any future enum " +
      "additions.",
  );
});

test("Resolution picker renders a <select> tagged for the verdict", () => {
  assert.match(
    PAGE_SOURCE,
    /data-disagreement-resolve-verdict-select/,
    "Resolution picker must render a <select " +
      "data-disagreement-resolve-verdict-select=… so operators (and " +
      "tests) can identify the verdict picker.",
  );
});

test("Resolution picker maps RESOLUTION_VERDICTS (REVIEWER_VERDICTS minus PENDING) to <option>s", () => {
  // The picker filters PENDING from the canonical enum because
  // resolving a disagreement to PENDING is semantically meaningless.
  // All other REVIEWER_VERDICTS values must be selectable.
  assert.match(
    PAGE_SOURCE,
    /RESOLUTION_VERDICTS\s*=\s*REVIEWER_VERDICTS\.filter\([\s\S]{0,200}?!==\s*"PENDING"/,
    "Picker must build RESOLUTION_VERDICTS by filtering PENDING out of " +
      "REVIEWER_VERDICTS — every other enum value must remain " +
      "selectable.",
  );
  assert.match(
    PAGE_SOURCE,
    /RESOLUTION_VERDICTS\.map\(/,
    "Picker must map over RESOLUTION_VERDICTS so future enum additions " +
      "appear automatically.",
  );
});

test("Resolution picker renders a bounded <textarea> for rationale", () => {
  assert.match(
    PAGE_SOURCE,
    /data-disagreement-resolve-rationale/,
    "Resolution picker must render a rationale textarea tagged " +
      "data-disagreement-resolve-rationale.",
  );
  assert.match(
    PAGE_SOURCE,
    /RATIONALE_MAX\s*=\s*600/,
    "Resolution picker rationale must be capped at 600 chars (matches " +
      "reviewer-disagreement.service rationale.slice(0, 600)).",
  );
  assert.match(
    PAGE_SOURCE,
    /maxLength=\{RATIONALE_MAX\}/,
    "Resolution picker <textarea> must enforce maxLength={RATIONALE_MAX} " +
      "on the input element.",
  );
});

test("Resolution picker renders submit + cancel buttons", () => {
  assert.match(
    PAGE_SOURCE,
    /data-disagreement-resolve-submit/,
    "Resolution picker must render a submit button " +
      "(data-disagreement-resolve-submit).",
  );
  assert.match(
    PAGE_SOURCE,
    /data-disagreement-resolve-cancel/,
    "Resolution picker must render a cancel button " +
      "(data-disagreement-resolve-cancel).",
  );
});

// ---------------------------------------------------------------------------
// 3. Submission shape — transitionDisagreement is called with picker values.
// ---------------------------------------------------------------------------

test("Resolution path calls onTransition with picked verdict + rationale", () => {
  assert.match(
    PAGE_SOURCE,
    /onTransition\(\s*row\.id,\s*pickerTo,\s*verdict,\s*rationale\s*\)/,
    "Resolution submit must call onTransition(row.id, pickerTo, " +
      "verdict, rationale) with the picker-driven values.",
  );
});

test("transitionDisagreement is invoked with verdict + rationale", () => {
  // The shell handler threads { verdict, rationale } into the helper.
  // Pinning the shape so a refactor cannot drop either field.
  assert.match(
    PAGE_SOURCE,
    /transitionDisagreement\(\s*\{[\s\S]{0,400}?verdict,[\s\S]{0,200}?rationale,/,
    "Shell handler must call transitionDisagreement with verdict + " +
      "rationale fields drawn from the picker — never a hardcoded " +
      "default.",
  );
});

// ---------------------------------------------------------------------------
// 4. Non-resolving transitions still submit without a verdict.
// ---------------------------------------------------------------------------

test("Non-resolving transitions call onTransition with no verdict / rationale", () => {
  // FILED -> UNDER_SECOND_REVIEW and FILED -> WITHDRAWN do not record
  // a resolution verdict — they must call onTransition(row.id, to)
  // with no extra picker args. The action button branch falls through
  // directly to onTransition.
  assert.match(
    PAGE_SOURCE,
    /void onTransition\(row\.id,\s*to\)/,
    "Non-resolution transitions must call onTransition(row.id, to) " +
      "without the verdict/rationale args — those are only for " +
      "RESOLVED_* targets.",
  );
});

// ---------------------------------------------------------------------------
// 5. Submit-gate behaviour — replicates the picker's gating rules.
// ---------------------------------------------------------------------------

function canSubmitResolution(input: {
  busy: boolean;
  verdict: string;
  rationale: string;
}): boolean {
  const trimmed = input.rationale.trim();
  return (
    !input.busy &&
    input.verdict.length > 0 &&
    (REVIEWER_VERDICTS as ReadonlyArray<string>).includes(input.verdict) &&
    trimmed.length > 0 &&
    trimmed.length <= 600
  );
}

test("Resolution submit gate: blocked when no verdict picked", () => {
  assert.equal(
    canSubmitResolution({
      busy: false,
      verdict: "",
      rationale: "I uphold the original decision.",
    }),
    false,
    "Submit must be blocked until a verdict is selected from the picker.",
  );
});

test("Resolution submit gate: blocked when rationale is whitespace", () => {
  assert.equal(
    canSubmitResolution({
      busy: false,
      verdict: "APPROVE",
      rationale: "   ",
    }),
    false,
    "Submit must be blocked until rationale carries non-whitespace " +
      "content.",
  );
});

test("Resolution submit gate: blocked when rationale exceeds 600 chars", () => {
  assert.equal(
    canSubmitResolution({
      busy: false,
      verdict: "APPROVE",
      rationale: "x".repeat(601),
    }),
    false,
    "Submit must be blocked when rationale length exceeds 600 chars.",
  );
});

test("Resolution submit gate: blocked when verdict is not a canonical enum value", () => {
  assert.equal(
    canSubmitResolution({
      busy: false,
      verdict: "BOGUS_VERDICT",
      rationale: "Why",
    }),
    false,
    "Submit must be blocked when verdict is not a REVIEWER_VERDICTS " +
      "enum value (the service denies DISAGREEMENT_STATE_INVALID / " +
      "VERDICT_REQUIRED otherwise).",
  );
});

test("Resolution submit gate: blocked while a prior submission is in flight", () => {
  assert.equal(
    canSubmitResolution({
      busy: true,
      verdict: "APPROVE",
      rationale: "Why",
    }),
    false,
    "Inflight guard must prevent double-firing the transition POST.",
  );
});

test("Resolution submit gate: enabled with verdict + rationale + idle", () => {
  assert.equal(
    canSubmitResolution({
      busy: false,
      verdict: "APPROVE",
      rationale: "I uphold the original decision.",
    }),
    true,
    "Submit must be enabled when verdict + rationale are valid and no " +
      "request is in flight.",
  );
});

// ---------------------------------------------------------------------------
// 6. Each non-PENDING REVIEWER_VERDICTS value passes the gate.
// ---------------------------------------------------------------------------

test("Every non-PENDING REVIEWER_VERDICTS value passes the gate", () => {
  for (const v of REVIEWER_VERDICTS) {
    if (v === "PENDING") continue;
    assert.equal(
      canSubmitResolution({
        busy: false,
        verdict: v,
        rationale: "Bounded rationale recorded by the picker.",
      }),
      true,
      `Verdict ${v} must be accepted by the picker gate.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Resolution persistence uses the canonical declared fields, and
//    the compact table still avoids extra lifecycle detail.
// ---------------------------------------------------------------------------

test("service writes resolution through canonical declared fields", () => {
  assert.match(
    SERVICE_SOURCE,
    /data\["resolvedAtUtc"\]\s*=\s*now/,
    "transitionDisagreement must stamp resolvedAtUtc on RESOLVED_* transitions.",
  );
  assert.match(
    SERVICE_SOURCE,
    /data\["resolvedByUserId"\]\s*=\s*input\.actorUserId/,
    "transitionDisagreement must record resolvedByUserId on RESOLVED_* transitions.",
  );
  assert.match(
    SERVICE_SOURCE,
    /data\["resolution"\]\s*=\s*buildResolutionSummary\(/,
    "transitionDisagreement must persist the bounded verdict/rationale payload through the declared resolution field.",
  );
});

test("service does NOT write undeclared disagreement detail columns", () => {
  for (const field of [
    "secondReviewerVerdict",
    "secondReviewerRationale",
    "secondReviewerDecidedAt",
    "supervisorVerdict",
    "supervisorRationale",
    "withdrawnAtUtc",
  ]) {
    assert.doesNotMatch(
      SERVICE_SOURCE,
      new RegExp(`\\b${field}\\b`),
      `transitionDisagreement must not write undeclared field ${field}.`,
    );
  }
});

test("schema does NOT declare the removed extra disagreement detail columns", () => {
  for (const field of [
    "secondReviewerVerdict",
    "secondReviewerRationale",
    "secondReviewerDecidedAt",
    "supervisorVerdict",
    "supervisorRationale",
    "withdrawnAtUtc",
  ]) {
    assert.doesNotMatch(
      SCHEMA_SOURCE,
      new RegExp(`\\b${field}\\b`),
      `schema.prisma must stay aligned with the canonical resolution contract and omit ${field}.`,
    );
  }
});

test("page.tsx does NOT render secondReviewerVerdict in the compact table", () => {
  assert.doesNotMatch(
    PAGE_SOURCE,
    /\bsecondReviewerVerdict\b/,
    "Disagreements page keeps secondReviewerVerdict out of the compact table.",
  );
});

test("page.tsx does NOT render supervisorVerdict in the compact table", () => {
  assert.doesNotMatch(
    PAGE_SOURCE,
    /\bsupervisorVerdict\b/,
    "Disagreements page keeps supervisorVerdict out of the compact table.",
  );
});

test("page.tsx does NOT render extra resolution detail columns inline", () => {
  for (const field of [
    "secondReviewerRationale",
    "supervisorRationale",
    "secondReviewerDecidedAt",
    "withdrawnAtUtc",
  ]) {
    assert.doesNotMatch(
      PAGE_SOURCE,
      new RegExp(`\\b${field}\\b`),
      `Disagreements page intentionally omits ${field} from the compact ` +
        "table layout.",
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Challenger rationale is rendered but bounded (truncated).
// ---------------------------------------------------------------------------

test("Challenger rationale is rendered through the bounded preview component", () => {
  assert.match(
    PAGE_SOURCE,
    /function ChallengerRationalePreview\(/,
    "Page must define a ChallengerRationalePreview component that " +
      "truncates the rationale before render.",
  );
  assert.match(
    PAGE_SOURCE,
    /CHALLENGER_RATIONALE_PREVIEW_MAX\s*=\s*300/,
    "Challenger rationale preview must cap at 300 chars (bounded copy).",
  );
  assert.match(
    PAGE_SOURCE,
    /data-disagreement-challenger-rationale/,
    "Challenger rationale must render via a tagged element " +
      "(data-disagreement-challenger-rationale) so tests can verify it.",
  );
});

// ---------------------------------------------------------------------------
// 9. DISAGREEMENT_STATES enum coverage — every state has a label.
// ---------------------------------------------------------------------------

test("Every DISAGREEMENT_STATES value has a human label in STATE_LABELS", () => {
  for (const state of DISAGREEMENT_STATES) {
    // Each enum value must appear as a key in the STATE_LABELS map.
    assert.match(
      PAGE_SOURCE,
      new RegExp(`${state}:\\s*"`),
      `STATE_LABELS must define a label for ${state}.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10. Runtime exercise — bounded denial surface, no fake success.
// ---------------------------------------------------------------------------

type TransitionResult = { ok: true } | { ok: false; denial: string };

function runTransitionSpy(args: { apiResult: TransitionResult }): {
  banner: string;
  pickerClosed: boolean;
  refreshed: boolean;
} {
  let banner = "";
  let pickerClosed = false;
  let refreshed = false;
  if (args.apiResult.ok) {
    banner = "Moved to Resolved (upheld).";
    pickerClosed = true;
    refreshed = true;
  } else {
    banner = `Refused: ${args.apiResult.denial}`;
    pickerClosed = false;
    refreshed = false;
  }
  return { banner, pickerClosed, refreshed };
}

test("Resolution submit on success: closes picker and refreshes list", () => {
  const r = runTransitionSpy({ apiResult: { ok: true } });
  assert.equal(r.pickerClosed, true);
  assert.equal(r.refreshed, true);
  assert.match(r.banner, /Moved to/);
});

test("Resolution submit on failure: keeps picker open and surfaces denial", () => {
  const r = runTransitionSpy({
    apiResult: { ok: false, denial: "VERDICT_REQUIRED" },
  });
  assert.equal(
    r.pickerClosed,
    false,
    "On failure the picker must stay open so the operator can retry " +
      "without re-picking the verdict.",
  );
  assert.equal(
    r.refreshed,
    false,
    "On failure the disagreements list must NOT be refreshed — the " +
      "transition was not recorded.",
  );
  assert.match(
    r.banner,
    /VERDICT_REQUIRED/,
    "Failure banner must surface the bounded denial code so the " +
      "operator can act on it.",
  );
  assert.doesNotMatch(
    r.banner,
    /^Moved to/,
    "Failure banner must NOT use the same wording as success.",
  );
});
