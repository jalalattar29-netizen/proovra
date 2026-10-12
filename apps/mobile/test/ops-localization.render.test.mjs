/**
 * OPERATIONS LOCALIZATION — en / de / ar.
 *
 *   1. Every key of the Operations vocabulary (src/product/ops-copy.ts) and of
 *      the Workspace-health state copy (src/product/ops-health.ts) exists in
 *      all three languages, with the same shape, and no entry is empty.
 *   2. Rendered in German and in Arabic, the Operations queue (grouped and
 *      flat), a condition's inspector, a group's sheet, and Workspace health
 *      show NO English string from either dictionary (or from the shared
 *      Operations dictionary). Server data in the fixtures (titles, summaries)
 *      is data, not chrome, and is not part of the scan.
 *
 * Render-harness proof only; no device.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let OPS;
let HEALTH;
let requests = [];
let handlers = {};
let mounted = [];

before(async () => {
  OPS = await loadModule("app/(stack)/operations/index.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/ops-copy.ts",
    "src/product/ops-health.ts",
    "src/product/ops-console.ts",
  ]);
  HEALTH = await loadModule("app/(stack)/operations/health.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

/* ------------------------------------------------------------ dictionary completeness */

function leaves(v, path = "") {
  if (typeof v === "string") return [[path, v]];
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [[path, v]];
}

test("every Operations key exists, with the same shape, and is non-empty in en, de and ar", () => {
  const en = leaves(OPS.opsCopyFor("en"));
  assert.ok(en.length > 250, `the vocabulary is unexpectedly small (${en.length})`);
  for (const locale of ["de", "ar"]) {
    const other = new Map(leaves(OPS.opsCopyFor(locale)));
    assert.equal(other.size, en.length, `${locale} has a different number of entries`);
    for (const [path] of en) {
      const v = other.get(path);
      assert.equal(typeof v, "string", `${locale}.${path} is missing`);
      assert.ok(v.trim().length > 0, `${locale}.${path} is empty`);
    }
  }
  for (const [path, v] of en) assert.ok(typeof v === "string" && v.trim().length > 0, `en.${path} is empty`);
  // Placeholders survive translation: a {name} in English is a {name} in de/ar.
  const ph = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
  for (const locale of ["de", "ar"]) {
    const other = new Map(leaves(OPS.opsCopyFor(locale)));
    for (const [path, v] of en) assert.equal(ph(other.get(path)), ph(v), `${locale}.${path} placeholders differ`);
  }
});

test("every Workspace-health state key exists and is non-empty in en, de and ar", () => {
  const en = leaves(OPS.healthCopyFor("en"));
  for (const locale of ["de", "ar"]) {
    const other = new Map(leaves(OPS.healthCopyFor(locale)));
    assert.equal(other.size, en.length, `${locale} health copy has a different shape`);
    for (const [path] of en) assert.ok(typeof other.get(path) === "string" && other.get(path).trim(), `${locale}.${path} is missing or empty`);
  }
});

test("German and Arabic are not English copies", () => {
  for (const locale of ["de", "ar"]) {
    const other = new Map(leaves(OPS.opsCopyFor(locale)));
    // "Status {label}" is the same word in German; that is a translation, not a copy.
    const sameWord = new Set(["a11yStatus", "statusLabel"]);
    const same = leaves(OPS.opsCopyFor("en")).filter(([p, v]) => other.get(p) === v && v.length > 12 && !sameWord.has(p));
    assert.deepEqual(same.map(([p]) => p), [], `${locale} entries identical to English`);
  }
});

/* ------------------------------------------------------------ rendered: no English */

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
    const res = key ? await handlers[key]({ path, method }) : { status: 500, body: { message: "unstubbed" } };
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

