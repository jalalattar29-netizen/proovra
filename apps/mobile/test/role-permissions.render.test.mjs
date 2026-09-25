/**
 * T-15 — "Who can do what" on Workspace People (GET /v1/platform/rbac/matrix).
 * Native had no way to see what each role may do; the web opens the server's
 * capability catalog from the same page.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const MATRIX = {
  version: "2026.09",
  roles: [
    { id: "VIEWER", label: "Viewer", rank: 1 },
    { id: "OWNER", label: "Owner", rank: 4 },
    { id: "ADMIN", label: "Admin", rank: 3 },
    { id: "AUDITOR", label: "Auditor", rank: 2 },
  ],
  categories: [
    {
      id: "evidence",
      label: "Evidence",
      capabilities: [
        { id: "evidence.delete", label: "Delete evidence", description: "Moves a record to Trash.", roles: ["OWNER", "ADMIN"] },
        { id: "evidence.nuke", label: "Destroy permanently", description: null, roles: [] },
      ],
    },
  ],
};

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/platform/rbac/matrix": () => MATRIX,
    // The detail read (teams.routes.ts:760). Like the web's error state, a
    // workspace that failed to load offers no page actions, so it is stubbed.
    "/v1/teams/team-1": () => ({ id: "team-1", name: "Acme", currentUserRole: "ADMIN", canManageMembers: true, canManageWorkspace: false, stats: { memberCount: 1 } }),
    "/v1/teams/team-1/members": () => ({ members: [{ id: "m1", userId: "user-1", role: "ADMIN", status: "ACTIVE", user: { displayName: "Test Operator" } }], nextCursor: null }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const open = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Role permissions");
  await settle();
  return r;
};

test("the server's catalog: roles in rank order, allowed roles per capability, the viewer's role named", async () => {
  const r = await open();
  assert.ok(requests.includes("/v1/platform/rbac/matrix"));
  assert.ok(r.hasText("Your role here is Admin."));
  assert.ok(r.hasText("Owner · Admin"), "allowed roles are not in the server's rank order");
  assert.ok(r.hasText("No role can do this."));
  await r.press("Delete evidence: Owner, Admin");
  assert.ok(r.hasText("Moves a record to Trash."));
});

test("403 is a statement about this account, not an error", async () => {
  routes["/v1/platform/rbac/matrix"] = () => ({ __status: 403 });
  const r = await open();
  assert.ok(r.hasText("Your account is not permitted to read the capability catalog."));
});

test("an empty catalog says so", async () => {
  routes["/v1/platform/rbac/matrix"] = () => ({ roles: [], categories: [] });
  const r = await open();
  assert.ok(r.hasText("The server returned no capability catalog for this deployment."));
});
