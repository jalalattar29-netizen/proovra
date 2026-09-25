/**
 * T-11 / RC-12 — the native Operations console and Workspace health.
 *
 * THE DEFECT
 * ----------
 * `/operations` and `/operations/health` are CORE-tier web surfaces
 * (`lib/surface/tiers.ts`: "tenant Operations — shared unresolved workspace
 * work") and native had no screen for either. The manifest had inferred
 * "enterprise" from the registry domain, and the guard that forbids linking to
 * reserved surfaces then forbade the fix.
 *
 * WHAT IS PROVEN HERE
 * -------------------
 *   1. The access gate equals the web's — by EXECUTING the web's
 *      `resolveRuntimeReadAccess` + the page's own reason mapping.
 *   2. The bulk arithmetic counts the server's success value (`COMPLETED`);
 *      the web's `SUCCEEDED` never arrives (spec §1).
 *   3. The rendered journeys: restricted state, queue + filters, inspector,
 *      acknowledge, server refusal notice, and a bulk action that passes
 *      through the challenge step-up and retries WITH the challenge header.
 *   4. Health: both panels fail independently; alerts most-severe first.
 *
 * Device acceptance is NOT claimed: no EAS build has run.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const WEB = resolve(MOBILE, "../web");
const h = React.createElement;

let WEB_ACCESS;
let OPS; // screen module (+ pure module + stubs)
let HEALTH;
let requests = [];
let handlers = {};

before(async () => {
  const out = await build({
    stdin: {
      contents: `export { resolveRuntimeReadAccess } from "./lib/platform-context/runtimeReadAccess";`,
      resolveDir: WEB,
      sourcefile: "web-access.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const dir = resolve(MOBILE, "node_modules/.render-test-cache");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `web-access-${Date.now()}.mjs`);
  await writeFile(file, out.outputFiles[0].text, "utf8");
  WEB_ACCESS = await import(pathToFileURL(file).href);

  OPS = await loadModule("app/(stack)/operations/index.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ops-console.ts",
  ]);
  HEALTH = await loadModule("app/(stack)/operations/health.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ops-health.ts",
  ]);
});

/** handlers: "METHOD /path-prefix" → (req) => ({ status?, body }) */
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
    const res = key ? handlers[key](req) : { status: 500, body: { message: "unstubbed" } };
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const TEAM = "team-1";
const OPS_CAPS = {
  OPERATIONS_VIEW: true,
  // Granted from the same predicate (capability-registry.ts:368-374); the
  // health route is gated on it (routeRegistry.ts:1164-1172).
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
  requestId: "req-1",
  traceId: null,
  relatedEvidenceId: "ev-9",
  relatedJobId: null,
  relatedProvider: null,
  assignedOperatorUserId: null,
  lifecycle: { resolutionAuthority: "OPERATOR_DECISION", manualResolution: true },
  metric: null,
  sla: { posture: "BREACHED", obligation: "ACKNOWLEDGEMENT", dueAtUtc: "2026-09-24T09:30:00.000Z", targetHours: 1 },
};

function healthyOps() {
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({ body: opsEnvelope() }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/ops/summary": () => ({
      body: {
        summary: { open: 1, critical: 0, high: 1, warning: 0, slaBreached: 1, slaAtRisk: 0, resolved: 4, assignedToMe: 0, unassigned: 1, complete: true, mayAssertAllClear: false, readiness: "READY" },
        workspace: { operatorCount: 2 },
      },
    }),
    "GET /v1/ops/incidents/": () => ({ body: { incident: { ...INCIDENT, timeline: [{ id: "t1", eventType: "opened", safeMessage: "First seen", occurredAtUtc: INCIDENT.firstSeenAtUtc }], timelineComplete: true }, remediation: null } }),
    "GET /v1/ops/incidents": () => ({
      body: { incidents: [INCIDENT], completeness: { complete: true }, sla: { attentionPostures: ["BREACHED", "AT_RISK"] }, pagination: { nextCursor: null } },
    }),
    "GET /v1/ops/incident-groups": () => ({
      body: {
        groups: [
          { groupKey: "g-upload", sourceId: "upload.integrity", category: "UPLOAD", title: "Upload integrity failures", conditionCount: 1, affectedRecordCount: 3, affectedUnit: "records", observations: 3, durationSeconds: null, severity: "HIGH", statusPosture: "OPEN", firstSeenAtUtc: INCIDENT.firstSeenAtUtc, lastSeenAtUtc: INCIDENT.lastSeenAtUtc, assignedCount: 0, failureGroups: [], metric: null },
        ],
        totals: { groups: 1, conditions: 1 },
      },
    }),
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
  await signIn(OPS);
  await signIn(HEALTH);
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function renderOps() {
  const el = () => h(OPS.TestProviders, null, h(OPS.default, {}));
  const r = await renderComponent(el());
  for (let i = 0; i < 4; i += 1) await settle();
  return r;
}

