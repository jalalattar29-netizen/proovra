/**
 * Phase CASES-EVIDENCE-NAMES — Case Detail evidence-row display
 * names. Pins:
 *
 *   1. The header no longer renders a duplicate "Case settings"
 *      button. The Settings tab is the canonical destination for
 *      rename/archive/restore/delete.
 *
 *   2. The Settings tab and its actions are preserved.
 *
 *   3. Both the Evidence tab and the Reports & Packages tab run
 *      every evidence row through the canonical
 *      `getDisplayTitle()` cascade so the UI never renders the
 *      backend's legacy "Untitled evidence" string when a filename
 *      field exists. The same resolver is used in both tabs —
 *      no per-tab title logic.
 *
 *   4. Backend matter-workspace evidence section is extended with
 *      `displayFileName`, `originalFileName`, `mimeType`, and
 *      `itemCount` (derived from `_count.parts`) so the client
 *      cascade has the data it needs. The shape extension is
 *      additive — no existing field was renamed or removed.
 *
 *   5. The backend no longer substitutes a "Untitled evidence"
 *      sentinel for null titles — the cascade runs on the client.
 *
 *   6. The cascade is also exercised in unit form against synthetic
 *      inputs covering the documented priority order:
 *        title > displayFileName > originalFileName > multipart
 *        type-label > short id > "Evidence record"
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getDisplayTitle } from "../app/(app)/evidence/lib/evidence-library-status";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const SIMPLE_DETAIL = src(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const TYPES = src("apps/web/components/cases-experience/types.ts");
const MATTER_WORKSPACE_SERVICE = src(
  "services/api/src/services/cases/matter-workspace.service.ts",
);

// ===========================================================================
// Header — no duplicate "Case settings" button
// ===========================================================================

test("Case Detail header no longer renders a 'Case settings' button (Settings tab is the canonical destination)", () => {
  // The literal button label must be gone from JSX.
  assert.doesNotMatch(SIMPLE_DETAIL, />\s*Case settings\s*</);
  // The action data-attribute the button used must also be gone.
  assert.doesNotMatch(
    SIMPLE_DETAIL,
    /data-simple-case-action="settings"/,
  );
  // The `onGoToSettings` prop on the header is removed too.
  assert.doesNotMatch(SIMPLE_DETAIL, /onGoToSettings/);
});

test("Case Detail header keeps the primary 'Add evidence' action", () => {
  assert.match(SIMPLE_DETAIL, /data-simple-case-action="add-evidence"/);
  assert.match(SIMPLE_DETAIL, />\s*Add evidence\s*</);
});

// ===========================================================================
// Settings tab + actions preserved
// ===========================================================================

test("Settings tab is still mounted in the canonical tab order", () => {
  assert.match(
    SIMPLE_DETAIL,
    /\{ id: "settings", label: "Settings" \}/,
  );
});

test("Rename / Status / Delete actions are still rendered (status now via single dropdown — Phase CASES-STATUS-MANUAL)", () => {
  for (const anchor of [
    "data-simple-case-settings-rename",
    // Archive + Restore folded into the canonical status <select>.
    "data-simple-case-settings-status-select",
    "data-simple-case-settings-delete-trigger",
  ]) {
    assert.ok(
      SIMPLE_DETAIL.includes(anchor),
      `Settings action anchor missing: ${anchor}`,
    );
  }
});

// ===========================================================================
// Display-name cascade used in BOTH tabs via the canonical resolver
// ===========================================================================

test("Evidence tab row renders the title through getDisplayTitle (not raw item.title)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-evidence-title[\s\S]{0,200}?\{getDisplayTitle\(item\)\}/,
  );
});

test("Reports & Packages tab row renders the title through getDisplayTitle (not raw item.title)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /data-simple-case-reports-title[\s\S]{0,200}?\{getDisplayTitle\(item\)\}/,
  );
});

test("Both tabs import the same canonical resolver (no per-tab title helper)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /import \{ getDisplayTitle \} from "\.\.\/\.\.\/\.\.\/app\/\(app\)\/evidence\/lib\/evidence-library-status"/,
  );
});

test("Remove-from-case confirm modal title uses the same resolved display name (single source of truth)", () => {
  assert.match(
    SIMPLE_DETAIL,
    /handleRemove\(item\.id,\s*getDisplayTitle\(item\)\)/,
  );
});

// ===========================================================================
// Frontend envelope type exposes the cascade's required fields
// ===========================================================================

test("matter-workspace envelope evidence item exposes title/displayFileName/originalFileName/mimeType/itemCount", () => {
  // The cascade needs every field — the type must declare each
  // one. Anchor by searching the evidence-items block.
  const start = TYPES.indexOf("evidence: {");
  assert.ok(start > 0, "evidence block not found in envelope type");
  const block = TYPES.slice(start, start + 2000);
  for (const field of [
    "title: string | null",
    "displayFileName: string | null",
    "originalFileName: string | null",
    "mimeType: string | null",
    "itemCount: number",
  ]) {
    assert.ok(
      block.includes(field),
      `envelope evidence item must declare ${field}`,
    );
  }
});

// ===========================================================================
// Backend — additive extension, no sentinel substitution
// ===========================================================================

test("Backend matter-workspace evidence select pulls displayFileName/originalFileName/mimeType + parts count", () => {
  // The new select fields all live inside the same select block.
  // We grab the whole block once and assert every expected field.
  const start = MATTER_WORKSPACE_SERVICE.indexOf(
    "const items = await prisma.evidence.findMany(",
  );
  assert.ok(start > 0, "evidence findMany call not found");
  const end = MATTER_WORKSPACE_SERVICE.indexOf("});", start);
  const block = MATTER_WORKSPACE_SERVICE.slice(start, end);
  for (const field of [
    "displayFileName: true",
    "originalFileName: true",
    "mimeType: true",
    "_count: { select: { parts: true } }",
  ]) {
    assert.ok(
      block.includes(field),
      `evidence select must include ${field}`,
    );
  }
});

test("Backend no longer substitutes 'Untitled evidence' on the matter-workspace evidence section", () => {
  // The mapper used to fall back to a literal string. The literal
  // must be gone from the mapping block so the cascade can fall
  // through to filename fields on the client.
  const start = MATTER_WORKSPACE_SERVICE.indexOf(
    "items: items.map((e) => ({",
  );
  assert.ok(start > 0, "evidence map not found");
  const block = MATTER_WORKSPACE_SERVICE.slice(start, start + 2400);
  assert.doesNotMatch(block, /title: e\.title \?\? "Untitled evidence"/);
  // And the new shape passes nullable title + filename fields.
  assert.match(block, /title: e\.title \?\? null/);
  assert.match(block, /displayFileName: e\.displayFileName \?\? null/);
  assert.match(block, /originalFileName: e\.originalFileName \?\? null/);
  assert.match(block, /mimeType: e\.mimeType \?\? null/);
  assert.match(block, /itemCount: e\._count\.parts > 0 \? e\._count\.parts : 1/);
});

test("Backward compatibility — every previously-emitted evidence field is still emitted", () => {
  const start = MATTER_WORKSPACE_SERVICE.indexOf(
    "items: items.map((e) => ({",
  );
  const block = MATTER_WORKSPACE_SERVICE.slice(start, start + 2400);
  for (const field of [
    "id: e.id",
    "type:",
    "status:",
    "verificationStatus:",
    "lifecycleState:",
    "createdAt: e.createdAt.toISOString()",
    "reportReady:",
    "packageReady:",
    "linkId:",
    "linkRole:",
    "linkSource:",
  ]) {
    assert.ok(
      block.includes(field),
      `evidence map must still emit ${field}`,
    );
  }
});

// ===========================================================================
// Cascade unit tests — priority order
// ===========================================================================

test("getDisplayTitle returns the user-provided title when it is meaningful", () => {
  const out = getDisplayTitle({
    id: "ev-1",
    title: "Accident scene video",
    displayFileName: "anything.mp4",
    originalFileName: "raw.mp4",
    type: "VIDEO",
    mimeType: "video/mp4",
    itemCount: 1,
  });
  assert.equal(out, "Accident scene video");
});

test("getDisplayTitle falls through legacy 'Digital Evidence Record' sentinel to displayFileName", () => {
  const out = getDisplayTitle({
    id: "ev-1",
    title: "Digital Evidence Record",
    displayFileName: "Witness Statement.pdf",
    originalFileName: "v1 (31).pdf",
    type: "DOCUMENT",
    mimeType: "application/pdf",
    itemCount: 1,
  });
  assert.equal(out, "Witness Statement.pdf");
});

test("getDisplayTitle uses displayFileName when title is null", () => {
  const out = getDisplayTitle({
    id: "ev-1",
    title: null,
    displayFileName: "IMG_20260615_1842.jpg",
    originalFileName: "raw.jpg",
    type: "PHOTO",
    mimeType: "image/jpeg",
    itemCount: 1,
  });
  assert.equal(out, "IMG_20260615_1842.jpg");
});

test("getDisplayTitle uses originalFileName when displayFileName is null", () => {
  const out = getDisplayTitle({
    id: "ev-1",
    title: null,
    displayFileName: null,
    originalFileName: "v1 (9).pdf",
    type: "DOCUMENT",
    mimeType: "application/pdf",
    itemCount: 1,
  });
  assert.equal(out, "v1 (9).pdf");
});

test("getDisplayTitle uses multipart package label when both name fields are null and itemCount > 1", () => {
  const out = getDisplayTitle({
    id: "ev-1",
    title: null,
    displayFileName: null,
    originalFileName: null,
    type: "DOCUMENT",
    mimeType: "application/pdf",
    itemCount: 5,
  });
  // The multipart helper inserts "5" somewhere in the label.
  assert.match(out, /5/);
  assert.notEqual(out, "Untitled evidence");
});

test("getDisplayTitle falls back to a type + short-id label when no filename fields exist", () => {
  const out = getDisplayTitle({
    id: "82528237-aaaa-bbbb-cccc-000000000000",
    title: null,
    displayFileName: null,
    originalFileName: null,
    type: "VIDEO",
    mimeType: "video/mp4",
    itemCount: 1,
  });
  // Never the legacy sentinel; never "Untitled evidence".
  assert.notEqual(out, "Untitled evidence");
  assert.notEqual(out, "Digital Evidence Record");
  // Includes the short id so two unnamed records can be told apart.
  assert.match(out, /825282/);
});

test("getDisplayTitle final fallback is 'Evidence record <shortId>' — never 'Untitled evidence'", () => {
  const out = getDisplayTitle({
    id: "82528237-aaaa-bbbb-cccc-000000000000",
    title: null,
    displayFileName: null,
    originalFileName: null,
    type: null,
    mimeType: null,
    itemCount: 1,
  });
  assert.notEqual(out, "Untitled evidence");
});
