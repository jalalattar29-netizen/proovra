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
import { readFileSync } from "node:fs";
import { inventory } from "../tools/native-action-inventory.mjs";

const { rows, counts, byKind } = await inventory();

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

// ---------------------------------------------------------------------------
// READS, NAVIGATION, AND THE PROOF THAT THIS CHECK CAN FAIL
// ---------------------------------------------------------------------------

test("reads are classified, not only writes", () => {
  // The first version looked at writes only, on the reasoning that a write is
  // what does damage. That is the wrong question: showing an ordinary user an
  // Enterprise console's DATA is the same F-01 failure as letting them change
  // it, and a governance campaign's findings are a GET.
  assert.ok(byKind.READ > 0, "no reads were classified — F-01 is writes-only again");
  assert.ok(byKind.WRITE > 0);
  assert.equal(byKind.READ + byKind.WRITE, rows.length);
});

test("the native-only actions are named, and each has a reason", () => {
  // Named rather than tolerated. Each of these is native BY DESIGN and the
  // reason is recorded where the decision was made.
  const REASONED = [
    // The UC-0 capture spine. The web reaches these through the browser
    // extension, which the capability map counts as a separate consumer class.
    "/v1/capture/direct-sessions",
    // The portal grant a reviewer opens from a link on a phone.
    "/v1/external-review/access/",
    // BD-3: dispositioned SUPERSEDED_REMOVE on the claim that no UI was owed,
    // and the tree contradicted it — the native Cases tab reads it for four
    // counters the replacement does not carry. Now PRODUCT_CONNECTED.
    "/v1/cases/summary",
    // The canonical server-served legal corpus. Native reads legal text from
    // the API rather than carrying a second copy or opening a browser.
    "/v1/legal",
    // The plain case ZIP. The web's Cases surface exports through the SIU
    // family (`/v1/cases/:id/siu-export`) instead; this one is ordinary
    // member-authorized access to the same case, not a reserved surface.
    "/v1/cases/:id/export",
  ];
  for (const r of rows.filter((x) => x.verdict === "NATIVE_ONLY")) {
    assert.ok(
      REASONED.some((prefix) => r.routeId.includes(prefix)),
      `${r.routeId} is native-only and has no recorded reason (${r.nativeSites[0]})`,
    );
  }
});

test("NEGATIVE — an Enterprise action offered natively is REFUSED", async () => {
  // THE CHECK'S OWN FAILURE PATH. A guard whose failure branch has never
  // executed is a claim, not a guard — and this one proved the point when
  // extending it to reads fired the ENTERPRISE_ONLY branch for the first time
  // and crashed the reporter on a field that had never existed.
  const { inventory } = await import("../tools/native-action-inventory.mjs");
  const map = JSON.parse(
    readFileSync(new URL("../../../docs/architecture/current-runtime-capability-map.json", import.meta.url), "utf8"),
  );
  // A real reserved console page, read from the manifest rather than invented.
  const reservedPage = "apps/web/app/(app)/admin/platform/queues/page.tsx";
  map.routes = [
    ...map.routes,
    {
      routeId: "POST /v1/__negative__/platform-queue-drain",
      productConsumers: [
        { class: "WEB", file: reservedPage, line: 1 },
        { class: "MOBILE", file: "apps/mobile/app/(stack)/__negative__.tsx", line: 1 },
      ],
    },
  ];
  const { rows: withOffence } = await inventory({ map });
  const offending = withOffence.find((r) => r.routeId.includes("__negative__"));
  assert.equal(offending.verdict, "ENTERPRISE_ONLY");
});

test("NEGATIVE — a web owner nobody can classify is not a pass", async () => {
  const { inventory } = await import("../tools/native-action-inventory.mjs");
  const map = JSON.parse(
    readFileSync(new URL("../../../docs/architecture/current-runtime-capability-map.json", import.meta.url), "utf8"),
  );
  map.routes = [
    ...map.routes,
    {
      routeId: "POST /v1/__negative__/unknown-owner",
      productConsumers: [
        // A page the manifest has never heard of: the first draft of this tool
        // looked up a manifest that was not there, every route read
        // "unclassified", and it reported a clean result over nothing.
        { class: "WEB", file: "apps/web/app/(app)/__not_a_real_surface__/page.tsx", line: 1 },
        { class: "MOBILE", file: "apps/mobile/app/(stack)/__negative__.tsx", line: 1 },
      ],
    },
  ];
  const { rows: withUnknown } = await inventory({ map });
  const row = withUnknown.find((r) => r.routeId.includes("__negative__"));
  assert.equal(row.verdict, "UNKNOWN_WEB_OWNER");
});

test("NEGATIVE — a web file no surface renders is not a pass either", async () => {
  const { inventory } = await import("../tools/native-action-inventory.mjs");
  const map = JSON.parse(
    readFileSync(new URL("../../../docs/architecture/current-runtime-capability-map.json", import.meta.url), "utf8"),
  );
  map.routes = [
    ...map.routes,
    {
      routeId: "POST /v1/__negative__/orphan-consumer",
      productConsumers: [
        { class: "WEB", file: "apps/web/lib/__not_imported_by_anything__.ts", line: 1 },
        { class: "MOBILE", file: "apps/mobile/app/(stack)/__negative__.tsx", line: 1 },
      ],
    },
  ];
  const { rows: withOrphan } = await inventory({ map });
  const row = withOrphan.find((r) => r.routeId.includes("__negative__"));
  assert.equal(row.verdict, "UNOWNED_WEB_FILE");
});

test("no native control links into a web surface the product reserves", async () => {
  // A button that opens an Enterprise console in the browser makes no API
  // call, so the route join above can never see it — and it is the same F-01
  // failure: an ordinary user offered a surface they will then be refused.
  const { navigationOffers } = await import("../tools/native-action-inventory.mjs");
  const { findings, reservedPaths } = await navigationOffers();
  assert.ok(reservedPaths.length > 50, "the reserved surface list collapsed");
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} -> ${f.literal} [${f.webSurface}]`),
    [],
  );
});

test("NEGATIVE — a link into a reserved console IS caught", async () => {
  const { navigationOffers } = await import("../tools/native-action-inventory.mjs");
  const { findings } = await navigationOffers({
    sources: [
      {
        file: "apps/mobile/app/(stack)/__negative__.tsx",
        text: 'export const X = () => router.push("/admin/platform/queues");',
      },
    ],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].literal, "/admin/platform/queues");
  assert.equal(findings[0].classification, "ADMIN_ONLY");
});

test("NEGATIVE — an open surface below a reserved one is NOT caught", async () => {
  // `/organizations/[id]/admin/...` is reserved and `/organizations` is not.
  // Taking the static prefix of the reserved path reclassified the open
  // surface as Enterprise administration and flagged the Spaces screen's
  // perfectly ordinary link to it.
  const { navigationOffers } = await import("../tools/native-action-inventory.mjs");
  const { findings } = await navigationOffers({
    sources: [
      {
        file: "apps/mobile/app/(stack)/__negative__.tsx",
        text: 'router.push("/organizations"); router.push("/settings");',
      },
    ],
  });
  assert.deepEqual(findings, []);
});
