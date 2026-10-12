/**
 * OPERATIONS REMEDIATION CLOSURE (2026-10-12) — native.
 *
 * The server contract moved (ops.routes.ts, workspace-operations.routes.ts,
 * operations-summary.service.ts):
 *   - every summary count is number|null; null ⇔ SOURCE_FAILED; a bounded scan
 *     (SCAN_BOUND_REACHED) makes the counts floors;
 *   - the queue's status defaults to UNRESOLVED (OPEN+ACKNOWLEDGED+SUPPRESSED);
 *   - remediation deep links are WEB paths;
 *   - a reconcile refusal is retryable unless schema_mismatch/permission_denied;
 *   - POST …/unsuppress ("Resume notifications") exists, gated on OPERATIONS_SUPPRESS.
 *
 * What is proven here, against the real screen in the render harness (NOT on a
 * device): KPI predicates, the unavailable summary, stale-page discard,
 * deep-link withholding, reconcile copy by refusal, unsuppress, and the Home
 * health verdict. Every stub is the server's reply shape.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "../app");
const h = React.createElement;
let OPS;
let HOME_OVERVIEW;
let HEALTH;
let HOME_ANALYTICS;
let requests = [];
let handlers = {};
let mounted = [];

before(async () => {
  OPS = await loadModule("app/(stack)/operations/index.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ops-console.ts",
    "src/product/home-operations.ts",
  ]);
  HOME_OVERVIEW = await loadModule("src/ui/home-overview.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  HEALTH = await loadModule("app/(stack)/operations/health.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/ops-health.ts"]);
  HOME_ANALYTICS = await loadModule("src/ui/home-operations-sections.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
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

const TEAM = "team-1";
const CAPS = {
  OPERATIONS_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
  OPERATIONS_ASSIGN: true,
};
const envelope = (caps = CAPS) =>
  platformContextEnvelope({
    activeSpace: { id: TEAM, type: "ORGANIZATION", displayName: "Acme", status: "active" },
    workspace: { id: TEAM, status: "active" },
    account: { userId: "user-1", accountStatus: "active" },
    capabilities: caps,
  });

const INCIDENT = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "UPLOAD",
  severity: "HIGH",
  status: "OPEN",
  title: "Uploads are failing",
  safeSummary: "Three uploads failed their integrity check.",
  occurrenceCount: 1,
  firstSeenAtUtc: "2026-10-12T08:00:00.000Z",
  lastSeenAtUtc: "2026-10-12T09:00:00.000Z",
  relatedEvidenceId: null,
  assignedOperatorUserId: null,
  lifecycle: { resolutionAuthority: "OPERATOR_DECISION", manualResolution: true },
};
const summary = (over = {}) => ({
  summary: {
    open: 1, critical: 0, high: 1, warning: 0, info: 0, acknowledged: 0, resolved: 2,
    assignedToMe: 0, unassigned: 1, slaBreached: 0, slaAtRisk: 0,
    complete: true, mayAssertAllClear: false, incompleteReason: null, readiness: "READY",
    ...over,
  },
  workspace: { operatorCount: 2 },
});
const list = (incidents, nextCursor = null) => ({
  incidents,
  sla: { attentionPostures: [] },
  pagination: { nextCursor },
  completeness: { complete: true },
});
const detail = (incident, remediation = null) => ({ incident: { ...incident, timeline: [], timelineComplete: true }, remediation });

beforeEach(async () => {
  requests = [];
  globalThis.__LINKING_OPENED__ = [];
  delete process.env.EXPO_PUBLIC_WEB_BASE;
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({ body: envelope() }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/ops/summary": () => ({ body: summary() }),
    "GET /v1/ops/incidents/": () => ({ body: detail(INCIDENT) }),
    "GET /v1/ops/incidents": () => ({ body: list([INCIDENT]) }),
    "GET /v1/ops/incident-groups": () => ({ body: { groups: [], totals: { groups: 0, conditions: 0 } } }),
    "GET /v1/ops/assignable-operators": () => ({ body: { operators: [], selfUserId: "user-1" } }),
    "GET /v1/ops/saved-views": () => ({ body: { views: [] } }),
    "POST /v1/ops/workspace-reconcile": () => ({ status: 202, body: { started: true, ran: true, alreadyRunning: false, refusedReason: null, retryable: true, readiness: "READY" } }),
    "POST /v1/ops/incidents/": () => ({ body: { incident: INCIDENT } }),
  };
  installFetch();
  OPS.calls?.reset?.();
  await signIn(OPS);
  await signIn(HOME_OVERVIEW);
  await signIn(HEALTH);
  await signIn(HOME_ANALYTICS);
});
afterEach(() => {
  for (const r of mounted) {
    try {
      r.unmount();
    } catch {
      /* already unmounted */
    }
  }
  mounted = [];
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function settleN(n = 6) {
  for (let i = 0; i < n; i += 1) await settle();
}
async function renderOps() {
  const r = await renderComponent(h(OPS.TestProviders, null, h(OPS.default, {})));
  mounted.push(r);
  await settleN();
  return r;
}
async function pressTestId(r, id) {
  const hits = r.byTestId(id).filter((n) => n.props.onPress);
  assert.ok(hits.length > 0, `no pressable with testID ${id}`);
  if (hits[0].props.disabled || hits[0].props.accessibilityState?.disabled) return;
  await act(async () => {
    await hits[0].props.onPress();
  });
}
const listReads = () => requests.filter((q) => q.method === "GET" && q.path.startsWith("/v1/ops/incidents?"));

