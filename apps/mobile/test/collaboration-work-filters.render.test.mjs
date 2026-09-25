/**
 * T-12 / RC-13 — the collaboration group's Work filters.
 *
 * The web offers FOUR server-side filters on a group's work
 * (`AssignmentsTab.tsx:363-398`): status, assignee, priority, work type. Native
 * offered two. `buildAssignmentsPath` already sent `assignee` and `priority`,
 * and nothing on screen could set them — so "what is Dana carrying?" and "what
 * is urgent?" had no answer on a phone.
 *
 * These tests assert the filters reach the SERVER query, not that chips render.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];

before(async () => {
  M = await loadModule("src/ui/collaboration-work.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  requests = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    return new Response(JSON.stringify({ assignments: [], total: 0, nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

const MEMBERS = [
  { id: "u-dana", role: "MEMBER", status: "ACTIVE", displayName: "Dana", email: null },
  { id: "u-gone", role: "MEMBER", status: "REMOVED", displayName: "Former", email: null },
];
const render = () =>
  renderComponent(h(M.TestProviders, null, h(M.CollaborationWorkSection, { teamId: "t1", members: MEMBERS })));
const last = () => requests.filter((p) => p.includes("/assignments")).at(-1);

test("the assignee filter reaches the server query, including the team-level sentinel", async () => {
  const r = await render();
  await r.press("Assignee: Dana");
  assert.match(last(), /[?&]assignee=u-dana(&|$)/);
  await r.press(`Assignee: ${M.ASSIGNEE_TEAM_LEVEL_LABEL}`);
  assert.match(last(), /[?&]assignee=UNASSIGNED(&|$)/);
  await r.press("Assignee: All assignees");
  assert.doesNotMatch(last(), /assignee=/);
});

test("only ACTIVE members are offered as assignees, as on the web", async () => {
  const r = await render();
  assert.equal(r.byLabel("Assignee: Former").length, 0);
});

test("the priority filter reaches the server query", async () => {
  const r = await render();
  await r.press("Priority: Urgent");
  assert.match(last(), /[?&]priority=URGENT(&|$)/);
});

test("filters compose into ONE query", async () => {
  const r = await render();
  await r.press("Assignee: Dana");
  await r.press("Priority: High");
  const q = last();
  assert.match(q, /assignee=u-dana/);
  assert.match(q, /priority=HIGH/);
});
