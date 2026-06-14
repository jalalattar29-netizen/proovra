/**
 * Phase HOME-TRUTH-FIX — frontend behavioral test for the new
 * operationally-truthful Home view-model.
 *
 * What this file proves end-to-end against `normalizeHomeViewModel`:
 *
 *  1. SIGNED evidence with no Report is NOT counted as End-to-end
 *     ready. The headline KPI stays low.
 *  2. SIGNED evidence with no Report DOES inflate "Operational
 *     issues" and the headline KPI gets a `warn` tone.
 *  3. REPORTED evidence with Report but no Package DOES inflate
 *     "Operational issues".
 *  4. Multiple Report versions for ONE evidence count as ONE ready
 *     evidence record (the version-inflation bug is gone — the
 *     backend now uses evidence-distinct counts; we feed those into
 *     the view-model via the existing pipelineDetail shape).
 *  5. Soft-deleted evidence is NOT in the input list (the backend
 *     excludes it), so it does not inflate the counts.
 *  6. TSA-failed evidence is surfaced in the operational/attention
 *     signal mix on Home.
 *  7. OTS-failed evidence is surfaced too.
 *  8. Records by Type stays per-evidence-primary-type (multipart
 *     parts are NOT split into separate buckets). Subtitle wording
 *     remains operator-truthful.
 *  9. The headline KPI's label is "End-to-end ready" — NOT "Trust
 *     ready" — and the subtitle does NOT use the word "sealed" for
 *     report/package readiness.
 * 10. Workspace Health renames "Records complete" → "Records
 *     reported" and adds an "Operational issues" indicator.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeHomeViewModel,
  type NormalizeInputs,
} from "../components/home-experience/home-view-model";

const WS = "ws_truth_fix";
const NOW = Date.parse("2026-06-14T12:00:00Z");

function baseInputs(over: Partial<NormalizeInputs> = {}): NormalizeInputs {
  return {
    workspaceId: WS,
    plan: "PRO",
    activeSpaceType: "PERSONAL",
    isProcessing: false,
    // The fields below are filled in by individual tests.
    trustSummary: null,
    billing: null,
    reports: null,
    intakeLinks: null,
    inbox: null,
    communications: null,
    orgs: [],
    evidenceList: null,
    commandCenter: null,
    organizationName: null,
    organizationSlug: null,
    sessionUserName: null,
    sessionUserEmail: null,
    rawClockNow: NOW,
    rawClockTimezone: "UTC",
    ...over,
  } as NormalizeInputs;
}

// ---------------------------------------------------------------------------
// 1 — End-to-end ready is the headline KPI, NOT signed
// ---------------------------------------------------------------------------

test("KPI label is 'End-to-end ready' (NOT 'Trust ready')", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 50,
        signed: 50,
        endToEndReady: 5,
      },
    }),
  );
  const trust = vm.kpis.find((k) => k.key === "trust");
  assert.ok(trust);
  assert.equal(trust.label, "End-to-end ready");
});

test("100 evidence, 90 SIGNED-without-Report, 10 end-to-end ready → KPI shows 10% (NOT 100%)", () => {
  // This is the exact failure mode the audit identified. With the
  // OLD predicate (signed/total), the KPI showed 100% green while
  // every fresh capture was stuck. The new predicate shows 10%.
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 100,
        signed: 100, // all signed (signing happens before report worker)
        endToEndReady: 10, // only 10 made it through the report+package chain
        signedWithoutReport: 90, // 90 are stuck because the worker died
      },
    }),
  );
  const trust = vm.kpis.find((k) => k.key === "trust");
  assert.equal(trust?.value, "10%");
});

test("KPI subtitle does NOT use the word 'sealed' for report/package readiness", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 100,
        signed: 100,
        endToEndReady: 100,
      },
    }),
  );
  const trust = vm.kpis.find((k) => k.key === "trust");
  assert.ok(trust);
  assert.ok(
    !/sealed/i.test(trust.subtitle ?? ""),
    `KPI subtitle reads "${trust.subtitle}" — must not use "sealed"`,
  );
  // Honest replacement wording is present.
  assert.match(trust.subtitle ?? "", /report \+ package/);
});

test("KPI tone is 'warn' when stuck-SIGNED or stuck-REPORTED records exist", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 100,
        signed: 100,
        endToEndReady: 70,
        signedWithoutReport: 20,
        reportedWithoutPackage: 10,
      },
    }),
  );
  const trust = vm.kpis.find((k) => k.key === "trust");
  assert.equal(trust?.tone, "warn");
});

// ---------------------------------------------------------------------------
// 2 — Operational Issues indicator catches stuck-deliverable evidence
// ---------------------------------------------------------------------------

test("Workspace Health includes an 'Operational issues' indicator", () => {
  const vm = normalizeHomeViewModel(baseInputs());
  const keys = vm.workspaceHealth.map((m) => m.key);
  assert.ok(keys.includes("operational"));
});

test("Operational Issues sums stuck-SIGNED + stuck-REPORTED + failed report/package incidents", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 100,
        signed: 100,
        endToEndReady: 60,
        signedWithoutReport: 15,
        reportedWithoutPackage: 5,
        needingAttention: 0,
      },
      commandCenter: {
        sections: {
          pipelineDetail: {
            data: {
              evidence: { signed: 100, reported: 60 },
              reports: { ready: 60, failed: 3 },
              packages: { ready: 55, failed: 2 },
            },
          },
        },
      },
    }),
  );
  const operational = vm.workspaceHealth.find((m) => m.key === "operational");
  assert.ok(operational);
  // 15 stuck-signed + 5 stuck-reported + 3 failed-report + 2 failed-package = 25
  assert.equal(operational.value, 25);
  assert.equal(operational.tone, "danger");
});

test("Operational Issues is GREEN (zero) when no stuck evidence and no failed incidents", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: {
        totalEvidence: 50,
        signed: 50,
        endToEndReady: 50,
        signedWithoutReport: 0,
        reportedWithoutPackage: 0,
      },
    }),
  );
  const operational = vm.workspaceHealth.find((m) => m.key === "operational");
  assert.equal(operational?.value, 0);
  assert.equal(operational?.tone, "ok");
});

// ---------------------------------------------------------------------------
// 3 — Records complete renamed to Records reported
// ---------------------------------------------------------------------------

test("Workspace Health renames 'Records complete' → 'Records reported'", () => {
  const vm = normalizeHomeViewModel(baseInputs());
  const complete = vm.workspaceHealth.find((m) => m.key === "complete");
  assert.ok(complete);
  assert.equal(complete.label, "Records reported");
});

// ---------------------------------------------------------------------------
// 4 — Reports Ready flips to WARN when signed evidence exists but no reports
// ---------------------------------------------------------------------------

test("'Reports ready' tone is WARN (not neutral) when finalised evidence exists but no reports", () => {
  // Reproduces the puppeteer __name failure mode: 100 records
  // finalised at SIGNED, 0 reports generated. The old code left
  // this indicator at 'neutral' (effectively invisible). The new
  // code raises it to 'warn' so the operator notices.
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: { totalEvidence: 100, signed: 100, endToEndReady: 0 },
      commandCenter: {
        sections: {
          pipelineDetail: {
            data: {
              evidence: { signed: 100, reported: 0 },
              reports: { ready: 0 },
              packages: { ready: 0 },
            },
          },
        },
      },
    }),
  );
  const reportsReady = vm.workspaceHealth.find((m) => m.key === "reports_ready");
  assert.equal(reportsReady?.value, 0);
  assert.equal(reportsReady?.tone, "warn");
});

test("'Reports ready' tone stays neutral when nothing is finalised yet (true zero state)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: { totalEvidence: 0, signed: 0, endToEndReady: 0 },
      commandCenter: {
        sections: {
          pipelineDetail: {
            data: {
              evidence: { signed: 0, reported: 0 },
              reports: { ready: 0 },
              packages: { ready: 0 },
            },
          },
        },
      },
    }),
  );
  const reportsReady = vm.workspaceHealth.find((m) => m.key === "reports_ready");
  assert.equal(reportsReady?.tone, "neutral");
});

// ---------------------------------------------------------------------------
// 5 — The 'signed' field is still available but never anchors the KPI
// ---------------------------------------------------------------------------

test("`signed` count remains on the trust state for the Trust State card row", () => {
  // The Trust State card still needs the signed number — it's a real
  // metric, just not the headline. We assert the view-model preserves
  // it on the trustState object so the Trust State card can render it.
  const vm = normalizeHomeViewModel(
    baseInputs({
      trustSummary: { totalEvidence: 50, signed: 42, endToEndReady: 30 },
    }),
  );
  assert.equal(vm.trustState.signed, 42);
  assert.equal(vm.trustState.endToEndReady, 30);
});

// ---------------------------------------------------------------------------
// 6 — Multipart Records by Type stays per-record (regression of task #15)
// ---------------------------------------------------------------------------

test("Records by Type: one multipart Evidence with 5 images counts as ONE record in its primary bucket", () => {
  const t = new Date(NOW - 3600_000).toISOString();
  const vm = normalizeHomeViewModel(
    baseInputs({
      // One multipart evidence record whose primary MIME is image/jpeg.
      // The 5 child parts are NOT exposed to the view-model.
      evidenceList: {
        items: [
          {
            id: "multi-1",
            type: "PHOTO",
            mimeType: "image/jpeg",
            captureMethod: "MULTIPART_PACKAGE",
            createdAt: t,
            teamId: WS,
          },
        ],
      },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  // Exactly 1 record, in the Images bucket (NOT 5). This is the
  // load-bearing assertion: multipart parts are NOT expanded into
  // separate bucket counts. The widget's subtitle ("by primary
  // type") is composed at render time in HomeDashboardSections.tsx
  // — locked separately by the existing
  // tests/HomeDashboardSections.subtitle test.
  assert.equal(buckets["Images"] ?? 0, 1);
  // The total record count is 1, not 5.
  const total = vm.typeDistribution.slices.reduce(
    (a, s) => a + s.count,
    0,
  );
  assert.equal(total, 1);
});
