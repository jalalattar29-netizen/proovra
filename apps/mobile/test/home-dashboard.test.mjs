/**
 * Home dashboard projections — behavioural.
 *
 * Two properties throughout:
 *   - HONESTY: an absent source is unknown, never zero;
 *   - the SERVER'S KEYS: every fixture below is shaped like the route's
 *     reply — trust-summary.service.ts TrustSummary, command-center.service.ts
 *     PipelineDetail / caseOperations, billing-overview.service.ts
 *     workspaces.personal.storage, reports.routes.ts `{ items, nextCursor }`,
 *     ops.routes.ts `{ summary }`. The previous fixtures fed
 *     `commandCenter.evidence.total`, `cases.active`, `reports.readyCount`
 *     and `billingOverview.storage` — keys no route sends — so they passed
 *     while the screen read nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/home-dashboard.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const H = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const kpi = (sources, key, opts) => H.buildHomeKpis(sources, opts).find((k) => k.key === key);
const cc = (data) => ({ sections: { caseOperations: { status: "ok", data } } });
const pipe = (data) => ({ sections: { pipelineDetail: { status: "ok", data } } });

/* -------------------------------------------------------------------- KPIs */

test("the five canonical KPIs are always present, in the web's order", () => {
  const keys = H.buildHomeKpis({}).map((k) => k.key);
  assert.deepEqual(keys, ["evidence", "matters", "trust", "deliverables", "intake"]);
});

test("KPI labels and destinations match the canonical web surface", () => {
  const k = H.buildHomeKpis({}, { intakeIncluded: true });
  assert.deepEqual(
    k.map((x) => x.label),
    ["Total evidence", "Active matters", "End-to-end ready", "Reports & packages", "Intake & submissions"],
  );
  assert.deepEqual(k.map((x) => x.href), ["/evidence", "/cases", "/evidence", "/reports", "/intake-links"]);
});

test("without the intake entitlement the intake KPI is locked and points at billing", () => {
  const k = kpi({}, "intake");
  assert.equal(k.value, "—");
  assert.equal(k.subtitle, "Included with PRO");
  assert.equal(k.href, "/billing");
});

test("an absent source reads as unknown, never as zero", () => {
  for (const key of ["evidence", "matters", "trust", "deliverables"]) {
    const k = kpi({}, key);
    assert.equal(k.value, "—", `${key}: showing 0 to someone whose dashboard failed is a lie`);
    assert.equal(k.subtitle, "Not available");
  }
});

test("a real zero is reported as zero, not as unknown", () => {
  const k = kpi({ commandCenter: cc({ activeCasesCount: 0, topCases: [] }) }, "matters");
  assert.equal(k.value, "0");
  assert.equal(k.subtitle, "No open matters");
});

test("matters needing attention are the cases with gaps plus the blocked ones", () => {
  const k = kpi(
    { commandCenter: cc({ activeCasesCount: 5, casesWithEvidenceGapsCount: 1, topCases: [{ caseId: "a", openEscalationsCount: 2 }] }) },
    "matters",
  );
  assert.equal(k.subtitle, "2 need attention");
  assert.equal(k.tone, "pending");
});

test("the evidence total is the trust summary's, with the web's 7-day delta", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const k = kpi(
    {
      trustSummary: { totalEvidence: 1280 },
      recentEvidence: { items: [{ createdAt: "2026-09-24T10:00:00.000Z" }, { createdAt: "2026-01-01T00:00:00.000Z" }], nextCursor: null },
    },
    "evidence",
    { nowMs: now },
  );
  assert.equal(k.value, "1,280");
  assert.equal(k.subtitle, "+1 in the last 7 days");
  assert.equal(kpi({ trustSummary: { totalEvidence: 0 } }, "evidence").subtitle, "No records yet — capture your first");
});

