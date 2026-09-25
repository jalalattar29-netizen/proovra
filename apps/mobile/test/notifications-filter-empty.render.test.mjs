/**
 * The Notifications empty states — THREE different nothings (web
 * inbox/page.tsx:1760-1815): an inbox with nothing in it, an archive with
 * nothing filed, and filters that matched nothing. The filtered case keeps a
 * way back ("Clear filters"), which is what the T-13 adjudication found native
 * missing.
 *
 * Filtering is the SERVER's now (me-inbox.routes.ts inboxQuerySchema :279), so
 * "nothing matched" is an envelope whose scope population is non-zero while
 * the filtered page is empty.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];

const ITEM = {
  id: "k1", itemKey: "k1", category: "report_failure", tone: "high", priority: "P2", title: "Report failed", body: "Generation stopped.",
  href: "/evidence/e1", occurredAt: "2026-09-24T10:00:00Z", isRead: true, readAt: null, dismissedAt: null, snoozedUntil: null,
  canMarkRead: true, canDismiss: true, canSnooze: true, dueAt: null, context: {},
};
const env = (items, scopeTotal) => ({
  summary: { total: items.length, byTone: {}, byCategory: {} },
  scopeSummary: { total: scopeTotal, unread: 0, byTone: { critical: 0, high: scopeTotal, warning: 0, info: 0 }, byCategory: { report_failure: scopeTotal }, deadlines: { dueSoon: 0, overdue: 0 } },
  metricSummary: { total: items.length, unread: 0, byTone: { critical: 0, high: items.length, warning: 0, info: 0 } },
  pagination: { offset: 0, pageSize: 25, returned: items.length, nextCursor: null, totalEstimate: items.length, totalIsExact: true, appliedFilter: "all", appliedTone: null },
  items,
});
let inbox = () => env([ITEM], 1);

before(async () => {
  M = await loadModule("app/(tabs)/notifications.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  const routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope({ planFeatures: { reportsIncluded: true } }) }),
    "/v1/me/inbox": (path) => inbox(path),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("filters that match nothing show the filtered-empty state, and Clear filters brings the list back", async () => {
  inbox = (path) => (path.includes("filter=reports") ? env([], 1) : env([ITEM], 1));
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.ok(r.hasText("Report failed"));
  await r.press("Filters");
  await r.press("Type: Reports");
  await settle();
  assert.ok(requests.some((p) => p.includes("filter=reports")), "the category filter was not sent to the server");
  assert.ok(r.hasText("No notifications match these filters."), "a filter that hid everything left a blank card");
  assert.ok(r.hasText("Try changing or clearing the active filters."));
  await r.press("Done");
  await r.press("Clear filters");
  await settle();
  assert.ok(r.hasText("Report failed"), "Clear filters did not bring the items back");
  r.unmount();
});

test("an empty inbox says the reader is caught up, with no action", async () => {
  inbox = () => env([], 0);
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.ok(r.hasText("You're all caught up"));
  assert.equal(r.byLabel("Clear filters").length, 0);
  r.unmount();
});

test("an empty archive says what archiving does", async () => {
  inbox = (path) => (path.includes("lifecycle=archived") ? { ...env([], 0), scopeSummary: undefined, summary: { total: 0 }, historyAvailable: true } : env([ITEM], 1));
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Filters");
  await r.press("Status: Archived");
  await settle();
  // The archived reply has no scopeSummary and summary.total 0 (route :3578),
  // which the web reads as "caught up" (inbox/page.tsx:1761) and so never
  // reaches its own archive sentence. Native says what is true.
  assert.ok(r.hasText("No archived notifications."));
  assert.ok(r.hasText("Archiving a notification files it here and takes it out of your active list."));
  assert.ok(!r.hasText("You're all caught up"));
  r.unmount();
});
