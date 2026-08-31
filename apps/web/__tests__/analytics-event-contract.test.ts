/**
 * The analytics event contract, asserted from the CLIENT side.
 *
 * `POST /v1/analytics/track` validates `eventType` with
 * `z.enum(ANALYTICS_EVENT_NAMES)`. This test reads that same shared constant
 * — it never restates the list — and proves the browser cannot name an event
 * the route would refuse.
 *
 * It exists because that is exactly what happened. `trackEvent` took a plain
 * `string`, so `trackEvent("page_view")` compiled while the API answered 422
 * for every page view a consenting visitor produced: analytics collected
 * nothing, and each navigation logged a console error. Nothing in between the
 * two ends was in a position to notice the disagreement.
 *
 * The parameter type is now the real guard — a wrong name is a compile error.
 * These assertions are the backstop for the ways a type can be escaped: a
 * cast, an `any`, or a call written in a file the type-checker does not cover.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { ANALYTICS_EVENT_NAMES } from "@proovra/shared";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tests__",
  "dist",
  "coverage",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(full));
      continue;
    }
    const ext = extname(entry.name);
    if (ext === ".ts" || ext === ".tsx") out.push(full);
  }
  return out;
}

/** Every `trackEvent("name"` literal in the web tree, with its file. */
function emittedEventNames(): Array<{ name: string; file: string }> {
  const found: Array<{ name: string; file: string }> = [];
  for (const file of sourceFiles(APP_ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/trackEvent\(\s*["']([^"']+)["']/g)) {
      found.push({ name: m[1]!, file: file.slice(APP_ROOT.length + 1) });
    }
  }
  return found;
}

test("every analytics event the web app emits is accepted by the shared allowlist", () => {
  const emitted = emittedEventNames();

  // A sweep that finds nothing would pass vacuously and hide a rename.
  assert.ok(
    emitted.length > 0,
    "no trackEvent(...) call sites were found — the scan is broken, not the app",
  );

  const allowed = new Set<string>(ANALYTICS_EVENT_NAMES);
  for (const { name, file } of emitted) {
    assert.ok(
      allowed.has(name),
      `${file} emits "${name}", which POST /v1/analytics/track would reject ` +
        `with 422. Allowed: ${[...allowed].join(", ")}`,
    );
  }
});

test("page_view is the canonical page-view event and is ingestible", () => {
  // The persistence layer, the admin dashboard filters, the overview service
  // and the sensitive-route rejection all key on this exact string. If it
  // ever stops being accepted at ingest, page-view analytics silently stops.
  assert.ok(
    (ANALYTICS_EVENT_NAMES as readonly string[]).includes("page_view"),
    "page_view must remain in the ingest allowlist",
  );
});

test("trackEvent is typed from the shared contract, not from string", () => {
  const source = readFileSync(resolve(APP_ROOT, "lib/analytics.ts"), "utf8");

  assert.match(
    source,
    /export async function trackEvent\(\s*\n?\s*eventType:\s*AnalyticsEventName\b/,
    "trackEvent must take AnalyticsEventName so a wrong name cannot compile",
  );
  assert.match(
    source,
    /import type \{[^}]*AnalyticsEventName[^}]*\} from "@proovra\/shared"/,
    "the event type must come from the shared package, not a local copy",
  );
});