test("large numbers carry thousands separators, as the web formats them", () => {
  assert.equal(H.formatKpiNumber(1234567), "1,234,567");
  assert.equal(H.formatKpiNumber(null), "—");
});

/* ------------------------------------------------------------- trust tone */

test("End-to-end ready is a percentage from ten records, with the web's tones", () => {
  const complete = kpi({ trustSummary: { totalEvidence: 10, endToEndReady: 10 } }, "trust");
  assert.equal(complete.value, "100%");
  assert.equal(complete.tone, "verified");

  const stuck = kpi({ trustSummary: { totalEvidence: 100, endToEndReady: 92, signedWithoutReport: 8 } }, "trust");
  assert.equal(stuck.value, "92%");
  assert.equal(stuck.tone, "pending", "records stuck without a report are not 'verified'");
  assert.equal(stuck.subtitle, "92 of 100 have report + package · 8 need attention");

  const flagged = kpi({ trustSummary: { totalEvidence: 100, endToEndReady: 40, needingAttention: 3 } }, "trust");
  assert.equal(flagged.tone, "risk");

  assert.equal(kpi({ trustSummary: { totalEvidence: 4, endToEndReady: 3 } }, "trust").value, "3", "under ten records the count is shown");
});

test("an empty workspace does not claim a verified posture", () => {
  const none = kpi({ trustSummary: { totalEvidence: 0, endToEndReady: 0 } }, "trust");
  assert.equal(none.value, "0");
  assert.equal(none.tone, "neutral");
  assert.equal(none.subtitle, "End-to-end readiness appears with your first record");
});

/* ---------------------------------------------------------- deliverables */

test("deliverables read the pipeline, never keys /v1/reports does not send", () => {
  const k = kpi(
    { commandCenter: pipe({ reports: { ready: 12, queued: 2, failed: 1 }, packages: { ready: 3, queued: 0, failed: 0, blocked: 1 } }) },
    "deliverables",
  );
  assert.equal(k.value, "12 / 3");
  assert.equal(k.subtitle, "2 failed · 2 pending");
  assert.equal(k.tone, "risk");
  // A fictional envelope key is not a count.
  assert.equal(kpi({ reports: { readyCount: 99 } }, "deliverables").value, "0 / 0");
});

test("without a pipeline the deliverables fall back to the reports list", () => {
  const k = kpi(
    { reports: { items: [{ evidenceId: "a", report: { available: true }, package: { available: true } }, { evidenceId: "b", report: { available: true }, package: { available: false } }], nextCursor: null } },
    "deliverables",
  );
  assert.equal(k.value, "2 / 1");
});

/* ------------------------------------------------------------- priorities */

test("priorities come from shared workspace facts, ranked critical > warning > info", () => {
  const p = H.buildWorkspacePriorities({
    trust: H.parseTrustState({ totalEvidence: 10, tsa: { failed: 2 }, ots: { pending: 4 }, needingAttention: 1, intake: { submissionsAwaitingReview: 3 } }),
    pipeline: H.parsePipeline(pipe({ packages: { queued: 5 }, publicVerify: { unpublished: 2 }, reports: { ready: 1 } })),
    reportCount: 1,
    mattersNeedingWork: 0,
    reportsReady: 1,
    storage: null,
    intakeIncluded: false,
    activeLinks: null,
  });
  assert.equal(p[0].key, "tsa_failures");
  assert.equal(p[0].severity, "critical");
  assert.equal(p[0].label, "2 TSA timestamps failed");
  assert.equal(p[0].href, "/evidence?tsaStatus=FAILED,REJECTED,ERROR");
  // Warnings rank by affected count.
  assert.deepEqual(p.slice(1, 4).map((x) => x.key), ["complete_packages", "ots_pending", "review_submissions"]);
  assert.equal(p.length, 5, "the web caps the list at five");
});