const TEAM = "team-1";
const CAPS = {
  OPERATIONS_VIEW: true,
  WORKSPACE_HEALTH_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
  OPERATIONS_ASSIGN: true,
};
const INCIDENT = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "UPLOAD",
  severity: "HIGH",
  status: "OPEN",
  title: "DATA-TITLE",
  safeSummary: "DATA-SUMMARY",
  occurrenceCount: 3,
  firstSeenAtUtc: "2026-09-24T08:00:00.000Z",
  lastSeenAtUtc: "2026-09-24T09:00:00.000Z",
  requestId: "req-1",
  relatedEvidenceId: "ev-123456789",
  assignedOperatorUserId: "user-2",
  lifecycle: { resolutionAuthority: "OPERATOR_DECISION", manualResolution: true },
  metric: { currentValue: 12, previousValue: 10, delta: 2, thresholdValue: 5, criticalThresholdValue: 20, unit: "u", observedAtUtc: "2026-09-24T09:00:00.000Z", stale: true },
  sla: { posture: "BREACHED", obligation: "ACKNOWLEDGEMENT", dueAtUtc: "2026-09-24T09:30:00.000Z", targetHours: 1, acknowledgementBreached: true },
};
const GROUP = {
  groupKey: "g-1", sourceId: "upload.integrity", category: "UPLOAD", title: "DATA-GROUP", conditionCount: 2, affectedRecordCount: 3,
  affectedUnit: "records", observations: 4, durationSeconds: 7200, severity: "HIGH", statusPosture: "OPEN",
  firstSeenAtUtc: INCIDENT.firstSeenAtUtc, lastSeenAtUtc: INCIDENT.lastSeenAtUtc, assignedCount: 1, failureGroups: [],
  metric: { currentValue: 3, unit: "records", thresholdValue: 1, criticalThresholdValue: 5, observedAtUtc: INCIDENT.lastSeenAtUtc, stale: true, contract: "AGGREGATE_THRESHOLD" },
};

