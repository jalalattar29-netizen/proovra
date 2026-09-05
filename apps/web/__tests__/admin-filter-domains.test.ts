/**
 * A FILTER MAY NOT OFFER A VALUE ITS ENDPOINT REFUSES.
 *
 * ===========================================================================
 * WHAT THIS CAUGHT
 * ===========================================================================
 * `/admin/security` offered two choices that could not work:
 *
 *   • Event severity → "Critical". `SECURITY_EVENT_SEVERITIES` is INFO,
 *     WARNING, HIGH, and `GET /v1/security/events` validates `severity`
 *     against that zod enum.
 *   • Scan result → "Infected". `FILE_SECURITY_SCAN_STATUSES` says
 *     SUSPICIOUS, and `GET /v1/security/scans` validates against it.
 *
 * Both returned 400, and the section rendered "Some details need attention
 * before we can continue. / Try again" — a form-validation sentence, on a
 * list, for a choice the page itself had put in front of the reader. The
 * second one was the result an operator opens a malware panel to find, and the
 * posture strip directly above the control was already labelling the same
 * number "SCANS SUSPICIOUS", so the page contradicted itself on screen.
 *
 * ===========================================================================
 * WHY A SOURCE TEST
 * ===========================================================================
 * A browser sweep can find this only by selecting every option on every
 * filter and watching for a refusal — which is what found it, and which needs
 * a running fixture and a seeded workspace. The defect itself is a hand-copied
 * list drifting from a shared constant, so it is visible in the source, in
 * milliseconds, with no server. What this asserts is not the values but the
 * DERIVATION: an option list built from the canonical constant cannot drift
 * from it, and a hand-written one always can.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "../..");

const POSTURE = resolve(
  WEB,
  "app/(app)/admin/security/_sections/WorkspaceSecurityPostureSection.tsx",
);
const SHARED_SECURITY = resolve(REPO, "packages/shared/src/security.ts");

/** The values in a `["A", "B"] as const` catalog. */
function catalog(source: string, name: string): string[] {
  const re = new RegExp(
    `export const ${name} = \\[([\\s\\S]*?)\\] as const`,
    "m",
  );
  const m = re.exec(source);
  assert.ok(m, `${name} not found in packages/shared/src/security.ts`);
  return Array.from(m[1].matchAll(/"([A-Z_]+)"/g)).map((x) => x[1]);
}

const shared = readFileSync(SHARED_SECURITY, "utf8");
const posture = readFileSync(POSTURE, "utf8");

const SEVERITIES = catalog(shared, "SECURITY_EVENT_SEVERITIES");
const SCAN_STATUSES = catalog(shared, "FILE_SECURITY_SCAN_STATUSES");

test("the canonical catalogs are the ones this test thinks they are", () => {
  // If a catalog is renamed or emptied, the assertions below would silently
  // pass against nothing. This is the tripwire for that.
  assert.deepEqual(SEVERITIES, ["INFO", "WARNING", "HIGH"]);
  assert.deepEqual(SCAN_STATUSES, [
    "PENDING",
    "CLEAN",
    "SUSPICIOUS",
    "FAILED",
    "SKIPPED",
  ]);
});

test("the security filters import their domains rather than restating them", () => {
  assert.match(
    posture,
    /import\s*\{[\s\S]*?FILE_SECURITY_SCAN_STATUSES[\s\S]*?\}\s*from\s*"@proovra\/shared"/,
    "the scan-result filter must be built from FILE_SECURITY_SCAN_STATUSES",
  );
  assert.match(
    posture,
    /import\s*\{[\s\S]*?SECURITY_EVENT_SEVERITIES[\s\S]*?\}\s*from\s*"@proovra\/shared"/,
    "the severity filter must be built from SECURITY_EVENT_SEVERITIES",
  );
  assert.match(
    posture,
    /const SEVERITY_OPTIONS = \[[\s\S]*?SECURITY_EVENT_SEVERITIES/,
    "SEVERITY_OPTIONS must spread the canonical catalog",
  );
  assert.match(
    posture,
    /const SCAN_STATUS_OPTIONS = \[[\s\S]*?FILE_SECURITY_SCAN_STATUSES/,
    "SCAN_STATUS_OPTIONS must spread the canonical catalog",
  );
});

test("no filter option is a literal outside its catalog", () => {
  // Every `{ value: "…" }` in this file, other than the "all" sentinel, has to
  // be a value one of the two endpoints accepts. This is the assertion that
  // fails if somebody re-adds "Critical" or "Infected" by hand.
  const allowed = new Set(["all", ...SEVERITIES, ...SCAN_STATUSES]);
  const offered = Array.from(
    posture.matchAll(/\{\s*value:\s*"([^"]+)"/g),
    (m) => m[1],
  );
  const strays = offered.filter((v) => !allowed.has(v));
  assert.deepEqual(
    strays,
    [],
    `these filter options are not accepted by the endpoint they filter: ${strays.join(", ")}`,
  );
});

test("the one result an operator acts on is toned as risk", () => {
  // SUSPICIOUS fell through `scanTone` to `neutral` — grey, in a table where
  // CLEAN is green and FAILED is red, for the only outcome that means "look at
  // this file".
  const tone = /function scanTone\([\s\S]*?\n\}/.exec(posture);
  assert.ok(tone, "scanTone not found");
  assert.match(
    tone[0],
    /"SUSPICIOUS"[\s\S]*?return "risk"/,
    "a SUSPICIOUS scan must tone as risk",
  );
});
