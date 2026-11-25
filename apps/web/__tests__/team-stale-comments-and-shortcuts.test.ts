/**
 * Stage E, W2 — the copy that still described the pre-Team-on-Personal model,
 * and help that advertised keys nothing handles.
 *
 *   T-124   stale comments in the commercial code are rewritten to the
 *           Team-on-Personal model (comment-only item: a grep is the proof)
 *   ARCH-18 / T-094 the shortcut help lists only keys the page registered
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CONSOLE_ROWS } from "../app/(app)/reviewer-ops/components/ReviewerShortcutsHelp";
import {
  INBOX_KEYMAP,
  REVIEW_PAGE_KEYMAP,
  bindingForEvent,
  keymapHelpRows,
} from "../lib/reviewer-workspace/review-keymap";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

// ===========================================================================
// T-124 — stale comments (comment-only item: a grep test is the proof)
// ===========================================================================

test("T-124 — the stale pre-Team-on-Personal statements are gone", () => {
  const stale: Array<[string, RegExp]> = [
    ["packages/shared-billing/src/plan-catalog.ts", /TEAM says no/],
    ["packages/shared-billing/src/plan-catalog.ts", /you buy\s*\*?\s*TEAM for a team, not for yourself/],
    ["apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx", /plan that sells five\s*\n?\s*seats/],
    ["apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx", /This branch has no Assignments tab at all/],
    ["apps/web/lib/settings/settingsNavigation.ts", /a personal space has\s*\n?\s*\/\/\s*none, so the pane would describe roles nobody can hold/],
  ];
  for (const [file, phrase] of stale) {
    assert.doesNotMatch(read(file), phrase, `${file} still says ${phrase}`);
  }
});

// ===========================================================================
// ARCH-18 / T-094 (stage D) — the shortcut help is GENERATED from the keymap
// the page registers its handlers from, so every help row is a handled key.
// ===========================================================================

test("T-094 — every help row maps to a registered handler; an unregistered key is never listed", () => {
  const handlers = { next: () => {}, previous: () => {}, open: () => {}, filter: () => {}, help: () => {} };
  const rows = keymapHelpRows(INBOX_KEYMAP, handlers);
  assert.deepEqual(rows.map((r) => r.action), ["next", "previous", "open", "filter", "help"]);
  for (const row of rows) {
    assert.equal(typeof (handlers as Record<string, unknown>)[row.action], "function", row.key);
  }
  // A key the page did not register (assign, focus) is not in the help.
  assert.ok(!rows.some((r) => r.action === "assign" || r.action === "focus"));
  // The default rows are exactly the keymap: E and M (never handled by the
  // Inbox) are not listed.
  assert.deepEqual(CONSOLE_ROWS.map((r) => r.key), INBOX_KEYMAP.map((b) => b.display));
  assert.ok(!CONSOLE_ROWS.some((r) => r.key === "E" || r.key === "M"));
  // The binding a key event selects is the one its row names.
  for (const b of REVIEW_PAGE_KEYMAP) {
    const picked = bindingForEvent(REVIEW_PAGE_KEYMAP, { key: b.keys[0]!, ctrlKey: false, metaKey: false, altKey: false });
    assert.equal(picked?.action, b.action, b.display);
  }
  // Ctrl/Cmd chords belong to the app-wide palette.
  assert.equal(bindingForEvent(INBOX_KEYMAP, { key: "k", ctrlKey: true, metaKey: false, altKey: false }), null);
});
