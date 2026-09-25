/**
 * NEW:VIS-SHELL-BG + NEW:VIS-AUTH-HERO — the two web artworks were shipped in
 * assets/brand/ (byte-identical to apps/web/public) and required by NOTHING:
 * every signed-in screen and every auth screen rendered a flat surface.
 *
 * These tests prove CONSUMPTION, not existence: the image a screen renders is
 * compared byte-for-byte with the WEB asset, the card and header surfaces over
 * it are the web's re-scoped values, and a screen outside both keeps the
 * opaque tokens.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public", "assets");
const dataUrl = (file) => "data:image/png;base64," + readFileSync(file).toString("base64");
const WEB_SHELL_BG = dataUrl(resolve(WEB, "backgrounds", "app-shell-bg.png"));
const WEB_AUTH_HERO = dataUrl(resolve(WEB, "hero", "register-logo...png"));

let Reports; // the Settings tab: a ProovraShell surface that always renders cards
let Auth;
let Verify;
let S;
before(async () => {
  Reports = await loadModule("app/(tabs)/settings.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Auth = await loadModule("app/(stack)/auth.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Verify = await loadModule("app/verify.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  S = await loadModule("src/ui/shell-surface.tsx");
});
beforeEach(() => {
  globalThis.__EXPO_PARAMS__ = {};
  const routes = authenticatedRoutes({ "/v1/users/me": () => ({ user: { id: "user-1" } }) });
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : {}), { status: 200, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
/** The test renderer never lays out; give the backdrop a phone-sized box. */
const layout = async (r, id, width = 390, height = 844) => {
  const box = r.byTestId(id)[0];
  assert.ok(box, `no ${id}`);
  await act(async () => { box.props.onLayout({ nativeEvent: { layout: { width, height, x: 0, y: 0 } } }); });
};

test("every signed-in screen sits on the web's app-shell artwork, with the web's card and header surfaces over it", async () => {
  await signIn(Reports);
  const r = await renderComponent(h(Reports.TestProviders, null, h(Reports.default, {})));
  await settle();
  await layout(r, "app-shell-backdrop");
  const art = r.byTestId("app-shell-artwork")[0];
  assert.ok(art, "the shell artwork is not drawn");
  assert.equal(art.props.source, WEB_SHELL_BG, "the drawn image is not the web's app-shell-bg.png");
  const header = r.byRole("header")[0];
  const hs = r.styleOf(header);
  assert.equal(hs.backgroundColor, "rgba(255, 255, 255, 0.18)", "header is not the web glass bar");
  assert.equal(hs.borderBottomWidth, 0, "the web header has no separator");
  const translucent = r.renderer.root.findAll((n) => typeof n.type === "string" && r.styleOf(n).backgroundColor === "rgba(255, 255, 255, 0.92)");
  assert.ok(translucent.length > 0, "no content card took the web's 92% surface");
});

test("the auth screens sit on the web's auth hero, with the glass card", async () => {
  const r = await renderComponent(h(Auth.TestProviders, null, h(Auth.default, {})));
  await settle();
  await layout(r, "auth-backdrop");
  const art = r.byTestId("auth-artwork")[0];
  assert.ok(art, "the auth hero is not drawn");
  assert.equal(art.props.source, WEB_AUTH_HERO, "the drawn image is not the web's register-logo...png");
  const glass = r.renderer.root.findAll((n) => typeof n.type === "string" && r.styleOf(n).backgroundColor === "rgba(255, 255, 255, 0.74)");
  assert.ok(glass.length > 0, "no card took the web glass surface");
  assert.equal(r.styleOf(glass[0]).borderRadius, 28);
  assert.equal(r.byTestId("app-shell-backdrop").length, 0, "auth must not carry the shell artwork");
});

test("a public page outside both keeps opaque surfaces and no artwork", async () => {
  const r = await renderComponent(h(Verify.TestProviders, null, h(Verify.default, {})));
  await settle();
  assert.equal(r.byTestId("app-shell-backdrop").length, 0);
  assert.equal(r.byTestId("auth-backdrop").length, 0);
  const tinted = r.renderer.root.findAll((n) => typeof n.type === "string" && ["rgba(255, 255, 255, 0.92)", "rgba(255, 255, 255, 0.74)"].includes(r.styleOf(n).backgroundColor));
  assert.equal(tinted.length, 0);
});

test("cover-fit reproduces CSS cover: centre-top for the shell, centre for the hero", () => {
  // Portrait phone: height-bound, cropped left/right, pinned to the top.
  const p = S.coverFit({ w: 1672, h: 941 }, 390, 844, "top");
  assert.equal(Math.round(p.height), 844);
  assert.ok(p.width > 390 && p.left < 0 && p.top === 0);
  assert.equal(Math.round(p.left * 2 + p.width), 390, "not centred horizontally");
  // Very wide tablet: width-bound; the shell stays pinned to the top, the hero is centred.
  const t = S.coverFit({ w: 1672, h: 941 }, 2000, 600, "top");
  assert.equal(Math.round(t.width), 2000);
  assert.equal(t.top, 0);
  const c = S.coverFit({ w: 1688, h: 932 }, 2000, 600, "center");
  assert.ok(c.top < 0 && Math.round(c.top * 2 + c.height) === 600);
});

test("all five web hero screens carry it on native: login, register, reset-password, forgot-password, verify-email", async () => {
  for (const [file, params] of [
    ["app/(stack)/register.tsx", {}],
    ["app/(stack)/reset-password.tsx", { token: "t-1" }],
    ["app/(stack)/forgot-password.tsx", {}],
    ["app/(stack)/verify-email.tsx", {}],
  ]) {
    globalThis.__EXPO_PARAMS__ = params;
    const M = await loadModule(file, ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
    const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
    await settle();
    assert.equal(r.byTestId("auth-backdrop").length, 1, `${file} has no auth hero`);
    r.unmount();
  }
});
