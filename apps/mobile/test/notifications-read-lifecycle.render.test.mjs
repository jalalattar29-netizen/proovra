/**
 * NATIVE NOTIFICATIONS — read is a STATE, never a disappearance; All / Unread /
 * Read; and no raw internal code reaches the screen.
 *
 * The native screen and the web page read the same `GET /v1/me/inbox` contract
 * and the same presentation authority (`@proovra/shared` notification
 * presentation). The server behaviour itself is proven against live PostgreSQL
 * in services/api/test/inbox-notification-lifecycle.integration.test.ts.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let rows;
let incompleteSources;

const row = (o) => ({
  id: o.itemKey, tone: "info", priority: "P3", body: "Details.", href: "/evidence/e1",
  occurredAt: "2026-09-20T10:00:00.000Z", readAt: null, dismissedAt: null, snoozedUntil: null,
  canMarkRead: true, canDismiss: true, canSnooze: true, dueAt: null, context: {}, ...o,
});

function envelope(path) {
  const url = new URL(path, "http://x");
  const readState = url.searchParams.get("readState");
  const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
  const population = rows.filter((r) => (readState === "unread" ? !r.isRead : readState === "read" ? r.isRead : true));
  const unread = rows.filter((r) => !r.isRead).length;
  const items = population.slice(0, pageSize);
  return {
    generatedAt: "2026-09-25T00:00:00.000Z",
    degraded: false,
    degradedSources: [],
    summary: { total: population.length, byTone: { critical: 0, high: 0, warning: 0, info: rows.length }, byCategory: {}, byPriority: {} },
    scopeSummary: { total: rows.length, unread, workload: rows.length, guidance: 0, byTone: { critical: 0, high: 0, warning: 0, info: rows.length }, byCategory: {}, deadlines: { dueSoon: 0, overdue: 0 } },
    metricSummary: { total: rows.length, unread, byTone: { critical: 0, high: 0, warning: 0, info: rows.length } },
    truncated: {},
    anyTruncated: false,
    completeness: { bySource: {}, anyIncomplete: incompleteSources.length > 0, incompleteSources, mayAssertAllClear: incompleteSources.length === 0 },
    pagination: { offset: 0, pageSize, returned: items.length, nextCursor: null, totalEstimate: population.length, totalIsExact: true, appliedFilter: "all", appliedTone: null },
    items,
  };
}

before(async () => {
  M = await loadModule("app/(tabs)/notifications.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/inbox.ts"]);
});

beforeEach(async () => {
  requests = [];
  incompleteSources = [];
  M.calls.reset();
  rows = [
    row({ itemKey: "discussion_mention:m1", category: "discussion_mention", title: "You were mentioned", isRead: false }),
    row({ itemKey: "collaboration:c1", category: "collaboration", title: "Team update", isRead: true }),
    row({ itemKey: "future_kind:f1", category: "future_kind", title: "Something new", isRead: false }),
  ];
  const routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope() }),
    "/v1/me/inbox/items/": (path, init) => {
      const m = path.match(/\/v1\/me\/inbox\/items\/([^/]+)\/(read|unread)$/);
      const target = m ? rows.find((r) => r.itemKey === decodeURIComponent(m[1])) : null;
      if (target && init.method === "POST") target.isRead = m[2] === "read";
      return { itemKey: target?.itemKey ?? "x", isRead: target?.isRead ?? false, readAt: null, dismissedAt: null, snoozedUntil: null };
    },
    "/v1/me/inbox": (path) => envelope(path),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const inboxReads = () => requests.filter((q) => q.method === "GET" && q.path.startsWith("/v1/me/inbox?")).map((q) => q.path);
const RAW = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[a-z]+_[a-z_]+\b/;

test("opens on All, offers All / Unread / Read, and Read asks the server for readState=read", async () => {
  const r = await render();
  assert.ok(!inboxReads()[0].includes("readState"), inboxReads()[0]);
  assert.ok(r.hasText("You were mentioned") && r.hasText("Team update"), "All holds read and unread");
  assert.equal(r.byLabel("Read: 1").length, 1, "the Read card counts the read population");
  await r.press("Show: Read");
  await settle();
  assert.ok(inboxReads().some((p) => p.includes("readState=read")), inboxReads().join("\n"));
  assert.ok(r.hasText("Team update"));
  assert.ok(!r.hasText("You were mentioned"));
  r.unmount();
});

test("Mark as read keeps the row in All, and the Unread card reconciles from the server", async () => {
  const r = await render();
  assert.equal(r.byLabel("Unread: 2").length, 1);
  await r.press("Mark as read: You were mentioned");
  await settle();
  assert.ok(r.hasText("You were mentioned"), "read must not remove the row from All");
  assert.equal(r.byLabel("Mark as unread: You were mentioned").length, 1);
  assert.equal(r.byLabel("Unread: 1").length, 1, "the count above the list did not move");
  assert.equal(r.byLabel("Read: 2").length, 1);
  r.unmount();
});

test("in the Unread view a row read there leaves THAT view only", async () => {
  const r = await render();
  await r.press("Show: Unread");
  await settle();
  assert.ok(r.hasText("You were mentioned"));
  await r.press("Mark as read: You were mentioned");
  await settle();
  assert.ok(!r.hasText("You were mentioned"));
  r.unmount();
});

test("categories and sources are named through the shared authority — never their codes", async () => {
  incompleteSources = ["discussion_mention", "some_new_source"];
  const r = await render();
  assert.equal(r.byLabel("Mention").length, 1);
  assert.equal(r.byLabel("Collaboration").length, 1);
  assert.equal(r.byLabel("Notification").length, 1, "an unknown category reads as a neutral label");
  assert.equal(r.byLabel("future_kind").length, 0);
  assert.ok(r.hasText("Some sources could not be read, so this may not be everything. Affected: Mention, Other notifications."));
  for (const t of r.texts()) assert.doesNotMatch(t, RAW, t);
  r.unmount();
});
