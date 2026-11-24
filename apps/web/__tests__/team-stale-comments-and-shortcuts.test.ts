/**
 * Stage E, W2 — the copy that still described the pre-Team-on-Personal model,
 * and help that advertised keys nothing handles.
 *
 *   T-124   stale comments in the commercial code are rewritten to the
 *           Team-on-Personal model (comment-only item: a grep is the proof)
 *   ARCH-18 the console shortcut help lists only keys ReviewerConsole handles
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CONSOLE_ROWS } from "../app/(app)/reviewer-ops/components/ReviewerShortcutsHelp";

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
// ARCH-18 — console shortcut help lists only keys the console handles
// ===========================================================================

test("ARCH-18 — every console help row maps to a key ReviewerConsole handles", () => {
  const consoleSrc = read("apps/web/components/reviewer-experience/ReviewerConsole.tsx");
  const handled = new Set<string>(["?"]); // the help hotkey itself (useReviewerHelpHotkey)
  for (const m of consoleSrc.matchAll(/e\.key(?:\.toLowerCase\(\))?\s*===\s*"([^"]+)"/g)) {
    handled.add(m[1].toLowerCase());
  }
  // Sanity: the extraction sees the console's real bindings.
  for (const k of ["j", "k", "enter", "/", "a"]) assert.ok(handled.has(k), `extractor missed ${k}`);
  for (const row of CONSOLE_ROWS) {
    for (const key of row.key.split("/").map((k) => k.trim().toLowerCase()).filter(Boolean)) {
      assert.ok(handled.has(key), `help lists "${row.key}" (${row.label}), the console handles no "${key}"`);
    }
  }
  // "/" itself is a row: the split above drops it, so check it explicitly.
  if (CONSOLE_ROWS.some((r) => r.key === "/")) assert.ok(handled.has("/"));
});