test("the one-person inbox is NOT a source of workspace priorities", () => {
  const p = H.buildWorkspacePriorities({
    trust: H.parseTrustState({ totalEvidence: 5 }),
    pipeline: null,
    reportCount: 0,
    mattersNeedingWork: 0,
    reportsReady: 0,
    storage: null,
    intakeIncluded: false,
    activeLinks: null,
  });
  assert.deepEqual(p, []);
});

test("the intake nudge needs a real zero, not an unread links list", () => {
  const base = { trust: null, pipeline: null, reportCount: 0, mattersNeedingWork: 0, reportsReady: 0, storage: null, intakeIncluded: true };
  assert.equal(H.buildWorkspacePriorities({ ...base, activeLinks: null }).length, 0);
  assert.equal(H.buildWorkspacePriorities({ ...base, activeLinks: 0 })[0].key, "create_intake_link");
});

/* --------------------------------------------------- operations verdict */

test("all clear only when the Operations summary says so; the refusal names its reason", () => {
  assert.equal(H.buildOperationsVerdict(undefined, true).loadState, "loading");
  const unread = H.buildOperationsVerdict(undefined, false);
  assert.equal(unread.mayAssertAllClear, false);
  assert.equal(unread.refusal.title, "Operations status unavailable");
  assert.equal(H.buildOperationsVerdict({ mayAssertAllClear: true }, false).mayAssertAllClear, true);
  const open = H.buildOperationsVerdict({ mayAssertAllClear: false, clearRefusalReason: "UNRESOLVED_CONDITIONS" }, false);
  assert.equal(open.refusal.title, "Open operational conditions");
  assert.equal(H.buildOperationsVerdict({ mayAssertAllClear: false, clearRefusalReason: "NEVER_RUN" }, false).refusal.title, "Operations not scanned yet");
  assert.equal(H.buildOperationsVerdict({ mayAssertAllClear: false, clearRefusalReason: "PARTIAL_SOURCES" }, false).refusal.title, "Operations status incomplete");
});

/* -------------------------------------------------------- executive band */

const summary = (over) =>
  H.buildHomeSummary({
    sources: { commandCenter: {}, trustSummary: {} },
    trust: H.parseTrustState({ totalEvidence: 3, signed: 3 }),
    priorities: [],
    production: H.buildReportProduction(null, []),
    storage: null,
    showGettingStarted: false,
    ...over,
  });

test("a failed dashboard says so instead of reporting a calm workspace", () => {
  const s = summary({ sources: {} });
  assert.equal(s.state, "Unavailable");
  assert.match(s.sentence, /could not be loaded/);
  assert.notEqual(s.tone, "verified", "absent data must never read as healthy");
});

test("the band leads with the top priority and its action", () => {
  const s = summary({
    trust: H.parseTrustState({ totalEvidence: 3, signed: 3, tsa: { failed: 1 } }),
    priorities: [
      { key: "tsa_failures", severity: "critical", count: 1, label: "1 TSA timestamp failed", whyItMatters: "Why.", recommendedAction: "Do.", actionLabel: "Open affected records", href: "/evidence" },
      { key: "ots_pending", severity: "warning", count: 1, label: "1 OTS proof is still pending", whyItMatters: "W", recommendedAction: "D", actionLabel: "Review anchoring", href: "/evidence" },
    ],
  });
  assert.equal(s.state, "Critical");
  assert.equal(s.title, "1 TSA timestamp failed");
  assert.equal(s.sentence, "1 TSA timestamp failed — Why.");
  assert.deepEqual(s.secondarySignals, ["1 OTS proof is still pending"]);
  assert.equal(s.actionLabel, "Open affected records");
});

test("a new workspace is onboarding, with the capture action", () => {
  const s = summary({ showGettingStarted: true });
  assert.equal(s.state, "Getting started");
  assert.equal(s.actionHref, "/capture");
});

test("a workspace with nothing open is healthy", () => {
  const s = summary({});
  assert.equal(s.state, "Healthy");
  assert.equal(s.title, "Workspace is healthy");
});

