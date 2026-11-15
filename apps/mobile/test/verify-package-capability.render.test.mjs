/**
 * F-P1-16 — native verify has no local-file comparison; the package link
 * screen states that accurately and offers the supported alternative (the web
 * package page, which hashes a chosen ZIP in the browser).
 *
 * Real route over the expo stubs. RED on the pre-remediation tree: the screen
 * said only "Verification packages open in a browser." — nothing about where
 * a copy you hold can be checked, or that the app cannot.
 */
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;

before(async () => {
  process.env.EXPO_PUBLIC_WEB_URL ??= "https://www.proovra.test";
  M = await loadModule("app/verify/package/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
afterEach(() => {
  delete globalThis.__EXPO_PARAMS__;
});

test("F-P1-16: the package screen states the app's capability and the browser alternative", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "11111111-2222-4333-8444-555555555555" };
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  const copy = r.byTestId("verify-package-local-check");
  assert.equal(copy.length > 0, true, r.texts().join(" | "));
  assert.ok(r.texts().some((t) => /hashed there, never uploaded/.test(t) && /does not compare files on your device/.test(t)), r.texts().join(" | "));
  r.unmount();
});
