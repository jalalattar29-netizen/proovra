/**
 * T-12 / T-17 — the UI language is an ACCOUNT preference, and every offered
 * language is named, not coded or marked "beta".
 *
 * The web saves the choice with PATCH /v1/users/me { locale }
 * (PreferencesSection.tsx); native kept it in AsyncStorage only, so a person
 * who chose French on the phone found the web app in English.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];

before(async () => {
  M = await loadModule("app/(tabs)/settings.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  const routes = { ...authenticatedRoutes(), "/v1/users/me": () => ({ user: { id: "user-1", locale: "fr" } }) };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : {}), { status: 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

test("choosing a language saves it to the account", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  await r.press("Français");
  const patch = requests.find((q) => q.method === "PATCH" && q.path === "/v1/users/me");
  assert.ok(patch, "the language choice never reached the account");
  assert.deepEqual(patch.body, { locale: "fr" });
});

test("every language is offered by its own name, none as beta", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (const name of ["English", "العربية", "Deutsch", "Français", "Español", "Türkçe", "Русский"]) {
    assert.ok(r.byLabel(name).length > 0 || r.hasText(name), `${name} missing`);
  }
  assert.ok(!r.texts().some((t) => t.includes("beta")), "a translated language is still labelled beta");
});

test("editing the display name says where it appears (OverviewSection :227)", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  // The account row (titled by the profile name, here "Signed in") opens the editor.
  await r.press("Signed in");
  assert.ok(r.hasText("Display name — what appears on evidence reviews, reports, and invitations."));
});
