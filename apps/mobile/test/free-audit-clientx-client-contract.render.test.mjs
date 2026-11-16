/**
 * CLIENT-X — B8-F-402 (native half).
 *
 * The API now sends `x-proovra-min-client-contract` (and keeps sending
 * `x-proovra-contract`). Before: native read neither, so a store build the
 * API no longer serves kept interpreting responses with no word to the person.
 * Absent headers (an older API) must change nothing.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let headers = {};

before(async () => {
  M = await loadModule("src/ui/client-update-notice.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts", "src/network/client-contract.ts"]);
});
beforeEach(() => {
  headers = {};
  M.resetClientUpdateNoticeForTests();
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", ...headers } });
});
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("B8-F-402: a minimum client contract above this build raises 'Update required' (non-blocking)", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ClientUpdateNotice)));
  headers = { "x-proovra-contract": "2", "x-proovra-min-client-contract": "2" };
  const body = await M.apiFetch("/v1/anything");
  assert.deepEqual(body, { ok: true }, "the response was blocked");
  await settle();
  assert.equal(r.byTestId("client-update-notice-UPDATE_REQUIRED").length, 1);
  assert.ok(r.hasText("Update required"));
  await r.press("Dismiss update notice");
  assert.equal(r.byTestId("client-update-notice-UPDATE_REQUIRED").length, 0);
  r.unmount();
});

test("B8-F-402: an API on a newer contract (minimum still met) says 'Please update'", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ClientUpdateNotice)));
  headers = { "x-proovra-contract": "2", "x-proovra-min-client-contract": "1" };
  await M.apiFetch("/v1/anything");
  await settle();
  assert.equal(r.byTestId("client-update-notice-UPDATE_AVAILABLE").length, 1);
  r.unmount();
});

test("B8-F-402: absent, current or malformed headers never raise a notice", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ClientUpdateNotice)));
  for (const hs of [{}, { "x-proovra-contract": "1" }, { "x-proovra-contract": "1", "x-proovra-min-client-contract": "1" }, { "x-proovra-min-client-contract": "abc" }]) {
    headers = hs;
    await M.apiFetch("/v1/anything");
  }
  await settle();
  assert.equal(M.getClientUpdateNotice(), null);
  assert.deepEqual(r.texts(), []);
  r.unmount();
});
