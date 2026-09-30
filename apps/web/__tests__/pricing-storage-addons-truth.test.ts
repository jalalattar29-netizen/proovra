/**
 * ET-SEC-23 — the Pricing page's storage add-on row says what the server
 * allows.
 *
 * On a40ca76f the FREE cell was a hard-coded "Not available" while the shared
 * commercial policy (resolveStorageAddonEntitlement) and the API let a FREE
 * account buy storage add-ons.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveStorageAddonEntitlement } from "@proovra/shared-billing";

const page = readFileSync(new URL("../app/pricing/page.tsx", import.meta.url), "utf8");

test("ET-SEC-23: the policy lets FREE, PRO and TEAM buy storage and not ENTERPRISE", () => {
  for (const plan of ["FREE", "PRO", "TEAM"] as const) {
    assert.equal(resolveStorageAddonEntitlement({ plan }).storageAddonsPurchasable, true, plan);
  }
  assert.equal(resolveStorageAddonEntitlement({ plan: "ENTERPRISE" }).storageAddonsPurchasable, false);
});

test("ET-SEC-23: every self-service cell of the row is derived from that policy", () => {
  const at = page.indexOf('label: "Storage add-ons"');
  assert.ok(at > 0);
  const row = page.slice(at, page.indexOf("],", at));
  assert.doesNotMatch(row, /"Not available"/);
  for (const plan of ["FREE", "PRO", "TEAM"]) {
    assert.match(row, new RegExp(`storageAddonCell\\("${plan}",`), plan);
  }
  assert.match(page, /resolveStorageAddonEntitlement\(\{ plan \}\)\.storageAddonsPurchasable \? offer : "Not available"/);
});
