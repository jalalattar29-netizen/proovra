/**
 * PV-NAV-001 — the breadcrumb never repeats the crumb before it.
 *
 * /governance/retention rendered "Governance › Governance › Retention
 * policies": the component renders the operational group, and the page also
 * passed its group as its first crumb. /governance/destruction still did.
 * The trail is now decided by one pure function the component renders from.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { breadcrumbTrail } from "../lib/navigation/breadcrumbTrail";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a first crumb that repeats the group title is dropped", () => {
  const trail = breadcrumbTrail("Governance", [
    { label: "Governance", href: "/governance" },
    { label: "Destruction reviews" },
  ]);
  assert.deepEqual(trail.map((t) => t.label), ["Destruction reviews"]);
});

test("adjacent repeats are dropped, case and spacing aside; distinct crumbs stay", () => {
  const trail = breadcrumbTrail("Workspace", [
    { label: "Matters", href: "/cases" },
    { label: " matters " },
    { label: "Matter 12" },
  ]);
  assert.deepEqual(trail.map((t) => t.label), ["Matters", "Matter 12"]);
  assert.deepEqual(
    breadcrumbTrail(null, [{ label: "A" }, { label: "B" }]).map((t) => t.label),
    ["A", "B"],
  );
});

test("OperationalBreadcrumb renders the trail, not the raw items", () => {
  const src = readFileSync(resolve(WEB, "components/navigation/OperationalBreadcrumb.tsx"), "utf8");
  assert.match(src, /breadcrumbTrail\(groupDescriptor\?\.title \?\? null, items\)/);
  assert.doesNotMatch(src, /\{items\.map\(/);
});