beforeEach(async () => {
  requests = [];
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({
      body: platformContextEnvelope({
        activeSpace: { id: TEAM, type: "ORGANIZATION", displayName: "DATA-WS", status: "active" },
        workspace: { id: TEAM, status: "active" },
        account: { userId: "user-1", accountStatus: "active" },
        capabilities: CAPS,
      }),
    }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/ops/summary": () => ({
      body: {
        summary: { open: 1, critical: 0, high: 1, warning: 0, info: 0, slaBreached: 1, slaAtRisk: 0, resolved: 4, assignedToMe: 0, unassigned: 0, complete: true, mayAssertAllClear: false, readiness: "PARTIAL", reconciliation: { sources: { failedSources: 1, truncatedSources: 0, sourceFailures: [{ retryable: true }] } } },
        workspace: { operatorCount: 2 },
      },
    }),
    "GET /v1/ops/incidents/": () => ({
      body: {
        incident: { ...INCIDENT, timeline: [{ eventType: "opened", safeMessage: null, occurredAtUtc: INCIDENT.firstSeenAtUtc }], timelineComplete: false },
        remediation: { actions: [{ actionId: "a1", label: "DATA-ACTION", description: "DATA-DESC", async: true }], deepLink: { href: "/integrations", label: "DATA-LINK" }, guidance: null, unsafeReason: null },
      },
    }),
    "GET /v1/ops/incidents": () => ({ body: { incidents: [INCIDENT], completeness: { complete: true }, sla: { attentionPostures: ["BREACHED"] }, pagination: { nextCursor: "c2" } } }),
    "GET /v1/ops/incident-groups/": () => ({ body: { records: [{ conditionId: "c1", evidenceId: "ev-1", title: "DATA-RECORD", severity: "HIGH", status: "OPEN", firstSeenAtUtc: INCIDENT.firstSeenAtUtc, assignedOperatorUserId: "user-2" }], pagination: { nextCursor: "n" } } }),
    "GET /v1/ops/incident-groups": () => ({ body: { groups: [GROUP], totals: { groups: 1, conditions: 2 } } }),
    "GET /v1/ops/assignable-operators": () => ({ body: { operators: [{ userId: "user-1", displayName: "DATA-ME" }, { userId: "user-2", displayName: "DATA-DANA" }], selfUserId: "user-1" } }),
    "GET /v1/ops/saved-views": () => ({ body: { views: [{ id: "v1", name: "DATA-VIEW", visibility: "TEAM", filter: {}, updatedAt: "2026-09-24T09:00:00.000Z", ownedByViewer: true }] } }),
    [`GET /v1/teams/${TEAM}/operations/health`]: () => ({
      body: { state: "UNKNOWN", unknownReason: "STALE", readiness: "STALE", openIncidents: { total: 1, bySeverity: { HIGH: 1 } }, unresolvedIncidents: 1, untriagedIncidents: 1, lastIncidentActivityUtc: INCIDENT.lastSeenAtUtc, evaluatedAtUtc: INCIDENT.lastSeenAtUtc },
    }),
    [`GET /v1/teams/${TEAM}/operations/alerts`]: () => ({
      body: { items: [{ id: "al1", severity: "HIGH", title: "DATA-ALERT", category: "UPLOAD", firstSeenAtUtc: INCIDENT.firstSeenAtUtc, lastSeenAtUtc: INCIDENT.lastSeenAtUtc, occurrenceCount: 2 }], counts: { total: 150 }, complete: false, evaluatedAtUtc: INCIDENT.lastSeenAtUtc },
    }),
  };
  installFetch();
  await signIn(OPS);
  await signIn(HEALTH);
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
  for (const M of [OPS, HEALTH]) {
    await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
    await M.AsyncStorage.setItem("proovra-locale", "en");
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function settleN(n = 8) {
  for (let i = 0; i < n; i += 1) await settle();
}
async function useLocale(M, locale) {
  await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await M.AsyncStorage.setItem("proovra-locale", locale);
}

/** English strings this surface owns: our dictionaries plus the shared Operations dictionary. */
function englishBank(locale) {
  const target = new Set([
    ...leaves(OPS.opsCopyFor(locale)).map(([, v]) => v),
    ...leaves(OPS.healthCopyFor(locale)).map(([, v]) => v),
    ...leaves(OPS.operationsCopyFor(locale)).map(([, v]) => v),
  ]);
  const en = [
    ...leaves(OPS.opsCopyFor("en")).map(([, v]) => v),
    ...leaves(OPS.healthCopyFor("en")).map(([, v]) => v),
    ...leaves(OPS.operationsCopyFor("en")).map(([, v]) => v),
  ];
  // Templates are matched by their longest literal fragment.
  const fragments = en.flatMap((v) => v.split(/\{\w+\}/).map((f) => f.trim()));
  return [...new Set(fragments)].filter((f) => f.length >= 4 && !target.has(f) && /[A-Za-z]{3,}/.test(f) && ![...target].some((t) => t.includes(f)));
}

/** Every string a person reads or hears inside the screen's own subtree. */
function rendered(r, rootTestId) {
  const roots = r.root.findAll((n) => typeof n.type === "string" && n.props?.testID === rootTestId);
  const scope = roots.length ? roots : [r.root];
  const modals = r.root.findAll((n) => n.type === "Modal");
  const out = [];
  for (const root of [...scope, ...modals]) {
    for (const n of root.findAll((x) => typeof x.type === "string")) {
      if (n.type === "Text") out.push([n.props.children].flat(6).filter((c) => typeof c === "string" || typeof c === "number").join(""));
      if (typeof n.props?.accessibilityLabel === "string") out.push(n.props.accessibilityLabel);
      if (typeof n.props?.placeholder === "string") out.push(n.props.placeholder);
    }
  }
  return out.map((s) => s.replace(/DATA-[A-Z]+/g, "")).filter(Boolean);
}

function assertNoEnglish(texts, locale, where) {
  const bank = englishBank(locale);
  const hits = [];
  for (const text of texts) {
    for (const f of bank) {
      const exact = f.length < 14 ? text === f || text.startsWith(`${f}:`) || text.endsWith(` ${f}`) : text.includes(f);
      if (exact) hits.push(`"${f}" in "${text}"`);
    }
  }
  assert.deepEqual([...new Set(hits)], [], `${where} (${locale}) rendered English`);
}

for (const locale of ["de", "ar"]) {
  test(`the Operations queue, inspector and group sheet render no English in ${locale}`, async () => {
    await useLocale(OPS, locale);
    const el = h(OPS.TestProviders, null, h(OPS.default, {}));
    const r = await renderComponent(el);
    mounted.push(r);
    await settleN();
    const t = OPS.opsCopyFor(locale);
    // Grouped view (the default).
    assert.ok(r.hasText(t.sectionFilters), "the screen did not render in the chosen locale");
    assertNoEnglish(rendered(r, "operations"), locale, "grouped queue");

    // The group sheet.
    const card = r.root.findAll((n) => typeof n.type === "string" && n.props?.testID === "ops-group-g-1" && n.props.onPress)[0];
    await act(async () => { await card.props.onPress(); });
    await settleN();
    assertNoEnglish(rendered(r, "ops-group-inspector"), locale, "group sheet");
    await r.press(t.close);
    await settleN(2);

    // The flat list, its row menu, and the inspector.
    await r.press(`${t.filterView}: ${OPS.operationsCopyFor(locale).viewAll}`);
    await settleN();
    assertNoEnglish(rendered(r, "operations"), locale, "flat queue");
    await r.press(OPS.fillOpsCopy(t.selectFor, { title: "DATA-TITLE" }));
    await settleN(2);
    assertNoEnglish(rendered(r, "operations"), locale, "bulk toolbar");
    await r.press("DATA-TITLE");
    await settleN();
    assertNoEnglish(rendered(r, "ops-inspector"), locale, "inspector");
  });

  test(`Workspace health renders no English in ${locale}`, async () => {
    await useLocale(HEALTH, locale);
    const r = await renderComponent(h(HEALTH.TestProviders, null, h(HEALTH.default, {})));
    mounted.push(r);
    await settleN();
    const hc = OPS.healthCopyFor(locale);
    assert.ok(r.hasText(hc.word.UNKNOWN), "health did not render in the chosen locale");
    assertNoEnglish(rendered(r, "workspace-health"), locale, "workspace health");
  });
}

/* ------------------------------------------------------------ source registry (2026-10-12) */

test("registry: the new webhook-destination source is labelled in en/de/ar; retired sources are never rendered", () => {
  const src = "integration.webhook_destination_disabled";
  for (const locale of ["en", "de", "ar"]) {
    const label = OPS.opsCopyFor(locale).sourceLabel[src];
    assert.ok(typeof label === "string" && label.trim(), `${locale} has no label for ${src}`);
    assert.equal(OPS.conditionTitle({ title: "", sourceId: src }, OPS.opsCopyFor(locale)), label);
  }
  assert.equal(OPS.categoryLabel("INTEGRATION", OPS.opsCopyFor("de")), "Integrationen");
  // Its next step (Automation) has no native screen: withheld, offered on the web.
  assert.equal(OPS.remediationDestination("/operations/automation").native, null);

  const row = (id, sourceId) => ({ id, title: "x", status: "OPEN", severity: "HIGH", lifecycle: { sourceId } });
  const page = OPS.parseIncidentsPage({
    incidents: [row("a", src), row("b", "security.unclassified_signal"), row("c", "pipeline.signed_without_report_aged"), row("d", null)],
  });
  assert.deepEqual(page.incidents.map((i) => i.id), ["a", "d"]);
  const groups = OPS.parseGroups({
    groups: [
      { groupKey: "g1", sourceId: src, title: "" },
      { groupKey: "g2", sourceId: "security.unclassified_signal", title: "t" },
      { groupKey: "g3", sourceId: "pipeline.signed_without_report_aged", title: "t" },
    ],
  });
  assert.deepEqual(groups.groups.map((g) => g.groupKey), ["g1"]);
  assert.equal(OPS.conditionTitle(groups.groups[0], OPS.opsCopyFor("ar")), OPS.opsCopyFor("ar").sourceLabel[src]);
});
