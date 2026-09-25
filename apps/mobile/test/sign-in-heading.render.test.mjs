/**
 * T-14 — sign-in (login/page.tsx:724): the web heading "Return to your
 * PROOVRA workspace." and its subtitle. Native carried a different tagline.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
before(async () => {
  M = await loadModule("app/(stack)/auth.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});

test("sign-in says what the web says", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.ok(r.hasText("Return to your PROOVRA workspace."));
  assert.ok(r.hasText("Sign in to continue reviewing evidence records, verification reports, cases, workspaces, and protected review workflows."));
});

test("NEW:L10N-LOGIN — the strings the web login localizes follow the chosen language (ar: RTL)", async () => {
  await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await M.AsyncStorage.setItem("proovra-locale", "ar");
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.ok(r.byLabel("إنشاء حساب").length >= 1, r.texts().join(" | "));
  assert.ok(r.hasText("أو"));
  assert.ok(r.byLabel("المتابعة عبر غوغل").length >= 1);
  r.unmount();
  await M.AsyncStorage.setItem("proovra-locale", "en");
  const r2 = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.ok(r2.byLabel("Register").length >= 1);
  assert.ok(r2.hasText("Or"));
  await M.AsyncStorage.removeItem("proovra-locale-mode");
  await M.AsyncStorage.removeItem("proovra-locale");
});
