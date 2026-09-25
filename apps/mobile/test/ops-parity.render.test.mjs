/**
 * OPERATIONS + WORKSPACE HEALTH — web parity pass (2026-09-25).
 *
 * Each test names the web source it holds native to, and every stub is the
 * server's own reply shape:
 *   /v1/ops/summary            ops.routes.ts:936-939  { summary, workspace: { operatorCount } }
 *   /v1/ops/incidents          ops.routes.ts:1118-1141 { incidents, sla, pagination, completeness }
 *   /v1/ops/incident-groups    ops.routes.ts:1261     { groups, totals }
 *   /v1/ops/incidents/:id      ops.routes.ts:1467-1470 { incident, remediation }  (404 { error: { code } })
 *   group.affectedUnit         operations-grouping.service.ts:481-486 ("records" | source unit, e.g. "conditions")
 *   /v1/teams/:id/operations/* workspace-operations.routes.ts:133,196
 *   /v1/runtime/status         { status }
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let OPS;
let HEALTH;
let BANNER;
let requests = [];
let handlers = {};

before(async () => {
  OPS = await loadModule("app/(stack)/operations/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/ops-console.ts"]);
  HEALTH = await loadModule("app/(stack)/operations/health.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  BANNER = await loadModule("src/ui/runtime-status-banner.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

/** handlers: "METHOD /path-prefix" → (req) => ({ status?, body }) | Promise<…> */
function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = { path, method, headers, body: init.body ? JSON.parse(init.body) : null };
    requests.push(req);
    const key = Object.keys(handlers)
      .filter((k) => {
        const [m, p] = k.split(" ");
        return m === method && path.startsWith(p);
      })
      .sort((a, b) => b.length - a.length)[0];
    const res = key ? await handlers[key](req) : { status: 500, body: { message: "unstubbed" } };
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const TEAM = "team-1";
const OPS_CAPS = {
  OPERATIONS_VIEW: true,
  WORKSPACE_HEALTH_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
  OPERATIONS_ASSIGN: true,
};
function opsEnvelope(overrides = {}) {
  return platformContextEnvelope({
    activeSpace: { id: TEAM, type: "ORGANIZATION", displayName: "Acme Legal", status: "active" },
    workspace: { id: TEAM, status: "active" },
    account: { userId: "user-1", accountStatus: "active" },
    capabilities: OPS_CAPS,
    ...overrides,
  });
}

const INCIDENT = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "UPLOAD",
  severity: "HIGH",
  status: "OPEN",
  title: "Uploads are failing",
  safeSummary: "Three uploads failed their integrity check.",
  occurrenceCount: 3,
  firstSeenAtUtc: "2026-09-24T08:00:00.000Z",
  lastSeenAtUtc: "2026-09-24T09:00:00.000Z",
  requestId: "req-incident-1",
  traceId: null,
  relatedEvidenceId: "ev-9",
  relatedJobId: null,
  relatedProvider: null,
  assignedOperatorUserId: "user-2",
  lifecycle: { resolutionAuthority: "OPERATOR_DECISION", manualResolution: true },
  metric: null,
  sla: null,
};

const GROUP = {
  groupKey: "g-retry",
  sourceId: "workflow.retry_storm",
  category: "WORKER",
  title: "Repeated retries",
  conditionCount: 1,
  affectedRecordCount: 36,
  affectedUnit: "conditions",
  observations: 4,
  durationSeconds: null,
  lastObservedAtUtc: "2026-09-24T09:00:00.000Z",
  severity: "WARNING",
  statusPosture: "OPEN",
  firstSeenAtUtc: "2026-09-24T08:00:00.000Z",
  lastSeenAtUtc: "2026-09-24T09:00:00.000Z",
  latestActivityAtUtc: "2026-09-24T09:00:00.000Z",
  assignedCount: 0,
  failureGroups: [],
  affectedSample: [],
  hasMoreAffected: false,
  availableActions: ["acknowledge", "assign", "suppress"],
  metric: {
    currentValue: 36,
    unit: "conditions",
    thresholdValue: 20,
    criticalThresholdValue: null,
    observedAtUtc: "2026-09-24T09:00:00.000Z",
    stale: false,
    contract: "AGGREGATE_THRESHOLD",
  },
};

