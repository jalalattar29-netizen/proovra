/**
 * T-15 — "Also here" presence (/v1/me/presence/heartbeat, /v1/me/presence/here).
 * Native never told an operator that a colleague was on the same record.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];
let answer;

before(async () => {
  M = await loadModule("src/ui/presence-indicator.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  requests = [];
  answer = () => ({ status: 200, body: { viewers: [
    { userId: "u2", displayName: "Rana K.", lastSeenAtUtc: "2026-09-24T10:00:00Z", ipAddress: "10.0.0.1" },
    { userId: "u3", displayName: "Omar S.", lastSeenAtUtc: "2026-09-24T10:00:00Z" },
  ] } });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    // Only presence traffic is recorded; the providers make their own reads.
    if (!path.startsWith("/v1/me/presence")) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const out = answer(path);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  };
});
afterEach(() => {
  delete globalThis.__APP_STATE__;
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mount = async (props) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.PresenceIndicator, { teamId: "team-1", resourceKind: "evidence", resourceId: "ev-1", ...props })));
  await settle();
  return r;
};

test("foreground: claims presence with a heartbeat and names the others", async () => {
  const r = await mount();
  assert.deepEqual(requests[0], { path: "/v1/me/presence/heartbeat", method: "POST", body: { teamId: "team-1", resourceKind: "evidence", resourceId: "ev-1" } });
  assert.equal(r.byLabel("2 other operators also here").length, 1);
  assert.ok(r.hasText("Rana K.") && r.hasText("Omar S."));
  assert.ok(!r.hasText("10.0.0.1"), "an unbounded field was rendered");
  r.unmount();
});

test("background: observes WITHOUT claiming presence", async () => {
  globalThis.__APP_STATE__ = "background";
  const r = await mount({ resourceKind: "matter", resourceId: "case-9" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].path, "/v1/me/presence/here?teamId=team-1&resourceKind=matter&resourceId=case-9");
  assert.ok(!requests.some((q) => q.path.endsWith("/heartbeat")), "a backgrounded app claimed presence");
  r.unmount();
});

test("nobody else, a denial, or no workspace renders nothing and invents nobody", async () => {
  answer = () => ({ status: 200, body: { viewers: [] } });
  let r = await mount();
  assert.ok(!r.hasText("Also here:"));
  r.unmount();
  answer = () => ({ status: 403, body: { error: { code: "forbidden" } } });
  r = await mount();
  assert.ok(!r.hasText("Also here:"));
  r.unmount();
  requests = [];
  r = await mount({ teamId: null });
  assert.equal(requests.length, 0, "presence was sent without a workspace");
  r.unmount();
});

/* ------------------------------------------------ mounted on the matter screen */
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

test("the matter screen claims presence on its own workspace + case", async () => {
  const S = await loadModule("app/(stack)/case/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  globalThis.__EXPO_PARAMS__ = { id: "case-9" };
  const routes = {
    ...authenticatedRoutes(),
    "/v1/cases/case-9": () => ({ case: { id: "case-9", name: "Leaking roof", status: "OPEN", teamId: "team-7", access: [] } }),
    "/v1/evidence": () => ({ items: [] }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/v1/me/presence")) {
      requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ viewers: [{ userId: "u2", displayName: "Rana K." }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : {}), { status: key ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  try {
    await signIn(S);
    const r = await renderComponent(h(S.TestProviders, null, h(S.default, {})));
    await settle();
    const beat = requests.find((q) => q.path === "/v1/me/presence/heartbeat");
    assert.ok(beat, "the matter screen never claimed presence");
    assert.deepEqual(beat.body, { teamId: "team-7", resourceKind: "matter", resourceId: "case-9" });
    assert.equal(r.byLabel("1 other operator also here").length, 1);
    r.unmount();
  } finally {
    delete globalThis.__EXPO_PARAMS__;
  }
});
