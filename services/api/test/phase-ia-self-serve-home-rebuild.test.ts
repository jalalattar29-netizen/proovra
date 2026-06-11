/**
 * Phase IA-self-serve-home-rebuild — contract tests for the new
 * production self-serve Home dashboard.
 *
 * Covers:
 *   1. The view-model normalizer correctly translates the
 *      command-center envelope into the safe self-serve shape.
 *   2. The boundary blocks every enterprise section listed in
 *      `ENTERPRISE_ONLY_SECTIONS` — the normalizer must NOT export
 *      them on the view model, and no UI section reads them.
 *   3. Snapshot tiles + Recent Evidence + Recent Cases + Recent
 *      Reports + Pipeline + Storage + Integrity + Checklist all
 *      render REAL data when supplied with real fixtures.
 *   4. Plan-aware visibility holds:
 *        FREE   → no Team Activity, Recent Reports shows the FREE
 *                 locked copy when empty, Intake-link checklist row
 *                 hidden.
 *        PAYG   → no Team Activity, Intake-link checklist row hidden.
 *        PRO    → Team Activity card AND intake/invite checklist rows
 *                 visible.
 *        TEAM   → same as PRO.
 *   5. Self-serve Home never contains banned enterprise vocabulary.
 *   6. Bugs A/B/C/D fixed earlier still hold (source-contract pins):
 *        A — All Tools gate on isPlatformAdmin in AppSidebarV2.
 *        B — Invite teammate hidden for FREE/PAYG, /teams renders
 *            without admin.teams PageRouteGate.
 *        C — Reports page falls back to GET /v1/reports.
 *        D — /intake-links tier rule = PROFESSIONAL (visible to
 *            PRO/TEAM).
 *
 * The normalizer is imported directly from the apps/web tree so the
 * tests run against the actual code path the runtime executes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_ONLY_SECTIONS,
  normalizeHomeViewModel,
  type HomeCommandCenterInput,
  type HomeReportsInput,
  type HomeBillingInput,
} from "../../../apps/web/components/home-experience/home-view-model";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

// ============================================================================
// Fixtures — small but realistic snapshots of the production envelopes.
// ============================================================================

const FIXTURE_CC: HomeCommandCenterInput = {
  sections: {
    recentEvidence: {
      status: "ok",
      items: [
        {
          id: "ev-1",
          title: "Door camera — 2026-06-09",
          status: "REPORTED",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "ev-2",
          title: "Voice memo — interview",
          status: "SIGNED",
          createdAt: "2026-06-08T14:00:00Z",
        },
      ],
    },
    caseOperations: {
      status: "ok",
      data: {
        activeCasesCount: 3,
        casesWithEvidenceGapsCount: 0,
        unreviewedEvidenceCount: 0,
        topCases: [
          {
            caseId: "case-1",
            caseName: "Jones v. Smith — pre-trial",
            evidenceCount: 12,
            lastActivityAtUtc: "2026-06-09T12:00:00Z",
          },
        ],
      },
    },
    pipelineDetail: {
      status: "ok",
      data: {
        evidence: {
          created: 1,
          uploading: 0,
          uploaded: 2,
          signed: 3,
          reported: 5,
          stuckUploading: 0,
        },
        reports: {
          ready: 5,
          queued: 0,
          failed: 0,
          missingFromSigned: 1,
        },
        packages: {
          ready: 4,
          queued: 0,
          failed: 0,
          missingFromReported: 0,
        },
        publicVerify: { published: 4, unpublished: 1, suspended: 0 },
      },
    },
    custodyIntegrityAnomalies: {
      status: "ok",
      items: [
        {
          evidenceId: "ev-3",
          title: "Photo — chain of custody check",
          reasonCode: "INTEGRITY_REVIEW_REQUIRED",
          severity: "warning",
          href: "/evidence/ev-3",
        },
      ],
    },
    deepIntegrityWatch: {
      meta: { status: "ok" },
      items: [],
    },
    routingQueue: {
      meta: { status: "ok" },
      items: [
        {
          id: "rq-1",
          title: "Generate a missing report",
          severity: "warning",
          affectedDomain: "core_evidence",
          primaryRoute: "/reports",
        },
        {
          id: "rq-2",
          title: "Review pending escalation",
          severity: "warning",
          affectedDomain: "reviewer_ops",
          primaryRoute: "/reviewer-ops",
        },
      ],
    },
  },
};

const FIXTURE_BILLING: HomeBillingInput = {
  workspaces: {
    personal: {
      storage: {
        usedLabel: "1.2 GB",
        limitLabel: "5 GB",
        usagePercent: 24,
        nearLimit: false,
        limitReached: false,
      },
    },
  },
};

const FIXTURE_REPORTS: HomeReportsInput = {
  items: [
    {
      evidenceId: "ev-1",
      title: "Door camera — 2026-06-09",
      report: {
        available: true,
        version: 3,
        generatedAtUtc: "2026-06-09T12:30:00Z",
      },
      package: { available: true },
    },
    {
      evidenceId: "ev-2",
      title: "Voice memo — interview",
      report: {
        available: false,
        version: null,
        generatedAtUtc: null,
      },
      package: { available: false },
    },
  ],
};

const FIXTURE_ORGS = [
  {
    id: "org-1",
    name: "Acme Legal",
    displayName: "Acme Legal",
    memberCount: 4,
    role: "OWNER",
    membershipStatus: "ACTIVE",
  },
];

// ============================================================================
// 1. Normalizer happy-path
// ============================================================================

describe("Phase IA-self-serve-home-rebuild — normalizer happy path", () => {
  it("produces a fully-populated view model from real fixtures (PRO plan)", () => {
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: FIXTURE_CC,
      billing: FIXTURE_BILLING,
      reports: FIXTURE_REPORTS,
      orgs: FIXTURE_ORGS,
    });

    expect(vm.plan).toBe("PRO");
    expect(vm.hasAnyData).toBe(true);

    // 5 snapshot tiles in canonical order.
    expect(vm.snapshot.map((t) => t.key)).toEqual([
      "evidence_records",
      "cases",
      "reports",
      "verification_links",
      "storage",
    ]);
    // Evidence records = signed + uploaded + reported = 10
    expect(vm.snapshot[0].value).toBe("10");
    expect(vm.snapshot[1].value).toBe("3");
    expect(vm.snapshot[2].value).toBe("5"); // pipelineDetail.reports.ready
    expect(vm.snapshot[3].value).toBe("4"); // publicVerify.published
    expect(vm.snapshot[4].value).toBe("1.2 GB / 5 GB");
    expect(vm.snapshot[4].hint).toBe("24% used");

    // Recent lists
    expect(vm.recentEvidence).toHaveLength(2);
    expect(vm.recentEvidence[0].id).toBe("ev-1");
    expect(vm.recentEvidence[0].href).toBe("/evidence/ev-1");

    expect(vm.recentCases).toHaveLength(1);
    expect(vm.recentCases[0].caseId).toBe("case-1");

    // Only available reports show — ev-2 has no report.
    expect(vm.recentReports).toHaveLength(1);
    expect(vm.recentReports[0].evidenceId).toBe("ev-1");
    expect(vm.recentReports[0].version).toBe(3);
    expect(vm.recentReports[0].reportReady).toBe(true);
    expect(vm.recentReports[0].packageReady).toBe(true);

    // Pipeline mapping
    expect(vm.pipeline.find((s) => s.key === "uploaded")?.value).toBe(10);
    expect(vm.pipeline.find((s) => s.key === "reported")?.value).toBe(5);

    // Storage
    expect(vm.storage?.usedLabel).toBe("1.2 GB");
    expect(vm.storage?.usagePercent).toBe(24);

    // Team activity present for PRO + we have an org.
    expect(vm.teamActivity?.ownedTeamCount).toBe(1);
    expect(vm.teamActivity?.totalMemberCount).toBe(4);

    // Integrity alert surfaces plain-language body, never the raw code.
    expect(vm.integrityAlerts).toHaveLength(1);
    expect(vm.integrityAlerts[0].body).not.toMatch(/INTEGRITY_REVIEW_REQUIRED/);

    // Checklist — 3 of 5 visible for PRO (all 5); the first three should
    // be done because we have evidence/cases/reports in the fixture.
    const visible = vm.checklist.filter((c) => c.visible);
    expect(visible).toHaveLength(5);
    expect(visible.find((s) => s.key === "capture_first")?.done).toBe(true);
    expect(visible.find((s) => s.key === "create_first_case")?.done).toBe(true);
    expect(visible.find((s) => s.key === "first_report")?.done).toBe(true);
    expect(visible.find((s) => s.key === "invite_first_teammate")?.done).toBe(true);

    // NextAction prefers the SELF-SERVE routing-queue item, not the
    // reviewer_ops one.
    expect(vm.nextAction.href).toBe("/reports");
    expect(vm.nextAction.label).toBe("Generate a missing report");
  });
});

// ============================================================================
// 2. Plan-aware visibility
// ============================================================================

describe("Phase IA-self-serve-home-rebuild — plan-aware visibility", () => {
  function build(plan: "FREE" | "PAYG" | "PRO" | "TEAM") {
    return normalizeHomeViewModel({
      plan,
      commandCenter: FIXTURE_CC,
      billing: FIXTURE_BILLING,
      reports: FIXTURE_REPORTS,
      orgs: FIXTURE_ORGS,
    });
  }

  it("FREE — Team Activity is null AND intake/invite checklist rows are hidden", () => {
    const vm = build("FREE");
    expect(vm.teamActivity).toBeNull();
    const visible = vm.checklist.filter((c) => c.visible).map((c) => c.key);
    expect(visible).not.toContain("first_intake_link");
    expect(visible).not.toContain("invite_first_teammate");
  });

  it("PAYG — Team Activity is null AND intake/invite checklist rows are hidden", () => {
    const vm = build("PAYG");
    expect(vm.teamActivity).toBeNull();
    const visible = vm.checklist.filter((c) => c.visible).map((c) => c.key);
    expect(visible).not.toContain("first_intake_link");
    expect(visible).not.toContain("invite_first_teammate");
  });

  it("PRO — Team Activity exists AND intake/invite checklist rows are visible", () => {
    const vm = build("PRO");
    expect(vm.teamActivity).not.toBeNull();
    const visible = vm.checklist.filter((c) => c.visible).map((c) => c.key);
    expect(visible).toContain("first_intake_link");
    expect(visible).toContain("invite_first_teammate");
  });

  it("TEAM — Team Activity exists AND intake/invite checklist rows are visible", () => {
    const vm = build("TEAM");
    expect(vm.teamActivity).not.toBeNull();
    const visible = vm.checklist.filter((c) => c.visible).map((c) => c.key);
    expect(visible).toContain("first_intake_link");
    expect(visible).toContain("invite_first_teammate");
  });
});

// ============================================================================
// 3. Empty-state behaviour
// ============================================================================

describe("Phase IA-self-serve-home-rebuild — empty states", () => {
  it("returns zero tiles + onboarding next action when nothing is fetched", () => {
    const vm = normalizeHomeViewModel({
      plan: "FREE",
      commandCenter: null,
      billing: null,
      reports: null,
      orgs: null,
    });
    expect(vm.hasAnyData).toBe(false);
    expect(vm.snapshot.every((t) => t.value === "0" || t.value === "—")).toBe(
      true,
    );
    expect(vm.nextAction.kind).toBe("capture");
    expect(vm.recentEvidence).toEqual([]);
    expect(vm.recentCases).toEqual([]);
    expect(vm.recentReports).toEqual([]);
    expect(vm.integrityAlerts).toEqual([]);
    expect(vm.teamActivity).toBeNull();
  });

  it("never emits placeholder dashes for numeric tiles when zero is the truth", () => {
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: null,
      billing: null,
      reports: null,
      orgs: null,
    });
    // Evidence / Cases / Reports / Verification all numeric → "0".
    // ONLY Storage may render "—" because we genuinely have no data
    // (and the brief says "show a graceful state, not a dash forever"
    // — the StorageUsageCard renders an empty state, not the tile).
    const numericTiles = vm.snapshot.filter(
      (t) => t.key !== "storage",
    );
    for (const t of numericTiles) {
      expect(t.value).not.toBe("—");
    }
  });
});

// ============================================================================
// 4. Enterprise allowlist — defence in depth
// ============================================================================

describe("Phase IA-self-serve-home-rebuild — enterprise allowlist", () => {
  it("blocklist names every enterprise section the audit identified", () => {
    expect(ENTERPRISE_ONLY_SECTIONS).toEqual(
      expect.arrayContaining([
        "workloadEngine",
        "reviewerOrchestration",
        "reviewerCapacity",
        "governancePosture",
        "queueCongestion",
        "queueWorkerTelemetry",
        "incidents",
        "predictiveRisk",
        "accessSecurityAnomalies",
        "accessSecurityClassifier",
        "organizationalIntelligenceV2",
        "organizationalHealth",
        "operationalGraph",
        "crossCaseIntelligenceV2",
        "relationshipIntelligence",
      ]),
    );
  });

  it("normalizer ignores enterprise-only sections even when present on the envelope", () => {
    const ccWithEnterprise = {
      sections: {
        ...FIXTURE_CC.sections,
        // The next four sections SHOULD NEVER leak to the UI.
        workloadEngine: { meta: { status: "ok" }, reviewers: [{}] },
        governancePosture: {
          status: "ok",
          data: { activeLegalHoldsCount: 99 },
        },
        reviewerOrchestration: {
          status: "ok",
          data: { queueDepth: 7 },
        },
        operationalGraph: {
          meta: { status: "ok" },
          nodeCountsByType: { evidence: 12 },
        },
      },
    } as unknown as HomeCommandCenterInput;

    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: ccWithEnterprise,
      billing: FIXTURE_BILLING,
      reports: FIXTURE_REPORTS,
      orgs: FIXTURE_ORGS,
    });

    // Nothing on the view model surfaces a value from those sections.
    const serialized = JSON.stringify(vm);
    expect(serialized).not.toMatch(/activeLegalHoldsCount/);
    expect(serialized).not.toMatch(/queueDepth/);
    expect(serialized).not.toMatch(/operationalGraph/);
    expect(serialized).not.toMatch(/workloadEngine/);
  });

  it("Next Action skips routing-queue items in enterprise domains", () => {
    const ccOnlyEnterprise: HomeCommandCenterInput = {
      sections: {
        routingQueue: {
          meta: { status: "ok" },
          items: [
            {
              id: "rq-1",
              title: "Investigate security anomaly",
              severity: "warning",
              affectedDomain: "security",
              primaryRoute: "/security-center",
            },
            {
              id: "rq-2",
              title: "Resolve reviewer SLA",
              severity: "warning",
              affectedDomain: "reviewer_ops",
              primaryRoute: "/reviewer-ops",
            },
          ],
        },
        pipelineDetail: {
          status: "ok",
          data: {
            evidence: { signed: 1, reported: 0, uploaded: 0 },
            reports: { ready: 0 },
            packages: { ready: 0 },
            publicVerify: { published: 0, unpublished: 0, suspended: 0 },
          },
        },
      },
    };
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: ccOnlyEnterprise,
      billing: null,
      reports: null,
      orgs: [],
    });
    // Falls through to the onboarding-style next action.
    expect(vm.nextAction.kind).not.toBe("review_evidence_missing_report");
    expect(vm.nextAction.href).not.toMatch(/security-center|reviewer-ops/);
  });
});

// ============================================================================
// 5. Vocabulary — Home must NOT contain banned enterprise words
// ============================================================================

describe("Phase IA-self-serve-home-rebuild — vocabulary lock", () => {
  // The Dashboard + sections + view-model source must never include
  // any of these enterprise-vocabulary strings.
  const HOME_FILES = [
    "components/home-experience/SelfServeHomeDashboard.tsx",
    "components/home-experience/HomeSections.tsx",
    "components/home-experience/home-view-model.ts",
    "components/home-experience/useHomeData.ts",
  ];

  const BANNED_STRINGS: RegExp[] = [
    /Operational command surface/i,
    /Governance posture/i,
    /Reviewer queue/i,
    /Reviewer orchestration/i,
    /Workload engine/i,
    /SLA pressure/i,
    /Organization admin/i,
    /Enterprise intelligence/i,
    /Queue congestion/i,
    /Predictive risk/i,
    /Operational graph/i,
  ];

  for (const file of HOME_FILES) {
    it(`${file} contains no banned enterprise vocabulary`, () => {
      // Strip JS comments before pattern-matching so an explanatory
      // docstring that mentions a banned phrase (to document its
      // exclusion) doesn't trip the assertion.
      const src = readWeb(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const re of BANNED_STRINGS) {
        expect(src, `Banned phrase ${re} found in ${file}`).not.toMatch(re);
      }
    });
  }

  it("Home shows plain self-serve labels in the snapshot", () => {
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: FIXTURE_CC,
      billing: FIXTURE_BILLING,
      reports: FIXTURE_REPORTS,
      orgs: FIXTURE_ORGS,
    });
    expect(vm.snapshot.map((t) => t.label)).toEqual([
      "Evidence records",
      "Cases",
      "Reports",
      "Verification links",
      "Storage",
    ]);
  });
});

// ============================================================================
// 6. Bugs A/B/C/D still hold after the Home rebuild
// ============================================================================

describe("Phase IA-self-serve-home-rebuild — Bug A/B/C/D contract", () => {
  it("Bug A — All Tools sidebar block is gated on isPlatformAdmin", () => {
    const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(SIDEBAR).toMatch(
      /isPlatformAdmin \? \([\s\S]{0,800}data-sidebar-group="All Tools"/,
    );
  });

  it("Bug B — /teams page does not wrap in <PageRouteGate routeId=\"admin.teams\">", () => {
    const TEAMS = readWeb("app/(app)/teams/page.tsx");
    const stripped = TEAMS.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(^|[^:])\/\/.*$/gm,
      "$1",
    );
    expect(stripped).not.toMatch(/<\s*PageRouteGate\b/);
  });

  it("Bug B — Home Invite teammate gated on isProOrTeam (FREE/PAYG don't see it)", () => {
    const VM = readWeb("components/home-experience/home-view-model.ts");
    // The view model derives `pro = isProOrTeam(args.plan)` and the
    // intake/invite checklist rows set `visible: pro`.
    expect(VM).toMatch(/isProOrTeam\(args\.plan\)/);
    expect(VM).toMatch(
      /invite_first_teammate[\s\S]{0,400}visible:\s*pro/,
    );
  });

  it("Bug C — Reports page falls back to /v1/reports user-scoped list", () => {
    const REP = readWeb(
      "components/reports-experience/ReportsIndex.tsx",
    );
    expect(REP).toMatch(/tryUserScopedReports/);
    expect(REP).toMatch(/apiFetch\(`?\/v1\/reports`?/);
  });

  it("Bug D — /intake-links is tier=PROFESSIONAL (visible to PRO/TEAM)", () => {
    const TIERS = readWeb("lib/surface/tiers.ts");
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/intake-links",\s*tier:\s*"PROFESSIONAL"/,
    );
  });
});

// ============================================================================
// 7. Home uses ONLY pre-existing endpoints (no new APIs introduced)
// ============================================================================

describe("Phase IA-self-serve-home-rebuild — no new APIs", () => {
  it("useHomeData fetches ONLY four pre-existing endpoints", () => {
    const HOOK = readWeb("components/home-experience/useHomeData.ts");
    // Allowed endpoints
    expect(HOOK).toMatch(/\/v1\/dashboard\/command-center/);
    expect(HOOK).toMatch(/\/v1\/billing\/overview/);
    expect(HOOK).toMatch(/\/v1\/reports/);
    // organizations come from the envelope hook — not a fetch.
    expect(HOOK).toMatch(/useOrganizations/);

    // Banned: must not invent /v1/home/* or similar.
    expect(HOOK).not.toMatch(/\/v1\/home\//);
    expect(HOOK).not.toMatch(/\/v1\/dashboard\/(?!command-center)/);
  });
});
