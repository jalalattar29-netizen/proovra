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
  assert.equal(integrity?.tone, "danger");
});

// ---------------------------------------------------------------------------
// 3 — KPI cards carry real values.
// ---------------------------------------------------------------------------

test("KPI cards render real view-model values (no fabrication)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 334,
        signed: 300,
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
  // ≥10 records ⇒ percentage; 300/334 ⇒ 90%.
  assert.equal(byKey.trust.value, `${Math.round((300 / 334) * 100)}%`);
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

test("Evidence-by-type donut reflects the real type distribution", () => {
  const t = new Date(NOW - 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          { id: "a", type: "PHOTO", createdAt: t, teamId: WS },
          { id: "b", type: "PHOTO", createdAt: t, teamId: WS },
          { id: "c", type: "DOCUMENT", createdAt: t, teamId: WS },
          { id: "d", type: "VIDEO", createdAt: t, teamId: WS },
        ],
      },
    }),
  );
  assert.equal(vm.typeDistribution.sampleSize, 4);
  const images = vm.typeDistribution.slices.find((s) => s.label === "Images");
  assert.equal(images?.count, 2);
  assert.equal(images?.percent, 50);
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
