/**
 * T-14 — org invite accept (org-invites/[token]/accept/page.tsx:259 Open):
 * after accepting, each granted workspace has its own explicit "Open <name>"
 * switch. Native only said how many workspaces were shared.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let posts = [];
let switchStatus = 200;
before(async () => {
  M = await loadModule("app/(stack)/org-invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts"]);
});
beforeEach(async () => {
  posts = [];
  switchStatus = 200;
  globalThis.__EXPO_PARAMS__ = { token: "oinv_1" };
  const routes = {
    ...authenticatedRoutes({
      "/v1/platform/context": () =>
        platformContextEnvelope({ contextOptions: { organizations: [{ organizationId: "o1", workspaces: [{ workspaceId: "ws-a", workspaceName: "Claims desk" }] }] } }),
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const send = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (init.method === "POST") {
      posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
      if (path === "/v1/org-invites/oinv_1/accept") return send({ organizationId: "o1", role: "ORG_MEMBER", assignedWorkspaceIds: ["ws-a", "ws-b"] });
      if (path === "/v1/platform/context/switch-workspace") return send({}, switchStatus);
    }
    const key = Object.keys(routes).find((p) => path.startsWith(p));
    return send(key ? routes[key]() : {});
  };
  M.calls.reset();
  await signIn(M);
  M.setAuthToken("test-token");
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const acceptInvite = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Accept invite");
  await settle();
  return r;
};

test("each granted workspace gets its own Open, named from the context options", async () => {
  const r = await acceptInvite();
  assert.equal(r.byLabel("Open Claims desk").length, 1);
  assert.equal(r.byLabel("Open Workspace").length, 1, "an unnamed grant was dropped instead of labelled");
  await r.press("Open Claims desk");
  await settle();
  assert.deepEqual(posts.find((p) => p.path === "/v1/platform/context/switch-workspace").body, { workspaceId: "ws-a" });
  assert.equal(M.calls.replace.at(-1), "/(tabs)");
});

test("a refused switch lands on Organizations", async () => {
  switchStatus = 403;
  const r = await acceptInvite();
  await r.press("Open Claims desk");
  await settle();
  assert.equal(M.calls.replace.at(-1), "/organizations");
});
