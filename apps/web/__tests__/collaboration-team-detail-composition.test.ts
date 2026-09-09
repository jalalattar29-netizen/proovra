/**
 * COLLABORATION TEAM DETAIL — the composition contract.
 *
 * Three invariants that a render test cannot cheaply see and that regress
 * silently, each one written because it had already broken:
 *
 *   1. SETTINGS IS A GRID, not a 620px column. It was `maxWidth: 620` with
 *      every card stacked full-width inside it, so on a 1360px page roughly
 *      half the width was permanently empty.
 *   2. A CAPSULE IS AN EXCEPTION. The activity history printed its CATEGORY —
 *      "Assignments", "Settings" — as a filled badge on every single row, so a
 *      column of lozenges carried no information the sentence beside it did
 *      not. Capsules survive only where a state is genuinely exceptional.
 *   3. A CLASS NAME THAT STYLES NOTHING IS A BUG. The case picker's option
 *      rows carried `app-listbox-option` — the canonical primitive is
 *      `.app-listbox__option` — so the "selected" state matched no rule and
 *      choosing a case changed nothing on screen. Nothing tells you: the class
 *      attribute is a string, and a typo in it is silent.
 *
 * Everything below reads the SHIPPED source.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const TEAM = "apps/web/app/(app)/collaboration-teams/[teamId]";
const PAGE = read(`${TEAM}/page.tsx`);
const SETTINGS = read(`${TEAM}/_tabs/SettingsTab.tsx`);
const ACTIVITY = read(`${TEAM}/_tabs/ActivityTab.tsx`);
const ASSIGNMENTS = read(`${TEAM}/_tabs/AssignmentsTab.tsx`);
const MODAL = read(`${TEAM}/_components/CreateAssignmentModal.tsx`);
const PICKER = read("apps/web/components/app-primitives/AppSearchSelect.tsx");
const PRIM_CSS = read("apps/web/components/app-primitives/app-primitives.css");
const GLOBALS = read("apps/web/app/globals.css");

const TAB_FILES: ReadonlyArray<[string, string]> = [
  ["OverviewTab", read(`${TEAM}/_tabs/OverviewTab.tsx`)],
  ["AssignmentsTab", ASSIGNMENTS],
  ["MembersTab", read(`${TEAM}/_tabs/MembersTab.tsx`)],
  ["DiscussionTab", read(`${TEAM}/_tabs/DiscussionTab.tsx`)],
  ["SettingsTab", SETTINGS],
  ["ActivityTab", ACTIVITY],
];

// ---------------------------------------------------------------------------
// 1. SETTINGS LAYOUT
// ---------------------------------------------------------------------------

test("Settings composes on the canonical panel grid, not a narrow column", () => {
  assert.match(
    SETTINGS,
    /className="app-grid-panels app-grid-panels--pairs"/,
    "Settings must lay its cards out on the shared panel grid",
  );
  assert.ok(
    !/data-testid="tab-settings-content"[\s\S]{0,80}maxWidth/.test(SETTINGS),
    "the settings section must not clamp itself back to a narrow column",
  );
});

test("the cards that need the width say so, and the grid honours it", () => {
  // Danger zone is destructive and its rows are [explanation | action] bars;
  // Leadership's body is three lines of governance copy. Both read badly in a
  // half column, and both would otherwise leave an empty half beside them.
  for (const testid of ["settings-danger-zone", "settings-leadership"]) {
    const at = SETTINGS.indexOf(`data-testid="${testid}"`);
    assert.ok(at > 0, `${testid} must still exist`);
    assert.ok(
      SETTINGS.slice(Math.max(0, at - 220), at).includes(
        "app-grid-panels__full",
      ),
      `${testid} must span the grid rather than sit in a half column`,
    );
  }
  assert.match(
    PRIM_CSS,
    /\.app-grid-panels--pairs\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    "--pairs must fix the column count at two",
  );
  assert.match(
    PRIM_CSS,
    /\.app-grid-panels--pairs\s*>\s*\.app-grid-panels__full\s*\{\s*grid-column:\s*1\s*\/\s*-1;/,
    "a full-width card must have a rule that makes it one",
  );
  // One collapse step, so a phone and a portrait tablet get a clean stack
  // rather than two columns holding a textarea each.
  assert.match(
    PRIM_CSS,
    /@media \(max-width: 900px\) \{\s*\.app-grid-panels--pairs \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    "the paired grid must collapse to a single column",
  );
});

// ---------------------------------------------------------------------------
// 2. CAPSULES ARE EXCEPTIONS
// ---------------------------------------------------------------------------

test("a capsule on this surface only ever marks a red exception", () => {
  const offenders: string[] = [];
  for (const [name, src] of TAB_FILES) {
    for (const m of src.matchAll(/<AppStatusBadge([^>]*)>/g)) {
      const attrs = m[1] ?? "";
      if (!/tone="red"/.test(attrs)) {
        offenders.push(`${name}: <AppStatusBadge${attrs}>`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a status that is not an exception belongs in AppStatusText — same tone table, no capsule",
  );
});

test("the activity CATEGORY is semantic text, and the icon carries its colour", () => {
  assert.match(
    ACTIVITY,
    /<AppStatusText\s+tone=\{tone\}[\s\S]{0,260}CATEGORY_TONE_LABEL\[cat\]/,
    "the per-row category label must be text, not a capsule",
  );
  // A row's glyph and its label read the same tone table, so an icon and its
  // word cannot disagree about what the row means.
  assert.match(
    ACTIVITY,
    /data-activity-tone=\{tone\}/,
    "the category glyph must be tinted by the same canonical tone",
  );
  assert.ok(
    !ACTIVITY.includes("#7C3AED"),
    "the glyph must not repaint itself with a fixed hex outside the tone table",
  );
});

// ---------------------------------------------------------------------------
// 3. ONE ASSIGNMENT FLOW, TWO DOORS
// ---------------------------------------------------------------------------

test("the header offers Create assignment as a peer secondary, gated once", () => {
  assert.match(
    PAGE,
    /\{canAssign \? \(\s*<button[\s\S]{0,240}data-testid="header-create-assignment-button"/,
    "the header action must be gated on the same canAssign the tab uses",
  );
  const at = PAGE.indexOf('data-testid="header-create-assignment-button"');
  const decl = PAGE.slice(Math.max(0, at - 240), at);
  assert.ok(
    decl.includes('className="app-secondary-action"'),
    "Create assignment must wear the same treatment as Discussion",
  );
  assert.ok(
    !decl.includes("app-primary-action"),
    "Add people is the header's one primary action",
  );
});

test("there is exactly ONE create-assignment implementation, and one render of it", () => {
  // The dialog is a component, rendered once, above the tabs.
  const renders = [...PAGE.matchAll(/<CreateAssignmentModal/g)].length;
  assert.equal(renders, 1, "the page must render exactly one dialog");
  // And the Work tab must not have grown its own copy back.
  assert.ok(
    !ASSIGNMENTS.includes("function CreateAssignmentModal"),
    "the Work tab must invoke the shared dialog, not define a second one",
  );
  assert.ok(
    !ASSIGNMENTS.includes("createAssignment("),
    "there must be exactly one caller of the create mutation",
  );
  assert.ok(
    MODAL.includes("createAssignment("),
    "and that caller is the shared dialog",
  );
});

test("the picker submits the id it was given, never a label or an index", () => {
  // `targetId` is DERIVED from the chosen record rather than tracked beside
  // it, so the field cannot claim a selection the payload would not send.
  assert.match(
    MODAL,
    /const targetId = selectedTarget\?\.id \?\? "";/,
    "the submitted id must be derived from the selected record",
  );
  assert.match(
    MODAL,
    /targetId,\n/,
    "and that same id is what the create call carries",
  );
});

// ---------------------------------------------------------------------------
// 4. NO CLASS NAME THAT STYLES NOTHING
// ---------------------------------------------------------------------------

test("the retired ad-hoc picker class names are gone from the product", () => {
  // `app-listbox-option` (single hyphen) is the exact string that made
  // "clicking Talal does nothing" true: the canonical primitive is
  // `.app-listbox__option`, so the class matched no rule at all.
  for (const [name, src] of [
    ...TAB_FILES,
    ["CreateAssignmentModal", MODAL] as [string, string],
    ["AppSearchSelect", PICKER] as [string, string],
  ]) {
    /*
     * COMMENTS STRIPPED FIRST, and that is not a convenience. The picker's
     * docblock NAMES the retired class in order to record what went wrong and
     * why; a raw text search cannot tell that apart from the class attribute
     * itself, and would force someone to delete the explanation to get green.
     */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.ok(
      !/app-listbox-option/.test(code),
      `${name} still names app-listbox-option, which no stylesheet defines`,
    );
  }
});

test("every app-* class the picker renders is actually declared", () => {
  const css = `${PRIM_CSS}\n${GLOBALS}`;
  const used = new Set<string>();
  for (const [, src] of [
    ["CreateAssignmentModal", MODAL],
    ["AppSearchSelect", PICKER],
  ] as ReadonlyArray<[string, string]>) {
    // Only literal class strings — a computed className is not a typo risk of
    // this kind, and pretending to parse one would be the weaker check.
    for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
      for (const token of (m[1] ?? "").split(/\s+/)) {
        if (token.startsWith("app-")) used.add(token);
      }
    }
  }
  assert.ok(used.size > 5, "expected the picker to name several app-* classes");
  const undeclared = [...used].filter((c) => !css.includes(`.${c}`)).sort();
  assert.deepEqual(
    undeclared,
    [],
    "a class the stylesheet has never heard of styles nothing, silently",
  );
});
