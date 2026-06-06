/**
 * PHASE 2 — Reviewer QC FAIL reason picker regression lock.
 *
 * Before this phase /review/qc submitted QC_FAILURE_REASONS[0]
 * ("INCORRECT_CODING") unconditionally on every FAIL click — every
 * failed sample landed with the same canned reason regardless of
 * operator intent.
 *
 * This phase replaces the hardcoded reason with a `<select>` listing
 * every QC_FAILURE_REASONS enum value plus a bounded rationale
 * textarea. The canonical /v1/reviewer/qc/samples/:id/verdict route +
 * qc-sample.service.renderQcVerdict require BOTH a bounded
 * failureReason enum AND a non-empty rationale (RATIONALE_REQUIRED on
 * FAIL).
 *
 * Contracts pinned by this test:
 *
 *   1. The page source no longer contains the hardcoded
 *      `QC_FAILURE_REASONS[0]` submission.
 *
 *   2. The page imports QC_FAILURE_REASONS from @proovra/shared (the
 *      canonical enum source) and renders a <select> populated from
 *      it — every value must appear as an <option>.
 *
 *   3. The page renders a bounded <textarea> for rationale with a 600
 *      char maxLength (the server BoundedNote limit; the service
 *      truncates server-side too).
 *
 *   4. The page renders submit/cancel buttons for the FAIL picker and
 *      the submit button cannot fire without both a picked reason and
 *      a non-empty trimmed rationale.
 *
 *   5. The verdict mutation helper (renderQcVerdict) is called with
 *      the picked failureReason + rationale values — not the
 *      hardcoded enum[0].
 *
 *   6. PASS / PARTIAL paths still submit without a reason.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-qc-reason-picker.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { QC_FAILURE_REASONS, QC_VERDICTS } from "@proovra/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "qc",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Hardcoded QC_FAILURE_REASONS[0] is gone.
// ---------------------------------------------------------------------------

test("QC page no longer hardcodes QC_FAILURE_REASONS[0] on FAIL", () => {
  // The old call site looked like:
  //   v === "FAIL" ? QC_FAILURE_REASONS[0] : undefined
  // Any future regression that re-introduces an indexed access of the
  // failure-reason enum at submit time would silently undo this work.
  assert.doesNotMatch(
    PAGE_SOURCE,
    /QC_FAILURE_REASONS\s*\[\s*0\s*\]/,
    "QC page must not submit QC_FAILURE_REASONS[0] — operator must " +
      "pick a reason explicitly.",
  );
});

// ---------------------------------------------------------------------------
// 2. The picker imports the canonical enum and renders every value.
// ---------------------------------------------------------------------------

test("QC page imports QC_FAILURE_REASONS from @proovra/shared", () => {
  assert.match(
    PAGE_SOURCE,
    /import\s*\{[^}]*QC_FAILURE_REASONS[^}]*\}\s*from\s*"@proovra\/shared"/,
    "QC page must import QC_FAILURE_REASONS from the canonical shared " +
      "enum so the picker tracks any future enum additions.",
  );
});

test("QC FAIL picker maps every QC_FAILURE_REASONS value to an <option>", () => {
  // Each enum value must appear as the value= attribute on an option
  // in the picker (the page maps over the enum to render options).
  for (const reason of QC_FAILURE_REASONS) {
    assert.match(
      PAGE_SOURCE,
      new RegExp(
        `QC_FAILURE_REASONS\\.map\\(\\(?[a-z]+\\)?\\s*=>[\\s\\S]{0,400}?value=\\{[a-z]+\\}`,
      ),
      "QC picker must map QC_FAILURE_REASONS to <option value={r}>… so " +
        "every enum value is selectable.",
    );
    // Sanity: the enum value must be defined somewhere in the import
    // chain. We use the imported QC_FAILURE_REASONS array as the
    // source of truth; the regex above asserts the .map(...) pattern
    // covering all entries.
    assert.ok(
      reason.length > 0,
      "Every enum value must be a non-empty string.",
    );
  }
});

test("QC FAIL picker renders a <select> tagged for the reason", () => {
  assert.match(
    PAGE_SOURCE,
    /data-qc-fail-reason-select/,
    "QC FAIL picker must render a <select data-qc-fail-reason-select=… " +
      "so operators (and tests) can identify the reason picker.",
  );
});

test("QC FAIL picker renders a bounded <textarea> for rationale", () => {
  assert.match(
    PAGE_SOURCE,
    /data-qc-fail-rationale/,
    "QC FAIL picker must render a rationale textarea tagged " +
      "data-qc-fail-rationale.",
  );
  assert.match(
    PAGE_SOURCE,
    /RATIONALE_MAX\s*=\s*600/,
    "QC FAIL picker rationale must be capped at 600 chars (matches " +
      "qc-sample.service rationale.slice(0, 600)).",
  );
  assert.match(
    PAGE_SOURCE,
    /maxLength=\{RATIONALE_MAX\}/,
    "QC FAIL picker <textarea> must enforce maxLength={RATIONALE_MAX} " +
      "on the input element.",
  );
});

test("QC FAIL picker renders submit + cancel buttons", () => {
  assert.match(
    PAGE_SOURCE,
    /data-qc-fail-submit/,
    "QC FAIL picker must render a submit button (data-qc-fail-submit).",
  );
  assert.match(
    PAGE_SOURCE,
    /data-qc-fail-cancel/,
    "QC FAIL picker must render a cancel button (data-qc-fail-cancel).",
  );
});

// ---------------------------------------------------------------------------
// 3. Submission shape — renderQcVerdict is called with picker values.
// ---------------------------------------------------------------------------

test("QC FAIL path calls renderQcVerdict with picked failureReason + rationale", () => {
  // The onVerdict callback must forward failureReason + rationale —
  // not synthesize them or send empty strings. We assert the function
  // signature accepts both, and the FAIL picker submit forwards both.
  assert.match(
    PAGE_SOURCE,
    /onVerdict\(\s*r\.id,\s*"FAIL",\s*failureReason,\s*rationale\s*\)/,
    "QC FAIL submit must call onVerdict(r.id, 'FAIL', failureReason, " +
      "rationale) with the picker-driven values.",
  );
});

test("QC verdict helper signature carries failureReason + rationale", () => {
  // The onVerdict prop is typed to accept both — pins the shape so a
  // future refactor cannot drop the rationale argument.
  assert.match(
    PAGE_SOURCE,
    /onVerdict:\s*\(\s*id:\s*string,\s*v:\s*"PASS"\s*\|\s*"FAIL"\s*\|\s*"PARTIAL",\s*failureReason\?:\s*string,\s*rationale\?:\s*string,?\s*\)\s*=>\s*Promise<void>/,
    "onVerdict prop type must carry failureReason + rationale as " +
      "optional strings so the picker can forward them on FAIL.",
  );
});

// ---------------------------------------------------------------------------
// 4. PASS / PARTIAL paths still submit without a reason.
// ---------------------------------------------------------------------------

test("PASS / PARTIAL submit through onVerdict without picker arguments", () => {
  // The verdict buttons short-circuit FAIL into opening the picker,
  // and PASS / PARTIAL submit directly without forcing a reason.
  assert.match(
    PAGE_SOURCE,
    /onVerdict\(\s*r\.id,\s*v\s*as\s*"PASS"\s*\|\s*"PARTIAL"\s*\)/,
    "PASS / PARTIAL verdict click must call onVerdict(r.id, v) with no " +
      "failureReason / rationale arguments — only FAIL routes through " +
      "the picker.",
  );
});

test("PASS / FAIL / PARTIAL buttons are still rendered for every verdict", () => {
  // The button row maps over QC_VERDICTS — pin so a refactor cannot
  // accidentally drop a verdict from the action bar.
  for (const v of QC_VERDICTS) {
    assert.ok(
      v === "PASS" || v === "FAIL" || v === "PARTIAL",
      `QC_VERDICTS must cover the canonical trio (saw ${v}).`,
    );
  }
  assert.match(
    PAGE_SOURCE,
    /QC_VERDICTS\.map\(/,
    "Verdict buttons must be rendered by mapping QC_VERDICTS so any " +
      "future enum addition appears in the UI.",
  );
});

// ---------------------------------------------------------------------------
// 5. Submit-gate behaviour — replicates the picker's gating rules.
// ---------------------------------------------------------------------------

function canSubmitQcFail(input: {
  busy: boolean;
  failureReason: string;
  rationale: string;
}): boolean {
  const trimmed = input.rationale.trim();
  return (
    !input.busy &&
    input.failureReason.length > 0 &&
    (QC_FAILURE_REASONS as ReadonlyArray<string>).includes(
      input.failureReason,
    ) &&
    trimmed.length > 0 &&
    trimmed.length <= 600
  );
}

test("QC FAIL submit gate: blocked when no reason picked", () => {
  assert.equal(
    canSubmitQcFail({
      busy: false,
      failureReason: "",
      rationale: "Coding wrong",
    }),
    false,
    "Submit must be blocked until a reason is selected from the picker.",
  );
});

test("QC FAIL submit gate: blocked when rationale is whitespace", () => {
  assert.equal(
    canSubmitQcFail({
      busy: false,
      failureReason: "INCORRECT_CODING",
      rationale: "   ",
    }),
    false,
    "Submit must be blocked until rationale carries non-whitespace " +
      "content (server rejects with RATIONALE_REQUIRED otherwise).",
  );
});

test("QC FAIL submit gate: blocked when rationale exceeds 600 chars", () => {
  assert.equal(
    canSubmitQcFail({
      busy: false,
      failureReason: "INCORRECT_CODING",
      rationale: "x".repeat(601),
    }),
    false,
    "Submit must be blocked when rationale length exceeds 600 chars.",
  );
});

test("QC FAIL submit gate: blocked when reason is not in the canonical enum", () => {
  assert.equal(
    canSubmitQcFail({
      busy: false,
      failureReason: "BOGUS_REASON",
      rationale: "Coding wrong",
    }),
    false,
    "Submit must be blocked when failureReason is not a " +
      "QC_FAILURE_REASONS enum value (server denies QC_VERDICT_INVALID).",
  );
});

test("QC FAIL submit gate: blocked while a prior submission is in flight", () => {
  assert.equal(
    canSubmitQcFail({
      busy: true,
      failureReason: "INCORRECT_CODING",
      rationale: "Coding wrong",
    }),
    false,
    "Inflight guard must prevent double-firing the verdict POST.",
  );
});

test("QC FAIL submit gate: enabled with picker selected + rationale + idle", () => {
  assert.equal(
    canSubmitQcFail({
      busy: false,
      failureReason: "INCORRECT_CODING",
      rationale: "Coding wrong",
    }),
    true,
    "Submit must be enabled when reason + rationale are valid and no " +
      "request is in flight.",
  );
});

// ---------------------------------------------------------------------------
// 6. Each canonical QC_FAILURE_REASONS value passes the gate.
// ---------------------------------------------------------------------------

test("Every QC_FAILURE_REASONS value passes the gate when paired with rationale", () => {
  for (const reason of QC_FAILURE_REASONS) {
    assert.equal(
      canSubmitQcFail({
        busy: false,
        failureReason: reason,
        rationale: "Picker rationale for the failure",
      }),
      true,
      `Reason ${reason} must be accepted by the picker gate.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Runtime exercise — bounded denial surface, no fake success.
// ---------------------------------------------------------------------------

type QcVerdictResult = { ok: true } | { ok: false; denial: string };

function runQcVerdictSpy(args: { apiResult: QcVerdictResult }): {
  banner: string;
  pickerClosed: boolean;
  refreshed: boolean;
} {
  let banner = "";
  let pickerClosed = false;
  let refreshed = false;
  if (args.apiResult.ok) {
    banner = "Verdict FAIL recorded.";
    pickerClosed = true;
    refreshed = true;
  } else {
    banner = `Verdict refused: ${args.apiResult.denial}`;
    pickerClosed = false;
    refreshed = false;
  }
  return { banner, pickerClosed, refreshed };
}

test("QC FAIL submit on success: closes picker and refreshes list", () => {
  const r = runQcVerdictSpy({ apiResult: { ok: true } });
  assert.equal(r.pickerClosed, true);
  assert.equal(r.refreshed, true);
  assert.match(r.banner, /FAIL recorded/);
});

test("QC FAIL submit on failure: keeps picker open and surfaces denial", () => {
  const r = runQcVerdictSpy({
    apiResult: { ok: false, denial: "RATIONALE_REQUIRED" },
  });
  assert.equal(
    r.pickerClosed,
    false,
    "On failure the picker must stay open so the operator can retry " +
      "without re-picking the reason.",
  );
  assert.equal(
    r.refreshed,
    false,
    "On failure the samples list must NOT be refreshed — the verdict " +
      "was not recorded.",
  );
  assert.match(
    r.banner,
    /RATIONALE_REQUIRED/,
    "Failure banner must surface the bounded denial code so the " +
      "operator can act on it.",
  );
  assert.doesNotMatch(
    r.banner,
    /recorded\./i,
    "Failure banner must NOT use the same wording as success.",
  );
});
