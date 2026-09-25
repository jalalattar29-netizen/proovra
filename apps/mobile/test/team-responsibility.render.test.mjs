/**
 * T-12 / RC-13 — record-side team responsibility
 * (TeamResponsibilityPanel.tsx :515 assign, :533 edit, :553 remove), on the
 * case and on the evidence Review tab.
 *
 * Before: native never read `/v1/collaboration-teams/responsibility`, so a
 * record could not say which group was coordinating it, and work could only be
 * handed to a group from that group's own Work tab.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const ROW = { id: "as-1", teamId: "t-lead", teamName: "Claims", teamStatus: "ACTIVE", assigneeUserId: null, status: "OPEN", priority: "HIGH", dueAtUtc: "2026-10-01T15:30:00.000Z", overdue: false, note: "check dates", createdAt: "x" };
const TEAMS = {
  teams: [
    { id: "t-lead", name: "Claims", status: "ACTIVE", viewerRole: "LEAD" },
    { id: "t-view", name: "Legal", status: "ACTIVE", viewerRole: "VIEWER" },
    { id: "t-arch", name: "Old", status: "ARCHIVED", viewerRole: "LEAD" },
  ],
  nextCursor: null,
};

before(async () => {
  M = await loadModule("src/ui/team-responsibility.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  requests = [];
  routes = {
    "/v1/collaboration-teams/responsibility": () => ({ assignments: [ROW] }),
    "/v1/collaboration-teams": () => TEAMS,
    "/v1/collaboration-teams/t-lead/members": () => ({ members: [
      { userId: "u-dana", displayName: "Dana", status: "ACTIVE" },
      { userId: "u-gone", displayName: "Former", status: "REMOVED" },
    ] }),
    "/v1/collaboration-teams/t-lead/assignments": () => ({ assignment: { id: "as-2" } }),
    "/v1/collaboration-teams/t-lead/assignments/as-1": () => ({ assignment: { id: "as-1" } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const res = routes[path.split("?")[0]]?.(method);
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (targetType = "CASE") => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.TeamResponsibilityPanel, { targetType, targetId: "rec-1" })));
  await settle();
  return r;
};
const writes = () => requests.filter((q) => q.method !== "GET");

test("the record says which group coordinates it, read from the responsibility authority", async () => {
  const r = await render("EVIDENCE");
  assert.ok(requests.some((q) => q.path === "/v1/collaboration-teams/responsibility?targetType=EVIDENCE&targetId=rec-1"));
  assert.ok(r.byLabel("Open Claims").length === 1);
  assert.ok(r.hasText("High priority"));
  assert.ok(r.hasText("Open"));
  assert.ok(r.hasText("Team-level"));
  assert.ok(r.hasText("Responsibility coordinates work. It does not change who owns this record or who can open it."));
});

test("assign offers only ACTIVE groups the viewer may hand work to, and posts to that group's writer", async () => {
  routes["/v1/collaboration-teams/responsibility"] = () => ({ assignments: [] });
  const r = await render();
  assert.ok(r.hasText("No collaboration team is currently responsible for this record."));
  await r.press("Assign to a team");
  await settle();
  // One assignable group (t-lead) → no team chooser; VIEWER and ARCHIVED are excluded.
  assert.equal(r.byLabel("Team: Legal").length, 0, "a group the viewer cannot assign in was offered");
  assert.equal(r.byLabel("Assignee: Former").length, 0, "an inactive member was offered as assignee");
  await r.press("Assignee: Dana");
  await r.press("Priority: Urgent");
  await r.type("Due", "2026-13-40 99:99");
  assert.ok(r.hasText("Enter the date and time as YYYY-MM-DD HH:MM."));
  await r.press("Save responsibility");
  assert.equal(writes().length, 0, "saved an impossible due date");
  await r.type("Due", "2026-10-02 09:15");
  await r.type("Note", "  coordinate intake  ");
  await r.press("Save responsibility");
  await settle();
  const post = writes()[0];
  assert.equal(post.path, "/v1/collaboration-teams/t-lead/assignments");
  assert.equal(post.method, "POST");
  assert.deepEqual(post.body, {
    targetType: "CASE",
    targetId: "rec-1",
    assigneeUserId: "u-dana",
    priority: "URGENT",
    dueAtUtc: new Date(2026, 9, 2, 9, 15).toISOString(),
    note: "coordinate intake",
  });
  assert.ok(r.hasText("Assigned to the team."));
});

test("edit prefills the due time in LOCAL time and patches the same assignment", async () => {
  const r = await render();
  await r.press("Edit Claims's responsibility");
  await settle();
  const d = new Date(ROW.dueAtUtc);
  const p = (n) => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  assert.equal(r.byLabel("Due").filter((n) => n.props.onChangeText)[0].props.value, local);
  await r.press("Priority: Low");
  await r.press("Save responsibility");
  await settle();
  const patch = writes()[0];
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, "/v1/collaboration-teams/t-lead/assignments/as-1");
  assert.equal(patch.body.dueAtUtc, ROW.dueAtUtc, "an unchanged due time moved on save");
  assert.equal(patch.body.priority, "LOW");
  assert.equal(patch.body.note, "check dates");
});

test("remove asks first, then cancels the group's assignment — the record is untouched", async () => {
  const r = await render();
  await r.press("Remove Claims from this record");
  assert.ok(r.hasText("Remove Claims from this record?"));
  assert.equal(writes().length, 0);
  const confirm = r.byLabel("Remove from team").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.deepEqual(writes()[0], { path: "/v1/collaboration-teams/t-lead/assignments/as-1", method: "PATCH", body: { status: "CANCELLED" } });
});

test("no manage controls on a group the viewer cannot manage; a failed read never blanks the record", async () => {
  routes["/v1/collaboration-teams/responsibility"] = () => ({ assignments: [{ ...ROW, id: "as-9", teamId: "t-view", teamName: "Legal" }] });
  let r = await render();
  assert.equal(r.byLabel("Edit Legal's responsibility").length, 0);
  assert.equal(r.byLabel("Remove Legal from this record").length, 0);
  r.unmount();
  routes["/v1/collaboration-teams/responsibility"] = () => ({ __status: 500 });
  r = await render();
  assert.equal(r.byTestId("team-responsibility-panel").length, 1);
  assert.ok(!r.hasText("No collaboration team is currently responsible"), "a failed read shown as 'none'");
});

test("the CASE screen carries the panel, reading responsibility for that case", async () => {
  const { loadWithProviders, renderInProviders } = await import("./support/render.mjs");
  const CaseScreen = await loadWithProviders("app/(stack)/case/[id].tsx");
  globalThis.__EXPO_PARAMS__ = { id: "case-7" };
  routes["/v1/cases/case-7"] = () => ({ case: { id: "case-7", name: "Roof leak", status: "OPEN" } });
  routes["/v1/evidence"] = () => ({ items: [] });
  routes["/v1/cases/case-7/matter-workspace"] = () => ({});
  const r = await renderInProviders(CaseScreen, h(CaseScreen.default, {}));
  await settle();
  assert.ok(requests.some((q) => q.path === "/v1/collaboration-teams/responsibility?targetType=CASE&targetId=case-7"), "the case never asked who coordinates it");
  assert.equal(r.byTestId("team-responsibility-panel").length, 1);
});
