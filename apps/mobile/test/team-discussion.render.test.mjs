/**
 * Sweep S21/S22 — a collaboration group's conversation is its COMMENTS
 * (/v1/collaboration-teams/:id/comments, the web DiscussionTab). Native mounted
 * the evidence-anchored thread system with the GROUP id, which those routes
 * authorise as a WORKSPACE, so the discussion could never load.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let Screen;
let requests = [];
let routes = {};
const TEAM = (over = {}, env = {}) => ({
  team: { id: "t1", name: "Claims", status: "ACTIVE", viewerRole: "LEAD", activeMemberCount: 2, pendingInviteCount: 0, members: [], invites: [], ...over },
  ...env,
});
const COMMENTS = {
  items: [
    { id: "c1", authorUserId: "u-ari", targetType: "TEAM", targetId: null, body: "Photos are in.", status: "ACTIVE", createdAt: "2026-09-24T09:00:00Z", updatedAt: "2026-09-24T09:00:00Z", mentions: [] },
    { id: "c2", authorUserId: "u-bo", targetType: "TEAM", targetId: null, body: "Reviewed.", status: "EDITED", createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:05:00Z", mentions: [] },
  ],
  directory: { "u-ari": { userId: "u-ari", displayName: "Ari", initials: "A", avatarUrl: null, email: null, emailMasked: null } },
};

before(async () => {
  Screen = await loadWithProviders("app/(stack)/collaboration-team/[id].tsx");
});
beforeEach(() => {
  requests = [];
  globalThis.__EXPO_PARAMS__ = { id: "t1" };
  routes = {
    "/v1/collaboration-teams/t1": () => TEAM(),
    "/v1/collaboration-teams/entitlement": () => ({ collaborationTeamMembers: { limit: 10, source: "plan" } }),
    "/v1/collaboration-teams/t1/comments": (method) => (method === "POST" ? { comment: { id: "c3" } } : COMMENTS),
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
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  return r;
};

test("the group's comments are read from the comments system, named from the server's directory", async () => {
  const r = await render();
  assert.ok(requests.some((q) => q.path === "/v1/collaboration-teams/t1/comments"), "the group's comments were never read");
  assert.ok(!requests.some((q) => q.path.startsWith("/v1/collaboration/threads")), "the evidence thread system was used for a group");
  assert.ok(r.hasText("Photos are in.") && r.hasText("Reviewed."));
  assert.ok(r.texts().some((t) => t.startsWith("Ari · ")), "the author was not named");
  assert.ok(r.texts().some((t) => t.startsWith("Team member · ") && t.endsWith(" · edited")), "an unknown author / edited mark is wrong");
});

test("posting sends a TEAM comment; a non-moderator cannot edit someone else's", async () => {
  const r = await render();
  assert.equal(r.byLabel("Delete comment c1").length, 0, "moderation offered without the server's capability");
  await r.type("Write a comment for the team", "Chasing the invoice.");
  await r.press("Post comment");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/collaboration-teams/t1/comments");
  assert.deepEqual(post.body, { targetType: "TEAM", body: "Chasing the invoice." });
});

test("a moderator may edit and delete; a governance-only viewer is told why there is no conversation", async () => {
  routes["/v1/collaboration-teams/t1"] = () => TEAM({ viewerCapabilities: { canModerateComments: true } });
  let r = await render();
  assert.equal(r.byLabel("Delete comment c1").length, 1);
  assert.equal(r.byLabel("Edit comment c2").length, 1);
  r.unmount();
  routes["/v1/collaboration-teams/t1"] = () => TEAM({}, { viaWorkspaceGovernance: true });
  requests = [];
  r = await render();
  assert.ok(r.hasText("Discussion is for members of this team"));
  assert.ok(!requests.some((q) => q.path.includes("/comments")), "comments were read for a governance-only viewer");
});
