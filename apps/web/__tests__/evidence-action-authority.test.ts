/**
 * ONE action authority across Case Details and the Evidence Library Inspector.
 *
 * The Inspector's two downloads used to carry their own treatments — the
 * accent-filled primary for `Download Report` and the filled neutral for
 * `Download Verification Package` — while the accepted Case Details actions
 * (`Add evidence`, `Generate report`) are the canonical secondary action. Three
 * treatments for the same kind of operational control on two surfaces of the
 * same product.
 *
 * These assertions pin the SHARED class, not a colour: the treatment itself
 * lives in `app-primitives.css`, so neither surface can drift without the
 * other, and neither may reintroduce a local palette.
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

test("the accepted Case Details actions are the canonical secondary action", () => {
  for (const label of ["Add evidence", "Generate report"]) {
    const block = buttonBlockFor(CASE_DETAIL, label);
    assert.match(
      block,
      /className="app-secondary-action app-secondary-action--block"/,
      `${label} must keep the canonical secondary action`,
    );
  }
});

test("the Inspector downloads reuse that same canonical action", () => {
  for (const label of ["Download Report", "Download Verification Package"]) {
    const block = buttonBlockFor(INSPECTOR, label);
    assert.match(block, /className="app-secondary-action"/, `${label} treatment`);
    // NOT the accent primary, and not the filled neutral variant.
    assert.doesNotMatch(block, /app-primary-action/);
    assert.doesNotMatch(block, /app-secondary-action--filled/);
    // The Evidence download icon survives, and stays decorative.
    assert.match(block, /<Download size=\{16\}[\s\S]*?aria-hidden="true"/);
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
  // …and the reason is rendered as text with that id.
  assert.match(INSPECTOR, /id=\{REPORT_REASON_ID\}/);
  assert.match(INSPECTOR, /id=\{PACKAGE_REASON_ID\}/);
});

test("the treatment lives in the canonical primitive, not in Evidence CSS", () => {
  assert.match(PRIMITIVES, /\.app-secondary-action \{/);
  assert.match(PRIMITIVES, /\.app-secondary-action:hover:not\(:disabled\)/);
  assert.match(PRIMITIVES, /\.app-secondary-action:focus-visible/);
  assert.match(PRIMITIVES, /\.app-secondary-action:disabled/);
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
// Bulk action — the states the confirm dialog must carry.
// ---------------------------------------------------------------------------

const TOOLBAR = read("app/(app)/evidence/components/BulkActionsToolbar.tsx");

test("the confirm control names the action, then the committing state", () => {
  assert.match(TOOLBAR, /ARCHIVE: \{ pending: "Archiving…"/);
  assert.match(TOOLBAR, /aria-busy=\{running\}/);
  assert.match(TOOLBAR, /disabled=\{running\}/);
  // The spinner is the canonical one, and it is decorative.
  assert.match(TOOLBAR, /className="app-spinner"/);
  assert.match(TOOLBAR, /<Loader2[\s\S]{0,120}aria-hidden="true"/);
});

test("a committing dialog cannot be dismissed, and a rejected request is caught", () => {
  assert.match(TOOLBAR, /dismissDisabled=\{running\}/);
  assert.match(TOOLBAR, /catch \(runError\)/);
  assert.match(TOOLBAR, /toSafeUserError\(/);
  // The failure is announced, not merely rendered.
  assert.match(TOOLBAR, /role="alert"/);
  assert.match(TOOLBAR, /errorRef\.current\?\.focus\(\)/);
});

test("the second results modal is gone — one dialog carries the whole action", () => {
  const modals = TOOLBAR.match(/<Modal\b/g) ?? [];
  assert.equal(modals.length, 1, "the bulk toolbar renders exactly one dialog");
  assert.doesNotMatch(TOOLBAR, /evidence-bulk-result"/);
});
