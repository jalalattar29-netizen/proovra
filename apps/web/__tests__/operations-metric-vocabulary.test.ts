/**
 * THE OPERATIONS QUEUE SAYS WHICH NUMBER IT IS SHOWING.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ON SCREEN
 * ---------------------------------------------------------------------------
 * A grouped row could read, all at once:
 *
 *     Queue telemetry sampler delayed (902m)
 *     34 conditions - 34 affected records
 *     26 occurrences
 *
 * Three separate problems in three lines. An elapsed time formatted as part of
 * a name. One fact printed twice under two labels. And a number whose label
 * named nothing — an occurrence of what, counted how — sitting beside two other
 * numbers of similar size that meant entirely different things.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE SOURCE PINS
 * ---------------------------------------------------------------------------
 * The rendered behaviour is held by the render suite, which mounts the page.
 * These cases hold the two things a mounted test cannot: that the duration
 * helper is a real shared function with the arithmetic right, and that the
 * defect wording is GONE from the modules rather than merely absent from one
 * fixture's output.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeDuration } from "../lib/relative-time";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const read = (p: string) => readFileSync(resolve(APP_ROOT, p), "utf8");

/**
 * The same file with its commentary removed.
 *
 * Every "this module must not contain X" check below has to read CODE. The
 * comments beside each replacement quote the wording they replaced — that is
 * what makes them useful — so a check reading the raw text would fail on the
 * sentence explaining the property it is asserting.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const OPERATIONS = "app/(app)/operations";

describe("describeDuration — an elapsed span, in words", () => {
  it("renders 902 minutes as 15h 2m, which is the point", () => {
    // The literal number that reached production inside a condition title.
    // Nobody reads fifteen hours out of nine hundred and two on the way past.
    assert.equal(describeDuration(902 * 60), "15h 2m");
  });

  it("drops the smaller unit when it is zero", () => {
    assert.equal(describeDuration(2 * 3600), "2h");
    assert.equal(describeDuration(48 * 3600), "2d");
  });

  it("never shows three units", () => {
    // A stopwatch, not an operations queue — and the precision would be false
    // anyway, because the underlying sample is a whole number of minutes.
    const span = describeDuration(2 * 86400 + 3 * 3600 + 47 * 60);
    assert.equal(span, "2d 3h");
    assert.equal(span.split(" ").length, 2);
  });

  it("says 'under a minute' rather than printing 0m", () => {
    assert.equal(describeDuration(0), "under a minute");
    assert.equal(describeDuration(59), "under a minute");
    assert.equal(describeDuration(60), "1m");
  });

  it("an absent or impossible span renders as an absence, never as zero", () => {
    // Zero would say "this just happened", which is the opposite of "we do
    // not know when".
    assert.equal(describeDuration(null), "—");
    assert.equal(describeDuration(undefined), "—");
    assert.equal(describeDuration(Number.NaN), "—");
    assert.equal(describeDuration(-1), "—");
  });
});

describe("the defect wording is gone from the modules", () => {
  it("no operations component renders the bare word 'occurrences'", () => {
    for (const file of [
      `${OPERATIONS}/_components/IncidentSurface.tsx`,
      `${OPERATIONS}/_components/IncidentInspector.tsx`,
      `${OPERATIONS}/_components/GroupSurface.tsx`,
      `${OPERATIONS}/_components/GroupInspector.tsx`,
    ]) {
      const src = code(file);
      assert.ok(
        !/\{[^}]*\}\s*occurrences/.test(src) && !/"\s*occurrences/.test(src),
        `${file} still renders "occurrences"`,
      );
    }
  });

  it("the queue row and the Inspector use ONE phrase for that number", () => {
    // Two names for one number, on two halves of one screen, was the whole
    // problem: "26 occurrences" in the row and "Times seen: 26" in the panel.
    for (const file of [
      `${OPERATIONS}/_components/IncidentSurface.tsx`,
      `${OPERATIONS}/_components/IncidentInspector.tsx`,
      `${OPERATIONS}/_components/GroupInspector.tsx`,
    ]) {
      assert.ok(
        read(file).includes("Observed in "),
        `${file} does not use the shared observation phrase`,
      );
    }
    // CODE only: the comment beside the replacement quotes the old label in
    // order to explain what it replaced, and a check that read the raw file
    // would fail on the sentence documenting the very property it asserts.
    assert.ok(
      !code(`${OPERATIONS}/_components/IncidentInspector.tsx`).includes(
        "Times seen",
      ),
      "the Inspector still says 'Times seen'",
    );
  });

  it("the grouped row never hard-codes the affected unit", () => {
    const src = code(`${OPERATIONS}/_components/GroupSurface.tsx`);
    // The unit belongs to the SOURCE. Hard-coding "records" is what described
    // thirty-six recurring conditions as thirty-six affected records, and an
    // age of nine hundred and two minutes as nine hundred and two records.
    assert.ok(
      src.includes("describeAffected("),
      "the grouped row does not route its affected count through the unit-aware helper",
    );
    assert.ok(
      !/affected\{" "\}/.test(src),
      "the grouped row still interpolates a bare 'affected' label",
    );
  });

  it("the grouped status uses the shared text primitive, not a capsule", () => {
    const src = read(`${OPERATIONS}/_components/GroupSurface.tsx`);
    // Both are imported: severity keeps its filled capsule, status loses it.
    assert.ok(src.includes("AppStatusText"), "AppStatusText is not imported");
    assert.ok(
      /<AppStatusText[\s\S]{0,200}data-ops-group-status/.test(src),
      "the group status is not rendered as text",
    );
    assert.ok(
      !/<AppStatusBadge[\s\S]{0,200}data-ops-group-status/.test(src),
      "the group status is still a capsule",
    );
  });

  it("the shared text primitive really declares no box", () => {
    // The property the brief asks for lives in ONE rule, in the design system,
    // and is asserted where it is defined rather than re-declared per surface.
    const css = read("components/app-primitives/app-primitives.css");
    const rule = css.slice(
      css.indexOf(".app-status-text {"),
      css.indexOf("}", css.indexOf(".app-status-text {")),
    );
    assert.ok(rule.includes("background: none"), "no background declaration");
    assert.ok(rule.includes("border: 0"), "no border declaration");
    assert.ok(rule.includes("box-shadow: none"), "no box-shadow declaration");
    assert.ok(rule.includes("border-radius: 0"), "no border-radius reset");
    // The colour still arrives, so removing the box does not remove meaning.
    assert.ok(rule.includes("--app-status-tone"), "the tone token is gone");
  });

  it("the grouped stylesheet adds no status box of its own", () => {
    const css = read(`${OPERATIONS}/operations.css`);
    const start = css.indexOf(".opsw-group__meta .app-status-text");
    assert.ok(start > 0, "the grouped status rule is missing");
    const rule = css.slice(start, css.indexOf("}", start));
    for (const banned of ["background", "border", "box-shadow"]) {
      assert.ok(
        !rule.includes(banned),
        `the grouped status rule re-declares ${banned}`,
      );
    }
  });
});
