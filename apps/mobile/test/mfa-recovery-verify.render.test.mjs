/**
 * T-14 — auth/mfa-recovery/verify/page.tsx (:176 verifying, :194 boundary,
 * :324 "not you" footer). Native paraphrased the boundary and had neither the
 * verifying line nor the footer every web state carries.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let answer = () => ({ status: 200, body: {} });

before(async () => {
  M = await loadModule("app/(stack)/mfa-recovery-verify.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  answer = () => ({ status: 200, body: {} });
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const a = answer(path);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("a confirmed recovery link states the web's boundary verbatim, and the not-you footer", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "11111111-1111-4111-8111-111111111111", token: "t".repeat(40) };
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.ok(r.hasText("Thanks — your mailbox access is confirmed."), r.texts().join(" | "));
  assert.ok(r.hasText("This step confirmed your email only. It did NOT log you in and did NOT change your two-factor authentication. You will still need to enroll a fresh authenticator once an admin approves your reset."));
  assert.ok(r.hasText("If you did not request an MFA recovery, contact your organization administrator immediately."));
});

test("the footer is there on failure too", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.ok(r.hasText("If you did not request an MFA recovery, contact your organization administrator immediately."));
});
