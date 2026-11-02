/**
 * MOBILE-004 / MOBILE-006 — links the app claims land somewhere real, and a link
 * arriving on a cold start is not read as "signed out".
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
const extras = ["test/support/providers.tsx", "test/support/expo-stub.mjs"];
let Id;
let Pkg;
let Missing;
let Gate;
let requests = [];
let routes = {};

before(async () => {
  Id = await loadModule("app/verify/[id].tsx", extras);
  Pkg = await loadModule("app/verify/package/[id].tsx", [...extras, "src/deep-link.ts"]);
  Missing = await loadModule("app/+not-found.tsx", extras);
  Gate = await loadModule("test/support/deep-link-gate-probe.tsx", extras);
});

beforeEach(() => {
  requests = [];
  routes = authenticatedRoutes();
  delete globalThis.__EXPO_URL__;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[path];
    return new Response(JSON.stringify(handler ? handler() : {}), { status: 200, headers: { "content-type": "application/json" } });
  };
  for (const m of [Id, Pkg, Missing, Gate]) m.calls.reset();
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
const render = async (M, child) => {
  const r = await renderComponent(h(M.TestProviders, null, child ?? h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__EXPO_PARAMS__;
});

test("/verify/<ref> lands on the verification screen with that reference", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "abc-123" };
  await render(Id);
  assert.deepEqual(Id.calls.redirect, { pathname: "/verify", params: { id: "abc-123" } });
});

test("a malformed reference lands on the paste box, not on a lookup", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "not a ref/x" };
  await render(Id);
  assert.equal(Id.calls.redirect, "/verify");
});

test("/verify/package is not read as the reference \"package\"", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "package" };
  await render(Id);
  assert.equal(Id.calls.redirect, "/verify");
});

test("the route files exist beside verify.tsx, so the router matches the claimed paths", () => {
  const app = new URL("../app/", import.meta.url);
  assert.ok(readdirSync(app).includes("verify.tsx"));
  assert.ok(readdirSync(app).includes("+not-found.tsx"));
  assert.ok(readdirSync(new URL("verify/", app)).includes("[id].tsx"));
  assert.ok(readdirSync(new URL("verify/package/", app)).includes("[id].tsx"));
});

test("a package link opens the web page in an in-app browser, once", async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  globalThis.__EXPO_PARAMS__ = { id: "pkg_1" };
  await render(Pkg);
  delete process.env.EXPO_PUBLIC_WEB_BASE;
  assert.deepEqual(Pkg.calls.openURL, ["https://www.proovra.com/verify/package/pkg_1"]);
});

test("with no web origin configured, a package link says what to do", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "pkg_1" };
  const r = await render(Pkg);
  assert.deepEqual(Pkg.calls.openURL, []);
  assert.ok(r.hasText("Open it in a web browser"));
});

test("the fallback page does not read as a fault in the evidence", async () => {
  const r = await render(Missing);
  assert.ok(r.hasText("This link does not open in the app"));
  assert.ok(!r.texts().some((t) => /unmatched/i.test(t)));
  await r.press("Go to home");
  assert.equal(Missing.calls.replace.at(-1), "/");
});

test("verificationPackageUrl refuses what is not an id", () => {
  assert.equal(Pkg.verificationPackageUrl("https://www.proovra.com/", "pkg_1"), "https://www.proovra.com/verify/package/pkg_1");
  assert.equal(Pkg.verificationPackageUrl(null, "pkg_1"), null);
  assert.equal(Pkg.verificationPackageUrl("https://www.proovra.com", "../x"), null);
});

test("MOBILE-006: a resource link on a cold start waits for the stored session", async () => {
  await signIn(Gate);
  routes["/v1/deep-link/resolve"] = () => ({ ok: true, workspaceId: "team-1" });
  globalThis.__EXPO_URL__ = "proovra://evidence/ev-1";
  await render(Gate, h(Gate.DeepLinkGate));
  assert.equal(Gate.calls.replace.length, 0, "a signed-in person must not be sent to sign-in");
  assert.equal(Gate.peekPendingRoute(), null);
  assert.deepEqual(requests.find((q) => q.path === "/v1/deep-link/resolve")?.body, { resourceType: "evidence", resourceId: "ev-1" });
  assert.deepEqual(Gate.calls.push, ["/(stack)/evidence/ev-1"]);
});

test("positive control: signed out, the link waits behind sign-in", async () => {
  await Gate.deleteItemAsync("proovra-token");
  Gate.setAuthToken(null);
  globalThis.__EXPO_URL__ = "proovra://evidence/ev-1";
  await render(Gate, h(Gate.DeepLinkGate));
  assert.deepEqual(Gate.calls.replace, ["/(stack)/auth"]);
  assert.equal(Gate.peekPendingRoute(), "/(stack)/evidence/ev-1");
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false);
  Gate.takePendingRoute();
});

test("a credential link is acted on once, though the session restores after it", async () => {
  await signIn(Gate);
  globalThis.__EXPO_URL__ = "https://www.proovra.com/reset-password?token=t1";
  await render(Gate, h(Gate.DeepLinkGate));
  assert.equal(Gate.calls.push.length, 1);
});