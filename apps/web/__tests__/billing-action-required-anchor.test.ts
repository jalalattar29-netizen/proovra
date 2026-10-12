/**
 * The Operations deep link for a storage add-on still billing lands on the
 * exact Billing surface: `/billing?workspace=personal#billing-action-required`.
 *
 * Source contract (`node:test`, this package's convention): the action-required
 * card carries the anchor id, is focusable, and scrolls itself into view once
 * the projection has rendered it, because the browser's own hash scroll runs
 * before the card exists.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const src = readFileSync(
  fileURLToPath(new URL("../app/(app)/billing/_sections/PlanAndUsage.tsx", import.meta.url)),
  "utf8",
);

test("the action-required card carries the canonical anchor id", () => {
  assert.match(src, /export const BILLING_ACTION_REQUIRED_ANCHOR = "billing-action-required";/);
  assert.match(src, /id=\{BILLING_ACTION_REQUIRED_ANCHOR\}/);
  assert.match(src, /tabIndex=\{-1\}/);
});

test("the card scrolls itself into view for the hash once it exists", () => {
  assert.match(src, /hashTargetsActionRequired\(window\.location\.hash\)/);
  assert.match(src, /scrollIntoView\(/);
  assert.match(src, /focus\(\{ preventScroll: true \}\)/);
  // The hook runs before the early return, so it is called on every render.
  const hook = src.indexOf("useEffect(");
  const early = src.indexOf("if (!banner) return null;");
  assert.ok(hook > 0 && early > hook, "useEffect must precede the early return");
});
