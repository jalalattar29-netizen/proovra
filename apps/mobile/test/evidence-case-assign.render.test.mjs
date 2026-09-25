/**
 * T-12 / RC-13 — assign evidence to a case from the record ("Select case",
 * evidence/[id]/page.tsx:1447).
 *
 * Native never read which case a record belongs to, and a record could only
 * join a case from the CASE screen or a bulk action. The picker lists the
 * server's ELIGIBILITY-narrowed cases (`?eligibleForEvidenceId=`), not every
 * case, so it cannot offer one the server will refuse.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let Screen;
let requests = [];
let relationships = { caseId: null, caseName: null };

before(async () => {
  Screen = await loadWithProviders("app/(stack)/evidence/[id].tsx");
});
beforeEach(() => {
  requests = [];
  relationships = { caseId: null, caseName: null };
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  const routes = {
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { ...relationships, items: [] } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
    "/v1/cases?eligibleForEvidenceId=ev-1": () => ({ items: [{ id: "case-9", name: "Roof leak" }] }),
    "/v1/cases/case-9/evidence": () => ({}),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : { message: "unstubbed" }), {
      status: key ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
});

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("an unassigned record offers the eligible cases and joins the chosen one", async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  assert.ok(r.hasText("Unassigned"), "the record's case is not shown");
  await r.press("Assign case");
  await settle();
  assert.ok(requests.some((q) => q.path === "/v1/cases?eligibleForEvidenceId=ev-1"), "the picker did not ask for ELIGIBLE cases");
  await r.press("Roof leak");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/cases/case-9/evidence");
  assert.deepEqual(post?.body, { evidenceId: "ev-1" });
  assert.ok(r.hasText("Evidence added to case"));
  assert.ok(r.byLabel("Reassign case").length > 0);
});

test("a record already in a case names it and can leave it", async () => {
  relationships = { caseId: "case-9", caseName: "Roof leak" };
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  assert.ok(r.hasText("Roof leak"));
  assert.ok(r.byLabel("Remove from case").length > 0);
});

test("T-12: a recorded capture location renders the map (shared display model) with Open in map", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v1/evidence/ev-1/review-workspace") {
      return new Response(
        JSON.stringify({ relationships: { items: [] }, sourceCaptureLocation: { lat: 51.5, lng: -0.12, accuracyMeters: 12, legalBoundary: "Device-reported position." } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return origFetch(url, init);
  };
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  await r.press("Integrity");
  assert.ok(r.hasText("Capture location"));
  assert.equal(r.byTestId("capture-location-map").length, 1);
  assert.ok(r.byLabel("Capture context map preview").length > 0);
  assert.ok(r.hasText("Boundary: Device-reported position."));
  assert.ok(r.byLabel("Open in map").length > 0, "no way to open the location in a map");
});

test("T-12: no recorded location, no map — never synthesised", async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  await r.press("Integrity");
  assert.equal(r.byTestId("capture-location-map").length, 0);
});
