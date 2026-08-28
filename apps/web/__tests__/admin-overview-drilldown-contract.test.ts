/**
 * PLATFORM ADMIN — "no terminal mystery numbers" (ADM-017 / ADM-029).
 *
 * WHY THIS TEST EXISTS
 * ---------------------------------------------------------------------------
 * Platform Admin is a control plane. Every aggregate on the Overview that
 * represents identifiable records must lead to those records — and a link that
 * lands on an UNFILTERED page 1 is not a drill-down. It is worse than a dead
 * link, because the operator sees a plausible list that shows a different
 * population than the number they clicked, with nothing on screen saying so.
 *
 * That failure is invisible to every other kind of test: the API returns a
 * correct number and a well-formed href, the page renders and 200s, and the two
 * halves are simply not wired to each other. It is only detectable by reading
 * BOTH sides at once, which is what this does.
 *
 * When it fails, the fix is to consume the parameter on the destination page —
 * never to delete the drill-down from the Overview.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const OVERVIEW = resolve(
  REPO,
  "services/api/src/services/admin/overview.service.ts",
);
const ADMIN_PAGES = resolve(HERE, "../app/(app)/admin");

/** Every `/admin/...` destination the Overview hands an operator. */
function overviewDestinations(): string[] {
  const src = readFileSync(OVERVIEW, "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/"(\/admin\/[^"]*)"/g)) {
    // Template holes (`?tier=${...}`) are real destinations too; the parameter
    // name is what matters here, not the interpolated value.
    found.add(m[1].replace(/\$\{[^}]*\}/g, "VALUE"));
  }
  return Array.from(found);
}

/** Concatenate every source file under an admin page directory. */
function pageSource(dir: string): string {
  let out = "";
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) {
        // A dynamic segment is a DIFFERENT surface, not this roster.
        if (!entry.startsWith("[")) walk(abs);
      } else if (/\.tsx?$/.test(entry)) {
        out += readFileSync(abs, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

test("every Overview destination is a real admin page", () => {
  for (const dest of overviewDestinations()) {
    const segment = dest.slice("/admin/".length).split("?")[0].split("/")[0];
    const dir = join(ADMIN_PAGES, segment);
    assert.ok(
      existsSync(join(dir, "page.tsx")),
      `Overview links to /admin/${segment}, which has no page.tsx`,
    );
  }
});

test("every Overview filter parameter is CONSUMED by its destination", () => {
  const failures: string[] = [];

  for (const dest of overviewDestinations()) {
    const [path, query] = dest.split("?");
    if (!query) continue;

    const segment = path.slice("/admin/".length).split("/")[0];
    const dir = join(ADMIN_PAGES, segment);
    if (!existsSync(dir)) continue;

    const src = pageSource(dir);
    for (const pair of query.split("&")) {
      const key = pair.split("=")[0];
      if (!key) continue;
      // The destination must READ the parameter, not merely mention the word.
      if (!src.includes(`params.get("${key}")`)) {
        failures.push(
          `${dest} → /admin/${segment} never reads params.get("${key}"), ` +
            `so the tile lands on an unfiltered page`,
        );
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    `Overview tiles that do not survive the click:\n  ${failures.join("\n  ")}`,
  );
});

test("no Overview figure is a terminal number", () => {
  const src = readFileSync(OVERVIEW, "utf8");
  assert.ok(
    !/figure\([^)]*,\s*null\s*\)/.test(src),
    "an Overview figure was given a null drillDown — every aggregate over " +
      "identifiable records must lead to those records",
  );
});
