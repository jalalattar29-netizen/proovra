/**
 * SERVER CONDITION TEXT IN THE READER'S LANGUAGE — native.
 *
 * The server sends each condition's message code and params beside the
 * English it stored; the app resolves them through the ONE shared catalogue
 * (@proovra/shared) — the same resolver the web uses — so no translated prose
 * lives in this client. A legacy row (no code), an unknown code and malformed
 * params all keep the stored text: never a raw key, never an empty line.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let OPS;
let requests = [];
let handlers = {};
let mounted = [];

before(async () => {
  OPS = await loadModule("app/(stack)/operations/index.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ops-copy.ts",
    "src/product/ops-console.ts",
  ]);
});

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ path, method });
    const key = Object.keys(handlers)
      .filter((k) => {
        const [m, p] = k.split(" ");
        return m === method && path.startsWith(p);
      })
      .sort((a, b) => b.length - a.length)[0];
    const res = key ? await handlers[key]() : { status: 500, body: { message: "unstubbed" } };
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const OPS_CAPS = { OPERATIONS_VIEW: true, OPERATIONS_ACKNOWLEDGE: true, OPERATIONS_RESOLVE: true, OPERATIONS_SUPPRESS: true, OPERATIONS_ASSIGN: true };

function incident(over) {
  return {
    category: "INTEGRATION",
    severity: "HIGH",
    status: "OPEN",
    occurrenceCount: 1,
    firstSeenAtUtc: "2026-10-12T08:00:00.000Z",
    lastSeenAtUtc: "2026-10-12T09:00:00.000Z",
    requestId: null,
    traceId: null,
    relatedEvidenceId: null,
    relatedJobId: null,
    relatedProvider: null,
    assignedOperatorUserId: null,
    lifecycle: { sourceId: "integration.webhook_destination_disabled", resolutionAuthority: "SOURCE_TRUTH", manualResolution: false, requiresResolutionNote: false },
    ...over,
  };
}

const CODED = incident({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Webhook destination disabled after repeated failures",
  safeSummary: "Automation stopped delivering to this webhook destination after 9 consecutive failed deliveries.",
  message: { code: "ops.integration.webhook_destination_disabled", params: { failures: 9 }, titleSource: "CONDITION" },
});
const LEGACY = incident({
  id: "22222222-2222-4222-8222-222222222222",
  title: "A legacy English title",
  safeSummary: "A legacy English summary.",
});

beforeEach(async () => {
  requests = [];
  globalThis.__APP_STATE__ = "active";
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({
      body: platformContextEnvelope({
        activeSpace: { id: "team-1", type: "ORGANIZATION", displayName: "Workspace team-1", status: "active" },
        workspace: { id: "team-1", status: "active" },
        account: { userId: "user-1", accountStatus: "active" },
        capabilities: OPS_CAPS,
      }),
    }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/ops/summary": () => ({
      body: {
        summary: { open: 2, critical: 0, high: 2, warning: 0, info: 0, acknowledged: 0, assignedToMe: 0, unassigned: 2, overdue: 0, complete: true, mayAssertAllClear: false, readiness: "READY", clearRefusalReason: "UNRESOLVED_CONDITIONS" },
        workspace: { operatorCount: 2 },
      },
    }),
    "GET /v1/ops/incidents/": () => ({ body: { incident: { ...CODED, timeline: [], timelineComplete: true }, remediation: null } }),
    "GET /v1/ops/incidents": () => ({
      body: { incidents: [CODED, LEGACY], sla: { postures: [], attentionPostures: [] }, pagination: { nextCursor: null, returned: 2 }, completeness: { complete: true, mayAssertAllClear: false } },
    }),
    "GET /v1/ops/incident-groups": () => ({ body: { groups: [], totals: { groups: 0, conditions: 0 } } }),
    "GET /v1/ops/assignable-operators": () => ({ body: { operators: [], selfUserId: "user-1" } }),
    "GET /v1/ops/saved-views": () => ({ body: { views: [] } }),
  };
  installFetch();
  await signIn(OPS);
});
afterEach(async () => {
  for (const r of mounted) {
    try {
      r.unmount();
    } catch {
      /* already unmounted */
    }
  }
  mounted = [];
  await OPS.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await OPS.AsyncStorage.setItem("proovra-locale", "en");
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function settleN(n = 8) {
  for (let i = 0; i < n; i += 1) await settle();
}