/* ================================================================ KPI predicates (D10) */

test("D10 every KPI opens exactly the predicate it counts; the default queue is UNRESOLVED", () => {
  const C = OPS;
  assert.equal(C.DEFAULT_FILTERS.status, "UNRESOLVED");
  assert.equal(C.anyFilterActive(C.DEFAULT_FILTERS), false, "the default queue is not 'filtered'");
  const want = {
    open: { status: "UNRESOLVED" },
    critical: { status: "UNRESOLVED", severity: "CRITICAL" },
    high: { status: "UNRESOLVED", severity: "HIGH" },
    warning: { status: "UNRESOLVED", severity: "WARNING" },
    slaBreached: { status: "UNRESOLVED", sla: "BREACHED" },
    slaAtRisk: { status: "UNRESOLVED", sla: "AT_RISK" },
    resolved: { status: "RESOLVED" },
    assignedToMe: { status: "UNRESOLVED", owner: "me" },
    unassigned: { status: "UNRESOLVED", owner: "unassigned" },
  };
  for (const m of C.QUEUE_METRICS) {
    const f = C.filtersForMetric(m.key);
    for (const [axis, value] of Object.entries(want[m.key])) assert.equal(f[axis], value, `${m.key}.${axis}`);
    assert.equal(C.selectedMetric(f), m.key === "open" ? "open" : m.key, `${m.key} does not read back as selected`);
    const path = C.buildOpsIncidentsPath(TEAM, f);
    assert.match(path, new RegExp(`[?&]status=${want[m.key].status}(&|$)`), `${m.key}: the wire predicate differs`);
  }
  assert.equal(C.QUEUE_METRICS.find((m) => m.key === "open").note, "Open, acknowledged or suppressed.");
});

test("D10 the screen reads UNRESOLVED by default, and the Critical card keeps the unresolved status", async () => {
  const r = await renderOps();
  assert.match(listReads()[0].path, /[?&]status=UNRESOLVED(&|$)/);
  await r.press("Critical: 0");
  await settleN();
  const last = listReads().at(-1).path;
  assert.match(last, /[?&]severity=CRITICAL(&|$)/);
  assert.match(last, /[?&]status=UNRESOLVED(&|$)/);
  assert.ok(r.hasText("Open, acknowledged or suppressed."));
});

test("D10 the all-clear is reachable: no unresolved conditions + a server-permitted clear", async () => {
  handlers["GET /v1/ops/summary"] = () => ({ body: summary({ open: 0, high: 0, unassigned: 0, mayAssertAllClear: true, clearRefusalReason: null }) });
  handlers["GET /v1/ops/incidents"] = () => ({ body: list([]) });
  const r = await renderOps();
  assert.ok(r.hasText("Workspace operations are clear"), r.texts().join(" | "));
});

