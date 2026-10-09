/**
 * OPERATIONS TRUTH CLOSURE — native (OPS-035, and the native half of OPS-011 /
 * OPS-029 / OPS-030).
 *
 *   OPS-035  the screen belongs to ONE workspace: a workspace changed while the
 *            app was away remounts it from that workspace's own state; coming
 *            back to the foreground re-reads the queue; the chrome reads the
 *            shared Operations dictionary (German here).
 *   OPS-030  "Stop notifying" asks why, confirms, and sends the reason.
 *   OPS-029  a source that needs a written conclusion asks for it before Resolve.
 *   OPS-011  a bulk sweep carries an idempotency key.
 *
 * Every stub is the server's own reply shape (see ops-parity.render.test.mjs).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let OPS;
let requests = [];
let handlers = {};

before(async () => {
  OPS = await loadModule("app/(stack)/operations/index.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ops-console.ts",
  ]);
});

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const req = { path, method, body: init.body ? JSON.parse(init.body) : null };
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

const OPS_CAPS = {
  OPERATIONS_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
  OPERATIONS_ASSIGN: true,
};
const envelopeFor = (team) =>
  platformContextEnvelope({
    activeSpace: { id: team, type: "ORGANIZATION", displayName: `Workspace ${team}`, status: "active" },
    workspace: { id: team, status: "active" },
    account: { userId: "user-1", accountStatus: "active" },
    capabilities: OPS_CAPS,
  });

const INCIDENT = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "GOVERNANCE",
  severity: "HIGH",
  status: "OPEN",
  title: "Retention policy conflicts with an active legal hold",
  safeSummary: "The record's retention would end during a hold.",
  occurrenceCount: 1,
  firstSeenAtUtc: "2026-09-24T08:00:00.000Z",
  lastSeenAtUtc: "2026-09-24T09:00:00.000Z",
  requestId: null,
  traceId: null,
  relatedEvidenceId: null,
  relatedJobId: null,
  relatedProvider: null,
  assignedOperatorUserId: null,
  lifecycle: {
    sourceId: "governance.policy_condition",
    resolutionAuthority: "OPERATOR_DECISION",
    manualResolution: true,
    requiresResolutionNote: true,
  },
};
const summaryBody = () => ({
  summary: {
    open: 1, critical: 0, high: 1, warning: 0, info: 0, acknowledged: 0,
    assignedToMe: 0, unassigned: 1, overdue: 0, complete: true, mayAssertAllClear: false,
    readiness: "READY", clearRefusalReason: "UNRESOLVED_CONDITIONS",
  },
  workspace: { operatorCount: 2 },
});
const listBody = (incidents) => ({
  incidents,
  sla: { postures: [], attentionPostures: [] },
  pagination: { nextCursor: null, returned: incidents.length },
  completeness: { complete: true, mayAssertAllClear: false },
});

let activeTeam = "team-1";
beforeEach(async () => {
  requests = [];
  activeTeam = "team-1";
  globalThis.__APP_STATE__ = "active";
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({ body: envelopeFor(activeTeam) }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/ops/summary": () => ({ body: summaryBody() }),
    "GET /v1/ops/incidents/": () => ({
      body: { incident: { ...INCIDENT, timeline: [], timelineComplete: true }, remediation: null },
    }),
    "GET /v1/ops/incidents": () => ({ body: listBody([INCIDENT]) }),
    "GET /v1/ops/incident-groups": () => ({ body: { groups: [], totals: { groups: 0, conditions: 0 } } }),
    "GET /v1/ops/assignable-operators": () => ({ body: { operators: [], selfUserId: "user-1" } }),
    "GET /v1/ops/saved-views": () => ({ body: { views: [] } }),
    "POST /v1/ops/incidents/": () => ({ body: { incident: INCIDENT } }),
    "POST /v1/ops/bulk-actions": () => ({ body: { runId: "r1", status: "COMPLETED", items: [{ targetId: INCIDENT.id, status: "COMPLETED" }] } }),
  };
  installFetch();
  OPS.calls?.reset?.();
  await signIn(OPS);
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function settleN(n = 5) {
  for (let i = 0; i < n; i += 1) await settle();
}
async function renderOps() {
  const r = await renderComponent(h(OPS.TestProviders, null, h(OPS.default, {})));
  await settleN();
  return r;
}
async function pressTestId(r, id) {
  const hits = r.byTestId(id).filter((n) => n.props.onPress);
  assert.ok(hits.length > 0, `no pressable with testID ${id}`);
  // A disabled Pressable does not call onPress; neither does this.
  if (hits[0].props.disabled || hits[0].props.accessibilityState?.disabled) return;
  await act(async () => {
    await hits[0].props.onPress();
  });
}
async function pressLast(r, label) {
  const hits = r.byLabel(label).filter((n) => n.props.onPress);
  assert.ok(hits.length > 0, `no pressable labelled ${label}`);
  await act(async () => {
    await hits[hits.length - 1].props.onPress();
  });
}
const gets = (prefix) => requests.filter((q) => q.method === "GET" && q.path.startsWith(prefix));
async function emitAppState(next) {
  await act(async () => {
    globalThis.__emitAppState(next);
  });
  await settleN();
}

test("OPS-035 coming back to the foreground re-reads the queue", async () => {
  const r = await renderOps();
  const before = gets("/v1/ops/incidents?").length;
  await emitAppState("background");
  await emitAppState("active");
  assert.ok(gets("/v1/ops/incidents?").length > before, "no re-read after returning to the foreground");
  r.unmount();
});

test("OPS-035 a workspace changed while away remounts the screen from that workspace's own state", async () => {
  const r = await renderOps();
  await r.press("View: All conditions");
  await settleN(2);
  // The previous workspace's view choice is armed.
  assert.equal(gets("/v1/ops/incident-groups?teamId=team-2").length, 0);
  activeTeam = "team-2";
  await emitAppState("background");
  await emitAppState("active");
  // Remounted: the new workspace is read, from its own default (grouped) view.
  assert.ok(gets("/v1/ops/incidents?teamId=team-2").length > 0, "the new workspace was not read");
  assert.ok(gets("/v1/ops/incident-groups?teamId=team-2").length > 0, "the previous workspace's view choice leaked into the new one");
  r.unmount();
});

test("OPS-030 'Stop notifying' asks why, confirms, and sends the reason", async () => {
  const r = await renderOps();
  await r.press("View: All conditions");
  await settleN(2);
  await r.press(INCIDENT.title);
  await settleN();
  await pressTestId(r, "ops-suppress");
  await settleN(1);
  assert.equal(requests.filter((q) => q.method === "POST" && q.path.endsWith("/suppress")).length, 0);
  await r.type("Why should notifications stop? (required, recorded in the history)", "Known provider maintenance window");
  await pressTestId(r, "ops-suppress");
  await settleN(1);
  await pressLast(r, "Stop notifying");
  await settleN();
  const sent = requests.filter((q) => q.method === "POST" && q.path.endsWith("/suppress"));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { teamId: "team-1", reason: "Known provider maintenance window" });
  r.unmount();
});

test("OPS-029 a source that needs a written conclusion asks for it before Resolve", async () => {
  const r = await renderOps();
  await r.press("View: All conditions");
  await settleN(2);
  await r.press(INCIDENT.title);
  await settleN();
  await pressTestId(r, "ops-resolve");
  await settleN(1);
  assert.equal(requests.filter((q) => q.method === "POST" && q.path.endsWith("/resolve")).length, 0, "Resolve sent without the required note");
  await r.type("Resolution note (required, recorded in the history)", "Hold released by counsel");
  await pressTestId(r, "ops-resolve");
  await settleN();
  const sent = requests.filter((q) => q.method === "POST" && q.path.endsWith("/resolve"));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { teamId: "team-1", resolutionNote: "Hold released by counsel" });
  r.unmount();
});

test("OPS-011 a native bulk sweep carries an idempotency key", async () => {
  const body = OPS.bulkBody("team-1", "BULK_ACKNOWLEDGE_INCIDENTS", ["a"], undefined, { idempotencyKey: "nv-key-123456" });
  assert.equal(body.idempotencyKey, "nv-key-123456");
  const outcome = OPS.summarizeBulk({ items: [{ targetId: "a", status: "COMPLETED" }, { targetId: "b", status: "SKIPPED" }] }, ["a", "b"]);
  assert.equal(outcome.failed, 0);
  assert.deepEqual(outcome.stillSelected, []);
});

test("OPS-032 Refresh asks for a NEW check of the sources, explicitly, then re-reads", async () => {
  handlers["POST /v1/ops/workspace-reconcile"] = () => ({ status: 202, body: { started: true, ran: true, alreadyRunning: false, readiness: "READY" } });
  const r = await renderOps();
  const before = gets("/v1/ops/incidents?").length;
  await pressTestId(r, "ops-refresh");
  await settleN();
  const sent = requests.filter((q) => q.method === "POST" && q.path.startsWith("/v1/ops/workspace-reconcile"));
  assert.equal(sent.length, 1, "Refresh did not ask for a new check");
  assert.equal(sent[0].body.explicit, true);
  assert.ok(gets("/v1/ops/incidents?").length > before, "no re-read after the check");
  r.unmount();
});
