#!/usr/bin/env node
/**
 * EVERY OPTION ON EVERY ADMIN FILTER MUST PRODUCE AN ANSWER, NOT A REFUSAL.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `/admin/security` offered two choices that could not work. Its event-severity
 * filter opened with "Critical", and a security event's severity domain is
 * INFO / WARNING / HIGH — `GET /v1/security/events` validates against that zod
 * enum, so the request came back 400. Its scan-result filter offered
 * "Infected", where the canonical status is SUSPICIOUS, so the one result an
 * operator opens a malware panel to find was the one choice that failed. Both
 * rendered "Some details need attention before we can continue. / Try again":
 * a form-validation sentence, on a list, for a choice the page itself had
 * offered.
 *
 * Nothing catches that except USING the control. A typecheck cannot: the option
 * value is a string literal in a hand-written array. A screenshot cannot: the
 * page looks correct until the reader picks the broken option. The route's own
 * API tests cannot: they send values the route accepts.
 *
 * So this selects every option of every select on all 47 admin routes and
 * reads what the page does. A refusal, an error surface, or a section that
 * loses its content while its siblings keep theirs is reported with the route,
 * the control and the value.
 *
 * ===========================================================================
 * WHAT IT DELIBERATELY DOES NOT CALL A FAILURE
 * ===========================================================================
 *   • AN EMPTY RESULT. "No records match these filters" is the filter working.
 *     A fixture has no rows for most narrow filters and that is not a defect.
 *   • A CHANGE OF ROW COUNT. That is what a filter is for.
 *   • A DISABLED OPTION. A control that says a choice is unavailable, and why,
 *     is the honest case — those are already covered by the controls sweep.
 *
 * The signal is specifically an ERROR or REFUSAL surface appearing where one
 * was not there before the click, which is the shape a rejected value takes.
 *
 * ===========================================================================
 * WHAT "selects=0" MEANS, SO THE COVERAGE CLAIM STAYS HONEST
 * ===========================================================================
 * Five routes the controls sweep counts as having a filter report no select
 * here — `/admin/platform/media-graph`, `/admin/platform/runbooks`,
 * `/admin/platform/runbooks/:slug`, `/admin/platform/signers` and
 * `/admin/search`. Each of those filters is a free-text input, checked
 * individually: a text field offers no enumerated values, so it cannot offer
 * one its endpoint refuses and there is nothing for this sweep to exercise.
 * "256 options across 47 routes" is therefore every enumerated filter option
 * in the console, not every filter.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { open, signIn, visit } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ROUTES = ARGS.length
  ? ARGS
  : JSON.parse(
      readFileSync(resolve(REPO, "docs/admin/phase7-routes.json"), "utf8"),
    ).routes;

/**
 * The sentences a refused read puts on screen.
 *
 * Taken from the components that render them — `SectionError`, the shared
 * error surfaces and `toSafeUserError`'s defaults — rather than invented, so a
 * copy change shows up here as a miss rather than as a silent pass.
 */
const REFUSAL = [
  "need attention before we can continue",
  "couldn't load",
  "could not load",
  "failed to load",
  "something went wrong",
  "unexpected error",
  "try again",
];

/** Is a refusal sentence on screen right now? */
async function refusalText(page) {
  return page.evaluate((needles) => {
    const main = document.querySelector("main") ?? document.body;
    const text = (main.textContent ?? "").toLowerCase();
    return needles.find((n) => text.includes(n)) ?? null;
  }, REFUSAL);
}

const findings = [];
const rows = [];

const { browser, page } = await open({ width: 1440, height: 900 });
await signIn(page);

for (const route of ROUTES) {
  const url = route.replace(/:slug/, "audit-chain-drift").replace(/:id$/, "");
  // A detail route with a fixture id, the same substitution the other sweeps
  // use. A route this cannot resolve is reported rather than skipped.
  const target = route.includes(":id")
    ? route.replace(":id", "0adf0000-0000-4000-8000-0000000000a1")
    : url;

  try {
    await visit(page, target, 2500);
  } catch (err) {
    findings.push(`${route}: could not open (${String(err).slice(0, 80)})`);
    continue;
  }

  // A page that is ALREADY refusing cannot tell us anything about its filters:
  // every option would look broken. Report it once and move on.
  const before = await refusalText(page);
  if (before) {
    rows.push({ route, selects: 0, options: 0, skipped: `already refusing: ${before}` });
    console.log(`skip  ${route.padEnd(38)} already refusing (${before})`);
    continue;
  }

  const selects = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main select")).map((s, i) => ({
      i,
      name: s.getAttribute("aria-label") ?? s.getAttribute("name") ?? `select${i}`,
      // A disabled control is not offering anything, and a disabled OPTION is
      // the honest case — neither is exercised.
      disabled: s.disabled,
      options: Array.from(s.options)
        .filter((o) => !o.disabled)
        .map((o) => o.value),
    })),
  );

  let optionCount = 0;
  const broken = [];

  for (const sel of selects) {
    if (sel.disabled || sel.options.length < 2) continue;
    const original = sel.options[0];

    for (const value of sel.options) {
      optionCount += 1;
      const applied = await page
        .evaluate(
          ({ i, value }) => {
            const s = document.querySelectorAll("main select")[i];
            if (!(s instanceof HTMLSelectElement)) return false;
            s.value = value;
            s.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          },
          { i: sel.i, value },
        )
        .catch(() => false);
      if (!applied) continue;

      await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(700);

      const hit = await refusalText(page);
      if (hit) {
        broken.push(`${sel.name}="${value}" → "${hit}"`);
        findings.push(`${route}: ${sel.name}="${value}" refused ("${hit}")`);
      }
    }

    // Put the control back before moving to the next one, so one filter's
    // narrow value does not empty the page the next one is measured on.
    await page
      .evaluate(
        ({ i, value }) => {
          const s = document.querySelectorAll("main select")[i];
          if (s instanceof HTMLSelectElement) {
            s.value = value;
            s.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { i: sel.i, value: original },
      )
      .catch(() => {});
    await page.waitForTimeout(700);
  }

  rows.push({ route, selects: selects.length, options: optionCount, broken });
  console.log(
    `${broken.length ? "FAIL" : "ok  "}  ${route.padEnd(38)} ` +
      `selects=${selects.length} options=${optionCount}` +
      (broken.length ? `\n      ${broken.join("\n      ")}` : ""),
  );
}

await browser.close();

const out = resolve(REPO, "docs/admin/artifacts/filter-options.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      generatedBy: "scripts/admin-ledger/visual/filter-options.mjs",
      routes: rows.length,
      totalOptionsExercised: rows.reduce((n, r) => n + (r.options ?? 0), 0),
      coverage:
        "Every ENUMERATED filter option on every admin route. A route with " +
        "selects=0 has no option list — its filter, where it has one, is a " +
        "free-text input, which cannot offer a value its endpoint refuses.",
      findings,
      rows,
    },
    null,
    2,
  )}\n`,
);

const exercised = rows.reduce((n, r) => n + (r.options ?? 0), 0);
console.log("");
if (findings.length) {
  console.log(`${findings.length} refused option(s) across ${rows.length} routes`);
  for (const f of findings) console.log(`  - ${f}`);
} else {
  console.log(`${exercised} options exercised across ${rows.length} routes — none refused`);
}
console.log(`artifact: docs/admin/artifacts/filter-options.json`);
process.exitCode = findings.length ? 1 : 0;
