/**
 * UC-OUT-002 — Case quick actions must not carry output-action verbs
 * ("Generate report", "Create verification package") on controls that only
 * switch to the Reports & Packages tab. No case-level output exists, so the
 * truthful label is navigation copy; a control whose onClick is a tab switch
 * must read as navigation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
  ),
  "utf8",
);

/** Every <button …>…</button> element in the file. */
function buttons(src: string): string[] {
  return [...src.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
}

test("no tab-switch button is labelled as an output action", () => {
  const offenders = buttons(SRC).filter(
    (b) =>
      /onClick=\{\(\) => onGoToTab\("reports"\)\}/.test(b) &&
      /(Generate report|Create verification package)/.test(b),
  );
  assert.deepEqual(
    offenders.map((b) => b.replace(/\s+/g, " ").slice(-80)),
    [],
    "a button that only opens the Reports tab must not claim to generate/create output",
  );
});

test("the quick-action rail offers the Reports tab as navigation", () => {
  const nav = buttons(SRC).filter((b) => /onClick=\{\(\) => onGoToTab\("reports"\)\}/.test(b));
  assert.equal(nav.length, 1, "one navigation control to Reports & packages, not two");
  assert.match(nav[0], /View reports &amp; packages|View reports & packages/);
});
