/**
 * CLIENT-X — B2B-F-01 (native half).
 *
 * `POST /v1/me/inbox/mark-all-read` now accepts `{ filter?, workspaceId? }`
 * and marks only that population; no body / `{}` stays account-wide. Before:
 * native sent no body whatever was on screen, so "Mark all read" with one
 * workspace and one category selected read every notification in every
 * workspace.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
const ORG = "0b000000-0000-4000-8000-0000000000a1";
const PERSONAL = "0b000000-0000-4000-8000-0000000000a2";
let M;
let requests = [];

const item = {
  itemKey: "report_failure:a", id: "report_failure:a", category: "report_failure", tone: "high", priority: "P2", title: "Report generation failed", body: "",
  href: "/evidence/e1", occurredAt: "2026-09-20T10:00:00.000Z", isRead: false, readAt: null, dismissedAt: null, snoozedUntil: null,
  canMarkRead: true, canDismiss: true, canSnooze: true, dueAt: null, context: { teamId: ORG },
};
const env = () => ({
  generatedAt: "2026-09-25T00:00:00.000Z", degraded: false, degradedSources: [],
  summary: { total: 1, byTone: { critical: 0, high: 1, warning: 0, info: 0 }, byCategory: {}, byPriority: {} },
  scopeSummary: { total: 1, unread: 1, byTone: { high: 1 }, byCategory: { report_failure: 1 }, deadlines: { dueSoon: 0, overdue: 0 } },
  metricSummary: { total: 1, unread: 1, byTone: { high: 1 } },
  truncated: {}, anyTruncated: false,
  completeness: { bySource: {}, anyIncomplete: false, incompleteSources: [], mayAssertAllClear: true },
  pagination: { offset: 0, pageSize: 25, returned: 1, nextCursor: null, totalEstimate: 1, totalIsExact: true, appliedFilter: "all", appliedTone: null },
  items: [item],
});

before(async () => {
  M = await loadModule("app/(tabs)/notifications.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  const routes = {
    ...authenticatedRoutes({
      "/v1/platform/context": () =>
        platformContextEnvelope({
          personalSpace: { id: PERSONAL },
          organizations: [{ id: ORG, displayName: "Harbour Org", membershipStatus: "ACTIVE" }],
        }),
    }),
    "/v1/me/inbox/mark-all-read": () => ({ markedRead: 1, filter: null, workspaceId: null }),
    "/v1/me/inbox": () => env(),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const markAll = () => requests.filter((q) => q.method === "POST" && q.path === "/v1/me/inbox/mark-all-read");
const pressMarkAll = async (r) => {
  const btn = r.byRole("button").find((n) => typeof n.props.accessibilityLabel === "string" && n.props.accessibilityLabel.startsWith("Mark all read"));
  assert.ok(btn, "no Mark all read button");
  await act(async () => { await btn.props.onPress(); });
  await settle();
};

test("B2B-F-01: with a workspace and a category selected, mark-all-read sends that scope", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Filters");
  await r.press("Workspace: Harbour Org");
  await settle();
  await r.press("Type: Reports");
  await settle();
  await pressMarkAll(r);
  assert.equal(markAll().length, 1);
  assert.deepEqual(markAll()[0].body, { filter: "reports", workspaceId: ORG }, "the bulk read ignored the scope on screen");
  r.unmount();
});

test("B2B-F-01: with nothing selected the read stays account-wide ({}), as the count is", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await pressMarkAll(r);
  assert.equal(markAll().length, 1);
  assert.deepEqual(markAll()[0].body ?? {}, {});
  r.unmount();
});

test("B2B-F-01: only bulk-readable categories are sent; \"all\" sends no scope", async () => {
  const V = await loadModule("src/product/inbox-view.ts");
  assert.deepEqual(V.buildMarkAllReadBody({ category: "all", workspaceId: "all" }), {});
  assert.deepEqual(V.buildMarkAllReadBody({ category: "security", workspaceId: ORG }), { filter: "security", workspaceId: ORG });
  for (const state of ["history", "archived", "snoozed"]) {
    assert.deepEqual(V.buildMarkAllReadBody({ category: state, workspaceId: "all" }), {}, state + " would be a 400");
  }
});