/* ================================================================ null / partial summary (D8) */

test("D8 an unreadable summary (SOURCE_FAILED, every count null) is unavailable — never 0 — and starts no check", async () => {
  handlers["GET /v1/ops/summary"] = () => ({
    body: summary({
      open: null, critical: null, high: null, warning: null, info: null, acknowledged: null, resolved: null,
      assignedToMe: null, unassigned: null, slaBreached: null, slaAtRisk: null,
      complete: false, incompleteReason: "SOURCE_FAILED", readiness: "NEVER_RUN",
    }),
  });
  const r = await renderOps();
  assert.ok(r.hasText("The queue counts are unavailable"));
  assert.equal(r.byLabel("Unresolved: 0").length, 0, "an unread count rendered as zero");
  assert.equal(r.byLabel("Unresolved: —").length, 0, "a strip of dashes rendered over an unread summary");
  assert.equal(
    requests.filter((q) => q.method === "POST" && q.path === "/v1/ops/workspace-reconcile").length,
    0,
    "a failed read started an automatic check",
  );
  // The queue itself still renders.
  assert.ok(r.hasText("Filters"));
});

test("D8 a bounded scan shows floors: 'N+' with the at-least note; Resolved is a count, not a floor", async () => {
  handlers["GET /v1/ops/summary"] = () => ({ body: summary({ open: 5000, high: 5000, complete: false, incompleteReason: "SCAN_BOUND_REACHED" }) });
  const r = await renderOps();
  assert.ok(r.byLabel("Unresolved: 5,000+").length > 0, r.texts().join(" | "));
  assert.ok(r.byLabel("Resolved · all time: 2").length > 0);
  assert.ok(r.byTestId("ops-summary-floor").length > 0);
  const s = OPS.parseSummary({ summary: { open: null, complete: false, incompleteReason: "SOURCE_FAILED" } }).summary;
  assert.equal(s.unreadable, true);
  assert.equal(OPS.shouldAutoReconcile({ ...s, readiness: "NEVER_RUN" }), false);
  assert.equal(OPS.summaryCountDisplay(s, "open"), "—");
});

/* ================================================================ stale page (D2) */

test("D2 a 'Load more' page that answers after the filters changed is discarded, not appended", async () => {
  let releaseStale;
  const stalePage = new Promise((resolveFn) => {
    releaseStale = resolveFn;
  });
  handlers["GET /v1/ops/incidents"] = (req) => {
    if (req.path.includes("cursor=c2")) return stalePage;
    if (req.path.includes("q=")) return { body: list([{ ...INCIDENT, id: "22222222-2222-4222-8222-222222222222", title: "Filtered row" }]) };
    return { body: list([INCIDENT], "c2") };
  };
  const r = await renderOps();
  await r.press("View: All conditions");
  await settleN();
  await pressTestId(r, "ops-load-more");
  // While the page is loading, the filter chips are held still.
  const chip = r.byLabel("Severity: Critical")[0];
  assert.equal(chip.props.disabled, true, "filters stayed live under an in-flight page");
  // The search box is not held; typing changes the queue's identity.
  await r.type("Search conditions", "filtered");
  await act(async () => { await new Promise((x) => setTimeout(x, 300)); });
  await settleN();
  assert.ok(r.hasText("Filtered row"));
  await act(async () => {
    releaseStale({ body: list([{ ...INCIDENT, id: "33333333-3333-4333-8333-333333333333", title: "Stale page row" }]) });
  });
  await settleN();
  assert.ok(!r.hasText("Stale page row"), "a page of the previous filters was appended to the new queue");
  assert.ok(r.hasText("Filtered row"));
});