test("unsigned records keep the band at needs attention", () => {
  const s = summary({ trust: H.parseTrustState({ totalEvidence: 3, signed: 1 }) });
  assert.equal(s.state, "Needs attention");
  assert.match(s.sentence, /2 records are not signed yet/);
});

/* ------------------------------------------------------------- onboarding */

test("getting started only for a truly new workspace, never for an unknown one", () => {
  assert.equal(H.shouldShowGettingStarted({ evidenceCount: 0, reportCount: 0, caseCount: 0, verifyPublished: 0 }), true);
  assert.equal(H.shouldShowGettingStarted({ evidenceCount: null, reportCount: 0, caseCount: 0, verifyPublished: 0 }), false);
  assert.equal(H.shouldShowGettingStarted({ evidenceCount: 0, reportCount: 0, caseCount: 1, verifyPublished: 0 }), false);
});

test("the header greets by time of day and switches its CTA for onboarding", () => {
  assert.equal(H.homeGreeting(9, "Dana"), "Good morning, Dana");
  assert.equal(H.homeGreeting(14, null), "Good afternoon");
  assert.equal(H.homeGreeting(20, "Dana"), "Good evening, Dana");
  assert.deepEqual(H.homeHeaderCta(true), { label: "Capture evidence", href: "/capture" });
  assert.deepEqual(H.homeHeaderCta(false), { label: "All evidence", href: "/evidence" });
});

/* ------------------------------------------------------------- storage */

const billing = (storage) => ({ billingOverview: { workspaces: { personal: { storage } } } });

test("storage is omitted entirely when billing did not answer", () => {
  assert.equal(H.buildHomeStorage({}), null, "an absent plan is not '0 bytes used'");
  assert.equal(H.buildHomeStorage({ billingOverview: { storage: { usedLabel: "1 GB" } } }), null, "a top-level `storage` is not a key the server sends");
});

test("storage reads workspaces.personal.storage and the server's own limit flags", () => {
  const near = H.buildHomeStorage(billing({ usedLabel: "4.6 GB", limitLabel: "5 GB", usedBytes: "4600", limitBytes: "5000", usagePercent: 92, nearLimit: true, limitReached: false }));
  assert.equal(near.tone, "pending");
  assert.equal(near.fraction, 0.92);
  const full = H.buildHomeStorage(billing({ usedLabel: "5 GB", limitLabel: "5 GB", usagePercent: 100, nearLimit: true, limitReached: true }));
  assert.equal(full.tone, "risk");
  const fine = H.buildHomeStorage(billing({ usedLabel: "1 GB", limitLabel: "5 GB", usagePercent: 20, nearLimit: false, limitReached: false }));
  assert.equal(fine.tone, "neutral");
});

test("a plan without a percentage reports usage without inventing a fraction", () => {
  const s = H.buildHomeStorage(billing({ usedLabel: "12 GB" }));
  assert.equal(s.fraction, null);
  assert.equal(s.limitLabel, "—");
  assert.equal(s.tone, "neutral");
});

/* --------------------------------------------------------- trust rows */

test("the verification summary says each count in its own tone", () => {
  const rows = H.buildTrustRows(H.parseTrustState({ totalEvidence: 176, tsa: { stamped: 138, failed: 34 }, ots: { anchored: 170, pending: 6 }, signed: 172, publicVerify: { published: 4, suspended: 1 } }));
  const tsa = rows.find((r) => r.key === "tsa");
  assert.deepEqual(tsa.segments, [{ text: "138 stamped", tone: "ok" }, { text: "34 failed", tone: "danger" }]);
  assert.equal(rows.find((r) => r.key === "signed").segments[0].text, "172 of 176");
  assert.ok(rows.some((r) => r.key === "verify-suspended"));
  assert.equal(rows.some((r) => r.key === "attention"), false, "a zero attention count adds no row");
});
