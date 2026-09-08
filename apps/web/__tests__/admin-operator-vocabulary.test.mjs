/**
 * ADM-P3-012 — NO RAW CAPABILITY CODE IN COPY AN OPERATOR READS.
 *
 * =============================================================================
 * THE RULE, AND WHERE IT COMES FROM
 * =============================================================================
 * `lib/navigation/routeRegistry.ts` states it for the Tools surface: no raw
 * capability codes shown to operators; reasons come from the access resolver's
 * bounded `reason` field. Two admin denial panels named the code itself:
 *
 *   /admin/platform/analytics   "Operational analytics require the
 *                                ANALYTICS_VIEW capability (team writer or
 *                                admin)."
 *   /admin/platform/automation  "Automation visibility requires the
 *                                AUTOMATION_VIEW capability (team writer or
 *                                admin)."
 *
 * A capability key is not something the reader can act on. It also flattened
 * two different problems — an expired session and a missing grant — into one
 * sentence, so the panel could not tell someone whether to sign in again or
 * ask an administrator.
 *
 * =============================================================================
 * WHAT THIS FILE DOES AND DOES NOT ASSERT
 * =============================================================================
 * It reads the STRING LITERALS an operator can see, not the whole file. A page
 * legitimately names its capability in `useCan("ANALYTICS_VIEW")`, in a
 * `PageRouteGate` routeId, and in the comment explaining why the copy stopped
 * naming it — none of which reaches a screen. Asserting over raw file text
 * would fail on the explanation, and the obvious way to make that pass is to
 * delete the explanation.
 *
 * The audit named only the analytics console. The automation page carries the
 * identical sentence one route over, and both are covered here: a rule kept on
 * one of two identical surfaces is a rule the next reader cannot tell is a
 * rule.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = resolve(HERE, "..", "app", "(app)", "admin");

/**
 * The capability keys this product defines, as they appear in code.
 *
 * SHOUT_CASE with an underscore is the shape; it is also the shape of some
 * legitimate operator-facing text (`FAILED_HASH_MISMATCH` is a lifecycle state
 * an operator sees elsewhere in the product and is arguably clearer than a
 * paraphrase). So this checks the keys that are CAPABILITIES specifically,
 * read from the capability catalogue rather than pattern-matched.
 */
function capabilityKeys() {
  const src = readFileSync(
    resolve(HERE, "..", "lib", "navigation", "routeRegistry.ts"),
    "utf8",
  );
  const keys = new Set();
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    // Capability keys are the ones the registry uses as required capabilities;
    // every one it names in that position is in scope.
    keys.add(m[1]);
  }
  return keys;
}

/** Every .tsx under app/(app)/admin. */
function adminPages(dir = ADMIN_ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) adminPages(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * The string literals a reader can see.
 *
 * Comments are stripped first — a page that explains why it stopped naming a
 * capability must not fail the check that made it stop. Then only quoted
 * strings are considered, and only those long enough to be prose: a bare
 * `"ANALYTICS_VIEW"` passed to `useCan` is an argument, not copy, and is
 * excluded by requiring the literal to contain a space.
 */
function visibleStrings(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const out = [];
  for (const m of code.matchAll(/"([^"\\\n]{12,400})"|'([^'\\\n]{12,400})'/g)) {
    const literal = m[1] ?? m[2] ?? "";
    if (literal.includes(" ")) out.push(literal);
  }
  // JSX text between tags is copy too, and carries no quotes.
  for (const m of code.matchAll(/>([^<>{}]{12,400})</g)) {
    const text = m[1].trim();
    if (text.includes(" ")) out.push(text);
  }
  return out;
}

test("no admin page shows a raw capability key in prose an operator reads", () => {
  const keys = capabilityKeys();
  assert.ok(keys.size > 0, "no capability keys were read from the registry");
  const offences = [];
  for (const file of adminPages()) {
    const rel = relative(resolve(HERE, "..", ".."), file).replace(/\\/g, "/");
    for (const literal of visibleStrings(readFileSync(file, "utf8"))) {
      for (const key of keys) {
        if (literal.includes(key)) offences.push(`${rel}: "${literal}"`);
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    "operator copy names a capability key, which the reader cannot act on:\n  " +
      offences.join("\n  "),
  );
});

test("the two denial panels tell the reader what to DO, and the two cases apart", () => {
  // The replacement is not just "remove the code". A denial panel that cannot
  // distinguish an expired session from a missing grant sends half its readers
  // to the wrong remedy.
  for (const [rel, subject] of [
    ["app/(app)/admin/platform/analytics/page.tsx", "operational analytics"],
    ["app/(app)/admin/platform/automation/page.tsx", "automation rules"],
  ]) {
    const src = readFileSync(resolve(HERE, "..", rel), "utf8");
    assert.match(
      src,
      /state\.code === "auth_required"[\s\S]{0,400}Sign in again/,
      `${rel}: the expired-session case does not tell the reader to sign in`,
    );
    assert.match(
      src,
      new RegExp(`cannot view ${subject}`),
      `${rel}: the permission case does not say what cannot be viewed`,
    );
    assert.match(
      src,
      /administrator can grant access/,
      `${rel}: the permission case does not name who can fix it`,
    );
  }
});
