/**
 * Independent forward audit closure — Wave D source pins on the web app.
 *
 * F-16: the Reports page fallback maps the canonical output state through THE
 *       shared row mapping; its own copy read a BLOCKED package as
 *       "not requested". (Behaviour: packages/shared afc-presentation-authorities
 *       and services/api afc-reports-row-lifecycle.)
 * F-27: the admin TSA tile names what it counts — validation failures.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(WEB, p), "utf8");

test("F-16: the Reports page reads THE shared row mapping and keeps no copy of it", () => {
  const src = read("components/reports-experience/ReportsIndex.tsx");
  assert.match(src, /import \{ outputRowLifecycle, type EvidenceOutputState \} from "@proovra\/shared"/);
  assert.match(src, /const toPackageLifecycle = \(state: EvidenceOutputState\): PackageLifecycle => outputRowLifecycle\(state\)/);
  assert.doesNotMatch(src, /case "BLOCKED":\s*return "not_requested"/);
  assert.doesNotMatch(src, /function toPackageLifecycle\(/);
});

test("F-27: the admin TSA tiles say validation failures", () => {
  for (const page of ["app/(app)/admin/page.tsx", "app/(app)/admin/evidence-ops/page.tsx"]) {
    const src = read(page);
    assert.match(src, /label="TSA validation failures"/, page);
    assert.doesNotMatch(src, /label="TSA failures"/, page);
  }
});
