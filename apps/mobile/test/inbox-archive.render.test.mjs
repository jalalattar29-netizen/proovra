/**
 * T-14 — the inbox's Status axis (web inbox/page.tsx:1501): an Archived view
 * (lifecycle=archived), the history chips, and Unarchive. Native could archive
 * a notification but never see it again or bring it back.
 *
 * Status now lives in the Filters panel, as on the web (inbox/page.tsx:1508),
 * and the list is read with the web's axes (`sort` always sent, no pageSize).
 * Item and envelope shapes are the route's (me-inbox.routes.ts InboxItem :490,
 * the archived reply :3578).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const item = (o) => ({
  id: o.itemKey, category: "report_failure", tone: "info", priority: "P4", body: "", href: "/evidence/e1",
  isRead: false, readAt: null, dismissedAt: null, snoozedUntil: null, canMarkRead: true, canDismiss: true, canSnooze: true,
  dueAt: null, context: {}, ...o,
});
const ACTIVE = item({ itemKey: "k-active", title: "Report ready", occurredAt: "2026-09-20T10:00:00.000Z" });
const LOCKED = item({ itemKey: "k-locked", title: "Legal hold placed", occurredAt: "2026-09-20T11:00:00.000Z", category: "governance", isRead: true, canDismiss: false });
const ARCHIVED = item({
  itemKey: "k-arch",
  title: "Upload finished",
  occurredAt: "2026-09-10T10:00:00.000Z",
  isRead: true,
  dismissedAt: "2026-09-12T10:00:00.000Z",
  resolvedAt: "2026-09-11T10:00:00.000Z",
  sourceClearedAt: "2026-09-11T09:00:00.000Z",
});
const envelope = (items, extra = {}) => ({
  summary: { total: items.length, byTone: {}, byCategory: {} },
  metricSummary: { total: items.length, unread: items.filter((i) => !i.isRead).length, byTone: { critical: 0, high: 0, warning: 0, info: items.length } },
  pagination: { offset: 0, pageSize: 25, returned: items.length, nextCursor: null, totalEstimate: items.length, totalIsExact: true, appliedFilter: "all", appliedTone: null },
  items,
  ...extra,
});

before(async () => {
  M = await loadModule("app/(tabs)/notifications.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/me/inbox?lifecycle=archived&sort=newest": () => envelope([ARCHIVED], { historyAvailable: true }),
    "/v1/me/inbox?sort=newest": () => envelope([ACTIVE, LOCKED], { scopeSummary: { total: 2, unread: 1, byTone: {} } }),
    "/v1/me/inbox/items/": () => ({ ok: true }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
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

test("Archive is offered only where the server allows it, in the web's word", async () => {
  const r = await render();
  assert.equal(r.byLabel("Archive: Report ready").length, 1);
  assert.equal(r.byLabel("Archive: Legal hold placed").length, 0, "archive offered on an item the server locks");
  assert.equal(r.byLabel("Dismiss").length, 0);
  r.unmount();
});

test("the Archived view reads the archived half, shows its history, and restores an item", async () => {
  const r = await render();
  await r.press("Filters");
  await r.press("Status: Archived");
  await settle();
  assert.ok(requests.some((q) => q.path === "/v1/me/inbox?lifecycle=archived&sort=newest"), "the archived half was never read");
  assert.ok(r.hasText("Upload finished"));
  assert.ok(r.texts().some((t) => t.includes("No longer active ")), "the resolved history chip is missing");
  assert.ok(r.texts().some((t) => t.includes("Archived ")), "the archived history chip is missing");
  await r.press("Unarchive: Upload finished");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/me/inbox/items/k-arch/unarchive"));
  r.unmount();
});
