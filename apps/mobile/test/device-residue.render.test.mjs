/**
 * MOBILE-011 — what one person leaves on a shared device.
 *
 * Search terms in an investigation are sensitive, a case archive is evidence, and
 * a pending link says where someone was going. None of it is the next person's.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(async () => {
  M = await loadModule("app/(stack)/search.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/api.ts",
    "src/auth-context.tsx",
    "src/deep-link/pending-intent.ts",
    "src/lib/share-file.ts",
    "src/product/search.ts",
  ]);
});

beforeEach(async () => {
  routes = authenticatedRoutes();
  globalThis.__DELETED__ = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (!key) return reply(200, {});
    const out = routes[key]();
    return out instanceof Response ? out : reply(200, out);
  };
  M.AsyncStorage.__reset();
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  M.takePendingRoute();
});

let auth;
const Grab = () => {
  auth = M.useAuth();
  return null;
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(Grab)));
  mounted.push(r);
  await settle();
  return r;
};
const keys = () => M.AsyncStorage.getAllKeys();
const seed = async () => {
  await M.AsyncStorage.setItem(M.searchRecentKey("user-1", TEST_TEAM_ID), JSON.stringify(["witness name"]));
  await M.AsyncStorage.setItem("proovra:tenant:old-team:search:recent", JSON.stringify(["older build"]));
  await M.AsyncStorage.setItem("proovra-locale", "de");
  M.setPendingRoute("/(stack)/case/c1");
  await settle();
};
const exportFolder = "file:///cache/proovra-exports/";
const personal = (k) => k.endsWith(":search:recent") || k === "proovra.pending-intent.v1";

test("recent searches belong to a person, not only to a workspace", () => {
  assert.notEqual(M.searchRecentKey("user-1", "t"), M.searchRecentKey("user-2", "t"));
});

test("signing out removes the searches, the pending link and the exports, and nothing of the device's own", async () => {
  await render();
  await seed();
  await act(async () => { auth.setToken(null); });
  await settle();
  const left = await keys();
  assert.ok(left.includes("proovra-locale"), "a device preference stays");
  assert.deepEqual(left.filter(personal), [], "a person's trail does not");
  assert.equal(M.peekPendingRoute(), null);
  assert.ok(globalThis.__DELETED__.includes(exportFolder));
});

test("a session the server ended is cleaned the same way", async () => {
  await render();
  await seed();
  routes["/v1/probe"] = () => reply(401, { error: { code: "UNAUTHORIZED" } });
  await act(async () => { await M.apiFetch("/v1/probe").catch(() => undefined); });
  await settle();
  assert.deepEqual((await keys()).filter(personal), []);
  assert.equal(M.peekPendingRoute(), null);
  assert.ok(globalThis.__DELETED__.includes(exportFolder));
});

test("positive control: a live session keeps its own searches", async () => {
  await render();
  await seed();
  assert.ok((await keys()).includes(M.searchRecentKey("user-1", TEST_TEAM_ID)));
  assert.equal(M.peekPendingRoute(), "/(stack)/case/c1");
});

test("exports go to the one folder sign-out removes", async () => {
  assert.equal(await M.exportFileUri("case-1.zip"), `${exportFolder}case-1.zip`);
  for (const file of [
    "app/(tabs)/evidence.tsx",
    "app/(stack)/case/[id].tsx",
    "app/(stack)/operations/batch-analysis.tsx",
    "src/ui/workspace-audit-section.tsx",
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(src.includes("exportFileUri("), `${file} writes its export somewhere else`);
    assert.ok(!src.includes("documentDirectory"), `${file} keeps an export in permanent storage`);
  }
});

test("Android backup is off: AsyncStorage and app files stay off Google's backup", () => {
  const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  assert.equal(app.expo.android.allowBackup, false);
});
