/**
 * PRO-NA-06 — the org-invite screen's "Open <workspace>" applies the switch at
 * once. It used to switch, then only re-read the context: until that re-read
 * landed (or for ever, when it failed) every request still named the workspace
 * that was left. The real screen, the real api + platform-context modules, over
 * a scripted network whose context re-read FAILS after the switch:
 *   - allowed: after Open, the next request names the opened workspace;
 *   - refused: a switch the server refuses leaves the header where it was.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let switchStatus = 200;
let contextDown = false;
let probes = [];

before(async () => {
  M = await loadModule("app/(stack)/org-invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts"]);
});

beforeEach(async () => {
  switchStatus = 200;
  contextDown = false;
  probes = [];
  globalThis.__EXPO_PARAMS__ = { token: "oinv_na06" };
  const routes = authenticatedRoutes({
    "/v1/platform/context": () =>
      platformContextEnvelope({ contextOptions: { organizations: [{ organizationId: "o1", workspaces: [{ workspaceId: "ws-a", workspaceName: "Claims desk" }] }] } }),
  });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const send = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (path.startsWith("/v1/probe")) {
      probes.push(new Headers(init.headers ?? {}).get("x-proovra-workspace-id"));
      return send({ ok: true });
    }
    if (init.method === "POST") {
      if (path === "/v1/org-invites/accept") return send({ organizationId: "o1", role: "ORG_MEMBER", assignedWorkspaceIds: ["ws-a"] });
      if (path === "/v1/platform/context/switch-workspace") {
        if (switchStatus !== 200) return send({ error: { code: "FORBIDDEN", message: "no" } }, switchStatus);
        contextDown = true; // the follow-up re-read fails from here on
        return send({ ok: true });
      }
    }
    if (path.startsWith("/v1/platform/context") && contextDown) return send({ error: { code: "INTERNAL", message: "down" } }, 500);
    const key = Object.keys(routes).find((p) => path.startsWith(p));
    return send(key ? routes[key]() : {});
  };
  M.calls.reset();
  await signIn(M);
  M.setAuthToken("test-token");
  M.setActiveWorkspaceId("ws-old");
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

async function acceptThenOpen() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Accept invite");
  await settle();
  M.setActiveWorkspaceId("ws-old");
  await r.press("Open Claims desk");
  await settle();
  await M.apiFetch("/v1/probe");
  return r;
}

test("allowed: after Open the next request names the opened workspace, even though the context re-read failed", async () => {
  await acceptThenOpen();
  assert.equal(probes.at(-1), "ws-a", "the header still named the workspace that was left");
  assert.equal(M.calls.replace.at(-1), "/(tabs)");
});

test("refused: a switch the server refuses leaves the header on the earlier workspace", async () => {
  switchStatus = 403;
  await acceptThenOpen();
  assert.equal(probes.at(-1), "ws-old");
  assert.equal(M.calls.replace.at(-1), "/organizations");
});
