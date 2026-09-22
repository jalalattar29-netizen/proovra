/**
 * F-01 — IS ANY ENTERPRISE ADMINISTRATION OFFERED TO AN ORDINARY USER?
 *
 * The route inventory could not answer this. `/organizations/[id]` is
 * membership-gated and correctly native (routeRegistry.ts:185 says so in
 * words) while the administration BELOW it is enterprise-gated — the two live
 * on the same surface, so classifying the surface tells you nothing about the
 * actions on it.
 *
 * `tools/native-action-inventory.mjs` classifies at the ACTION level by
 * joining two authorities that already exist: the capability map knows which
 * web file and which native file perform each write, and the product manifest
 * knows which web routes the registry reserves. No new opinion is formed.
 *
 * These tests assert the answer AND that the instrument could have given a
 * different one — the first draft looked up a manifest that was not there, so
 * every web route read "unclassified", the ENTERPRISE_ONLY verdict could never
 * fire, and it reported a clean result over nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inventory } from "../tools/native-action-inventory.mjs";

const { rows, counts } = await inventory();

test("no native write action is reserved to an Enterprise console", () => {
  // THE F-01 QUESTION. A row here is an action the product offers on a phone
  // that the web offers only behind a console an ordinary user never reaches.
  const offending = rows.filter((r) => r.verdict === "ENTERPRISE_ONLY");
  assert.deepEqual(
    offending.map((r) => `${r.routeId} <- ${r.nativeSites.join(", ")}`),
    [],
  );
});

test("every web owner is classified — an unknown one is not a pass", () => {
  const unknown = rows.filter((r) => r.verdict === "UNKNOWN_WEB_OWNER");
  assert.deepEqual(
    unknown.map((r) => `${r.routeId}: ${r.webOwners.map((o) => o.file).join(", ")}`),
    [],
  );
});

test("the instrument is looking at the whole app", () => {
  // A tool that quietly stopped finding call sites would report a clean
  // matrix over nothing, which is exactly how the first draft passed.
  assert.ok(
    rows.length >= 120,
    `only ${rows.length} native write actions found; the join has probably broken`,
  );
  assert.equal(counts.MATCHES_WEB + (counts.NATIVE_ONLY ?? 0), rows.length);
});

test("the classification really comes from the manifest, not a default", () => {
  // If the manifest lookup silently missed, every row would fall through to
  // one verdict. Both must be represented, and the reserved set must be
  // reachable at all.
  assert.ok(counts.MATCHES_WEB > 0, "nothing matched a web page");
  assert.ok((counts.NATIVE_ONLY ?? 0) > 0, "nothing was native-only");
  const withOwners = rows.filter((r) => r.webOwners.length > 0);
  assert.ok(
    withOwners.some((r) => r.webOwners.some((o) => o.classification === "NATIVE_REQUIRED")),
    "no web owner was classified NATIVE_REQUIRED — the manifest join is not working",
  );
});

test("the native-only actions are the capture spine and the portal grant", () => {
  // Named rather than tolerated. Everything here is native BY DESIGN: the
  // UC-0 direct-capture session (the web reaches the same routes through the
  // browser extension, which is a separate consumer class) and the portal
  // grant acceptance, which a reviewer opens from a link on a phone.
  const nativeOnly = rows.filter((r) => r.verdict === "NATIVE_ONLY").map((r) => r.routeId);
  for (const id of nativeOnly) {
    assert.ok(
      id.includes("/v1/capture/direct-sessions") || id.includes("/v1/external-review/access/"),
      `${id} is native-only and is not part of the capture spine or the portal grant — it needs a reason`,
    );
  }
});