/* ---------------------------------------------------------------- gate */

test("the access gate equals the web's executed resolveRuntimeReadAccess + page mapping", () => {
  const pageReason = (env, teamId) => {
    // P:596-606, over the executed web resolver.
    if (!env) return "no_envelope";
    const ra = WEB_ACCESS.resolveRuntimeReadAccess({ envelope: env, teamId });
    if (ra.refusedReason === "context_mismatch") return "context_mismatch";
    if (ra.refusedReason === "account_not_active") return "account_not_active";
    if (!teamId) return "no_workspace";
    if (env.capabilities?.OPERATIONS_VIEW !== true || !ra.incidents) return "not_included";
    return null;
  };
  const variants = [];
  for (const ws of [{ id: TEAM, status: "active" }, { id: TEAM, status: "no-workspace" }, { id: "other", status: "active" }, undefined]) {
    for (const account of [{ accountStatus: "active" }, { accountStatus: "suspended" }, {}]) {
      for (const caps of [OPS_CAPS, { ESCALATIONS_VIEW: true }, {}]) {
        for (const activeId of [TEAM, "other", undefined]) {
          for (const teamId of [TEAM, null]) {
            variants.push([{ workspace: ws, account, capabilities: caps, activeSpace: activeId ? { id: activeId } : {} }, teamId]);
          }
        }
      }
    }
  }
  variants.push([null, TEAM]);
  for (const [env, teamId] of variants) {
    assert.equal(OPS.resolveOperationsAccess(env, teamId), pageReason(env, teamId), JSON.stringify({ env, teamId }));
  }
  assert.ok(variants.length > 200);
});

test("bulk success is COMPLETED — the value the server writes — not the web's SUCCEEDED", () => {
  const out = OPS.summarizeBulk(
    { items: [{ targetId: "a", status: "COMPLETED" }, { targetId: "b", status: "FAILED" }, { targetId: "c", status: "SKIPPED" }] },
    ["a", "b", "c", "d"],
  );
  assert.equal(out.succeeded, 1);
  assert.equal(out.skipped, 1);
  // b failed, d was never reported on: both stay selected.
  assert.deepEqual(out.stillSelected.sort(), ["b", "d"]);
  assert.equal(out.message, "1 of 4 updated. 1 needed no change. 2 could not be changed and remain selected.");
});

/* -------------------------------------------------------------- render */

test("restricted: no OPERATIONS_VIEW shows the web's copy and makes NO /v1/ops call", async () => {
  handlers["GET /v1/platform/context"] = () => ({ body: opsEnvelope({ capabilities: {} }) });
  const r = await renderOps();
  assert.ok(r.hasText("Operations isn't available for this workspace"));
  assert.equal(requests.filter((q) => q.path.startsWith("/v1/ops/")).length, 0);
});

test("the queue renders summary cards, grouped conditions, and the flat list on demand", async () => {
  const r = await renderOps();
  assert.ok(r.hasText("Operations"));
  assert.ok(r.byLabel("Unresolved: 1").length > 0, "summary card missing");
  assert.ok(r.byLabel("Assigned to me: 0").length > 0, "collaborative cards must show when operatorCount > 1");
  assert.ok(r.hasText("Upload integrity failures"), "grouped view missing");
  await r.press("View: All conditions");
  await settle();
  assert.ok(r.hasText("Uploads are failing"));
  assert.ok(r.byLabel("Select Uploads are failing for a bulk action").length > 0);
});

test("a summary card is a filter toggle that reaches the server query", async () => {
  const r = await renderOps();
  await r.press("Overdue: 1");
  await settle();
  const last = requests.filter((q) => q.path.startsWith("/v1/ops/incidents?")).at(-1);
  assert.match(last.path, /[?&]sla=BREACHED(&|$)/);
});

test("inspector: acknowledge posts to /ack; a server refusal shows the web's notice", async () => {
  const r = await renderOps();
  await r.press("View: All conditions");
  await settle();
  await r.press("Uploads are failing");
  for (let i = 0; i < 3; i += 1) await settle();
  assert.ok(r.hasText("What happened"));
  assert.ok(r.hasText("History"));
  handlers["POST /v1/ops/incidents/"] = () => ({ status: 409, body: { error: { code: "CONDITION_STILL_ACTIVE" } } });
  await r.press("Acknowledge");
  await settle();
  const ack = requests.find((q) => q.method === "POST" && q.path.endsWith("/ack"));
  assert.ok(ack, "acknowledge never reached the API");
  assert.deepEqual(ack.body, { teamId: TEAM });
  assert.ok(r.hasText("Condition is still active"));
});