const summaryBody = (extra = {}) => ({
  summary: { open: 1, critical: 0, high: 1, warning: 0, slaBreached: 0, slaAtRisk: 0, resolved: 4, assignedToMe: 0, unassigned: 0, complete: true, mayAssertAllClear: false, readiness: "READY", ...extra },
  workspace: { operatorCount: 2 },
});
const listBody = (incidents, nextCursor = null) => ({
  incidents,
  sla: { postures: ["BREACHED", "AT_RISK", "ON_TRACK"], attentionPostures: ["BREACHED", "AT_RISK"] },
  pagination: { nextCursor, returned: incidents.length },
  completeness: { complete: nextCursor === null, mayAssertAllClear: nextCursor === null },
});

function healthyOps() {
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({ body: opsEnvelope() }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/ops/summary": () => ({ body: summaryBody() }),
    "GET /v1/ops/incidents/": () => ({
      body: { incident: { ...INCIDENT, timeline: [{ id: "t1", eventType: "opened", safeMessage: "First seen", occurredAtUtc: INCIDENT.firstSeenAtUtc }], timelineComplete: true }, remediation: null },
    }),
    "GET /v1/ops/incidents": () => ({ body: listBody([INCIDENT]) }),
    "GET /v1/ops/incident-groups": () => ({ body: { groups: [GROUP], totals: { groups: 1, conditions: 1 } } }),
    "GET /v1/ops/assignable-operators": () => ({
      body: { operators: [{ userId: "user-1", displayName: "Me Myself", role: "OWNER" }, { userId: "user-2", displayName: "Dana", role: "ADMIN" }], selfUserId: "user-1" },
    }),
    "GET /v1/ops/saved-views": () => ({ body: { views: [] } }),
  };
}