test("D13/D14 search is capped at 120 characters; a failed read keeps the filters and search on screen", async () => {
  handlers["GET /v1/ops/incidents"] = () => ({ status: 503, body: { error: { code: "SERVICE_UNAVAILABLE" } } });
  const r = await renderOps();
  assert.ok(r.hasText("Operational conditions are temporarily unavailable"));
  const search = r.byLabel("Search conditions").filter((n) => n.props.onChangeText);
  assert.ok(search.length > 0, "the search box vanished with the failed read");
  await r.type("Search conditions", "x".repeat(200));
  assert.equal(r.byLabel("Search conditions").filter((n) => n.props.onChangeText)[0].props.value.length, 120);
});

/* ================================================================ deep links (D3) */

test("D3 remediation deep links map through the native mappers; unknown routes are withheld", () => {
  const d = (href, origin = null) => OPS.remediationDestination(href, origin);
  assert.equal(d("/evidence/ev-9?tab=integrity").native, "/evidence/ev-9?tab=integrity");
  assert.equal(d("/evidence/ev-9?tab=artifacts").native, "/evidence/ev-9?tab=artifacts");
  assert.equal(d("/evidence/ev-9?tab=bogus").native, "/evidence/ev-9");
  assert.equal(d("/billing?workspace=personal#billing-action-required").native, "/billing");
  assert.equal(d("/intake-links").native, "/intake-links");
  for (const web of ["/integrations", "/operations/automation", "/communications", "/governance", "/security-center", "/security-center/sso/health", "/review"]) {
    assert.equal(d(web).native, null, `${web} must not be pushed natively`);
    assert.equal(d(web).webUrl, null, "no origin, no URL");
    assert.equal(d(web, "https://www.proovra.com").webUrl, `https://www.proovra.com${web}`);
  }
  // Every static native route the mapper may push is a real screen file.
  for (const route of OPS.NATIVE_STATIC_ROUTES) {
    const base = route === "/" ? "(tabs)/index" : route.slice(1);
    const candidates = [`${base}.tsx`, `${base}/index.tsx`, `(stack)/${base}.tsx`, `(stack)/${base}/index.tsx`, `(tabs)/${base}.tsx`];
    assert.ok(candidates.some((c) => existsSync(resolve(APP, c))), `${route} has no screen under apps/mobile/app`);
  }
});

test("D3 a web-only remediation link is withheld and offers the web app; a native one is pushed", async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  handlers["GET /v1/ops/incidents/"] = () => ({
    body: detail(INCIDENT, { actions: [], deepLink: { href: "/integrations", label: "Open integrations" }, guidance: null, unsafeReason: null }),
  });
  const r = await renderOps();
  await r.press("View: All conditions");
  await settleN();
  await r.press(INCIDENT.title);
  await settleN();
  assert.equal(r.byTestId("ops-remediation-link").length, 0, "a route with no native screen was offered as a button");
  assert.ok(r.byTestId("ops-remediation-web-only").length > 0);
  await r.press("Open on the web: Open integrations");
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://www.proovra.com/integrations"]);
  assert.equal(OPS.calls.push.length, 0, "a dead native route was pushed");
});

test("D3 an evidence remediation link keeps its tab and is pushed natively", async () => {
  handlers["GET /v1/ops/incidents/"] = () => ({
    body: detail(INCIDENT, { actions: [], deepLink: { href: "/evidence/ev-9?tab=integrity", label: "Open the record" }, guidance: null, unsafeReason: null }),
  });
  const r = await renderOps();
  await r.press("View: All conditions");
  await settleN();
  await r.press(INCIDENT.title);
  await settleN();
  await pressTestId(r, "ops-remediation-link");
  assert.deepEqual(OPS.calls.push, ["/evidence/ev-9?tab=integrity"]);
});

/* ================================================================ reconcile copy (D9) */

async function refreshWith(reply) {
  handlers["POST /v1/ops/workspace-reconcile"] = reply;
  const r = await renderOps();
  await pressTestId(r, "ops-refresh");
  await settleN();
  return r;
}

