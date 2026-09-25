/**
 * T-12 / RC-13 — evidence discussion THREADS and their lifecycle
 * (EvidenceDiscussionPanel.tsx + DiscussionThreadLifecycle.tsx; closes the
 * WorkspaceMemberSelect.tsx:189 "Choose a member" row, whose last consumer
 * was thread assignment).
 *
 * Before: native's Discussion tab carried only per-record comments; the
 * record's threads, their messages, and resolve/reopen/assign/escalate were
 * unreachable. Also fixed: a failed comments read said "No comments".
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let thread;

const WS = "33333333-3333-3333-3333-333333333333";
const THREADS = `/v1/collaboration/threads?teamId=${WS}&evidenceId=ev-1`;
const DETAIL = `/v1/collaboration/threads/th-1?teamId=${WS}`;

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  thread = { id: "th-1", title: "Timestamp mismatch", kind: "QUESTION", status: "OPEN", assignedToUserId: null, escalatedAtUtc: null, reopenCount: 0, updatedAt: "2026-09-24T10:00:00Z" };
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes(),
    "/v1/evidence/ev-1/review-workspace": () => ({
      relationships: { items: [] },
      reviewWorkflow: { teamId: WS },
      workspaceCapabilitySnapshot: { discussionEnabled: true, discussionReadOnly: false },
    }),
    "/v1/evidence/ev-1/comments": () => ({ comments: [] }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
    [THREADS]: () => ({ threads: [thread] }),
    [DETAIL]: () => ({ thread, resolutionNote: thread.status === "RESOLVED" ? "Clock drift explained" : null, escalationReason: thread.escalatedAtUtc ? "Needs counsel" : null }),
    [`/v1/collaboration/threads/th-1/messages?teamId=${WS}`]: (method) =>
      method === "POST" ? { message: { id: "m-2" } } : { messages: [{ id: "m-1", body: "Camera clock was off by an hour.", authorKind: "CONTRIBUTOR", contributorLabel: "Site photographer", createdAt: "2026-09-24T09:00:00Z" }] },
    [`/v1/collaboration/threads/th-1/mark-mentions-read?teamId=${WS}`]: () => ({}),
    "/v1/collaboration/threads/th-1/resolve": () => { thread = { ...thread, status: "RESOLVED" }; return {}; },
    "/v1/collaboration/threads/th-1/reopen": () => { thread = { ...thread, status: "OPEN", reopenCount: 1 }; return {}; },
    "/v1/collaboration/threads/th-1/assign": (m, body) => { thread = { ...thread, assignedToUserId: body.assignedToUserId }; return {}; },
    "/v1/collaboration/threads/th-1/escalate": () => { thread = { ...thread, escalatedAtUtc: "2026-09-24T11:00:00Z" }; return {}; },
    [`/v1/teams/${WS}/members`]: () => ({ members: [{ id: "mem-1", userId: "u-dana", role: "ADMIN", status: "ACTIVE", user: { displayName: "Dana", email: "d@example.com" } }], nextCursor: null }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    // Presence heartbeats (every record screen, as on the web) are not this suite's traffic.
    if (!path.startsWith("/v1/me/presence")) requests.push({ path, method, body });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method, body) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const openThread = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Discussion");
  await settle();
  return r;
};
const selectThread = async (r) => {
  await r.press("Timestamp mismatch");
  await settle();
};
const posts = () => requests.filter((q) => q.method === "POST" && !q.path.includes("mark-mentions-read"));

test("the record's threads are listed in its review workspace, with the web's boundary", async () => {
  const r = await openThread();
  assert.ok(requests.some((q) => q.path === THREADS), "threads never read for this record");
  assert.ok(r.hasText("Timestamp mismatch"));
  assert.ok(r.hasText("Posting a message does not change what was preserved about this evidence."));
  await r.press("Thread filter: Resolved");
  assert.ok(r.hasText("No threads match the current filter."));
  await r.press("Thread filter: All");
  await r.type("Filter threads by title", "zzz");
  assert.ok(r.hasText("No threads match the current filter."));
});

test("selecting a thread reads messages, clears mentions, and posts to the audited route", async () => {
  const r = await openThread();
  await selectThread(r);
  assert.ok(r.hasText("Camera clock was off by an hour."));
  assert.ok(r.hasText("Site photographer"));
  assert.ok(requests.some((q) => q.method === "POST" && q.path.includes("mark-mentions-read")), "mentions never cleared");
  await r.type("Post a message", "  Confirmed with the device log.  ");
  await r.press("Post message");
  await settle();
  const post = posts()[0];
  assert.equal(post.path, `/v1/collaboration/threads/th-1/messages?teamId=${WS}`);
  assert.deepEqual(post.body, { teamId: WS, body: "Confirmed with the device log." });
});

test("resolve asks first, posts the note, and announces only what the reread shows", async () => {
  const r = await openThread();
  await selectThread(r);
  await r.press("Resolve thread");
  await r.type("Resolution note (optional, internal)", "Clock drift explained");
  await r.press("Submit: Resolve thread");
  assert.ok(r.hasText("Resolve this thread?"));
  assert.equal(posts().length, 0, "resolved before confirmation");
  const confirm = r.byLabel("Resolve thread").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.deepEqual(posts()[0], { path: "/v1/collaboration/threads/th-1/resolve", method: "POST", body: { teamId: WS, resolutionNote: "Clock drift explained" } });
  assert.ok(r.hasText("Thread resolved. The saved thread was reloaded."));
  assert.ok(r.hasText("Resolution note (internal): Clock drift explained"));
  // Resolved → only Reopen is offered, with a required reason.
  assert.equal(r.byLabel("Resolve thread").length, 0);
  await r.press("Reopen thread");
  assert.ok(r.hasText("Enter the internal reason."));
});

test("assign picks an ACTIVE workspace member and names them after the reread", async () => {
  const r = await openThread();
  await selectThread(r);
  await r.press("Assign thread");
  assert.ok(r.hasText("Choose a workspace member to assign."));
  await r.press("Assign to");
  await settle();
  assert.ok(requests.some((q) => q.path.startsWith(`/v1/teams/${WS}/members`) && q.path.includes("status=ACTIVE")));
  await r.press("Dana");
  await r.press("Submit: Assign thread");
  await settle();
  assert.deepEqual(posts()[0].body, { teamId: WS, assignedToUserId: "u-dana" });
  assert.ok(r.hasText("Thread assigned to Dana. The saved thread was reloaded."));
  assert.ok(r.hasText("Assigned to: Dana"));
});

test("a write the reread does not show is not announced as success", async () => {
  routes["/v1/collaboration/threads/th-1/escalate"] = () => ({}); // accepted, but nothing changes
  const r = await openThread();
  await selectThread(r);
  await r.press("Escalate thread");
  await r.type("Reason (internal)", "Needs counsel");
  await r.press("Submit: Escalate thread");
  const confirm = r.byLabel("Escalate thread").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.ok(!r.hasText("Thread escalated."), "announced a change the server does not show");
  assert.ok(r.hasText("the reloaded thread does not show the change"));
});

test("read-only discussion: history shown, no composer, no lifecycle; no caps → no threads panel", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () => ({
    relationships: { items: [] }, reviewWorkflow: { teamId: WS },
    workspaceCapabilitySnapshot: { discussionEnabled: false, discussionReadOnly: true },
  });
  let r = await openThread();
  assert.ok(r.hasText("Read-only discussion"));
  await selectThread(r);
  assert.ok(r.hasText("Camera clock was off by an hour."));
  assert.equal(r.byLabel("Post a message").length, 0);
  assert.equal(r.byLabel("Resolve thread").length, 0);
  r.unmount();

  routes["/v1/evidence/ev-1/review-workspace"] = () => ({ relationships: { items: [] }, reviewWorkflow: { teamId: WS } });
  requests = [];
  r = await openThread();
  assert.equal(r.byTestId("evidence-discussion").length, 0);
  assert.ok(!requests.some((q) => q.path === THREADS), "threads read for a workspace without discussion");
});

test("a failed comments read is said, not shown as 'No comments'", async () => {
  routes["/v1/evidence/ev-1/comments"] = () => ({ __status: 500 });
  const r = await openThread();
  assert.ok(!r.hasText("No comments on this record yet."), "a failed read was presented as an empty record");
  assert.ok(r.hasText("Comments on this record could not be loaded."));
});

test("thread kinds use the web's curated words, the server's catalog for new kinds, the raw token otherwise", async () => {
  const extra = [
    { ...thread, id: "th-2", title: "Chain of custody", kind: "EVIDENCE_GENERAL" },
    { ...thread, id: "th-3", title: "Hold check", kind: "LEGAL_HOLD_REVIEW" },
    { ...thread, id: "th-4", title: "Mystery", kind: "ODD_KIND" },
  ];
  routes[THREADS] = () => ({ threads: [thread, ...extra] });
  routes["/v1/collaboration/catalogs"] = () => ({ threadKinds: ["EVIDENCE_GENERAL", "LEGAL_HOLD_REVIEW"], threadStatuses: [], threadVisibilities: [], participantRoles: [] });
  const r = await openThread();
  assert.ok(requests.some((q) => q.path === "/v1/collaboration/catalogs"), "the vocabulary was never read");
  assert.ok(r.texts().some((t) => t.startsWith("General")), "curated label not used");
  assert.ok(!r.texts().some((t) => t.includes("Evidence general")), "a curated kind was humanised instead");
  assert.ok(r.texts().some((t) => t.startsWith("Legal hold review")), "a catalog kind was not humanised");
  assert.ok(r.texts().some((t) => t.startsWith("ODD_KIND")), "an unknown kind was not shown as its token");
});

test("a reviewer's message is named from the workspace roster (the server sends only authorUserId)", async () => {
  routes[`/v1/collaboration/threads/th-1/messages?teamId=${WS}`] = () => ({
    messages: [
      { id: "m-1", threadId: "th-1", authorKind: "USER", authorUserId: "u-dana", contributorLabel: null, body: "Checked the clock.", createdAt: "2026-09-24T09:00:00Z" },
      { id: "m-2", threadId: "th-1", authorKind: "USER", authorUserId: "u-gone", contributorLabel: null, body: "Agreed.", createdAt: "2026-09-24T09:05:00Z" },
    ],
  });
  const r = await openThread();
  await selectThread(r);
  assert.ok(r.texts().some((t) => t.startsWith("Dana")), "the author was not named from the roster");
  assert.ok(r.texts().some((t) => t.startsWith("A workspace member")), "an unknown author was not stated honestly");
  assert.ok(!r.texts().some((t) => t.includes("u-gone")), "a raw user id was printed");
});
