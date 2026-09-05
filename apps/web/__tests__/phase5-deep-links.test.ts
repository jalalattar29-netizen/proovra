/**
 * PHASE 5 §7 — EVERY LINK AN AUDIT SURFACE OFFERS GOES SOMEWHERE.
 *
 * The platform timeline builds a deep link for each entry so an operator can
 * follow a lead. One of them pointed at `/admin/organizations/:id`, which has
 * never been a page in this app — so every organization-audit row offered a
 * link that could only 404, on the feed people open during an incident.
 *
 * That is not a class of defect a reviewer catches by reading: the href is a
 * template literal in a service file and the page is a directory in another
 * package. So it is resolved here, against the real route tree, from the
 * hrefs the service can actually emit.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(APP_ROOT, "..", "..");
const TIMELINE_SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/admin/timeline.service.ts",
);

/**
 * Does this app route exist as a page?
 *
 * A dynamic segment matches a `[param]` directory, which is how Next expresses
 * one — so `/admin/customers/:id` is satisfied by
 * `app/(app)/admin/customers/[id]/page.tsx`.
 */
function routeExists(pathname: string): boolean {
  const segments = pathname.split("?")[0]!.split("/").filter(Boolean);
  let dir = resolve(APP_ROOT, "app", "(app)");
  for (const segment of segments) {
    const literal = resolve(dir, segment);
    if (existsSync(literal)) {
      dir = literal;
      continue;
    }
    // A dynamic segment: look for exactly one [param] directory here.
    const dynamic = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter(
          (e) => e.isDirectory() && e.name.startsWith("[") && e.name.endsWith("]"),
        )
      : [];
    if (dynamic.length === 0) return false;
    dir = resolve(dir, dynamic[0]!.name);
  }
  return existsSync(resolve(dir, "page.tsx")) || existsSync(resolve(dir, "page.ts"));
}

/** Every `href:` the timeline service emits, read from the source it emits from. */
function timelineHrefs(): string[] {
  const src = readFileSync(TIMELINE_SERVICE, "utf8");
  const out: string[] = [];
  // Both plain strings and template literals; the interpolation is replaced
  // by a placeholder id, which is what a dynamic segment has to accept.
  for (const m of src.matchAll(/href:\s*(?:`([^`]*)`|"([^"]*)")/g)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw || !raw.startsWith("/")) continue;
    out.push(raw.replace(/\$\{[^}]*\}/g, "PLACEHOLDER"));
  }
  return Array.from(new Set(out));
}

test("the timeline emits at least one deep link (the extractor still works)", () => {
  // A silent extraction failure would make every assertion below vacuous.
  assert.ok(
    timelineHrefs().length >= 4,
    `expected several timeline hrefs, found ${timelineHrefs().length}`,
  );
});

test("every timeline deep link resolves to a real page", () => {
  const broken = timelineHrefs().filter((href) => !routeExists(href));
  assert.deepEqual(
    broken,
    [],
    `these timeline links point at routes that do not exist:\n${broken.join("\n")}`,
  );
});

test("no timeline link is an inert search parameter standing in for a page", () => {
  /*
   * PHASE 5 §7 forbids `?search=` links. They look like navigation and land
   * an operator on a list that may or may not honour the parameter, which is
   * worse than no link: it looks like it worked.
   */
  const inert = timelineHrefs().filter((href) => /[?&]search=/.test(href));
  assert.deepEqual(inert, [], `inert search links: ${inert.join(", ")}`);
});

test("the customer detail route the timeline now uses is the one that exists", () => {
  // Stated explicitly so the fix is legible without re-deriving it.
  assert.ok(routeExists("/admin/customers/PLACEHOLDER"), "/admin/customers/:id is missing");
  assert.ok(
    !routeExists("/admin/organizations/PLACEHOLDER"),
    "/admin/organizations/:id now exists — if it was added deliberately, the " +
      "timeline may link to it and this assertion should be revisited",
  );
});
