/**
 * ONE action authority across the Evidence Library Inspector and Case Details.
 *
 * The Inspector footer is the authority, and it carries two RANKS for two
 * kinds of work: the canonical purple primary for `Download Report`, the
 * canonical dark filled secondary for `Download Verification Package`. Case
 * Details adopts exactly that pair for `Add evidence` and `Generate report`.
 *
 * An earlier pass flattened both Inspector downloads to the outlined
 * secondary, which erased the rank difference and made the two downloads
 * indistinguishable. These assertions exist so that cannot recur in either
 * direction.
 *
 * They pin the SHARED class, not a colour: both treatments live in
 * `app-primitives.css`, so neither surface can drift without the other, and
 * neither may reintroduce a local palette.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const WEB = resolve(REPO_ROOT, "apps/web");
const read = (p: string) => readFileSync(resolve(WEB, p), "utf8");

const CASE_DETAIL = read(
  "components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const INSPECTOR = read("app/(app)/evidence/components/QueueSelectionPreview.tsx");
const PRIMITIVES = read("components/app-primitives/app-primitives.css");
const LIBRARY_CSS = read("app/(app)/evidence/evidence-library.css");

/**
 * The opening tag of the button whose CONTENT is `label`.
 *
 * The label also appears in prose and in tooltip strings, so an occurrence
 * only counts when the nearest preceding `<button` is closer than the nearest
 * preceding `</button>` — i.e. the label really sits inside a button element.
 */
function buttonBlockFor(src: string, label: string): string {
  let from = 0;
  for (;;) {
    const at = src.indexOf(label, from);
    assert.ok(at > -1, `expected a button whose content is "${label}"`);
    const open = src.lastIndexOf("<button", at);
    const closed = src.lastIndexOf("</button>", at);
    if (open > -1 && open > closed) return src.slice(open, at);
    from = at + label.length;
  }
}

/** The two ranks, and the control that carries each on both surfaces. */
const PAIRS = [
  {
    rank: "purple primary",
    classes: ["app-primary-action"],
    forbidden: "app-secondary-action",
    evidence: "Download Report",
    caseAction: "Add evidence",
  },
  {
    rank: "dark filled secondary",
    classes: ["app-secondary-action", "app-secondary-action--filled"],
    forbidden: "app-primary-action",
    evidence: "Download Verification Package",
    caseAction: "Generate report",
  },
] as const;

test("the Inspector downloads carry two distinct canonical ranks", () => {
  for (const pair of PAIRS) {
    const block = buttonBlockFor(INSPECTOR, pair.evidence);
    for (const cls of pair.classes) {
      assert.match(
        block,
        new RegExp(`\\b${cls.replace("--", "--")}\\b`),
        `${pair.evidence} must carry ${cls} (${pair.rank})`,
      );
    }
    assert.doesNotMatch(
      block,
      new RegExp(`\\b${pair.forbidden}\\b`),
      `${pair.evidence} must not also be the other rank`,
    );
    // The Evidence download icon survives, and stays decorative.
    assert.match(block, /<Download size=\{16\}[\s\S]*?aria-hidden="true"/);
  }
});

test("Case Details adopts the Inspector's ranks, laid out block", () => {
  for (const pair of PAIRS) {
    const block = buttonBlockFor(CASE_DETAIL, pair.caseAction);
    for (const cls of pair.classes) {
      assert.match(block, new RegExp(`\\b${cls}\\b`), `${pair.caseAction} must carry ${cls}`);
    }
    assert.doesNotMatch(block, new RegExp(`\\b${pair.forbidden}\\b`));
    // Layout only — the rail stacks; the treatment is unchanged.
    assert.match(block, /--block/, `${pair.caseAction} keeps the rail layout`);
  }
});

test("a disabled download exposes its real reason, not only a title attribute", () => {
  for (const [label, id] of [
    ["Download Report", "REPORT_REASON_ID"],
    ["Download Verification Package", "PACKAGE_REASON_ID"],
  ] as const) {
    const block = buttonBlockFor(INSPECTOR, label);
    assert.match(block, new RegExp(`aria-describedby=\\{[a-zA-Z]*DisabledReason \\? ${id}`));
  }
  assert.match(INSPECTOR, /id=\{REPORT_REASON_ID\}/);
  assert.match(INSPECTOR, /id=\{PACKAGE_REASON_ID\}/);
});