test("bulk: STEP_UP_REQUIRED → challenge → code → the SAME request retried WITH the challenge header", async () => {
  let bulkCalls = 0;
  handlers["POST /v1/ops/bulk-actions"] = (req) => {
    bulkCalls += 1;
    if (!req.headers["x-proovra-step-up-challenge-id"]) {
      return { status: 401, body: { error: { code: "STEP_UP_REQUIRED", details: { purpose: "REVIEWER_OPS_BULK_ACTION", resourceKind: "workspace", resourceId: TEAM } } } };
    }
    return { body: { items: [{ targetId: INCIDENT.id, status: "COMPLETED" }] } };
  };
  handlers["POST /v1/identity-security/step-up/start"] = () => ({ body: { challenge: { id: "ch-1" }, method: "TOTP" } });
  handlers["POST /v1/identity-security/step-up/check"] = () => ({ body: { status: "approved" } });

  const r = await renderOps();
  await r.press("View: All conditions");
  await settle();
  await r.press("Select Uploads are failing for a bulk action");
  assert.ok(r.hasText("1 condition selected"));
  await r.press("Acknowledge");
  for (let i = 0; i < 3; i += 1) await settle();
  assert.ok(r.hasText("Code from your authenticator app"), "the step-up sheet never asked for a code");
  await r.type("Verification code", "123456");
  await r.press("Confirm + retry");
  for (let i = 0; i < 3; i += 1) await settle();

  const start = requests.find((q) => q.path === "/v1/identity-security/step-up/start");
  assert.deepEqual(start.body, { teamId: TEAM, purpose: "REVIEWER_OPS_BULK_ACTION", resourceKind: "workspace", resourceId: TEAM });
  const retried = requests.filter((q) => q.path === "/v1/ops/bulk-actions").at(-1);
  assert.equal(retried.headers["x-proovra-step-up-challenge-id"], "ch-1");
  assert.deepEqual(retried.body, { teamId: TEAM, actionType: "BULK_ACKNOWLEDGE_INCIDENTS", targetIds: [INCIDENT.id] });
  assert.equal(bulkCalls, 2);
  assert.ok(r.hasText("1 of 1 updated."), "a COMPLETED item must count as updated");
});

test("bulk: cancelling verification changes nothing and says so", async () => {
  handlers["POST /v1/ops/bulk-actions"] = () => ({ status: 401, body: { error: { code: "STEP_UP_REQUIRED", details: { purpose: "REVIEWER_OPS_BULK_ACTION" } } } });
  handlers["POST /v1/identity-security/step-up/start"] = () => ({ body: { challenge: { id: "ch-2" }, method: "SMS", destinationMask: "•••• 12" } });
  const r = await renderOps();
  await r.press("View: All conditions");
  await settle();
  await r.press("Select Uploads are failing for a bulk action");
  await r.press("Acknowledge");
  for (let i = 0; i < 3; i += 1) await settle();
  assert.ok(r.hasText("Verification code (sent to •••• 12)"));
  await r.press("Cancel");
  await settle();
  assert.ok(r.hasText("Nothing was changed — verification was cancelled."));
});

/* -------------------------------------------------------------- health */

test("health: posture and list fail independently; alerts are most severe first", async () => {
  handlers["GET /v1/teams/team-1/operations/health"] = () => ({ status: 503, body: { error: { code: "down" } } });
  handlers["GET /v1/teams/team-1/operations/alerts"] = () => ({
    body: {
      evaluatedAtUtc: "2026-09-24T10:00:00.000Z",
      items: [
        { id: "a1", severity: "INFO", title: "Info thing", category: "WORKER", firstSeenAtUtc: "2026-09-24T08:00:00.000Z", lastSeenAtUtc: "2026-09-24T09:00:00.000Z", occurrenceCount: 1 },
        { id: "a2", severity: "CRITICAL", title: "Critical thing", category: "STORAGE", firstSeenAtUtc: "2026-09-24T08:00:00.000Z", lastSeenAtUtc: "2026-09-24T09:00:00.000Z", occurrenceCount: 2 },
      ],
    },
  });
  const el = () => h(HEALTH.TestProviders, null, h(HEALTH.default, {}));
  const r = await renderComponent(el());
  for (let i = 0; i < 4; i += 1) await settle();
  const texts = r.texts();
  assert.ok(texts.some((t) => t.includes("This is not a statement that the workspace is healthy")), "a failed posture read must not read as healthy");
  assert.ok(r.hasText("Critical thing") && r.hasText("Info thing"), "the list must still render when the posture failed");
  assert.ok(texts.indexOf("Critical thing") < texts.indexOf("Info thing"), "alerts must be most severe first");
  r.unmount();
});
