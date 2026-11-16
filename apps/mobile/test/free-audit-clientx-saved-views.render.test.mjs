/**
 * CLIENT-X — B5B-F-303 / B2A-F-09 / B5A-F-14 (A2-14 saved views), native half.
 *
 * The API now refuses a saved view with a `teamId` from a role without
 * `evidence.update_metadata` (Viewer → 403) and refuses a default change by
 * anyone but the view's owner (403). Before: the native "Save Current View"
 * offered "Team view: <workspace>" to a Viewer of an owned workspace, "Make
 * Default" appeared on a colleague's team view, and a rename of a colleague's
 * view sent `isDefault` (403 on every rename).
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes;
let requests;
let rendered;

const view = (id, ownerUserId, over = {}) => ({
  id, ownerUserId, teamId: "ws-owned", name: `View ${id}`, description: null, sortKey: "newest", scope: "active", isDefault: false,
  filters: { search: "", scope: "active", status: "all", type: "all", review: "all", exportReadiness: "all", caseAssignment: "all", retention: "all", sort: "newest" },
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...over,
});
const envelopeWithRole = (role) =>
  platformContextEnvelope({
    contextOptions: { ownedWorkspaces: [{ workspaceId: "ws-owned", name: "Harbour team", kind: "OWNED", role, lifecycleStatus: "active" }] },
  });

before(async () => {
  M = await loadModule("app/(tabs)/evidence.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = {};
  requests = [];
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => envelopeWithRole("VIEWER") }),
    "GET /v1/evidence/library-summary": () => ({ scope: "active", totalActiveRecords: 0 }),
    "GET /v1/evidence/saved-views": () => ({ items: [] }),
    "GET /v1/cases": () => ({ items: [] }),
    "GET /v1/evidence": () => ({ scope: "active", items: [], pageInfo: { limit: 50, nextCursor: null, hasMore: false } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method, path, body });
    const keys = Object.keys(routes).filter((k) => {
      const [m, p] = k.includes(" ") ? k.split(" ") : ["GET", k];
      return m === method && path.startsWith(p);
    });
    const key = keys.sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ message: "not stubbed" }), { status: 500, headers: { "content-type": "application/json" } });
    const out = routes[key]({ path, body });
    return new Response(JSON.stringify(out), { status: out?.__status ?? 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
afterEach(() => {
  if (rendered) rendered.unmount();
  rendered = null;
});
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
async function mount() {
  rendered = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await act(async () => { await new Promise((x) => setTimeout(x, 320)); });
  await settle();
  return rendered;
}

test("A2-14: a Viewer is offered only a personal view, so Save View sends teamId null", async () => {
  routes["POST /v1/evidence/saved-views"] = ({ body }) => ({ savedView: { ...view("v9", "user-1"), teamId: body.teamId, name: body.name } });
  const r = await mount();
  await r.press("Save Current View");
  assert.ok(!r.hasText("Team view: Harbour team"), "a Viewer was offered a team view the API refuses (403)");
  await r.type("View name", "Mine");
  await r.press("Save View");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/evidence/saved-views");
  assert.equal(post.body.teamId, null);
});

test("A2-14 control: a Member of the same workspace is still offered the team view", async () => {
  routes["/v1/platform/context"] = () => envelopeWithRole("MEMBER");
  const r = await mount();
  await r.press("Save Current View");
  assert.ok(r.hasText("Team view: Harbour team"));
});

test("B5B-F-303: Make Default is offered only on the reader's own views; a colleague's rename omits isDefault", async () => {
  routes["/v1/platform/context"] = () => envelopeWithRole("ADMIN");
  routes["GET /v1/evidence/saved-views"] = () => ({ items: [view("mine", "user-1", { teamId: null }), view("theirs", "user-2")] });
  routes["PATCH /v1/evidence/saved-views/"] = ({ body }) =>
    "isDefault" in body ? { __status: 403, error: { code: "FORBIDDEN" } } : { savedView: view("theirs", "user-2", { name: body.name }) };
  const r = await mount();
  await r.press("Saved Views");
  assert.equal(r.byLabel("Make Default View mine").length, 1);
  assert.equal(r.byLabel("Make Default View theirs").length, 0, "Make Default shown on a colleague's view (403)");
  await r.press("Rename View theirs");
  assert.equal(r.byLabel("Make this my default view").length, 0, "the default checkbox shown for a colleague's view");
  await r.type("View name", "Renamed");
  await r.press("Update View");
  await settle();
  const patch = requests.find((q) => q.method === "PATCH");
  assert.ok(patch, "no PATCH was sent");
  assert.ok(!("isDefault" in patch.body), "a rename of a colleague's view carried isDefault (403)");
});