beforeEach(async () => {
  requests = [];
  healthyOps();
  installFetch();
  OPS.calls.reset();
  BANNER.calls.reset();
  globalThis.__CLIPBOARD__ = undefined;
  await signIn(OPS);
  await signIn(HEALTH);
  await signIn(BANNER);
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function settleN(n = 4) {
  for (let i = 0; i < n; i += 1) await settle();
}
async function renderOps() {
  const r = await renderComponent(h(OPS.TestProviders, null, h(OPS.default, {})));
  await settleN();
  return r;
}
async function flatList(r) {
  await r.press("View: All conditions");
  await settleN(2);
}

/* -------------------------------------------------------------- groups */

test("a group's affected count speaks the server's unit: 'conditions' is not 'records' (GroupSurface describeAffected)", async () => {
  const r = await renderOps();
  assert.ok(r.hasText("Repeated retries"));
  assert.ok(r.hasText("36 repeatedly observed conditions"), r.texts().join(" | "));
  assert.ok(!r.hasText("36 affected records"), "a conditions-unit group was described as records");
  assert.equal(OPS.groupQuantity({ ...GROUP, affectedUnit: "workflows" }), "36 affected workflows");
  r.unmount();
});

test("grouped emptiness is decided by the GROUPS: an empty flat page never paints 'clear' over real groups (P:1808)", async () => {
  handlers["GET /v1/ops/summary"] = () => ({ body: summaryBody({ mayAssertAllClear: true }) });
  handlers["GET /v1/ops/incidents"] = () => ({ body: listBody([]) });
  const r = await renderOps();
  assert.ok(r.hasText("Repeated retries"), "the group must render");
  assert.ok(!r.hasText("Workspace operations are clear"), "an all-clear rendered over a real group");
  r.unmount();
});

test("a grouped read still in flight is LOADING, not an empty queue (P:1799-1807)", async () => {
  let release;
  handlers["GET /v1/ops/summary"] = () => ({ body: summaryBody({ mayAssertAllClear: true }) });
  handlers["GET /v1/ops/incidents"] = () => ({ body: listBody([]) });
  handlers["GET /v1/ops/incident-groups"] = () => new Promise((res) => { release = () => res({ body: { groups: [], totals: { groups: 0, conditions: 0 } } }); });
  const r = await renderOps();
  assert.ok(!r.hasText("Workspace operations are clear"), "a pending grouped read rendered an all-clear");
  assert.ok(!r.hasText("No operational conditions match these filters"), "a pending grouped read rendered no-match");
  assert.ok(r.hasText("Loading operational conditions…"));
  release();
  await settleN();
  assert.ok(r.hasText("Workspace operations are clear"), "once the read answers empty, the server-permitted clear shows");
  r.unmount();
});

/* ------------------------------------------------------------ the rows */

test("a row states owner, first seen and latest activity — not a truncated second line (C/IncidentSurface card)", async () => {
  const r = await renderOps();
  await flatList(r);
  assert.ok(r.byTestId(`ops-incident-${INCIDENT.id}`).length > 0);
  const texts = r.texts();
  assert.ok(texts.includes("Owner") && texts.includes("Dana"), "owner fact missing");
  assert.ok(texts.includes("First seen") && texts.includes("Latest activity"), "time facts missing");
  assert.ok(texts.some((t) => t.includes("Observed in 3 checks")), "observations missing");
  r.unmount();
});

test("the row menu: Actions → Resolve posts the lifecycle transition (C/IncidentSurface buildActions)", async () => {
  handlers["POST /v1/ops/incidents/"] = () => ({ body: { ok: true } });
  const r = await renderOps();
  await flatList(r);
  await r.press(`Actions for ${INCIDENT.title}`);
  const menu = r.byTestId(`ops-row-menu-${INCIDENT.id}`)[0];
  const labels = menu.findAll((n) => typeof n.type === "string" && n.props.accessibilityLabel).map((n) => n.props.accessibilityLabel);
  assert.deepEqual(labels, ["Open details", "Change owner", "Acknowledge", "Resolve", "Stop notifying about this"]);
  await r.press("Resolve");
  await settleN(2);
  const post = requests.find((q) => q.method === "POST" && q.path.endsWith("/resolve"));
  assert.ok(post, "resolve never reached the API");
  assert.equal(post.path, `/v1/ops/incidents/${INCIDENT.id}/resolve`);
  assert.deepEqual(post.body, { teamId: TEAM });
  r.unmount();
});

test("Load 50 more is the page-size label and appends the next page (P:1851-1861)", async () => {
  let n = 0;
  handlers["GET /v1/ops/incidents"] = (req) => {
    n += 1;
    return req.path.includes("cursor=c2")
      ? { body: listBody([{ ...INCIDENT, id: "22222222-2222-4222-8222-222222222222", title: "Second page row" }]) }
      : { body: listBody([INCIDENT, { ...INCIDENT, id: "33333333-3333-4333-8333-333333333333", title: "Another row" }], "c2") };
  };
  const r = await renderOps();
  await flatList(r);
  assert.ok(r.hasText("2+ conditions"), "a page with more behind it is counted as a floor");
  await r.press("Load 50 more");
  await settleN(2);
  assert.ok(r.hasText("Second page row") && r.hasText("Uploads are failing"));
  assert.ok(n >= 2);
  r.unmount();
});

/* ----------------------------------------------------------- inspector */

test("a failed history read keeps the condition on screen, with its support reference (P:707-728 + IncidentInspector)", async () => {
  handlers["GET /v1/ops/incidents/"] = () => ({ status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", requestId: "req-detail-77" } } });
  const r = await renderOps();
  await flatList(r);
  await r.press(INCIDENT.title);
  await settleN(3);
  assert.ok(r.hasText("What happened"), "the condition was blanked by a failed history read");
  assert.ok(r.hasText("Three uploads failed their integrity check."));
  assert.ok(r.hasText("The history could not be loaded, so what is shown here is not the full record."));
  assert.ok(r.hasText("req-detail-77"), "the support reference is missing");
  r.unmount();
});

test("technical references carry their own Copy control (IncidentInspector Identifier)", async () => {
  const r = await renderOps();
  await flatList(r);
  await r.press(INCIDENT.title);
  await settleN(3);
  assert.ok(r.hasText("Technical references"));
  await r.press("Copy request");
  await settle();
  assert.equal(globalThis.__CLIPBOARD__, "req-incident-1");
  r.unmount();
});

/* ------------------------------------------------------ page-level states */

test("a failed summary hides the cards and says so with a support reference (P:1562-1569, P:1675)", async () => {
  handlers["GET /v1/ops/summary"] = () => ({ status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", requestId: "req-sum-5" } } });
  const r = await renderOps();
  assert.ok(r.hasText("The queue summary could not be loaded."));
  assert.equal(r.byLabel("Unresolved: —").length, 0, "cards of dashes rendered over a failed summary");
  assert.ok(!r.hasText("Queue summary"), "the summary section rendered without a summary");
  assert.ok(r.hasText("req-sum-5"), "the support reference is missing");
  assert.ok(r.hasText("Uploads are failing") || r.hasText("Repeated retries"), "the queue must survive a failed summary");
  r.unmount();
});

test("Refresh reads 'Refreshing…' and is disabled while a re-read is in flight (P:1472-1481)", async () => {
  const r = await renderOps();
  let release;
  handlers["GET /v1/ops/incidents"] = () => new Promise((res) => { release = () => res({ body: listBody([INCIDENT]) }); });
  await r.press("Refresh");
  await settle();
  assert.equal(r.byLabel("Refreshing…").length > 0, true, "the header does not say it is refreshing");
  assert.ok(r.byTestId("ops-refreshing").length > 0);
  release();
  await settleN();
  assert.ok(r.byLabel("Refresh").length > 0);
  r.unmount();
});

/* --------------------------------------------------------------- health */

test("Workspace health is gated on WORKSPACE_HEALTH_VIEW: no capability, no read (routeRegistry.ts:1164-1172)", async () => {
  const caps = { ...OPS_CAPS };
  delete caps.WORKSPACE_HEALTH_VIEW;
  handlers["GET /v1/platform/context"] = () => ({ body: opsEnvelope({ capabilities: caps }) });
  const r = await renderComponent(h(HEALTH.TestProviders, null, h(HEALTH.default, {})));
  await settleN();
  assert.ok(r.hasText("Permission required"));
  assert.equal(requests.filter((q) => q.path.includes("/operations/")).length, 0, "a denied actor still read workspace health");
  r.unmount();

  const ops = await renderOps();
  assert.equal(ops.byLabel("Workspace health").length, 0, "the queue linked to a surface the actor may not open");
  ops.unmount();
});

test("with WORKSPACE_HEALTH_VIEW the queue links to Workspace health and the page reads it", async () => {
  handlers["GET /v1/teams/team-1/operations/health"] = () => ({
    body: { scope: "WORKSPACE", workspaceId: TEAM, state: "DEGRADED", openIncidents: { total: 1, bySeverity: { HIGH: 1 } }, unresolvedIncidents: 1, lastIncidentActivityUtc: null, evaluatedAtUtc: "2026-09-24T10:00:00.000Z" },
  });
  handlers["GET /v1/teams/team-1/operations/alerts"] = () => ({ body: { scope: "WORKSPACE", workspaceId: TEAM, items: [], counts: { total: 0, critical: 0, high: 0 }, evaluatedAtUtc: "2026-09-24T10:00:00.000Z" } });
  const ops = await renderOps();
  await ops.press("Workspace health");
  assert.deepEqual(OPS.calls.push.at(-1), "/operations/health");
  ops.unmount();
  const r = await renderComponent(h(HEALTH.TestProviders, null, h(HEALTH.default, {})));
  await settleN();
  assert.ok(r.hasText("Degraded"));
  assert.ok(requests.some((q) => q.path === "/v1/teams/team-1/operations/health"));
  r.unmount();
});

/* ------------------------------------------------------ runtime banner */

async function renderBanner(status) {
  handlers["GET /v1/runtime/status"] = () => ({ body: { status } });
  const r = await renderComponent(h(BANNER.TestProviders, null, h(BANNER.RuntimeStatusBanner, { pollMs: 0 })));
  await settleN(6);
  return r;
}

test("runtime UNAVAILABLE: 'View workspace health … for detail.' for a WORKSPACE_HEALTH_VIEW holder (RuntimeStatusBanner:185-196)", async () => {
  const r = await renderBanner("UNAVAILABLE");
  assert.ok(r.hasText("Runtime status is currently unknown."));
  assert.ok(r.hasText("for detail."));
  await r.press("View workspace health");
  assert.deepEqual(BANNER.calls.push.at(-1), "/operations/health");
  r.unmount();
});

test("runtime DEGRADED offers the health destination; without the capability there is no link", async () => {
  const r = await renderBanner("DEGRADED");
  assert.ok(r.hasText("Runtime is in degraded mode."));
  assert.ok(r.byLabel("View workspace health").length > 0);
  r.unmount();
  handlers["GET /v1/platform/context"] = () => ({ body: opsEnvelope({ capabilities: { OPERATIONS_VIEW: true } }) });
  const r2 = await renderBanner("DEGRADED");
  assert.ok(r2.hasText("Runtime is in degraded mode."));
  assert.equal(r2.byLabel("View workspace health").length, 0);
  r2.unmount();
});
