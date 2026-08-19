/**
 * P0 regression — Evidence Detail preview cards must switch the main
 * preview when clicked.
 *
 * The PreviewWorkspace component renders a large preview area at the
 * top of the page and a grid of file/attachment cards below. After
 * the IA decomposition the cards were rendered as plain <div>s with
 * no onClick and no selection state, so the main preview was stuck
 * on `defaultItem` forever — clicking a second/third card did
 * nothing. This file pins the fix:
 *
 *   1. The cards are rendered as <button type="button"> elements
 *      with onClick wired to setSelectedPreviewItemId.
 *   2. A selectedPreviewItemId state exists and seeds from the
 *      backend-suggested defaultPreviewItemId (then falls back
 *      through the same priority chain the page used before).
 *   3. The main preview renders the SELECTED item (renderPreview()
 *      reads `selectedItem`, not `defaultItem`).
 *   4. Each card carries aria-selected / aria-pressed mirroring
 *      the selection state.
 *   5. The selected card gets a visible "--selected" class so the
 *      operator can see which file is in the main preview.
 *   6. Native <button> gives Enter/Space keyboard handling for free;
 *      pin the button + type="button" markup so a future refactor
 *      can't quietly downgrade back to a <div>.
 *   7. Document/video/audio/PDF kinds each have a dedicated preview
 *      branch; unsupported kinds fall back to a placeholder that
 *      surfaces filename + kind + size + the original-access action.
 *   8. The component renders the cards inside a role="listbox"
 *      with role="option" on each, so screen readers see the
 *      single-select gallery model.
 *   9. No backend endpoint string changed (the data still comes
 *      from the existing review-workspace response).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const LIB = resolve(
  REPO_ROOT,
  "apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx",
);
const CSS = resolve(
  REPO_ROOT,
  "apps/web/app/(app)/evidence/[id]/evidence-detail.css",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — selected-preview state exists and seeds from defaultItem", () => {
  it("PreviewWorkspace declares a useState for selectedPreviewItemId", () => {
    const src = read(LIB);
    assert.match(
      src,
      /const \[selectedPreviewItemId, setSelectedPreviewItemId\] = useState<string \| null>\(\s*\n?\s*defaultItem\?\.id \?\? null,?\s*\n?\s*\)/,
    );
  });

  it("the seed cascade is unchanged: defaultPreviewItemId → previewable+viewUrl → primaryContentItem", () => {
    const src = read(LIB);
    // The fix MUST preserve the exact priority order so the
    // initial render looks identical to before.
    assert.match(src, /workspace\.evidence\.defaultPreviewItemId/);
    assert.match(src, /item\.previewable && item\.viewUrl/);
    assert.match(src, /workspace\.evidence\.primaryContentItem/);
  });

  it("re-seeds the selection when the evidence id changes (route navigation)", () => {
    const src = read(LIB);
    // useEffect depends on workspace.evidence.id and calls setter
    // with defaultItem?.id ?? null.
    assert.match(
      src,
      /useEffect\(\(\) => \{\s*\n?\s*setSelectedPreviewItemId\(defaultItem\?\.id \?\? null\);[\s\S]{0,500}\}, \[workspace\.evidence\.id\]\);/,
    );
  });
});

describe("Pin 2 — main preview renders the SELECTED item, not the default", () => {
  it("renderPreview() reads `selectedItem`, not `defaultItem`", () => {
    const src = read(LIB);
    // Locate renderPreview body and confirm it switches on
    // selectedItem.kind / selectedItem.viewUrl etc.
    const fnIdx = src.indexOf("const renderPreview = () =>");
    assert.ok(fnIdx > 0);
    const body = src.slice(fnIdx, fnIdx + 4000);
    assert.match(body, /!selectedItem \|\| !selectedItem\.viewUrl/);
    assert.match(body, /selectedItem\.kind === "image"/);
    assert.match(body, /selectedItem\.kind === "video"/);
    assert.match(body, /selectedItem\.kind === "audio"/);
    assert.match(body, /selectedItem\.kind === "pdf"/);
    // The unsupported-kind fallback surfaces filename + kind so the
    // operator knows WHICH file can't be previewed.
    assert.match(body, /data-evidence-preview-unsupported/);
    assert.match(body, /selectedItem\.originalFileName \|\| selectedItem\.label/);
  });

  it("selectedItem resolution falls back to defaultItem when the selected id no longer exists", () => {
    const src = read(LIB);
    assert.match(
      src,
      /const selectedItem =\s*\n?\s*contentItems\.find\(\(it\) => it\.id === selectedPreviewItemId\) \?\?\s*\n?\s*defaultItem;/,
    );
  });

  it("each <img>/<video>/<audio>/<iframe> uses `key={selectedItem.id}` so React swaps the element on selection change", () => {
    const src = read(LIB);
    // Without `key`, React may reuse the previous DOM node and the
    // <video> won't pick up the new `src` until the user clicks the
    // controls. Forcing remount via key={id} guarantees a fresh
    // load every time the selection changes.
    const fnIdx = src.indexOf("const renderPreview = () =>");
    const body = src.slice(fnIdx, fnIdx + 4000);
    // Each media element must include key={selectedItem.id}.
    const mediaMatches = body.match(/key=\{selectedItem\.id\}/g) ?? [];
    assert.ok(
      mediaMatches.length >= 4,
      `expected ≥4 key={selectedItem.id} on media elements, found ${mediaMatches.length}`,
    );
  });
});

describe("Pin 3 — cards are buttons with onClick + keyboard + aria + selected state", () => {
  it("each card is a <button type=\"button\"> (not a <div>)", () => {
    const src = read(LIB);
    // The card render block must produce a button, not a div.
    assert.match(
      src,
      /<button\s*\n?\s*key=\{item\.id\}\s*\n?\s*type="button"/,
    );
    // Negative: a leftover plain-div card would defeat the fix.
    assert.ok(
      !/<div key=\{item\.id\} className="evidence-detail-item-card"/.test(src),
      "no leftover <div key={item.id} className=\"evidence-detail-item-card\"> may remain",
    );
  });

  it("onClick calls setSelectedPreviewItemId(item.id)", () => {
    const src = read(LIB);
    assert.match(src, /onClick=\{\(\) => setSelectedPreviewItemId\(item\.id\)\}/);
  });

  it("each card carries aria-selected, aria-pressed, role=\"option\", and a data-attr that mirrors selection", () => {
    const src = read(LIB);
    assert.match(src, /aria-selected=\{isSelected\}/);
    assert.match(src, /aria-pressed=\{isSelected\}/);
    assert.match(src, /role="option"/);
    assert.match(
      src,
      /data-content-item-selected=\{isSelected \? "true" : "false"\}/,
    );
    assert.match(src, /data-content-item-card=\{item\.id\}/);
  });

  it("the grid wrapper uses role=\"listbox\" + aria-label so SR sees a single-select gallery", () => {
    const src = read(LIB);
    assert.match(
      src,
      /<div\s*\n?\s*className="evidence-detail-item-grid"\s*\n?\s*role="listbox"\s*\n?\s*aria-label="Evidence files"/,
    );
  });

  it("the selected card receives the --selected class so it's visibly highlighted", () => {
    const src = read(LIB);
    assert.match(
      src,
      /isSelected\s*\n?\s*\?\s*"evidence-detail-item-card evidence-detail-item-card--selected"\s*\n?\s*:\s*"evidence-detail-item-card"/,
    );
  });
});

describe("Pin 4 — CSS gives the button the look + selected state", () => {
  it("button.evidence-detail-item-card resets button chrome and gets a cursor:pointer", () => {
    const css = read(CSS);
    assert.match(css, /button\.evidence-detail-item-card\s*\{[\s\S]{0,400}cursor:\s*pointer/);
    assert.match(css, /button\.evidence-detail-item-card\s*\{[\s\S]{0,400}text-align:\s*(?:left|start)/);
  });

  it("--selected (or aria-pressed=true) renders a visible highlight border + background", () => {
    const css = read(CSS);
    assert.match(
      css,
      /\.evidence-detail-item-card--selected,\s*\n?\s*button\.evidence-detail-item-card\[aria-pressed="true"\]/,
    );
  });

  it(":focus-visible draws an accessible focus ring (no default browser outline)", () => {
    const css = read(CSS);
    assert.match(
      css,
      /button\.evidence-detail-item-card:focus-visible\s*\{[\s\S]{0,200}box-shadow:/,
    );
  });
});

describe("Pin 5 — no backend endpoint string changed", () => {
  it("review-workspace endpoint reference (or the data path) is untouched in _lib.tsx", () => {
    const src = read(LIB);
    // _lib.tsx is presentational and shouldn't have an endpoint
    // string at all. The fix must not introduce one (that would
    // mean the component now fetches data itself, which is wrong).
    assert.ok(
      !/\/v1\/evidence\/[\w-/]+\/review-workspace/.test(src),
      "_lib.tsx must remain presentational — no /v1/...review-workspace fetch",
    );
  });

  it("no apiFetch / fetch call added to _lib.tsx (still pure presentation)", () => {
    const src = read(LIB);
    assert.ok(
      !/\bapiFetch\(/.test(src),
      "_lib.tsx must not call apiFetch (page.tsx still owns data fetching)",
    );
  });
});
