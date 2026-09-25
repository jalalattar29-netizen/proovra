/**
 * NOTIFICATIONS PARITY — the canonical inbox page (apps/web/app/(app)/inbox/
 * page.tsx) on the device, against the route's REAL envelope
 * (services/api/src/routes/me-inbox.routes.ts GET /v1/me/inbox reply :3902-3966;
 * InboxItem :490; query schema :279).
 *
 * Native fetched one page of 50 and filtered/sorted the rows it held, so page
 * 2 did not exist and a filter spoke only for page 1. It had no metric cards,
 * no sort, no category filters beyond three substring guesses, no pagination
 * summary, no degraded-source honesty, no row body/tone/due date, and no
 * per-item Mark as read.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let inbox;
let platform;

const item = (o) => ({
  id: o.itemKey, category: "report_failure", tone: "info", priority: "P4", body: "", href: "/evidence/e1",
  occurredAt: "2026-09-20T10:00:00.000Z", isRead: false, readAt: null, dismissedAt: null, snoozedUntil: null,
  canMarkRead: true, canDismiss: true, canSnooze: true, dueAt: null, context: {}, ...o,
});
const A = item({ itemKey: "report_failure:a", title: "Report generation failed", body: "The report for Invoice.pdf could not be built.", tone: "high", dueAt: "2020-01-01T00:00:00.000Z", snoozedUntil: "2099-01-01T00:00:00.000Z" });
const B = item({ itemKey: "org_invite:b", title: "Invitation to Acme", category: "org_invite", isRead: true, href: "/organizations/org-1" });
const C = item({ itemKey: "security_event_high:c", title: "New sign-in", category: "security_event_high", href: "/security-center/x" });

const env = (items, extra = {}) => ({
  generatedAt: "2026-09-25T00:00:00.000Z",
  degraded: false,
  degradedSources: [],
  summary: { total: 7, byTone: { critical: 1, high: 2, warning: 0, info: 4 }, byCategory: {}, byPriority: {} },
  scopeSummary: { total: 7, unread: 3, workload: 7, guidance: 0, byTone: { critical: 1, high: 2, warning: 0, info: 4 }, byCategory: { report_failure: 1, org_invite: 1 }, deadlines: { dueSoon: 0, overdue: 1 } },
  metricSummary: { total: 7, unread: 3, byTone: { critical: 1, high: 2, warning: 0, info: 4 } },
  truncated: {},
  anyTruncated: false,
  completeness: { bySource: {}, anyIncomplete: false, incompleteSources: [], mayAssertAllClear: true },
  pagination: { offset: 0, pageSize: 25, returned: items.length, nextCursor: null, totalEstimate: 7, totalIsExact: true, appliedFilter: "all", appliedTone: null },
  items,
  ...extra,
});

before(async () => {
  M = await loadModule("app/(tabs)/notifications.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/inbox.ts"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.reset();
  inbox = () => env([A, B, C]);
  platform = () => platformContextEnvelope();
  const routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platform() }),
    "/v1/me/inbox/items/": () => ({ itemKey: "x", isRead: true, readAt: null, dismissedAt: null, snoozedUntil: null }),
    "/v1/me/inbox/mark-all-read": () => ({ updated: 3 }),
    "/v1/me/inbox": (path) => inbox(path),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const inboxReads = () => requests.filter((q) => q.method === "GET" && q.path.startsWith("/v1/me/inbox?")).map((q) => q.path);

test("the notification summary: six metric cards from metricSummary, each with the web's explanation", async () => {
  const r = await render();
  assert.equal(r.byLabel("Notification summary").length, 1);
  for (const [label, value] of [["All", 7], ["Unread", 3], ["Critical", 1], ["High", 2], ["Warning", 0], ["Info", 4]]) {
    assert.equal(r.byLabel(`${label}: ${value}`).length, 1, `metric card ${label}=${value} missing`);
  }
  assert.ok(r.hasText("Everything currently addressed to you."));
  assert.ok(r.hasText("Needs attention now."));
  assert.ok(r.hasText("Updates, assignments, mentions and integrity alerts relevant to you."));
  r.unmount();
});

test("the cards are ONE primary view on the wire: Unread then High asks for High, never the intersection", async () => {
  const r = await render();
  assert.equal(inboxReads()[0], "/v1/me/inbox?sort=newest", "the first read must send the sort and nothing else");
  await r.press("Unread: 3");
  await settle();
  assert.ok(inboxReads().includes("/v1/me/inbox?readState=unread&sort=newest"));
  await r.press("High: 2");
  await settle();
  const last = inboxReads().at(-1);
  assert.equal(last, "/v1/me/inbox?tone=high&sort=newest");
  r.unmount();
});

test("sorting is the server's: choosing Oldest first re-reads with sort=oldest", async () => {
  const r = await render();
  await r.press("Sort: Oldest first");
  await settle();
  assert.equal(inboxReads().at(-1), "/v1/me/inbox?sort=oldest");
  r.unmount();
});

test("advanced filters follow the server's eligibility, plus the actual-item override", async () => {
  const r = await render();
  await r.press("Filters");
  // Universal core and item-revealed filters show; plan-gated ones without an item do not.
  assert.equal(r.byLabel("Evidence & integrity: Integrity").length, 1);
  assert.equal(r.byLabel("Type: Security").length, 1);
  assert.equal(r.byLabel("Type: Reports").length, 1, "a real report_failure item must reveal Reports");
  assert.equal(r.byLabel("Type: Invitations").length, 1, "a real org_invite item must reveal Invitations");
  assert.equal(r.byLabel("Time & urgency: Overdue").length, 1, "a real overdue deadline must reveal Overdue");
  assert.equal(r.byLabel("Type: Intake").length, 0, "Intake shown without the plan or an item");
  // report_failure is also an ADMIN member (operationsFilterPolicy hasActualItem), so it reveals Admin.
  assert.equal(r.byLabel("Type: Admin").length, 1);
  r.unmount();

  // Without any item, neither the plan-gated nor the role-gated filters show.
  const base = env([A]);
  inbox = () => ({ ...base, scopeSummary: { ...base.scopeSummary, byCategory: {}, deadlines: { dueSoon: 0, overdue: 0 } } });
  const r1 = await render();
  await r1.press("Filters");
  assert.equal(r1.byLabel("Type: Reports").length, 0, "Reports shown without the plan or an item");
  assert.equal(r1.byLabel("Type: Admin").length, 0, "Admin shown to a non-admin");
  assert.equal(r1.byLabel("Time & urgency: Overdue").length, 0);
  r1.unmount();

  platform = () => platformContextEnvelope({ planFeatures: { intakeIncluded: true }, operationalEligibility: { security: { hasAdminSurface: true } } });
  const r2 = await render();
  await r2.press("Filters");
  assert.equal(r2.byLabel("Type: Intake").length, 1);
  assert.equal(r2.byLabel("Type: Admin").length, 1);
  r2.unmount();
});

test("a category filter is sent, counted on the Filters control, and removable from the active-filter row", async () => {
  const r = await render();
  await r.press("Filters");
  await r.press("Type: Reports");
  await r.press("Done");
  await settle();
  assert.equal(inboxReads().at(-1), "/v1/me/inbox?filter=reports&sort=newest");
  assert.ok(r.hasText("Filters (1)"));
  assert.equal(r.byLabel("Active filters").length, 1);
  await r.press("Remove Reports filter");
  await settle();
  assert.equal(inboxReads().at(-1), "/v1/me/inbox?sort=newest");
  assert.equal(r.byLabel("Active filters").length, 0);
  r.unmount();
});

test("Archived disables Unread (archiving marks read) and moves an Unread view back to All", async () => {
  const r = await render();
  await r.press("Unread: 3");
  await settle();
  await r.press("Filters");
  await r.press("Status: Archived");
  await settle();
  assert.equal(inboxReads().at(-1), "/v1/me/inbox?lifecycle=archived&sort=newest");
  assert.ok(r.hasText("Archived notifications are always marked read."));
  r.unmount();
});

test("the workspace narrowing appears only for a reader with somewhere else to switch to", async () => {
  platform = () => platformContextEnvelope({
    personalSpace: { id: "11111111-1111-1111-1111-111111111111" },
    organizations: [{ id: "22222222-2222-2222-2222-222222222222", name: "Acme", displayName: "Acme", membershipStatus: "ACTIVE" }],
  });
  const r = await render();
  await r.press("Filters");
  await r.press("Workspace: Acme");
  await settle();
  assert.equal(inboxReads().at(-1), "/v1/me/inbox?workspaceId=22222222-2222-2222-2222-222222222222&sort=newest");
  r.unmount();
});

test("the result count is honest: exact totals say 'of N', capped ones say more may exist", async () => {
  const r = await render();
  assert.ok(r.hasText("Showing 3 of 7 notifications"));
  r.unmount();
  inbox = () => env([A], {
    anyTruncated: true,
    truncated: { report_failure: true, governance: false },
    pagination: { offset: 0, pageSize: 25, returned: 1, nextCursor: null, totalEstimate: 1, totalIsExact: false, appliedFilter: "all", appliedTone: null },
    completeness: { bySource: {}, anyIncomplete: true, incompleteSources: ["governance"], mayAssertAllClear: false },
  });
  const r2 = await render();
  assert.ok(r2.hasText("Showing 1 notification (more may exist)"));
  assert.ok(r2.hasText("Some sources were capped: Report failures. Open the relevant console for the full list."));
  assert.ok(r2.hasText("Some sources could not be read, so this may not be everything. Affected: governance."));
  r2.unmount();
});

test("the server's cursor pages the list: Load more appends page 2", async () => {
  inbox = (path) =>
    path.includes("cursor=")
      ? env([C], { pagination: { offset: 2, pageSize: 25, returned: 1, nextCursor: null, totalEstimate: 3, totalIsExact: true, appliedFilter: "all", appliedTone: null } })
      : env([A, B], { pagination: { offset: 0, pageSize: 25, returned: 2, nextCursor: "Mg==", totalEstimate: 3, totalIsExact: true, appliedFilter: "all", appliedTone: null } });
  const r = await render();
  assert.ok(!r.hasText("New sign-in"));
  await r.press("Load more");
  await settle();
  assert.ok(inboxReads().includes("/v1/me/inbox?sort=newest&cursor=Mg%3D%3D"));
  assert.ok(r.hasText("Report generation failed") && r.hasText("New sign-in"), "page 2 did not append");
  assert.ok(r.hasText("Showing 3 of 3 notifications"));
  r.unmount();
});

test("a row carries its tone, category, body, due date and reminder, as the web row does", async () => {
  const r = await render();
  assert.equal(r.byLabel("HIGH").length, 1);
  assert.equal(r.byLabel("Report failure").length, 1);
  assert.equal(r.byLabel("Invite").length, 1);
  assert.ok(r.hasText("The report for Invoice.pdf could not be built."));
  assert.ok(r.texts().some((t) => t.includes("Overdue · ")), "the overdue deadline is missing");
  assert.ok(r.texts().some((t) => t.includes("Reminder set for ")), "the reminder is missing");
  assert.equal(r.byLabel("Later").length, 0, "the web withdrew the remind action from the UI");
  r.unmount();
});

test("Mark as read / Mark as unread per item, through the canonical endpoints", async () => {
  const r = await render();
  await r.press("Mark as read: Report generation failed");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/me/inbox/items/report_failure%3Aa/read"));
  assert.equal(r.byLabel("Mark as unread: Report generation failed").length, 1);
  await r.press("Mark as unread: Invitation to Acme");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/me/inbox/items/org_invite%3Ab/unread"));
  r.unmount();
});

test("Open goes to the native destination and marks the item read; a row with no destination has no Open", async () => {
  const r = await render();
  await r.press("Open: Invitation to Acme");
  assert.deepEqual(M.calls.push, ["/organizations/org-1"]);
  await r.press("Open: Report generation failed");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/me/inbox/items/report_failure%3Aa/read"));
  assert.equal(r.byLabel("Open: New sign-in").length, 0, "a security-center href has no native screen");
  r.unmount();
});

test("loading and error states say what the web says, and Retry re-reads", async () => {
  let fail = true;
  inbox = () => (fail ? undefined : env([A]));
  const r = await render();
  assert.ok(r.hasText("Couldn’t load inbox."));
  assert.ok(r.texts().some((t) => t.startsWith("HTTP 500: ")));
  fail = false;
  await r.press("Retry");
  await settle();
  assert.ok(r.hasText("Report generation failed"));
  r.unmount();
});

test("the archived read in an environment without the snapshot store says so", async () => {
  inbox = (path) =>
    path.includes("lifecycle=archived")
      ? { generatedAt: "x", degraded: false, degradedSources: [], historyAvailable: false, summary: { total: 0, byTone: {}, byCategory: {}, byPriority: {} }, metricSummary: { total: 0, unread: 0, byTone: { critical: 0, high: 0, warning: 0, info: 0 } }, truncated: {}, anyTruncated: false, pagination: { offset: 0, pageSize: 25, returned: 0, nextCursor: null, totalEstimate: 0, totalIsExact: true, appliedFilter: "all", appliedTone: null }, items: [] }
      : env([A]);
  const r = await render();
  await r.press("Filters");
  await r.press("Status: Archived");
  await settle();
  assert.ok(r.hasText("Archived notifications are not available in this environment yet."));
  r.unmount();
});

test("inbox hrefs the route emits map onto the native screens that exist", async () => {
  const { resolveInboxRoute } = M;
  assert.equal(resolveInboxRoute("/evidence-requests/r1"), "/evidence-request/r1");
  assert.equal(resolveInboxRoute("/organizations/o1"), "/organizations/o1");
  assert.equal(resolveInboxRoute("/organizations"), "/organizations");
  assert.equal(resolveInboxRoute("/settings/security"), "/settings/security");
  assert.equal(resolveInboxRoute("/intake-links?linkId=l1"), "/intake-links");
  assert.equal(resolveInboxRoute("/reviewer-ops/w1"), null);
  assert.equal(resolveInboxRoute("/security-center/mfa-recovery?requestId=1"), null);
});
