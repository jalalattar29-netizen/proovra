/**
 * T-12 / RC-13 — reviewer-criteria version history + from/to compare
 * (settings/reviewer-criteria/page.tsx:199 "Compare from version", :203
 * "Compare to version").
 *
 * Before: native showed a usage count per version and nothing else — which
 * criteria a version held, and what changed between two versions, could not
 * be read. Now "History" opens every version with its criteria, the web's
 * usage line, and a compare computed by the web's own key-based diff.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const V1 = {
  id: "v-1", version: 1, title: "Initial", publishedAt: "2026-09-01T10:00:00Z", createdAt: "2026-08-30T10:00:00Z",
  criteria: [
    { key: "chain", title: "Chain of custody intact", required: true, order: 0 },
    { key: "dates", title: "Dates consistent", required: false, order: 1 },
  ],
};
const V2 = {
  id: "v-2", version: 2, title: "Tightened", publishedAt: null, createdAt: "2026-09-10T10:00:00Z",
  criteria: [
    { key: "chain", title: "Chain of custody intact", required: true, order: 0 },
    { key: "dates", title: "Dates consistent", required: true, order: 1 },
    { key: "source", title: "Source identified", required: false, order: 2 },
  ],
};
const SET = { id: "set-1", name: "Intake review", description: null, status: "DRAFT", createdAt: "x", updatedAt: "y", versions: [V2, V1] };

before(async () => {
  M = await loadModule("app/(stack)/settings/reviewer-criteria.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/reviewer-criteria?teamId=": () => ({ sets: [SET] }),
    "/v1/reviewer-criteria/set-1/usage": () => ({ usageAvailable: true, usage: [{ version: 1, runCount: 3, reviewCount: 2, reviewerCount: 1, lastUsedAt: null }, { version: 2, runCount: 0, reviewCount: 0, reviewerCount: 0 }] }),
    "/v1/reviewer-criteria/set-1?teamId=": () => ({ set: SET }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("History shows every version, its criteria and the web's usage line", async () => {
  const r = await render();
  await r.press("History: Intake review");
  await settle();
  assert.ok(requests.some((q) => q.path === `/v1/reviewer-criteria/set-1?teamId=${TEST_TEAM_ID}`), "history read never sent");
  assert.ok(r.hasText("v2 — Tightened"));
  assert.ok(r.hasText("v1 — Initial"));
  assert.ok(r.hasText("• Source identified"));
  assert.ok(r.hasText("• Dates consistent (required)"));
  assert.ok(r.hasText("Used in 3 Copilot run(s) across 2 review(s) by 1 reviewer(s)"));
  assert.ok(r.hasText("Not used by any Copilot run yet."));
  assert.ok(r.hasText("draft"));
});

test("compare v1 → v2 lists the added, changed and title differences", async () => {
  const r = await render();
  await r.press("History: Intake review");
  await settle();
  assert.equal(r.byTestId("criteria-compare").length, 0, "a compare shown before two versions were chosen");
  await r.press("Compare from version: v1");
  await r.press("Compare to version: v2");
  assert.equal(r.byTestId("criteria-compare").length, 1);
  assert.ok(r.hasText("v1 → v2"));
  assert.ok(r.hasText("Title: “Initial” → “Tightened”"));
  assert.ok(r.hasText('• Changed "dates" — Dates consistent → Dates consistent (required)'));
  assert.ok(r.hasText('• Added "source" — Source identified'));
  await r.press("Compare from version: v2");
  assert.equal(r.byTestId("criteria-compare").length, 0, "compared a version against itself");
});

test("a failed history read is said; a failed usage read leaves the history intact", async () => {
  routes["/v1/reviewer-criteria/set-1/usage"] = () => ({ __status: 500 });
  let r = await render();
  await r.press("History: Intake review");
  await settle();
  assert.ok(r.hasText("v2 — Tightened"), "usage failure took the history with it");
  assert.ok(!r.hasText("Copilot run"));
  r.unmount();

  routes["/v1/reviewer-criteria/set-1?teamId="] = () => ({ __status: 500 });
  r = await render();
  await r.press("History: Intake review");
  await settle();
  assert.ok(r.hasText("Version history is unavailable."));
});
