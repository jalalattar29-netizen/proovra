/**
 * T-14 — Create assignment on a collaboration group (web CreateAssignmentModal).
 * Native listed a group's assignments but could not create one.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let Screen;
let requests = [];
let routes = {};
let created = 0;
const TEAM = (over = {}) => ({
  team: {
    id: "t1", name: "Claims", status: "ACTIVE", viewerRole: "LEAD", activeMemberCount: 2, pendingInviteCount: 0, invites: [],
    members: [{ id: "m1", userId: "u-ari", role: "MEMBER", status: "ACTIVE", user: { displayName: "Ari", email: "ari@example.com" } }],
    ...over,
  },
});

before(async () => {
  Screen = await loadWithProviders("app/(stack)/collaboration-team/[id].tsx");
});
beforeEach(() => {
  requests = [];
  created = 0;
  globalThis.__EXPO_PARAMS__ = { id: "t1" };
  routes = {
    "/v1/collaboration-teams/t1": () => TEAM(),
    "/v1/collaboration-teams/entitlement": () => ({}),
    "/v1/collaboration-teams/t1/comments": () => ({ items: [], directory: {} }),
    "/v1/collaboration-teams/t1/assignable-targets": () => ({ targets: [{ id: "case-9", label: "Leaking roof", sublabel: "#c0ffee00", status: "OPEN" }] }),
    "/v1/collaboration-teams/t1/assignments": (method) => {
      if (method === "POST") {
        created += 1;
        return { assignment: { id: "as-1" } };
      }
      return { items: [], nextCursor: null, total: created };
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const bare = path.split("?")[0];
    const res = routes[bare] ? routes[bare](method) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
});
const settle = async (ms = 0) => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, ms)); });
};
const render = async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  return r;
};

test("a LEAD creates an assignment from the server's assignable records", async () => {
  const r = await render();
  await r.press("Create assignment");
  await settle();
  assert.ok(requests.some((q) => q.path === "/v1/collaboration-teams/t1/assignable-targets?type=CASE"), "the assignable cases were never read");
  await r.press("Choose Leaking roof");
  await r.press("Assignee: Ari");
  await r.press("Priority: High");
  await r.type("Due date (optional)", "2026-10-01 17:00");
  await r.type("Description (optional)", "Photos first.");
  const before = requests.filter((q) => q.path.startsWith("/v1/collaboration-teams/t1/assignments") && q.method === "GET").length;
  // Two controls carry this label — the screen's opener and the form's submit; the submit is the last.
  const submit = r.byLabel("Create assignment").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await submit.props.onPress(); });
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/collaboration-teams/t1/assignments");
  assert.equal(post.body.targetType, "CASE");
  assert.equal(post.body.targetId, "case-9");
  assert.equal(post.body.assigneeUserId, "u-ari");
  assert.equal(post.body.priority, "HIGH");
  assert.equal(post.body.note, "Photos first.");
  assert.equal(post.body.dueAtUtc, new Date(2026, 9, 1, 17, 0).toISOString(), "the local due time was not sent as that instant");
  const after = requests.filter((q) => q.path.startsWith("/v1/collaboration-teams/t1/assignments") && q.method === "GET").length;
  assert.ok(after > before, "the work list was not reloaded after the create");
});

test("no permission, or an archived group, offers no create", async () => {
  routes["/v1/collaboration-teams/t1"] = () => TEAM({ viewerRole: "MEMBER" });
  let r = await render();
  assert.equal(r.byLabel("Create assignment").length, 0, "a plain member was offered create");
  r.unmount();
  routes["/v1/collaboration-teams/t1"] = () => TEAM({ status: "ARCHIVED" });
  r = await render();
  assert.equal(r.byLabel("Create assignment").length, 0, "an archived group was offered create");
});
