/**
 * Phase HOME-POLISH — regression tests for the premium Home pass.
 *
 * Covers the twelve polish requirements:
 *   1/2  Getting Started gating (active users never see it; true
 *        zero-data users do).
 *   3    KPI cards carry REAL view-model values.
 *   4    Evidence Activity series builds from real evidence/report data.
 *   5    Evidence-by-type donut reflects the real distribution.
 *   6    Recent Evidence title fallback never spams the generic label.
 *   7    Operational Queue integrity item carries a severity breakdown.
 *   8    Trust State rows are tone-styled (failed/pending/success).
 *   9    Workspace Health computes an overall verdict.
 *   10   No Home CTA points at /workspaces, bare /evidence-requests, /v/.
 *   11   Search routes to /search?q=…
 *   12   Charts contain no fabricated data (empty inputs ⇒ empty charts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  normalizeHomeViewModel,
  type NormalizeInputs,
} from "../components/home-experience/home-view-model";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOME_DIR = resolve(__dirname, "..", "components", "home-experience");
const SECTIONS_SRC = readFileSync(resolve(HOME_DIR, "HomeSections.tsx"), "utf8");
const DASH_SRC = readFileSync(resolve(HOME_DIR, "HomeDashboardSections.tsx"), "utf8");
const VM_SRC = readFileSync(resolve(HOME_DIR, "home-view-model.ts"), "utf8");
const SHELL_SRC = readFileSync(resolve(HOME_DIR, "SelfServeHomeDashboard.tsx"), "utf8");
const ALL_UI_SRC = SECTIONS_SRC + DASH_SRC + VM_SRC + SHELL_SRC;

const NOW = Date.parse("2026-06-12T12:00:00Z");

function baseInputs(overrides: Partial<NormalizeInputs> = {}): NormalizeInputs {
  return {
    plan: "PRO",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    workspaceName: "Personal Space",
    activeSpaceType: "PERSONAL",
    commandCenter: null,
    trustSummary: null,
    billing: null,
    reports: null,
    intakeLinks: null,
    inbox: null,
    communications: null,
    orgs: null,
    evidenceList: null,
    nowMs: NOW,
    ...overrides,
  };
}

const WS = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
// 1 + 2 — Getting Started gating.
// ---------------------------------------------------------------------------

test("Getting Started is HIDDEN for active users (any real work retires it)", () => {
  const withEvidence = normalizeHomeViewModel(
    baseInputs({ trustSummary: { totalEvidence: 5, signed: 2 } }),
  );
  assert.equal(withEvidence.showGettingStarted, false);

  const withReports = normalizeHomeViewModel(
    baseInputs({
      reports: { items: [{ evidenceId: "e1", title: "R", report: { available: true } }] },
    }),
  );
  assert.equal(withReports.showGettingStarted, false);

  const withVerify = normalizeHomeViewModel(
    baseInputs({ trustSummary: { totalEvidence: 0, publicVerify: { published: 3 } } }),
  );
  assert.equal(withVerify.showGettingStarted, false);
});

test("Getting Started is VISIBLE only for a true zero-data user", () => {
  const vm = normalizeHomeViewModel(baseInputs());
  assert.equal(vm.showGettingStarted, true);
  // The onboarding card has exactly the four core workflow steps.
  assert.deepEqual(
    vm.checklist.map((s) => s.key),
    ["capture_first", "create_first_case", "first_report", "share_verification"],
  );
  // Invite-teammate is no longer an onboarding step.
  assert.ok(!vm.checklist.some((s) => /teammate/i.test(s.label)));
});

test("active users get real Workspace Priorities instead", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: { totalEvidence: 20, signed: 15, needingAttention: 14 },
      inbox: {
        items: [
          {
            id: "i1",
            category: "EVIDENCE_REQUEST_RESPONSE_RECEIVED",
            title: "Submission",
            href: "/evidence-requests/abc",
            occurredAt: new Date(NOW - 3600_000).toISOString(),
            context: { teamId: WS },
          },
        ],
      },
    }),
  );
  assert.equal(vm.showGettingStarted, false);
  const keys = vm.workspacePriorities.map((p) => p.key);
  assert.ok(keys.includes("resolve_integrity"));
  const integrity = vm.workspacePriorities.find((p) => p.key === "resolve_integrity");
  assert.equal(integrity?.count, 14);
  assert.equal(integrity?.severity, "warning");
  assert.ok(integrity?.whyItMatters && integrity.whyItMatters.length > 10, "priority explains why it matters");
  assert.ok(integrity?.actionLabel, "priority carries an action label");
});

// ---------------------------------------------------------------------------
// 3 — KPI cards carry real values.
// ---------------------------------------------------------------------------

test("KPI cards render real view-model values (no fabrication)", () => {
  // Phase HOME-TRUTH-FIX — the "trust" KPI now uses `endToEndReady`
  // (status=REPORTED ∧ has Report ∧ has Package), NOT `signed`. The
  // previous predicate could show 100% when every record was missing
  // a deliverable (puppeteer __name failure mode). To keep this test
  // meaningful we feed BOTH counts and assert the KPI reflects
  // `endToEndReady`, not `signed`.
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 334,
        signed: 300, // 300 records have a signature
        endToEndReady: 200, // ...but only 200 have full deliverable chain
        publicVerify: { published: 118 },
        needingAttention: 0,
      },
      commandCenter: {
        sections: {
          caseOperations: { data: { activeCasesCount: 7, topCases: [] } },
          pipelineDetail: { data: { reports: { ready: 12 }, packages: { ready: 9 } } },
        },
      },
    }),
  );
  const byKey = Object.fromEntries(vm.kpis.map((k) => [k.key, k]));
  assert.equal(byKey.evidence.value, "334");
  assert.equal(byKey.matters.value, "7");
  // ≥10 records ⇒ percentage. The KPI must use endToEndReady (200),
  // NOT signed (300). 200/334 ⇒ 60%.
  assert.equal(byKey.trust.value, `${Math.round((200 / 334) * 100)}%`);
  assert.equal(byKey.trust.label, "End-to-end ready");
  assert.equal(byKey.deliverables.value, "12 / 9");
});

// ---------------------------------------------------------------------------
// 4 — Activity series from real data.
// ---------------------------------------------------------------------------

test("Evidence Activity series builds from real evidence + report timestamps", () => {
  const today = new Date(NOW - 2 * 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          { id: "e1", type: "PHOTO", createdAt: today, teamId: WS },
          { id: "e2", type: "PHOTO", createdAt: today, teamId: WS },
        ],
      },
      reports: {
        items: [
          { evidenceId: "e1", title: "R", report: { available: true, generatedAtUtc: today } },
        ],
      },
    }),
  );
  assert.equal(vm.activitySeries.points.length, 14);
  assert.equal(vm.activitySeries.totalEvidence, 2);
  assert.equal(vm.activitySeries.totalReports, 1);
  const last = vm.activitySeries.points[13];
  assert.equal(last.evidence, 2);
  assert.equal(last.reports, 1);
});

// ---------------------------------------------------------------------------
// 5 — Donut distribution.
// ---------------------------------------------------------------------------

test("Evidence-by-type donut reflects the real type distribution, including archive/folder/other file classification", () => {
  const t = new Date(NOW - 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          { id: "a", type: "PHOTO", mimeType: "image/jpeg", createdAt: t, teamId: WS },
          { id: "b", type: "PHOTO", mimeType: "image/jpeg", createdAt: t, teamId: WS },
          { id: "c", type: "DOCUMENT", mimeType: "application/pdf", createdAt: t, teamId: WS },
          { id: "d", type: "VIDEO", mimeType: "video/mp4", createdAt: t, teamId: WS },
          { id: "e", type: "AUDIO", mimeType: "audio/mpeg", createdAt: t, teamId: WS },
          { id: "f", type: "DOCUMENT", mimeType: "application/zip", createdAt: t, teamId: WS },
          { id: "g", type: "DOCUMENT", mimeType: "application/octet-stream", captureMethod: "MULTIPART_PACKAGE", createdAt: t, teamId: WS },
          { id: "h", type: "DOCUMENT", mimeType: "application/octet-stream", createdAt: t, teamId: WS },
        ],
      },
    }),
  );
  assert.equal(vm.typeDistribution.sampleSize, 8);
  const images = vm.typeDistribution.slices.find((s) => s.label === "Images");
  const archives = vm.typeDistribution.slices.find((s) => s.label === "Archives");
  const folders = vm.typeDistribution.slices.find((s) => s.label === "Folders");
  const other = vm.typeDistribution.slices.find((s) => s.label === "Other Files");
  assert.equal(images?.count, 2);
  assert.equal(images?.percent, 25);
  assert.equal(archives?.count, 1);
  assert.equal(folders?.count, 1);
  assert.equal(other?.count, 1);
});

// ---------------------------------------------------------------------------
// 6 — Recent Evidence title fallback.
// ---------------------------------------------------------------------------

test("recent-evidence titles use the fallback chain — never UUID/generic spam", () => {
  const t = new Date(NOW - 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          { id: "00000000-0000-4000-8000-00000000aaaa", title: "Door camera capture", createdAt: t, teamId: WS, type: "PHOTO" },
          // Generic backend default must fall through to the filename.
          { id: "00000000-0000-4000-8000-00000000bbbb", title: "Digital Evidence Record", displayFileName: "IMG_2024_1053.jpg", createdAt: t, teamId: WS, type: "PHOTO" },
          { id: "00000000-0000-4000-8000-00000000cccc", displayFileName: "contract.pdf", createdAt: t, teamId: WS, type: "DOCUMENT" },
          { id: "00000000-0000-4000-8000-00000000dddd", caseId: "case-1", createdAt: t, teamId: WS, type: "VIDEO" },
          { id: "00000000-0000-4000-8000-00000000eeee", createdAt: t, teamId: WS, type: "AUDIO" },
        ],
      },
    }),
  );
  const titles = vm.richRecentEvidence.map((r) => r.title);
  assert.equal(titles[0], "Door camera capture");
  assert.equal(titles[1], "IMG_2024_1053.jpg");
  assert.equal(titles[2], "contract.pdf");
  assert.equal(titles[3], "Case evidence — Videos");
  assert.equal(titles[4], "Audio record · 00000000");
  // Never a raw 36-char uuid as the visible title.
  for (const title of titles) {
    assert.ok(!/^[0-9a-f-]{36}$/i.test(title), `raw uuid leaked: ${title}`);
  }
});

// ---------------------------------------------------------------------------
// 7 — Operational Queue severity breakdown.
// ---------------------------------------------------------------------------

test("integrity queue item carries the real severity breakdown", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 20,
        signed: 15,
        tsa: { failed: 3 },
        ots: { pending: 10 },
        needingAttention: 14,
      },
    }),
  );
  const integrity = vm.operationalQueue.find((q) => q.type === "fix_integrity");
  assert.ok(integrity, "integrity item must exist when needingAttention > 0");
  assert.deepEqual(integrity?.breakdown, [
    "3 TSA failed",
    "10 OTS pending",
    "5 unsigned",
  ]);
});

// ---------------------------------------------------------------------------
// 8 — Trust State tone styling (source contract).
// ---------------------------------------------------------------------------

test("Trust State rows are tone-styled for failed/pending/success", () => {
  assert.match(SECTIONS_SRC, /tone:\s*trust\.tsaFailed > 0 \? "danger" : trust\.tsaPending > 0 \? "warn"/);
  // The row renderer maps tones to status colors.
  assert.match(SECTIONS_SRC, /r\.tone === "danger"[\s\S]{0,120}r\.tone === "warn"/);
});

// ---------------------------------------------------------------------------
// 9 — Workspace Health overall verdict.
// ---------------------------------------------------------------------------

test("workspace health computes the overall verdict from metric tones", () => {
  const danger = normalizeHomeViewModel(
    baseInputs({ trustSummary: { totalEvidence: 5, signed: 1, needingAttention: 2 } }),
  );
  assert.equal(danger.workspaceHealthOverall, "action_required");

  const healthy = normalizeHomeViewModel(baseInputs());
  assert.notEqual(healthy.workspaceHealthOverall, "action_required");
});

// ---------------------------------------------------------------------------
// 10 — CTA hygiene.
// ---------------------------------------------------------------------------

test("no Home CTA points at /workspaces, bare /evidence-requests, or /v/", () => {
  assert.ok(!/href="\/workspaces/.test(ALL_UI_SRC), "found /workspaces href");
  assert.ok(!/href:\s*"\/workspaces/.test(ALL_UI_SRC), "found /workspaces href in VM");
  assert.ok(!/href:\s*"\/evidence-requests"/.test(ALL_UI_SRC), "found bare /evidence-requests href");
  assert.ok(!/href="\/evidence-requests"/.test(ALL_UI_SRC), "found bare /evidence-requests href");
  assert.ok(!/href[:=]\s*["'`]\/v\//.test(ALL_UI_SRC), "found /v/ href");
});

// ---------------------------------------------------------------------------
// 11 — Search routes to /search?q=…
// ---------------------------------------------------------------------------

test("the header search routes to /search with the query", () => {
  assert.match(DASH_SRC, /router\.push\(q \? `\/search\?q=\$\{encodeURIComponent\(q\)\}` : "\/search"\)/);
});

// ---------------------------------------------------------------------------
// 12 — No fake data in charts.
// ---------------------------------------------------------------------------

test("charts render exclusively from real series — empty inputs ⇒ empty charts", () => {
  const vm = normalizeHomeViewModel(baseInputs());
  assert.equal(vm.activitySeries.totalEvidence, 0);
  assert.equal(vm.activitySeries.totalReports, 0);
  assert.equal(vm.typeDistribution.sampleSize, 0);
  // The chart components fabricate nothing.
  assert.ok(!/Math\.random/.test(DASH_SRC), "chart code must not use Math.random");
});

// ===========================================================================
// Phase HOME-FIELD-WIRING — Tickets 1-4 regression locks.
// ===========================================================================

// Ticket 1 — report/package pending never double-counts the queued alias.
test("T1: pending reads the authoritative counter, never queued + alias", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          pipelineDetail: {
            data: {
              reports: { ready: 1, queued: 5, failed: 0, missingFromSigned: 5 },
              packages: { ready: 1, queued: 3, failed: 0, blocked: 0, missingFromReported: 3 },
            },
          },
        },
      },
    }),
  );
  assert.equal(vm.reportProduction.reportsPending, 5);
  assert.equal(vm.reportProduction.packagesPending, 3);
});

// Ticket 2 — intake stages are six DISTINCT counts.
test("T2: received and pending review come from different fields", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      intakeLinks: {
        links: [
          { id: "l1", status: "ACTIVE", usedCount: 1, maxUses: 1, expiresAtUtc: "2026-07-01T00:00:00Z", createdAt: "2026-06-10T00:00:00Z" },
        ],
      },
      communications: {
        messages: [
          { id: "m1", channel: "SMS", status: "DELIVERED", createdAt: "2026-06-10T01:00:00Z", deliveredAtUtc: "2026-06-10T01:01:00Z", relatedIntakeLinkId: "l1" },
        ],
      },
      inbox: {
        items: [
          { id: "a", category: "intake_submission_pending_review", title: "S1", href: "/evidence-requests/a", occurredAt: "2026-06-11T00:00:00Z", context: { teamId: WS } },
          { id: "b", category: "intake_submission_pending_review", title: "S2", href: "/evidence-requests/b", occurredAt: "2026-06-11T00:00:00Z", context: { teamId: WS } },
          { id: "c", category: "intake_required_items_missing", title: "S3", href: "/evidence-requests/c", occurredAt: "2026-06-11T00:00:00Z", context: { teamId: WS } },
        ],
      },
    }),
  );
  const byKey = Object.fromEntries(vm.intakePipeline.stages.map((s) => [s.key, s.count]));
  assert.equal(byKey.active, 1);
  assert.equal(byKey.delivered, 1);
  assert.equal(byKey.in_review, 2);
  assert.equal(byKey.needs_more, 1);
  assert.equal(byKey.failed, 0);
  assert.equal(byKey.received, undefined);
  // No two stages may silently share a source count object.
  const keys = vm.intakePipeline.stages.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
});

// Ticket 3A — section-level matter counters reach VM + UI.
test("T3A: unlinked/unreviewed counters reach the VM and the Active Matters chips", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          caseOperations: {
            data: { activeCasesCount: 1, unlinkedEvidenceCount: 2, unreviewedEvidenceCount: 3, topCases: [] },
          },
        },
      },
    }),
  );
  assert.equal(vm.caseHealthSummary.unlinkedCount, 2);
  assert.equal(vm.caseHealthSummary.unreviewedCount, 3);
  // UI renders them only when > 0 (conditional chips with data attrs).
  assert.match(SECTIONS_SRC, /summary\.unlinkedCount > 0 \?[\s\S]{0,200}data-case-unlinked/);
  assert.match(SECTIONS_SRC, /summary\.unreviewedCount > 0 \?[\s\S]{0,200}data-case-unreviewed/);
  // Zero-data VM keeps them at 0 (hidden).
  const empty = normalizeHomeViewModel(baseInputs());
  assert.equal(empty.caseHealthSummary.unlinkedCount, 0);
  assert.equal(empty.caseHealthSummary.unreviewedCount, 0);
});

// Ticket 3B — tsa.none / ots.none pass through and render conditionally.
test("T3B: tsa.none and ots.none reach Trust State (neutral, conditional)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 10,
        tsa: { stamped: 5, none: 5 },
        ots: { anchored: 4, none: 6 },
      },
    }),
  );
  assert.equal(vm.trustState.tsaNone, 5);
  assert.equal(vm.trustState.otsNone, 6);
  // Rendered as a conditional suffix; never changes the row tone.
  assert.match(SECTIONS_SRC, /trust\.tsaNone \? ` · \$\{trust\.tsaNone\} not stamped` : ""/);
  assert.match(SECTIONS_SRC, /trust\.otsNone \? ` · \$\{trust\.otsNone\} not anchored yet` : ""/);
});

// Ticket 3C — previously filtered timeline kinds now appear with safe labels.
test("T3C: lifecycle_transition + destruction_review appear with self-serve labels", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          timeline: {
            items: [
              { id: "t1", kind: "lifecycle_transition", occurredAt: new Date(NOW - 3600_000).toISOString(), href: "/evidence/e1" },
              { id: "t2", kind: "destruction_review", occurredAt: new Date(NOW - 7200_000).toISOString(), href: "/evidence/e2" },
            ],
          },
        },
      },
    }),
  );
  const labels = vm.activity.flatMap((g) => g.events.map((e) => e.label));
  assert.ok(labels.includes("Evidence lifecycle updated"));
  assert.ok(labels.includes("Retention review recorded"));
  // Raw event names never leak as labels.
  assert.ok(!labels.includes("lifecycle_transition"));
  assert.ok(!labels.includes("destruction_review"));
  // subtitle/severity were explicitly removed from the TIMELINE input
  // type (the integrity-watch sections legitimately keep severity).
  const timelineBlockStart = VM_SRC.indexOf("timeline?: {");
  const timelineBlockEnd = VM_SRC.indexOf("custodyIntegrityAnomalies", timelineBlockStart);
  const timelineBlock = VM_SRC.slice(timelineBlockStart, timelineBlockEnd);
  assert.ok(timelineBlockStart > 0, "timeline input type must exist");
  assert.ok(!/subtitle\?:/.test(timelineBlock), "timeline subtitle must not linger in the input type");
  assert.ok(!/severity\?:/.test(timelineBlock), "timeline severity must not linger in the input type");
});

// Ticket 4 — dead fields removed or rendered.
test("T4: hasAnyData/recentReports removed; manageHref/expiry/delivery-at rendered", () => {
  const vm = normalizeHomeViewModel(baseInputs()) as Record<string, unknown>;
  assert.ok(!("hasAnyData" in vm), "hasAnyData must be removed (no consumer)");
  assert.ok(!("recentReports" in vm), "recentReports is internal-only now");
  // CollectionRow.status removed (constant ACTIVE after the filter).
  assert.ok(!/status:\s*l\.status/.test(VM_SRC), "CollectionRow.status mapping must be gone");
  // Rendered survivors:
  assert.match(SECTIONS_SRC, /cta=\{\{ label: "Manage team", href: team\.manageHref \}\}/);
  assert.match(SECTIONS_SRC, /data-link-expires/);
  assert.match(SECTIONS_SRC, /r\.delivery\.at \? ` · \$\{formatRelative\(r\.delivery\.at\)\}` : ""/);
});

// ===========================================================================
// Phase HOME-INTELLIGENCE — regression locks.
// ===========================================================================

const SEARCH_SRC = readFileSync(
  resolve(__dirname, "..", "app", "(app)", "search", "page.tsx"),
  "utf8",
);

test("INTEL: priorities rank critical > warning > info with reasons and actions", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 50,
        signed: 40,
        tsa: { failed: 33 },
        ots: { pending: 10 },
        needingAttention: 14,
        publicVerify: { published: 5 },
      },
      reports: {
        items: [{ evidenceId: "e1", title: "R", report: { available: true } }],
      },
      commandCenter: {
        sections: {
          pipelineDetail: {
            data: { publicVerify: { unpublished: 3 }, packages: { queued: 0 } },
          },
        },
      },
    }),
  );
  const p = vm.workspacePriorities;
  assert.equal(p[0].key, "tsa_failures");
  assert.equal(p[0].severity, "critical");
  assert.equal(p[0].count, 33);
  // Warnings before infos.
  const severities = p.map((x) => x.severity);
  const lastCritical = severities.lastIndexOf("critical");
  const firstWarning = severities.indexOf("warning");
  const firstInfo = severities.indexOf("info");
  if (firstWarning >= 0 && lastCritical >= 0) assert.ok(lastCritical < firstWarning);
  if (firstInfo >= 0 && firstWarning >= 0) assert.ok(severities.lastIndexOf("warning") < firstInfo);
  // Phase HOME-DECISIONS — every priority is a full decision:
  // explained, actionable, and auditable back to real source fields.
  for (const item of p) {
    assert.ok(item.whyItMatters.length > 10, `${item.key} has whyItMatters`);
    assert.ok(item.recommendedAction.length > 10, `${item.key} has a recommendedAction`);
    assert.ok(item.actionLabel.length > 0, `${item.key} has an action`);
    assert.ok(item.domains.length > 0, `${item.key} has source domains`);
    assert.ok(item.derivedFrom.length > 0, `${item.key} has derivedFrom`);
    for (const src of item.derivedFrom) {
      assert.match(src, /^[a-z-]+\/[a-z-]+\.|^reports\.|^me\/inbox|^workflow\//i, `${item.key} derivedFrom looks like a real source: ${src}`);
    }
  }
});

test("INTEL: zero data emits zero priorities (all-clear, nothing fabricated)", () => {
  const vm = normalizeHomeViewModel(baseInputs({ plan: "FREE" }));
  assert.equal(vm.workspacePriorities.length, 0);
});

test("DECISIONS: matter deliverable chain → needs_report / missing_package / needs_publication / ready", () => {
  // Phase HOME-DECISIONS — the bounded per-case aggregates drive the
  // full chain verdict (spec Part 3 status logic).
  const cc = {
    sections: {
      caseOperations: {
        data: {
          activeCasesCount: 4,
          topCases: [
            { caseId: "no-report", caseName: "A", evidenceCount: 4, reportsReadyCount: 0, packagesReadyCount: 0, verifyLiveCount: 0 },
            { caseId: "no-package", caseName: "B", evidenceCount: 2, reportsReadyCount: 2, packagesReadyCount: 0, verifyLiveCount: 0 },
            { caseId: "no-verify", caseName: "C", evidenceCount: 2, reportsReadyCount: 2, packagesReadyCount: 2, verifyLiveCount: 0 },
            { caseId: "done", caseName: "D", evidenceCount: 2, reportsReadyCount: 2, packagesReadyCount: 2, verifyLiveCount: 2 },
          ],
        },
      },
    },
  };
  const vm = normalizeHomeViewModel(baseInputs({ commandCenter: cc }));
  const byId = Object.fromEntries(vm.activeMatters.map((m) => [m.caseId, m]));
  assert.equal(byId["no-report"].verificationStatus, "needs_report");
  assert.equal(byId["no-report"].verdict, "needs_work");
  assert.ok(byId["no-report"].statusLabel.includes("no report yet"));
  assert.equal(byId["no-package"].verificationStatus, "missing_package");
  assert.equal(byId["no-package"].verdict, "needs_work");
  assert.ok(byId["no-package"].statusLabel.includes("package missing"));
  assert.equal(byId["no-verify"].verificationStatus, "needs_publication");
  assert.equal(byId["no-verify"].verdict, "needs_work");
  assert.equal(byId["done"].verificationStatus, "ready");
  assert.equal(byId["done"].verdict, "healthy");
  assert.equal(byId["done"].verifyLiveCount, 2);
  // Matters needing work feed the priorities layer (3 of 4 incomplete).
  assert.ok(vm.workspacePriorities.some((p) => p.key === "matters_need_reports" && p.count === 3));
});

test("DECISIONS: older payloads without per-case fields fall back to /v1/reports caseIds", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          caseOperations: {
            data: {
              activeCasesCount: 1,
              topCases: [{ caseId: "c-2", caseName: "Reported", evidenceCount: 2 }],
            },
          },
        },
      },
      reports: {
        items: [{ evidenceId: "e9", title: "R", caseId: "c-2", report: { available: true } }],
      },
    }),
  );
  const m = vm.activeMatters[0];
  assert.equal(m.hasReport, true);
  // Without package/verify aggregates the chain conservatively reports
  // the next missing step — never fabricated readiness.
  assert.equal(m.verificationStatus, "missing_package");
});

test("DECISIONS: storage pressure and reports-ready emit ranked decisions", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      billing: {
        workspaces: {
          personal: { storage: { usedLabel: "9.4 GB", limitLabel: "10 GB", usagePercent: 94, nearLimit: true, limitReached: false } },
        },
      },
      commandCenter: {
        sections: { pipelineDetail: { data: { reports: { ready: 365 } } } },
      },
      trustSummary: { totalEvidence: 365, signed: 365 },
    }),
  );
  const byKey = Object.fromEntries(vm.workspacePriorities.map((p) => [p.key, p]));
  assert.equal(byKey.storage_pressure.severity, "warning");
  assert.match(byKey.storage_pressure.whyItMatters, /uploads may be blocked/i);
  assert.equal(byKey.reports_ready.severity, "info");
  assert.equal(byKey.reports_ready.count, 365);
  // Warning (storage) ranks above info (reports ready).
  const keys = vm.workspacePriorities.map((p) => p.key);
  assert.ok(keys.indexOf("storage_pressure") < keys.indexOf("reports_ready"));
});

test("DECISIONS: recent verification publications surface in Verification Health", () => {
  const t = new Date(NOW - 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          timeline: {
            items: [
              { id: "v1", kind: "verification_published", occurredAt: t, label: "Verification published — Door camera", href: "/evidence/e1" },
            ],
          },
        },
      },
    }),
  );
  assert.equal(vm.verificationHealth.recentPublications.length, 1);
  assert.equal(vm.verificationHealth.recentPublications[0].label, "Verification published — Door camera");
  // No publications ⇒ empty list, nothing fabricated.
  const empty = normalizeHomeViewModel(baseInputs());
  assert.equal(empty.verificationHealth.recentPublications.length, 0);
});

test("INTEL: matter with escalations/overdue → action_required (ranked first)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          caseOperations: {
            data: {
              activeCasesCount: 2,
              topCases: [
                { caseId: "ok", caseName: "Fine", evidenceCount: 0 },
                { caseId: "hot", caseName: "Blocked", evidenceCount: 3, openEscalationsCount: 2 },
              ],
            },
          },
        },
      },
    }),
  );
  assert.equal(vm.activeMatters[0].caseId, "hot");
  assert.equal(vm.activeMatters[0].verdict, "action_required");
});

test("INTEL: verification issues combine package/publish signals (real counts)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: { totalEvidence: 10, signed: 8, publicVerify: { published: 2 } },
      commandCenter: {
        sections: {
          pipelineDetail: {
            data: {
              packages: { ready: 4, queued: 3 },
              publicVerify: { unpublished: 5 },
            },
          },
        },
      },
    }),
  );
  const issues = Object.fromEntries(vm.verificationHealth.issues.map((i) => [i.key, i]));
  assert.equal(issues.publish_ready.count, 4); // min(packagesReady=4, unpublished=5)
  assert.equal(issues.package_gap.count, 3);
  // Empty pipeline ⇒ no issues fabricated.
  const empty = normalizeHomeViewModel(baseInputs());
  assert.equal(empty.verificationHealth.issues.length, 0);
});

test("INTEL: report needs-action surfaces failures without fabricating a retry", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          pipelineDetail: {
            data: {
              reports: { ready: 2, queued: 0, failed: 3 },
              packages: { ready: 1, queued: 2, failed: 1 },
              publicVerify: { unpublished: 1 },
            },
          },
        },
      },
    }),
  );
  const issues = Object.fromEntries(vm.reportProduction.needsAction.map((i) => [i.key, i]));
  assert.equal(issues.failed_deliverables.count, 4); // 3 + 1
  assert.equal(issues.failed_deliverables.href, "/inbox");
  assert.equal(issues.package_gap.count, 2);
  // No retry endpoint exists for report jobs — the card must not ship one.
  const cardStart = SECTIONS_SRC.indexOf("export function ReportProductionCard");
  const cardSrc = SECTIONS_SRC.slice(cardStart, cardStart + 4000);
  assert.ok(!/retry/i.test(cardSrc), "no fabricated retry in Report Production");
});

test("INTEL: verification_published events render; identical labels collapse ×N", () => {
  const t = (h: number) => new Date(NOW - h * 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          timeline: {
            items: [
              { id: "v1", kind: "verification_published", occurredAt: t(1), label: "Verification published — Door camera", href: "/evidence/e1" },
              { id: "r1", kind: "report_generated", occurredAt: t(2), href: "/evidence/e1" },
              { id: "r2", kind: "report_generated", occurredAt: t(3), href: "/evidence/e2" },
              { id: "r3", kind: "report_generated", occurredAt: t(4), href: "/evidence/e3" },
            ],
          },
        },
      },
    }),
  );
  const today = vm.activity.find((g) => g.key === "today");
  assert.ok(today);
  const verify = today?.events.find((e) => e.kind === "verification_published");
  assert.equal(verify?.label, "Verification published — Door camera");
  const reports = today?.events.filter((e) => e.kind === "report_generated") ?? [];
  assert.equal(reports.length, 1, "identical report labels collapse to one row");
  assert.equal(reports[0].repeatCount, 3);
});

test("INTEL: request-more activity is surfaced from inbox and incident/escalation noise stays off self-serve Home", () => {
  const t = (h: number) => new Date(NOW - h * 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      inbox: {
        items: [
          {
            id: "req-more",
            category: "intake_required_items_missing",
            title: "Witness photos — need clearer plate image",
            href: "/evidence-requests/req-more",
            occurredAt: t(1),
            context: { teamId: WS },
          },
        ],
      },
      commandCenter: {
        sections: {
          timeline: {
            items: [
              { id: "i1", kind: "incident_opened", occurredAt: t(2), label: "Incident opened — Report generation failed", href: "/ops/observability" },
              { id: "e1", kind: "escalation_opened", occurredAt: t(3), label: "Escalation opened — overdue review", href: "/reviewer-ops/escalations" },
            ],
          },
        },
      },
    }),
  );
  const labels = vm.activity.flatMap((g) => g.events.map((e) => e.label));
  assert.ok(labels.includes("Request more sent — Witness photos — need clearer plate image"));
  assert.ok(!labels.some((label) => /Incident opened/i.test(label)));
  assert.ok(!labels.some((label) => /Escalation opened/i.test(label)));
});

test("INTEL: /search reads the q deep-link param and seeds the live filter", () => {
  assert.match(SEARCH_SRC, /URLSearchParams\(window\.location\.search\)\.get\("q"\)/);
  assert.match(SEARCH_SRC, /setQDraft\(initialQ\)/);
  assert.match(SEARCH_SRC, /\.\.\.\(initialQ \? \{ q: initialQ \} : \{\}\)/);
});

// ===========================================================================
// Phase HOME-EXEC — Executive Summary regression locks.
// ===========================================================================

test("EXEC: TSA failures force a critical summary (never healthy)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: { totalEvidence: 50, signed: 50, tsa: { stamped: 17, failed: 33 } },
    }),
  );
  const ex = vm.executiveSummary;
  assert.equal(ex.overallStatus, "critical");
  assert.equal(ex.statusLabel, "Critical");
  assert.match(ex.summaryTitle, /33 TSA timestamp/);
  assert.ok(ex.summarySentence.length > 20);
  assert.equal(ex.affectedCount, 33);
  assert.ok(ex.actionHref, "critical summary carries an action");
  assert.ok(ex.derivedFrom.includes("dashboard/trust-summary.tsa.failed"));
});

test("EXEC: integrity attention → action_required; OTS pending only → needs_attention", () => {
  const integrity = normalizeHomeViewModel(
    baseInputs({ trustSummary: { totalEvidence: 20, signed: 20, needingAttention: 14 } }),
  );
  assert.equal(integrity.executiveSummary.overallStatus, "action_required");
  assert.match(integrity.executiveSummary.summarySentence, /integrity review/i);

  const pending = normalizeHomeViewModel(
    baseInputs({ trustSummary: { totalEvidence: 10, signed: 10, ots: { anchored: 0, pending: 10 } } }),
  );
  assert.equal(pending.executiveSummary.overallStatus, "needs_attention");
});

test("EXEC: all-clear data → Healthy with the normal-operations sentence", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 5,
        signed: 5,
        tsa: { stamped: 5 },
        ots: { anchored: 5 },
        publicVerify: { published: 5 },
      },
    }),
  );
  const ex = vm.executiveSummary;
  assert.equal(ex.overallStatus, "healthy");
  assert.match(ex.summarySentence, /operating normally/);
  assert.equal(ex.topCause, null);
});

test("EXEC: zero-data user gets the onboarding summary, never fake health", () => {
  const ex = normalizeHomeViewModel(baseInputs()).executiveSummary;
  assert.equal(ex.overallStatus, "onboarding");
  assert.match(ex.summaryTitle, /first evidence workflow/i);
  assert.equal(ex.actionHref, "/capture");
});

test("EXEC: unsigned records block the healthy state", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({ trustSummary: { totalEvidence: 10, signed: 7, tsa: { stamped: 10 }, ots: { anchored: 10 } } }),
  );
  assert.notEqual(vm.executiveSummary.overallStatus, "healthy");
});

test("EXEC: suspended verification → action_required + danger issue first", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: { totalEvidence: 10, signed: 10, publicVerify: { published: 8, suspended: 2 } },
    }),
  );
  assert.equal(vm.executiveSummary.overallStatus, "action_required");
  const first = vm.verificationHealth.issues[0];
  assert.equal(first?.key, "suspended_verification");
  assert.equal(first?.count, 2);
  assert.equal(first?.tone, "danger");
});

// ===========================================================================
// Phase HOME-PROOF — bug-fix regression locks.
// ===========================================================================

// PROOF-1 — Report Production download buttons must hand the Recent
// Reports row an API path (NOT an app route), and the UI must call
// apiFetch + window.open rather than rendering a plain <a href>. The
// earlier shape produced a 404 because the browser navigated to the
// API host without an Authorization header.
test("PROOF: Download PDF / Download Package route through apiFetch, not raw <a href>", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      reports: {
        items: [{ evidenceId: "e1", title: "Witness statement", report: { available: true, version: 2 }, package: { available: true, version: 1 } }],
      },
    }),
  );
  const row = vm.reportProduction.recent[0];
  assert.ok(row, "recent report row exists");
  // API paths only — confirms the broken plain-href shape is gone.
  assert.equal(row.actions.reportPdfApiPath, "/v1/evidence/e1/report/latest");
  assert.equal(row.actions.packageZipApiPath, "/v1/evidence/e1/verification-package");
  // The UI MUST call apiFetch and open the returned presigned URL —
  // never expose the API path as an <a href>.
  assert.match(SECTIONS_SRC, /reportPdfApiPath/);
  assert.match(SECTIONS_SRC, /packageZipApiPath/);
  assert.match(SECTIONS_SRC, /apiFetch\(path/);
  assert.match(SECTIONS_SRC, /window\.open\(resp\.url/);
  // No remaining anti-pattern: a plain <a href={...reportPdf...}>.
  assert.ok(
    !/<a[^>]+href=\{[^}]*reportPdf[^}]*\}/.test(SECTIONS_SRC),
    "Download PDF must not be a plain <a href>",
  );
  assert.ok(
    !/<a[^>]+href=\{[^}]*packageZip[^}]*\}/.test(SECTIONS_SRC),
    "Download package must not be a plain <a href>",
  );
});

// PROOF-2 — Evidence-by-Type classification: a real PDF that happened
// to be captured through the multipart code path must STILL land in
// Documents (not Folders).
test("PROOF: PDF inside a multipart capture is classified as Documents, not Folders", () => {
  const t = new Date(NOW - 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          { id: "pdf-batch", type: "DOCUMENT", mimeType: "application/pdf", captureMethod: "MULTIPART_PACKAGE", createdAt: t, teamId: WS },
          { id: "img-batch", type: "PHOTO", mimeType: "image/jpeg", captureMethod: "MULTIPART_PACKAGE", createdAt: t, teamId: WS },
          { id: "true-folder", type: "DOCUMENT", mimeType: "application/octet-stream", captureMethod: "MULTIPART_PACKAGE", createdAt: t, teamId: WS },
        ],
      },
    }),
  );
  const byLabel = Object.fromEntries(vm.typeDistribution.slices.map((s) => [s.label, s.count]));
  assert.equal(byLabel["Documents"], 1, "PDF in multipart batch → Documents");
  assert.equal(byLabel["Images"], 1, "image in multipart batch → Images");
  assert.equal(byLabel["Folders"], 1, "only the unknown-MIME multipart record → Folders");
});

// PROOF-3 (CLOSURE) — Workspace Priority hrefs deep-link to the EXACT
// dataset the Home count was derived from. Each priority's href set
// of trust-status values must match the trust-summary bucket that
// produced the count, or the destination shows a different number of
// records than Home advertised.
test("CLOSURE: priority hrefs match the trust-summary bucket — destination count == Home count", () => {
  const trustVm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 30,
        signed: 25,
        tsa: { stamped: 20, failed: 5 },
        ots: { anchored: 18, pending: 6 },
        needingAttention: 3,
      },
    }),
  );
  const byKey = Object.fromEntries(trustVm.workspacePriorities.map((p) => [p.key, p.href]));
  // tsa.failed bucket = FAILED | REJECTED | ERROR (trust-summary.service.ts:64)
  assert.equal(byKey["tsa_failures"], "/evidence?tsaStatus=FAILED,REJECTED,ERROR");
  // ots.pending bucket = PENDING | UPGRADING | QUEUED (trust-summary.service.ts:71)
  assert.equal(byKey["ots_pending"], "/evidence?otsStatus=PENDING,UPGRADING,QUEUED");
  // needingAttention = verificationStatus IN (REVIEW_REQUIRED, FAILED) (trust-summary.service.ts:111-114)
  // CRITICAL REGRESSION LOCK: this must NEVER again be "/evidence?status=uploaded",
  // which filtered the wrong column entirely (Evidence.status, not Evidence.verificationStatus).
  assert.equal(byKey["resolve_integrity"], "/evidence?verificationStatus=REVIEW_REQUIRED,FAILED");
  assert.notEqual(byKey["resolve_integrity"], "/evidence?status=uploaded");

  const verifyVm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          pipelineDetail: { data: { publicVerify: { unpublished: 4 } } },
        },
      },
      reports: { items: [{ evidenceId: "e", title: "R", report: { available: true } }] },
    }),
  );
  const verifyByKey = Object.fromEntries(verifyVm.workspacePriorities.map((p) => [p.key, p.href]));
  // publicVerify.unpublished bucket includes both NOT_PUBLISHED and UNPUBLISHED
  // (trust-summary.service.ts:132-134).
  assert.equal(verifyByKey["publish_verification"], "/evidence?publicVerifyState=NOT_PUBLISHED,UNPUBLISHED");
});

// CTA-NORMALIZATION — three Home Integrity surfaces (header, queue,
// priority) used to all be labelled "Review Integrity" with two of
// them routing to bare /evidence (no filter). The normalization pass:
//   (a) renames the header CTA to "Evidence Queue" → /evidence
//       (independent of operational state — header is navigation, not
//       a duplicate decision surface);
//   (b) makes the Operational Queue card and the Workspace Priorities
//       row share the SAME constant integrity href, so clicking
//       either opens the exact dataset whose count Home displayed.
test("CTA-NORM: Header CTA is 'Evidence Queue' → /evidence (never duplicates the queue's Review Integrity)", () => {
  // Static source check — the SelfServeHomeDashboard hands the
  // HomeHeader the heroAction; HomeHeader's primary logic now ignores
  // heroAction.ctaLabel / .href except in the start_capture case.
  assert.match(DASH_SRC, /hero\.kind === "capture_first"\s*\?\s*\{\s*label:\s*"Capture evidence"/);
  assert.match(DASH_SRC, /\{\s*label:\s*"Evidence Queue"\s*,\s*href:\s*"\/evidence"\s*\}/);
  // Regression lock — must NEVER again use hero.ctaLabel for the header
  // primary, which is what duplicated "Review Integrity" twice.
  assert.ok(
    !/label:\s*hero\.ctaLabel/.test(DASH_SRC),
    "HomeHeader must not derive its label from hero.ctaLabel anymore",
  );
});

test("CTA-NORM: Operational Queue integrity CTA reuses HOME_INTEGRITY_REVIEW_HREF — same dataset as the priority row", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 50,
        signed: 36,
        tsa: { stamped: 30, failed: 3 },
        ots: { anchored: 28, pending: 5 },
        needingAttention: 14,
      },
    }),
  );
  const queueIntegrity = vm.operationalQueue.find((q) => q.type === "fix_integrity");
  const priorityIntegrity = vm.workspacePriorities.find((p) => p.key === "resolve_integrity");
  assert.ok(queueIntegrity, "operational queue integrity item exists");
  assert.ok(priorityIntegrity, "workspace priority integrity row exists");
  // The exact same href — single source of truth.
  assert.equal(queueIntegrity!.action.href, "/evidence?verificationStatus=REVIEW_REQUIRED,FAILED");
  assert.equal(queueIntegrity!.action.href, priorityIntegrity!.href);
  // Used to be a navigation fallback (bare /evidence) — now real.
  assert.equal(queueIntegrity!.fallback, false);
});

test("CTA-NORM: heroAction.fix_integrity also points at the same integrity dataset (used by Operational Queue empty-state)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 20,
        signed: 16,
        tsa: { stamped: 16, failed: 0 },
        ots: { anchored: 14, pending: 0 },
        needingAttention: 4,
      },
    }),
  );
  // The heroAction is computed by pickHeroAction and now uses the
  // shared constant; verify its href matches the queue+priority href.
  assert.equal(vm.heroAction.kind, "fix_integrity");
  assert.equal(vm.heroAction.href, "/evidence?verificationStatus=REVIEW_REQUIRED,FAILED");
});

test("CTA-NORM: source-level single-source-of-truth — every integrity surface uses HOME_INTEGRITY_REVIEW_HREF", () => {
  // The literal string must appear in the constant declaration and
  // NOWHERE ELSE in the view-model file (i.e. nobody is hardcoding it).
  const literal = "/evidence?verificationStatus=REVIEW_REQUIRED,FAILED";
  const occurrences = VM_SRC.split(literal).length - 1;
  assert.equal(
    occurrences,
    1,
    `expected the integrity href literal to appear EXACTLY ONCE in home-view-model.ts (in the constant declaration); found ${occurrences}`,
  );
  // And the constant must be exported.
  assert.match(VM_SRC, /export\s+const\s+HOME_INTEGRITY_REVIEW_HREF\s*=/);
});

// PROOF-4 — Rich activity labels never collapse a real entity into
// a generic "Untitled ×N". The backend builder uses title → display
// filename → original filename → short id as a deterministic fallback.
test("PROOF: activity labels prefer title, then filename, then short id — never 'Untitled'", () => {
  // Direct test of the project-fixed VM behaviour: distinct titles
  // produce distinct rows (collapse is by ${kind}:${label}). Identical
  // labels do collapse — but the backend now seeds non-generic labels
  // so they only collapse when the underlying entity really is the
  // same.
  const vm = normalizeHomeViewModel(
    baseInputs({
      commandCenter: {
        sections: {
          timeline: {
            items: [
              { id: "e1", kind: "evidence_finalized", occurredAt: "2026-06-12T10:00:00Z", label: "Evidence signed — Witness statement", href: "/evidence/e1" },
              { id: "e2", kind: "evidence_finalized", occurredAt: "2026-06-12T09:00:00Z", label: "Evidence signed — Door camera capture", href: "/evidence/e2" },
              { id: "r1", kind: "report_generated", occurredAt: "2026-06-12T08:00:00Z", label: "Report v2 generated — Water damage record", href: "/evidence/r1" },
            ],
          },
        },
      },
    }),
  );
  const labels = vm.activity.flatMap((g) => g.events.map((e) => e.label));
  assert.ok(labels.some((l) => l.includes("Witness statement")));
  assert.ok(labels.some((l) => l.includes("Door camera capture")));
  assert.ok(labels.some((l) => l.includes("Water damage record")));
  // Distinct entities never collapse to a single "×2" row.
  assert.ok(!labels.some((l) => /Untitled/i.test(l)));
});