test("both treatments live in the canonical primitive, not in Evidence CSS", () => {
  for (const base of ["app-primary-action", "app-secondary-action"]) {
    assert.match(PRIMITIVES, new RegExp(`\\.${base} \\{`));
    assert.match(PRIMITIVES, new RegExp(`\\.${base}:hover:not\\(:disabled\\)`));
    assert.match(PRIMITIVES, new RegExp(`\\.${base}:focus-visible`));
    assert.match(PRIMITIVES, new RegExp(`\\.${base}:disabled`));
  }
  assert.match(PRIMITIVES, /\.app-secondary-action--filled \{/);
  // The dark filled hover must WIN over the base hover. At equal specificity
  // that means being declared after it — a white label on the lilac base hover
  // is unreadable.
  assert.ok(
    PRIMITIVES.indexOf(".app-secondary-action--filled:hover") >
      PRIMITIVES.indexOf(".app-secondary-action:hover"),
    "the filled hover must be declared after the base hover",
  );
  // The Evidence route never repaints the download controls locally.
  assert.doesNotMatch(
    LIBRARY_CSS,
    /\[data-evidence-inspector-download-(report|package)\][^{]*\{[^}]*(background|color|border)/,
  );
});

test("Case Details styling is not imported into the Evidence Library", () => {
  assert.doesNotMatch(INSPECTOR, /cases-experience[^"']*\.css/);
  assert.doesNotMatch(LIBRARY_CSS, /case-detail-rail/);
});

// ---------------------------------------------------------------------------
// Bulk action — the request contract and the states the dialog must carry.
// ---------------------------------------------------------------------------

const TOOLBAR = read("app/(app)/evidence/components/BulkActionsToolbar.tsx");
const PAGE = read("app/(app)/evidence/page.tsx");

test("the page serialises the bulk request through the shared contract", () => {
  assert.match(PAGE, /buildEvidenceBulkRequest\(\{ action, evidenceIds, caseId \}\)/);
  assert.match(PAGE, /from "@proovra\/shared"/);
  // The null the API's schema has no word for is gone from the SERIALISER.
  // (The comment recording the defect stays in the source deliberately.)
  const serialiser = PAGE.slice(
    PAGE.indexOf('apiFetch("/v1/evidence/bulk"'),
    PAGE.indexOf('apiFetch("/v1/evidence/bulk"') + 400,
  );
  assert.doesNotMatch(serialiser, /caseId: caseId \?\? null/);
  assert.doesNotMatch(serialiser, /caseId: null/);
});

test("the toolbar derives its vocabulary and its bound from that contract", () => {
  assert.match(TOOLBAR, /EVIDENCE_BULK_ACTIONS/);
  assert.match(TOOLBAR, /EVIDENCE_BULK_MAX_IDS/);
  assert.match(TOOLBAR, /evidenceBulkActionRequiresCase\(action\)/);
  // The bound is enforced before submission, with an explanation.
  assert.match(TOOLBAR, /overSelectionLimit/);
  assert.match(TOOLBAR, /data-bulk-limit-helper/);
});

test("the confirm control names the action, then the committing state", () => {
  assert.match(TOOLBAR, /ARCHIVE: \{ pending: "Archiving…"/);
  assert.match(TOOLBAR, /aria-busy=\{running\}/);
  assert.match(TOOLBAR, /disabled=\{running\}/);
  assert.match(TOOLBAR, /className="app-spinner"/);
  assert.match(TOOLBAR, /<Loader2[\s\S]{0,120}aria-hidden="true"/);
});

test("a committing dialog cannot be dismissed, and a rejected request is caught", () => {
  assert.match(TOOLBAR, /dismissDisabled=\{running\}/);
  assert.match(TOOLBAR, /catch \(runError\)/);
  assert.match(TOOLBAR, /toSafeUserError\(/);
  assert.match(TOOLBAR, /role="alert"/);
  assert.match(TOOLBAR, /errorRef\.current\?\.focus\(\)/);
});

test("a refused request states what happened to THIS action", () => {
  assert.match(TOOLBAR, /function isRequestValidationFailure\(/);
  assert.match(TOOLBAR, /request was invalid and was not applied/);
  // …and never echoes the server's validation internals.
  assert.doesNotMatch(TOOLBAR, /zodFields|issues|\.path\b/);
});

test("the second results modal is gone — one dialog carries the whole action", () => {
  const modals = TOOLBAR.match(/<Modal\b/g) ?? [];
  assert.equal(modals.length, 1, "the bulk toolbar renders exactly one dialog");
  assert.doesNotMatch(TOOLBAR, /evidence-bulk-result"/);
});
