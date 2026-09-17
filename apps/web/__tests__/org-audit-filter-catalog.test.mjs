/**
 * The organization audit filter offers only event types the API writes.
 *
 * Found while relabelling the page for PV-LANG-003: two of its eight filter
 * options were `ORG_INVITE_CREATED` and `ORG_INVITE_ACCEPTED`. Neither is in
 * the org audit catalog — invitations are recorded as `ORG_MEMBER_INVITED`
 * and `ORG_MEMBER_ACCEPTED` — so choosing either filter returned an empty
 * timeline for an organization that had invited people. An empty result an
 * operator reads as "nothing happened" is a wrong answer, not a missing one.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = readFileSync(
  resolve(WEB_ROOT, "app/(app)/organizations/[id]/admin/audit/page.tsx"),
  "utf8",
);
const CATALOG_SRC = readFileSync(
  resolve(WEB_ROOT, "../../services/api/src/services/organization/org-audit.service.ts"),
  "utf8",
);

/** The string members of `const NAME = [ … ]` in a source file. */
function arrayMembers(src, name) {
  const at = src.indexOf(`const ${name}`);
  assert.ok(at >= 0, `${name} not found`);
  const open = src.indexOf("[", at);
  const close = src.indexOf("]", open);
  return [...src.slice(open, close).matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

test("every audit filter option is an event type the API records", () => {
  const catalog = new Set(arrayMembers(CATALOG_SRC, "ORG_AUDIT_EVENT_TYPES"));
  const options = arrayMembers(PAGE, "KNOWN_EVENT_TYPES");
  assert.ok(catalog.size > 10 && options.length > 0);
  assert.deepEqual(
    options.filter((o) => !catalog.has(o)),
    [],
    "filter options the API never writes",
  );
});
