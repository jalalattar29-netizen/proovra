/**
 * Phase IA-home-v2 — contract tests for the workflow-centric Home.
 *
 * The V2 Home replaced the V1 inventory dashboard (snapshot counters,
 * static Trust bullets, nav-duplicating Quick Actions, EvidenceHealth
 * approximations). This file pins the V2 contract AND carries forward
 * every still-valid invariant from the V1 suite:
 *
 *   - Workspace-scope consistency (no cross-workspace leak).
 *   - No fabricated data / no hardcoded completion / no static trust.
 *   - Enterprise-section allowlist (defence in depth).
 *   - Plan-aware visibility (FREE/PAYG vs PRO/TEAM).
 *   - Storage decimal formatting.
 *   - Bug A/B/C/D cross-cut contracts (All Tools, /teams, reports
 *     fallback, intake tier).
 *
 * Plus the V2 success-criteria coverage: the Home must answer
 *   1. what needs my attention  2. submissions to review
 *   3. integrity issues  4. reports ready  5. active intake requests
 *   6. incomplete cases  7. is my evidence trustworthy  8. recent activity
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_ONLY_SECTIONS,
  normalizeHomeViewModel,
  type HomeCommandCenterInput,
  type HomeInboxInput,
  type HomeIntakeLinksInput,
  type HomeCommunicationsInput,
  type HomeTrustSummaryInput,
  type HomeReportsInput,
  type HomeBillingInput,
} from "../../../apps/web/components/home-experience/home-view-model";

import { formatBytesHuman } from "@proovra/shared-billing";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

const WS = "00000000-0000-0000-0000-0000000000aa";
const FIXED_NOW = Date.UTC(2026, 5, 11, 12, 0, 0);

// ============================================================================
// Fixtures
// ============================================================================

const CC: HomeCommandCenterInput = {
  sections: {
    recentEvidence: {
      status: "ok",
      items: [
        { id: "ev-1", title: "Door cam", status: "REPORTED", verificationStatus: "VERIFIED", createdAt: "2026-06-11T09:00:00Z" },
        { id: "ev-2", title: "Voice memo", status: "SIGNED", verificationStatus: "REVIEW_REQUIRED", createdAt: "2026-06-10T14:00:00Z" },
      ],
    },
    caseOperations: {
      status: "ok",
      data: {
        activeCasesCount: 3,
        casesWithEvidenceGapsCount: 1,
        topCases: [
          { caseId: "c-1", caseName: "Jones v Smith", evidenceCount: 12, unreviewedCount: 2, overdueReviewCount: 1, openEscalationsCount: 0, hasActiveLegalHold: true, lastActivityAtUtc: "2026-06-11T08:00:00Z" },
          { caseId: "c-2", caseName: "Clean matter", evidenceCount: 4, unreviewedCount: 0, overdueReviewCount: 0, openEscalationsCount: 0, hasActiveLegalHold: false, lastActivityAtUtc: "2026-06-09T08:00:00Z" },
        ],
      },
    },
    pipelineDetail: {
      status: "ok",
      data: {
        evidence: { uploaded: 2, signed: 3, reported: 5, stuckUploading: 0 },
        reports: { ready: 5, failed: 0, missingFromSigned: 1 },
        packages: { ready: 4, failed: 0, blocked: 0, missingFromReported: 0 },
        publicVerify: { published: 4, unpublished: 1, suspended: 0 },
      },
    },
    timeline: {
      status: "ok",
      items: [
        { id: "t1", kind: "evidence_finalized", occurredAt: "2026-06-11T09:00:00Z", label: "Evidence finalized", href: "/evidence/ev-1" },
        { id: "t2", kind: "report_generated", occurredAt: "2026-06-10T10:00:00Z", label: "Report generated", href: "/evidence/ev-1" },
      ],
    },
    custodyIntegrityAnomalies: {
      status: "ok",
      items: [{ evidenceId: "ev-2", title: "Voice memo", reasonCode: "INTEGRITY_REVIEW_REQUIRED", severity: "warning", href: "/evidence/ev-2" }],
    },
    deepIntegrityWatch: { meta: { status: "ok" }, items: [] },
  },
};

const TRUST: HomeTrustSummaryInput = {
  totalEvidence: 50,
  tsa: { stamped: 47, pending: 2, failed: 1, none: 0 },
  ots: { anchored: 44, pending: 5, failed: 1, none: 0 },
  signed: 48,
  publicVerify: { published: 32, unpublished: 18, suspended: 0 },
  needingAttention: 3,
};

const REPORTS: HomeReportsInput = {
  items: [
    { evidenceId: "ev-1", title: "Door cam", report: { available: true, version: 3, generatedAtUtc: "2026-06-11T10:00:00Z" }, package: { available: true } },
    { evidenceId: "ev-2", title: "Voice memo", report: { available: false }, package: { available: false } },
  ],
};

const INTAKE: HomeIntakeLinksInput = {
  links: [
    { id: "lk-1", recipientLabel: "Witness A", status: "ACTIVE", usedCount: 1, maxUses: 1, expiresAtUtc: "2026-07-01T00:00:00Z", createdAt: "2026-06-11T08:00:00Z" },
    { id: "lk-2", recipientLabel: "Revoked", status: "REVOKED", usedCount: 0, maxUses: 1, expiresAtUtc: "2026-06-01T00:00:00Z", createdAt: "2026-05-01T08:00:00Z" },
  ],
};

const COMMS: HomeCommunicationsInput = {
  messages: [
    { id: "m-1", channel: "SMS", status: "DELIVERED", createdAt: "2026-06-11T08:05:00Z", sentAtUtc: "2026-06-11T08:05:00Z", deliveredAtUtc: "2026-06-11T08:06:00Z", relatedIntakeLinkId: "lk-1" },
  ],
};

const INBOX: HomeInboxInput = {
  items: [
    { id: "intake_submission_pending_review:r-1", category: "intake_submission_pending_review", title: "Intake submission awaiting review", href: "/evidence-requests/r-1", occurredAt: "2026-06-11T07:00:00Z", dueAt: null, context: { teamId: WS, requestId: "r-1", status: "RESPONSE_RECEIVED", priority: "P2" } },
    // Another workspace — must be filtered out.
    { id: "intake_submission_pending_review:r-2", category: "intake_submission_pending_review", title: "Other workspace", href: "/evidence-requests/r-2", occurredAt: "2026-06-11T07:00:00Z", dueAt: null, context: { teamId: "ffffffff-ffff-ffff-ffff-ffffffffffff", requestId: "r-2", status: "RESPONSE_RECEIVED", priority: "P2" } },
  ],
};

const ORGS = [{ id: WS, name: "Acme", displayName: "Acme Legal", memberCount: 4, role: "OWNER", membershipStatus: "ACTIVE" }];

function build(plan: "FREE" | "PAYG" | "PRO" | "TEAM", overrides: Partial<Parameters<typeof normalizeHomeViewModel>[0]> = {}) {
  return normalizeHomeViewModel({
    plan,
    workspaceId: WS,
    commandCenter: CC,
    trustSummary: TRUST,
    billing: null,
    reports: REPORTS,
    intakeLinks: INTAKE,
    inbox: INBOX,
    communications: COMMS,
    orgs: ORGS,
    nowMs: FIXED_NOW,
    ...overrides,
  });
}

// ============================================================================
// 1. Hero — what needs my attention (Phase 2)
// ============================================================================

describe("Phase IA-home-v2 — hero next action", () => {
  it("prioritizes submissions awaiting review above everything else", () => {
    const vm = build("PRO");
    expect(vm.heroAction.kind).toBe("review_submissions");
    expect(vm.heroAction.count).toBe(1);
    expect(vm.heroAction.href).toBe("/evidence-requests/r-1");
  });

  it("falls to reports-to-generate when no submissions pending", () => {
    const vm = build("PRO", { inbox: { items: [] } });
    expect(vm.heroAction.kind).toBe("generate_reports");
    expect(vm.heroAction.count).toBe(1); // missingFromSigned
  });

  it("onboarding hero when workspace is empty", () => {
    const vm = normalizeHomeViewModel({
      plan: "FREE", workspaceId: WS, commandCenter: null, trustSummary: null,
      billing: null, reports: null, intakeLinks: null, inbox: null, communications: null, orgs: null, nowMs: FIXED_NOW,
    });
    expect(vm.heroAction.kind).toBe("capture_first");
  });
});

// ============================================================================
// 2. Submissions strip (Phase 4) — workspace-scoped
// ============================================================================

describe("Phase IA-home-v2 — submissions to review", () => {
  it("surfaces only the active-workspace intake submissions (no cross-workspace leak)", () => {
    const vm = build("PRO");
    expect(vm.submissions).toHaveLength(1);
    expect(vm.submissions[0].id).toBe("intake_submission_pending_review:r-1");
    expect(vm.submissions[0].statusLabel).toBe("Response Received");
  });

  it("submission rows deep-link to the evidence-request review surface", () => {
    const vm = build("PRO");
    expect(vm.submissions[0].href).toBe("/evidence-requests/r-1");
  });
});

// ============================================================================
// 3. Collection status (Phase 5) — real intake links + delivery
// ============================================================================

describe("Phase IA-home-v2 — request & collect", () => {
  it("shows only ACTIVE intake links with their latest delivery state", () => {
    const vm = build("PRO");
    expect(vm.collection).toHaveLength(1);
    expect(vm.collection[0].id).toBe("lk-1");
    expect(vm.collection[0].delivery?.statusLabel).toBe("Delivered");
    expect(vm.collection[0].delivery?.channel).toBe("SMS");
  });
});

// ============================================================================
// 4. Recent evidence integrity chip (Phase 6) — real verificationStatus
// ============================================================================

describe("Phase IA-home-v2 — recent evidence integrity", () => {
  it("carries the real verificationStatus per row and flags integrity-watch ids", () => {
    const vm = build("PRO");
    const ev2 = vm.recentEvidence.find((r) => r.id === "ev-2");
    expect(ev2?.verificationStatus).toBe("REVIEW_REQUIRED");
    // ev-2 appears in custodyIntegrityAnomalies → needsAttention.
    expect(ev2?.needsAttention).toBe(true);
    const ev1 = vm.recentEvidence.find((r) => r.id === "ev-1");
    expect(ev1?.needsAttention).toBe(false);
  });
});

// ============================================================================
// 5. Trust State (Phase 7+8) — REAL counts, merged, no static copy
// ============================================================================

describe("Phase IA-home-v2 — trust state", () => {
  it("maps real backend trust totals 1:1 (no pipeline approximation)", () => {
    const vm = build("PRO");
    expect(vm.trustState.tsaStamped).toBe(47);
    expect(vm.trustState.tsaPending).toBe(2);
    expect(vm.trustState.otsAnchored).toBe(44);
    expect(vm.trustState.signed).toBe(48);
    expect(vm.trustState.verifyPublished).toBe(32);
    expect(vm.trustState.needingAttention).toBe(3);
    expect(vm.trustState.empty).toBe(false);
  });

  it("trust state is empty when there is no evidence", () => {
    const vm = build("PRO", { trustSummary: { totalEvidence: 0 } });
    expect(vm.trustState.empty).toBe(true);
  });

  it("the Trust card component renders LIVE counts, not static marketing bullets", () => {
    const SRC = readWeb("components/home-experience/HomeSections.tsx");
    // The V2 trust card reads trust.tsaStamped / otsAnchored / signed.
    expect(SRC).toMatch(/trust\.tsaStamped/);
    expect(SRC).toMatch(/trust\.otsAnchored/);
    expect(SRC).toMatch(/trust\.verifyPublished/);
    // The old static bullets must be gone.
    expect(SRC).not.toMatch(/Digital signatures on every captured record/);
    expect(SRC).not.toMatch(/RFC 3161 trusted timestamp plus OpenTimestamps public anchor/);
  });

  it("backend trust-summary endpoint exists and aggregates real Evidence columns", () => {
    const SVC = readApi("src/services/dashboard/trust-summary.service.ts");
    expect(SVC).toMatch(/groupBy/);
    expect(SVC).toMatch(/tsaStatus/);
    expect(SVC).toMatch(/otsStatus/);
    expect(SVC).toMatch(/publicVerifyState/);
    expect(SVC).toMatch(/signatureBase64:\s*\{\s*not:\s*null\s*\}/);
    const ROUTE = readApi("src/routes/dashboard.routes.ts");
    expect(ROUTE).toMatch(/\/v1\/dashboard\/trust-summary/);
    expect(ROUTE).toMatch(/requireMember\(req, reply, query\.teamId\)/);
  });
});

// ============================================================================
// 6. Case Health (Phase 12) — real gap signals
// ============================================================================

describe("Phase IA-home-v2 — case health", () => {
  it("surfaces only cases with a real incompleteness/blocker signal", () => {
    const vm = build("PRO");
    expect(vm.caseHealth).toHaveLength(1);
    expect(vm.caseHealth[0].caseId).toBe("c-1");
    expect(vm.caseHealth[0].reason).toContain("unreviewed");
    expect(vm.caseHealth[0].hasActiveLegalHold).toBe(true);
  });
});

// ============================================================================
// 7. Activity (Phase 9) — grouped, real events incl. delivery
// ============================================================================

describe("Phase IA-home-v2 — activity feed", () => {
  it("unifies timeline + intake-created + delivery events, grouped by day", () => {
    const vm = build("PRO");
    const allKinds = vm.activity.flatMap((g) => g.events.map((e) => e.kind));
    expect(allKinds).toContain("evidence_finalized");
    expect(allKinds).toContain("report_generated");
    expect(allKinds).toContain("intake_link_created");
    expect(allKinds).toContain("intake_delivered");
    // Grouped under Today / Earlier with a fixed now.
    expect(vm.activity.map((g) => g.key)).toContain("today");
  });

  it("does not translate enterprise-flavoured timeline kinds it doesn't recognise", () => {
    const vm = build("PRO", {
      commandCenter: {
        sections: { timeline: { status: "ok", items: [{ id: "x", kind: "reviewer_assignment_changed", occurredAt: "2026-06-11T09:00:00Z" }] } },
      },
    });
    const kinds = vm.activity.flatMap((g) => g.events.map((e) => e.kind));
    expect(kinds).not.toContain("reviewer_assignment_changed");
  });
});

// ============================================================================
// 8. Getting Started (Phase 11) — real signals, no hardcoded completion
// ============================================================================

describe("Phase IA-home-v2 — getting started real signals", () => {
  it("first_intake_link.done derives from a REAL intake link count (never hardcoded false)", () => {
    const VM = readWeb("components/home-experience/home-view-model.ts");
    expect(VM).toMatch(/done:\s*args\.intakeLinkCount > 0/);
    // The literal hardcoded-false bug must not return.
    expect(VM).not.toMatch(/key:\s*"first_intake_link"[\s\S]{0,200}done:\s*false/);
  });

  it("invite_first_teammate.done requires more than the owner (memberCount > 1)", () => {
    const VM = readWeb("components/home-experience/home-view-model.ts");
    expect(VM).toMatch(/done:\s*args\.teamMemberCount > 1/);
  });

  it("with intake link present + team of 4, both PRO steps complete from real data", () => {
    const vm = build("PRO");
    const steps = vm.checklist;
    expect(steps.find((s) => s.key === "first_intake_link")?.done).toBe(true);
    expect(steps.find((s) => s.key === "invite_first_teammate")?.done).toBe(true);
  });

  it("checklistComplete flips true only when every visible step is done; UI auto-collapses", () => {
    const vm = build("PRO");
    // capture+case+report+intake+invite all satisfied by fixtures.
    expect(vm.checklistComplete).toBe(true);
    const SRC = readWeb("components/home-experience/HomeSections.tsx");
    expect(SRC).toMatch(/if \(complete\) return null/);
  });
});

// ============================================================================
// 9. Storage formatting (carried forward)
// ============================================================================

describe("Phase IA-home-v2 — storage formatting", () => {
  it("formatBytesHuman never renders long decimals", () => {
    expect(formatBytesHuman(7012345678n)).toMatch(/^\d+(\.\d{1,2})? GB$/);
    expect(formatBytesHuman(5n * 1024n * 1024n * 1024n)).toBe("5 GB");
  });

  it("storage usagePercent is rounded to one decimal", () => {
    const billing: HomeBillingInput = {
      workspaces: { personal: { storage: { usedLabel: "6.528212832286954 GB", limitLabel: "10 GB", usagePercent: 65.28212832286954, nearLimit: false, limitReached: false } } },
    };
    const vm = build("PRO", { billing });
    expect(vm.storage?.usagePercent).toBe(65.3);
    expect(vm.storage?.usedLabel).toBe("6.53 GB");
  });
});

// ============================================================================
// 10. Plan-aware visibility (carried forward)
// ============================================================================

describe("Phase IA-home-v2 — plan visibility", () => {
  it("FREE/PAYG: no team work card, intake/invite checklist + launchers hidden", () => {
    for (const plan of ["FREE", "PAYG"] as const) {
      const vm = build(plan);
      expect(vm.teamWork).toBeNull();
      const visibleSteps = vm.checklist.filter((s) => s.visible).map((s) => s.key);
      expect(visibleSteps).not.toContain("first_intake_link");
      expect(visibleSteps).not.toContain("invite_first_teammate");
      const launchers = vm.launchers.filter((l) => l.visible).map((l) => l.key);
      expect(launchers).not.toContain("request_evidence");
      expect(launchers).not.toContain("review_submission");
    }
  });

  it("PRO/TEAM: team work present, intake/invite + request/review launchers visible", () => {
    for (const plan of ["PRO", "TEAM"] as const) {
      const vm = build(plan);
      expect(vm.teamWork).not.toBeNull();
      const launchers = vm.launchers.filter((l) => l.visible).map((l) => l.key);
      expect(launchers).toContain("request_evidence");
      expect(launchers).toContain("review_submission");
    }
  });

  it("team work is work-centric (awaiting review + reports today), not a roster headcount only", () => {
    const vm = build("PRO");
    expect(vm.teamWork?.submissionsAwaitingReview).toBe(1);
    // reports generated today (generatedAtUtc on FIXED_NOW day).
    expect(vm.teamWork?.reportsToday).toBe(1);
  });
});

// ============================================================================
// 11. Enterprise allowlist + vocabulary (carried forward)
// ============================================================================

describe("Phase IA-home-v2 — boundary + vocabulary", () => {
  it("ENTERPRISE_ONLY_SECTIONS still blocks the enterprise sections", () => {
    expect(ENTERPRISE_ONLY_SECTIONS).toEqual(
      expect.arrayContaining(["reviewerOrchestration", "governancePosture", "workloadEngine", "operationalGraph"]),
    );
  });

  it("enterprise envelope sections never surface on the view model", () => {
    const vm = build("PRO", {
      commandCenter: {
        sections: { ...CC.sections, governancePosture: { status: "ok", data: { activeLegalHoldsCount: 99 } }, reviewerOrchestration: { status: "ok", data: { queueDepth: 7 } } } as never,
      },
    });
    const serialized = JSON.stringify(vm);
    expect(serialized).not.toMatch(/activeLegalHoldsCount/);
    expect(serialized).not.toMatch(/queueDepth/);
  });

  const HOME_FILES = [
    "components/home-experience/SelfServeHomeDashboard.tsx",
    "components/home-experience/HomeSections.tsx",
    "components/home-experience/home-view-model.ts",
    "components/home-experience/useHomeData.ts",
  ];
  const BANNED = [/Governance posture/i, /Reviewer queue/i, /Reviewer orchestration/i, /Workload engine/i, /SLA pressure/i, /Queue congestion/i, /Predictive risk/i];
  for (const file of HOME_FILES) {
    it(`${file} contains no banned enterprise vocabulary`, () => {
      const src = readWeb(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const re of BANNED) expect(src, `${re} in ${file}`).not.toMatch(re);
    });
  }
});

// ============================================================================
// 12. Endpoints used (V2) — workspace-scoped, no surprise APIs
// ============================================================================

describe("Phase IA-home-v2 — endpoints", () => {
  const HOOK = readWeb("components/home-experience/useHomeData.ts");

  it("fetches the V2 endpoint set, all workspace-scoped where applicable", () => {
    expect(HOOK).toMatch(/\/v1\/dashboard\/command-center/);
    expect(HOOK).toMatch(/\/v1\/dashboard\/trust-summary/);
    expect(HOOK).toMatch(/\/v1\/billing\/overview/);
    expect(HOOK).toMatch(/\/v1\/reports/);
    expect(HOOK).toMatch(/\/v1\/workflow\/intake-links/);
    expect(HOOK).toMatch(/\/v1\/me\/inbox/);
    expect(HOOK).toMatch(/\/v1\/communications\/messages/);
  });

  it("command-center, reports, intake-links, communications all carry teamId scope", () => {
    // The `scoped()` helper appends teamId to each.
    expect(HOOK).toMatch(/teamId=\$\{encodeURIComponent\(workspaceId\)\}/);
  });

  it("does not invent a /v1/home/* family", () => {
    expect(HOOK).not.toMatch(/\/v1\/home\//);
  });
});

// ============================================================================
// 13. Cross-cut bug contracts (carried forward A/B/C/D)
// ============================================================================

describe("Phase IA-home-v2 — cross-cut bug contracts still hold", () => {
  it("Bug A — All Tools sidebar gated on isPlatformAdmin", () => {
    const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(SIDEBAR).toMatch(/isPlatformAdmin \? \([\s\S]{0,800}data-sidebar-group="All Tools"/);
  });
  it("Bug B — /teams page not wrapped in admin.teams PageRouteGate", () => {
    const TEAMS = readWeb("app/(app)/teams/page.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(TEAMS).not.toMatch(/<\s*PageRouteGate\b/);
  });
  it("Bug C — Reports page falls back to /v1/reports", () => {
    const REP = readWeb("components/reports-experience/ReportsIndex.tsx");
    expect(REP).toMatch(/tryUserScopedReports/);
  });
  it("Bug D — /intake-links tier=PROFESSIONAL", () => {
    const TIERS = readWeb("lib/surface/tiers.ts");
    expect(TIERS).toMatch(/pathPrefix:\s*"\/intake-links",\s*tier:\s*"PROFESSIONAL"/);
  });
});

// ============================================================================
// 14. Success criteria — Home answers all 8 questions
// ============================================================================

describe("Phase IA-home-v2 — success criteria coverage", () => {
  it("the dashboard mounts every component that answers the 8 required questions", () => {
    const DASH = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
    // 1 what needs me · 2 submissions · 3 integrity · 4 reports ·
    // 5 intake requests · 6 incomplete cases · 7 trustworthy · 8 activity
    expect(DASH).toMatch(/<HeroNextAction/);
    expect(DASH).toMatch(/<SubmissionsToReview/);
    expect(DASH).toMatch(/<RecentEvidence/);
    expect(DASH).toMatch(/<RecentReports/);
    expect(DASH).toMatch(/<RequestAndCollect/);
    expect(DASH).toMatch(/<CaseHealthCard/);
    expect(DASH).toMatch(/<TrustStateCard/);
    expect(DASH).toMatch(/<ActivityFeed/);
  });

  it("workflow launchers replace nav-duplicating quick actions (no CompactQuickActions)", () => {
    const DASH = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
    expect(DASH).toMatch(/<WorkflowLaunchers/);
    expect(DASH).not.toMatch(/CompactQuickActions/);
  });
});