test("D9 a retryable refusal says 'try again shortly', never a deployment mismatch", async () => {
  const r = await refreshWith(() => ({ status: 202, body: { started: false, refusedReason: "database_unavailable", retryable: true, readiness: "FAILED" } }));
  assert.ok(r.hasText("Nothing has changed. Try again shortly."));
  assert.ok(!r.texts().some((t) => /data store don't currently match/.test(t)), "a retryable refusal was presented as a deployment mismatch");
});

test("D9 schema_mismatch (503) — and only it — is the deployment mismatch", async () => {
  const r = await refreshWith(() => ({ status: 503, body: { started: false, refusedReason: "schema_mismatch", retryable: false, error: { code: "schema_mismatch", retryable: false } } }));
  assert.ok(r.hasText("This check can't run right now"));
  assert.ok(r.texts().some((t) => /data store don't currently match/.test(t)));
});

test("D9 permission_denied reads as a permission problem", async () => {
  const r = await refreshWith(() => ({ status: 202, body: { started: false, refusedReason: "permission_denied", retryable: false, readiness: "FAILED" } }));
  assert.ok(r.hasText("This check isn't permitted"));
  assert.ok(!r.texts().some((t) => /data store don't currently match/.test(t)));
  assert.equal(OPS.reconcileRefusalKind("timeout", true), "retry");
  assert.equal(OPS.reconcileRefusalKind("schema_mismatch", false), "mismatch");
  assert.equal(OPS.reconcileRefusalKind("permission_denied", false), "permission");
});

/* ================================================================ unsuppress (D19) */

test("D19 a SUPPRESSED condition offers 'Resume notifications' (POST …/unsuppress) only with OPERATIONS_SUPPRESS", async () => {
  const suppressed = { ...INCIDENT, status: "SUPPRESSED" };
  const caps = OPS.opsCapabilities({ capabilities: CAPS });
  const keys = (i, c, collaborative = true) => OPS.rowActions(OPS.parseIncident(i), c, { collaborative }).map((a) => a.key);
  assert.ok(keys(suppressed, caps).includes("unsuppress"));
  assert.ok(!keys(suppressed, { ...caps, suppress: false }).includes("unsuppress"));
  assert.ok(!keys(INCIDENT, caps).includes("unsuppress"), "an OPEN condition is not 'resumed'");
  // D12 — no "Change owner" where nobody else can take the work.
  assert.ok(keys(INCIDENT, caps, true).includes("assign"));
  assert.ok(!keys(INCIDENT, caps, false).includes("assign"));

  handlers["GET /v1/ops/incidents/"] = () => ({ body: detail(suppressed) });
  handlers["GET /v1/ops/incidents"] = () => ({ body: list([suppressed]) });
  const r = await renderOps();
  await r.press("View: All conditions");
  await settleN();
  await r.press(INCIDENT.title);
  await settleN();
  await pressTestId(r, "ops-unsuppress");
  await settleN();
  const post = requests.find((q) => q.method === "POST" && q.path.endsWith("/unsuppress"));
  assert.ok(post, "Resume notifications never reached the API");
  assert.equal(post.path, `/v1/ops/incidents/${INCIDENT.id}/unsuppress`);
  assert.deepEqual(post.body, { teamId: TEAM });
});

test("D19 a FAILED (502) remediation is a failure that says it can be retried; owner ids never leak (D16)", () => {
  const failed = OPS.remediationOutcome(
    { body: { remediation: { result: "FAILED", message: "The report service refused." }, error: { code: "remediation_failed", retryable: true } } },
    true,
    "fallback",
  );
  assert.deepEqual(failed, { tone: "failure", message: "The report service refused.", retryable: true });
  const refused = OPS.remediationOutcome({ body: { remediation: { result: "REFUSED", message: "Not allowed." }, error: { retryable: false } } }, true, "x");
  assert.equal(refused.retryable, false);
  assert.equal(OPS.remediationOutcome({ remediation: { result: "QUEUED", message: "Queued." } }, false, "x").tone, "success");
  const owned = OPS.parseIncident({ ...INCIDENT, assignedOperatorUserId: "abcdef12-3456-4789-8abc-def012345678" });
  assert.equal(OPS.ownerLabel(owned, "user-1", []), "Assigned");
});

/* ================================================================ Home health (D1) */

test("D1 Home 'Workspace health' is never Healthy when its sources failed or no workspace is selected", async () => {
  const H = OPS; // home-operations is bundled into the same module graph
  const failed = H.buildWorkspaceHealth({ activeCases: null, storageLabel: null, storagePercent: null });
  assert.ok(failed.every((m) => m.value === "—" && m.tone === "neutral"), JSON.stringify(failed));
  assert.equal(H.workspaceHealthOverall(failed), "unknown");
  const read = H.buildWorkspaceHealth({
    commandCenter: { sections: { pipelineDetail: { data: { evidence: { reported: 1, signed: 1 }, reports: { missingFromSigned: 0, ready: 1, failed: 0 } } } } },
    trustSummary: { needingAttention: 0, signedWithoutReport: 0, reportedWithoutPackage: 0 },
    reports: { items: [] },
    inbox: { items: [] },
    activeCases: 1,
    storageLabel: "1 GB of 10 GB",
    storagePercent: 10,
  });
  assert.equal(H.workspaceHealthOverall(read), "healthy");
  assert.equal(H.workspaceHealthOverall(read, { noWorkspace: true }), "unknown");
  // One unread source is enough to withhold "Healthy"…
  const oneMissing = read.map((m) => (m.key === "integrity" ? { ...m, value: "—", tone: "neutral", known: false } : m));
  assert.equal(H.workspaceHealthOverall(oneMissing), "unknown");
  // …but a KNOWN problem is still reported.
  const withDanger = oneMissing.map((m) => (m.key === "operational" ? { ...m, value: "3", tone: "danger" } : m));
  assert.equal(H.workspaceHealthOverall(withDanger), "action_required");

  const r = await renderComponent(h(HOME_OVERVIEW.TestProviders, null, h(HOME_OVERVIEW.HomeWorkspaceHealthCard, { health: failed })));
  mounted.push(r);
  await settleN(2);
  assert.ok(r.hasText("Unknown"));
  assert.ok(!r.hasText("Healthy"), "a card of unread sources said Healthy");
  const r2 = await renderComponent(h(HOME_OVERVIEW.TestProviders, null, h(HOME_OVERVIEW.HomeWorkspaceHealthCard, { health: read, noWorkspace: true })));
  mounted.push(r2);
  await settleN(2);
  assert.ok(r2.hasText("Unknown") && !r2.hasText("Healthy"));
});

/* ================================================================ Workspace health (D5, D7, states) */

const HEALTH_CAPS = { ...CAPS, WORKSPACE_HEALTH_VIEW: true };
const healthBody = (over = {}) => ({
  scope: "WORKSPACE",
  workspaceId: TEAM,
  state: "UNKNOWN",
  unknownReason: "NEVER_RUN",
  readiness: "NEVER_RUN",
  openIncidents: { total: 0, bySeverity: {} },
  unresolvedIncidents: 0,
  untriagedIncidents: 0,
  lastIncidentActivityUtc: "2026-10-11T08:30:00.000Z",
  evaluatedAtUtc: "2026-10-12T10:00:00.000Z",
  ...over,
});
async function renderHealth() {
  const r = await renderComponent(h(HEALTH.TestProviders, null, h(HEALTH.default, {})));
  mounted.push(r);
  await settleN();
  return r;
}

test("health: UNKNOWN states its reason and is never 'Healthy'; counts say which set they are; timestamps carry the date", async () => {
  handlers["GET /v1/platform/context"] = () => ({ body: envelope(HEALTH_CAPS) });
  handlers[`GET /v1/teams/${TEAM}/operations/health`] = () => ({ body: healthBody() });
  handlers[`GET /v1/teams/${TEAM}/operations/alerts`] = () => ({ body: { items: [], counts: { total: 0 }, complete: true, evaluatedAtUtc: "2026-10-12T10:00:00.000Z" } });
  const r = await renderHealth();
  assert.ok(r.hasText("Unknown"));
  assert.ok(!r.hasText("Healthy"));
  assert.ok(r.hasText("This workspace has not been checked for operational conditions yet"), r.texts().join(" | "));
  assert.ok(r.hasText("Unresolved conditions") && r.hasText("Not yet acknowledged"));
  // D7 — the date is part of every instant (formatUserDateTime), not the time alone.
  assert.ok(r.texts().some((t) => /2026/.test(t) && /Oct/.test(t)), "a timestamp was shown without its date");
});

test("health: ATTENTION (unresolved, none critical/high) reads 'Needs attention' with its reason", async () => {
  handlers["GET /v1/platform/context"] = () => ({ body: envelope(HEALTH_CAPS) });
  handlers[`GET /v1/teams/${TEAM}/operations/health`] = () => ({
    body: healthBody({ state: "ATTENTION", unknownReason: null, readiness: "READY", openIncidents: { total: 2, bySeverity: { WARNING: 2 } }, unresolvedIncidents: 2, untriagedIncidents: 1 }),
  });
  handlers[`GET /v1/teams/${TEAM}/operations/alerts`] = () => ({ body: { items: [], counts: { total: 2 }, complete: true, evaluatedAtUtc: "2026-10-12T10:00:00.000Z" } });
  const r = await renderHealth();
  assert.ok(r.hasText("Needs attention"));
  assert.ok(r.hasText("none is critical or high severity"));
  assert.ok(r.hasText("Warning · 2 unresolved"));
});

test("D5 health: an answer for an earlier read never overwrites a newer one", async () => {
  handlers["GET /v1/platform/context"] = () => ({ body: envelope(HEALTH_CAPS) });
  let release;
  const late = new Promise((ok) => {
    release = ok;
  });
  let calls = 0;
  handlers[`GET /v1/teams/${TEAM}/operations/health`] = () => {
    calls += 1;
    return calls === 1 ? late : { body: healthBody({ state: "CRITICAL", unknownReason: null, openIncidents: { total: 1, bySeverity: { CRITICAL: 1 } }, unresolvedIncidents: 1 }) };
  };
  handlers[`GET /v1/teams/${TEAM}/operations/alerts`] = () => ({ body: { items: [], complete: true, evaluatedAtUtc: "2026-10-12T10:00:00.000Z" } });
  const r = await renderHealth();
  await r.press("Refresh");
  await settleN();
  assert.ok(r.hasText("Critical"));
  await act(async () => {
    release({ body: healthBody({ state: "HEALTHY", unknownReason: null }) });
  });
  await settleN();
  assert.ok(r.byTestId("workspace-health-state-CRITICAL").length > 0, "a late, older answer replaced the current one");
  assert.equal(r.byTestId("workspace-health-state-HEALTHY").length, 0);
});

/* ================================================================ Home activity (D4, D18) */

test("D4/D18 the activity feed opens /evidence-requests/<id> natively and never claims complete history", async () => {
  const activity = [
    {
      id: "today",
      label: "Today",
      events: [
        { id: "a", title: "Intake incomplete — Leak photos", detail: null, atIso: "2026-10-12T09:00:00.000Z", href: "/evidence-requests/req-7" },
        { id: "b", title: "Web-only thing", detail: null, atIso: "2026-10-12T08:00:00.000Z", href: "/security-center" },
      ],
    },
  ];
  const r = await renderComponent(
    h(HOME_ANALYTICS.TestProviders, null, h(HOME_ANALYTICS.HomeAnalyticsSections, { distribution: null, series: null, activity })),
  );
  mounted.push(r);
  await settleN(2);
  assert.ok(!r.texts().some((t) => /Complete history/i.test(t)), "a capped feed claimed to be the complete history");
  await r.press("Intake incomplete — Leak photos");
  assert.deepEqual(HOME_ANALYTICS.calls.push, ["/evidence-request/req-7"]);
  const webOnly = r.byLabel("Web-only thing")[0];
  assert.equal(webOnly.props.onPress, undefined, "a route with no native screen was made pressable");
  assert.equal(HOME_ANALYTICS.activityRoute("/intake-links?linkId=l1"), "/intake-links?linkId=l1");
  assert.match(OPS.activityFeedCaption(12), /12 most recent/);
});