/* ------------------------------------------------------------- the resolver */

test("conditionTitle / conditionSummary resolve a code in de and ar, and keep English stored", () => {
  const de = OPS.opsCopyFor("de");
  const ar = OPS.opsCopyFor("ar");
  const en = OPS.opsCopyFor("en");
  const row = { ...CODED, sourceId: "integration.webhook_destination_disabled" };
  assert.equal(OPS.conditionTitle(row, de), "Webhook-Ziel nach wiederholten Fehlern deaktiviert");
  assert.match(OPS.conditionSummary(row, de), /9 aufeinanderfolgenden/);
  assert.equal(OPS.conditionTitle(row, ar), "عُطّلت وجهة Webhook بعد إخفاقات متكررة");
  assert.match(OPS.conditionSummary(row, ar), /\u20689\u2069/, "the Arabic count is isolated");
  assert.equal(OPS.conditionTitle(row, en), CODED.title);
  assert.equal(OPS.conditionSummary(row, en), CODED.safeSummary);
});

test("a legacy row, an unknown code and malformed params keep the stored text — never a raw key", () => {
  const de = OPS.opsCopyFor("de");
  assert.equal(OPS.conditionTitle(LEGACY, de), "A legacy English title");
  assert.equal(OPS.conditionSummary(LEGACY, de), "A legacy English summary.");
  const unknown = { ...LEGACY, message: { code: "ops.not_yet_known", params: {}, titleSource: "CONDITION" } };
  assert.equal(OPS.conditionTitle(unknown, de), "A legacy English title");
  const bad = { ...LEGACY, message: { code: "ops.integration.webhook_destination_disabled", params: { failures: "nine" }, titleSource: "CONDITION" } };
  assert.equal(OPS.conditionTitle(bad, OPS.opsCopyFor("ar")), "A legacy English title");
  // No server title at all: the source's label from the shared catalogue.
  assert.equal(OPS.conditionTitle({ title: "", sourceId: "integration.webhook_destination_disabled" }, de), "Webhook-Ziel nach wiederholten Fehlern deaktiviert");
  assert.equal(OPS.conditionTitle({ title: "", sourceId: "nope.unknown" }, de), de.conditionFallbackTitle);
});

test("the server's message is parsed defensively", () => {
  assert.deepEqual(OPS.parseConditionMessage({ code: "ops.x", params: { a: 1 }, titleSource: "SOURCE_LABEL" }), { code: "ops.x", params: { a: 1 }, titleSource: "SOURCE_LABEL" });
  assert.deepEqual(OPS.parseConditionMessage({ code: 4, params: [1] }), { code: null, params: null, titleSource: "CONDITION" });
  assert.equal(OPS.parseConditionMessage(null), null);
});

/* ------------------------------------------------------------- the screen */

for (const locale of ["de", "ar"]) {
  test(`the queue and inspector render server condition text in ${locale}`, async () => {
    await OPS.AsyncStorage.setItem("proovra-locale-mode", "manual");
    await OPS.AsyncStorage.setItem("proovra-locale", locale);
    const r = await renderComponent(h(OPS.TestProviders, null, h(OPS.default, {})));
    mounted.push(r);
    await settleN();
    const t = OPS.opsCopyFor(locale);
    await r.press(`${t.filterView}: ${OPS.operationsCopyFor(locale).viewAll}`);
    await settleN(3);
    const codedTitle = locale === "de" ? "Webhook-Ziel nach wiederholten Fehlern deaktiviert" : "عُطّلت وجهة Webhook بعد إخفاقات متكررة";
    assert.ok(r.hasText(codedTitle), `${locale}: the coded condition's title is not localized`);
    assert.ok(!r.hasText(CODED.title), `${locale}: the stored English title still shows`);
    assert.ok(r.hasText(LEGACY.title), `${locale}: the legacy row lost its stored title`);

    await r.press(codedTitle);
    await settleN();
    const summary = OPS.conditionSummary({ ...CODED, sourceId: "integration.webhook_destination_disabled" }, t);
    assert.ok(r.hasText(summary), `${locale}: the inspector summary is not localized`);
    assert.notEqual(summary, CODED.safeSummary);
  });
}
