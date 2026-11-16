/**
 * B3C-F-006 — native case detail "Delete case" sends the step-up the server
 * requires (SEC-03), as the Cases tab already does.
 *
 * Before: DELETE /v1/cases/:id went out with no challenge header, the server's
 * step-up middleware answered 401 STEP_UP_REQUIRED, and the screen toasted a
 * failure — deleting from the case screen always failed.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const CASE = "c0ffee00-0000-4000-8000-0000000000de";

before(async () => {
  M = await loadModule("app/(stack)/case/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { id: CASE };
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    [`/v1/cases/${CASE}/matter-workspace`]: () => ({ case: { id: CASE }, viewer: { canManage: true, canMutate: true, canChangeStatus: true }, sections: { evidence: { status: "ok", items: [] } } }),
    [`/v1/cases/${CASE}`]: (method, headers) => {
      if (method === "DELETE") {
        const challenge = Object.keys(headers).find((k) => k.toLowerCase() === "x-proovra-step-up-challenge-id");
        return challenge ? { __status: 204, __empty: true } : { __status: 401, error: { code: "STEP_UP_REQUIRED", details: { purpose: "CASE_DELETE" } } };
      }
      return { case: { id: CASE, name: "Leaking roof", status: "OPEN", teamId: "ws-case", access: [], createdAt: "2026-09-02T10:00:00.000Z", updatedAt: "2026-09-20T08:30:00.000Z" } };
    },
    "/v1/evidence": () => ({ items: [] }),
    "/v1/identity-security/step-up/start": () => ({ challenge: { id: "ch-1" }, method: "TOTP", destinationMask: null, availableMethods: ["TOTP"] }),
    "/v1/identity-security/step-up/check": () => ({ status: "approved" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...(init.headers ?? {}) };
    requests.push({ path, method, headers, body: init.body ? JSON.parse(init.body) : null });
    const bare = path.split("?")[0];
    const key = routes[bare] ? bare : Object.keys(routes).filter((p) => bare.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method, headers) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    if (res?.__empty) return new Response(null, { status });
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
  M.calls.reset();
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("Delete case asks for the step-up, then retries the SAME delete with the challenge and goes back", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Settings");
  await settle();
  const open = r.byLabel("Delete case").filter((n) => n.props.onPress)[0];
  await act(async () => { await open.props.onPress(); });
  await settle();
  const confirm = r.byLabel("Delete case").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  const start = requests.find((q) => q.path === "/v1/identity-security/step-up/start");
  assert.ok(start, "no step-up was started; the delete simply failed");
  assert.equal(start.body?.teamId, "ws-case", "the challenge is bound to the case's workspace");
  await r.type("Verification code", "123456");
  await r.press("Confirm + retry");
  await settle();
  const deletes = requests.filter((q) => q.method === "DELETE" && q.path === `/v1/cases/${CASE}`);
  assert.equal(deletes.length, 2);
  assert.ok(Object.keys(deletes[1].headers).some((k) => k.toLowerCase() === "x-proovra-step-up-challenge-id"));
  assert.equal(M.calls.back, 1, "the screen did not leave the deleted case");
});
