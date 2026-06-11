/**
 * Phase IA-home-polish — contract tests for the Home dashboard polish
 * pass. These pin the fixes for the issues called out in the operator
 * brief: counter consistency, storage formatting, pipeline-zeros
 * onboarding, new Activity + Health + Quick Actions sections, report
 * row actions, and trust-summary placement.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  normalizeHomeViewModel,
  type HomeCommandCenterInput,
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
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

// ============================================================================
// 1. Counter scope consistency
// ============================================================================

describe("Phase IA-home-polish — counter scope consistency", () => {
  it("reports count comes from the workspace-scoped reports endpoint, not pipeline.ready", () => {
    // Simulates the operator-brief bug: pipelineDetail.reports.ready
    // is 50 but workspace-scoped /v1/reports returns 0 items because
    // the 50 belong to a different workspace.
    const cc: HomeCommandCenterInput = {
      sections: {
        pipelineDetail: {
          status: "ok",
          data: {
            evidence: { uploaded: 0, signed: 0, reported: 0 },
            reports: { ready: 50, missingFromSigned: 0, failed: 0 },
            packages: { ready: 0, missingFromReported: 0, failed: 0 },
            publicVerify: { published: 0, unpublished: 0, suspended: 0 },
          },
        },
      },
    };
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: cc,
      billing: null,
      reports: { items: [] },
      orgs: [],
    });
    // Reports must reflect workspace-scoped truth = 0, NOT 50.
    const reportsTile = vm.snapshot.find((t) => t.key === "reports");
    expect(reportsTile?.value).toBe("0");
  });

  it("evidence count uses pipeline when present; else falls back to reports list ids; else recentEvidence", () => {
    // Case A — pipeline carries evidence counts.
    const a = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: {
        sections: {
          pipelineDetail: {
            status: "ok",
            data: {
              evidence: { uploaded: 2, signed: 3, reported: 5 },
              reports: { ready: 0 },
              packages: { ready: 0 },
              publicVerify: { published: 0, unpublished: 0, suspended: 0 },
            },
          },
        },
      },
      billing: null,
      reports: null,
      orgs: null,
    });
    expect(a.snapshot.find((t) => t.key === "evidence_records")?.value).toBe(
      "10",
    );

    // Case B — pipeline missing/0 but reports list has 3 distinct
    // evidence ids → fall back to that.
    const b = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: null,
      billing: null,
      reports: {
        items: [
          {
            evidenceId: "e1",
            title: null,
            report: { available: true },
            package: { available: false },
          },
          {
            evidenceId: "e2",
            title: null,
            report: { available: true },
            package: { available: false },
          },
          {
            evidenceId: "e3",
            title: null,
            report: { available: false },
            package: { available: false },
          },
        ],
      },
      orgs: null,
    });
    expect(b.snapshot.find((t) => t.key === "evidence_records")?.value).toBe(
      "3",
    );
  });

  it("reports list + evidence count + checklist all stay consistent", () => {
    // Both reports list and pipeline say 0 ⇒ checklist 'first_report'
    // must NOT be marked done.
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: null,
      billing: null,
      reports: { items: [] },
      orgs: null,
    });
    expect(
      vm.checklist.find((s) => s.key === "first_report")?.done,
    ).toBe(false);
    expect(
      vm.checklist.find((s) => s.key === "capture_first")?.done,
    ).toBe(false);
  });
});

// ============================================================================
// 2. Backend — /v1/reports accepts a teamId filter
// ============================================================================

describe("Phase IA-home-polish — /v1/reports workspace filter", () => {
  const ROUTE = readApi("src/routes/reports.routes.ts");

  it("accepts an optional teamId query parameter (uuid)", () => {
    expect(ROUTE).toMatch(/teamId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
  });

  it("filters by teamId AND validates membership/ownership when supplied", () => {
    // The new branch narrows the access clause to the requested workspace.
    expect(ROUTE).toMatch(/query\.teamId/);
    expect(ROUTE).toMatch(/scopedTeamId/);
    // We still require ownership when the user isn't an active member.
    expect(ROUTE).toMatch(/ownerUserId:\s*userId/);
  });
});

// ============================================================================
// 3. Storage formatting
// ============================================================================

describe("Phase IA-home-polish — storage formatting", () => {
  it("formatBytesHuman rounds floating values to at most 2 decimals", () => {
    // 7012345678 bytes ≈ 6.53 GB (not 6.528212832286954 GB).
    const out = formatBytesHuman(7012345678n);
    expect(out).toMatch(/^\d+(\.\d{1,2})? GB$/);
    expect(out).not.toMatch(/\.\d{3,}/);
  });

  it("formatBytesHuman drops trailing zeros for whole values", () => {
    expect(formatBytesHuman(5n * 1024n * 1024n * 1024n)).toBe("5 GB");
    expect(formatBytesHuman(1024n * 1024n * 1024n)).toBe("1 GB");
  });

  it("storage view-model usagePercent never renders raw long decimals", () => {
    const billing: HomeBillingInput = {
      workspaces: {
        personal: {
          storage: {
            usedLabel: "6.528212832286954 GB",
            limitLabel: "10 GB",
            // Backend might send a fractional percent.
            usagePercent: 65.28212832286954,
            nearLimit: false,
            limitReached: false,
          },
        },
      },
    };
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: null,
      billing,
      reports: null,
      orgs: null,
    });
    // Percent rounded to one decimal.
    expect(vm.storage?.usagePercent).toBe(65.3);
    // Belt-and-suspenders: usedLabel normalized to ≤ 2 decimals.
    expect(vm.storage?.usedLabel).toBe("6.53 GB");
  });
});

// ============================================================================
// 4. Pipeline onboarding when all zeros
// ============================================================================

describe("Phase IA-home-polish — pipeline onboarding fallback", () => {
  it("pipelineEmpty is true when every stage is zero", () => {
    const vm = normalizeHomeViewModel({
      plan: "FREE",
      commandCenter: null,
      billing: null,
      reports: null,
      orgs: null,
    });
    expect(vm.pipelineEmpty).toBe(true);
  });

  it("pipelineEmpty is false when any stage carries a non-zero value", () => {
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: {
        sections: {
          pipelineDetail: {
            status: "ok",
            data: {
              evidence: { uploaded: 1, signed: 0, reported: 0 },
              reports: { ready: 0 },
              packages: { ready: 0 },
              publicVerify: { published: 0, unpublished: 0, suspended: 0 },
            },
          },
        },
      },
      billing: null,
      reports: null,
      orgs: null,
    });
    expect(vm.pipelineEmpty).toBe(false);
  });

  it("PipelineSnapshot renders the onboarding card when empty=true", () => {
    const SECTIONS = readWeb(
      "components/home-experience/HomeSections.tsx",
    );
    // The component branches on `empty` and renders an onboarding
    // SectionCard with the testId pipeline-onboarding.
    expect(SECTIONS).toMatch(/if \(empty\)/);
    expect(SECTIONS).toMatch(/testId="pipeline-onboarding"/);
  });
});

// ============================================================================
// 5. Recent Reports actions
// ============================================================================

describe("Phase IA-home-polish — recent reports per-row actions", () => {
  it("view model attaches per-row Open / PDF / Package / Verify hrefs", () => {
    const reports: HomeReportsInput = {
      items: [
        {
          evidenceId: "ev-A",
          title: "Photo set",
          report: {
            available: true,
            version: 2,
            generatedAtUtc: "2026-06-08T10:00:00Z",
          },
          package: {
            available: true,
            version: 2,
            generatedAtUtc: "2026-06-08T10:01:00Z",
          },
        },
        {
          evidenceId: "ev-B",
          title: "Voice memo",
          report: {
            available: true,
            version: 1,
            generatedAtUtc: "2026-06-08T11:00:00Z",
          },
          package: { available: false },
        },
      ],
    };
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: null,
      billing: null,
      reports,
      orgs: null,
    });
    expect(vm.recentReports).toHaveLength(2);

    const rowA = vm.recentReports[0];
    expect(rowA.actions.open).toBe("/evidence/ev-A");
    expect(rowA.actions.reportPdf).toBe(
      "/v1/evidence/ev-A/report/latest",
    );
    expect(rowA.actions.packageZip).toBe(
      "/v1/evidence/ev-A/verification-package",
    );
    expect(rowA.actions.verify).toBe("/v/ev-A");

    const rowB = vm.recentReports[1];
    expect(rowB.actions.reportPdf).toBe(
      "/v1/evidence/ev-B/report/latest",
    );
    // No package ⇒ no zip + no verify link.
    expect(rowB.actions.packageZip).toBeNull();
    expect(rowB.actions.verify).toBeNull();
  });

  it("RecentReports component renders the action buttons", () => {
    const SRC = readWeb("components/home-experience/HomeSections.tsx");
    expect(SRC).toMatch(/data-report-action="open-evidence"/);
    expect(SRC).toMatch(/data-report-action="download-pdf"/);
    expect(SRC).toMatch(/data-report-action="download-package"/);
    expect(SRC).toMatch(/data-report-action="open-verify"/);
  });
});

// ============================================================================
// 6. Recent Activity timeline
// ============================================================================

describe("Phase IA-home-polish — Recent Activity timeline", () => {
  it("derives activity events from command-center.timeline + reports list", () => {
    const cc: HomeCommandCenterInput = {
      sections: {
        timeline: {
          status: "ok",
          items: [
            {
              id: "t1",
              kind: "evidence_uploaded",
              occurredAtUtc: "2026-06-10T09:00:00Z",
              evidenceId: "e-1",
            },
            {
              id: "t2",
              kind: "evidence_timestamped",
              occurredAtUtc: "2026-06-10T09:05:00Z",
              evidenceId: "e-1",
            },
            {
              id: "t3",
              // Enterprise-flavoured event — should NOT be translated.
              kind: "reviewer_assignment_changed",
              occurredAtUtc: "2026-06-10T09:10:00Z",
              evidenceId: "e-1",
            },
          ],
        },
      },
    };
    const reports: HomeReportsInput = {
      items: [
        {
          evidenceId: "e-1",
          title: "Photo",
          report: {
            available: true,
            generatedAtUtc: "2026-06-10T09:30:00Z",
          },
          package: { available: false },
        },
      ],
    };
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: cc,
      billing: null,
      reports,
      orgs: null,
    });

    const kinds = vm.activity.map((e) => e.kind);
    expect(kinds).toContain("evidence_uploaded");
    expect(kinds).toContain("evidence_timestamped");
    expect(kinds).toContain("report_generated");
    // Enterprise kinds drop silently.
    expect(kinds).not.toContain("reviewer_assignment_changed");

    // Plain-language labels.
    const labels = vm.activity.map((e) => e.label);
    expect(labels).toContain("Evidence uploaded");
    expect(labels).toContain("Evidence timestamped");
    expect(labels).toContain("Report generated");

    // Newest first.
    expect(vm.activity[0].occurredAt >= vm.activity[1].occurredAt).toBe(
      true,
    );
  });

  it("caps at 10 events", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`,
      kind: "evidence_uploaded",
      occurredAtUtc: new Date(2026, 5, 10, 0, i).toISOString(),
      evidenceId: `e-${i}`,
    }));
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: { sections: { timeline: { status: "ok", items } } },
      billing: null,
      reports: null,
      orgs: null,
    });
    expect(vm.activity.length).toBeLessThanOrEqual(10);
  });

  it("RecentActivity component is rendered in the dashboard layout", () => {
    const DASH = readWeb(
      "components/home-experience/SelfServeHomeDashboard.tsx",
    );
    expect(DASH).toMatch(/<RecentActivity\s+events=\{vm\.activity\}/);
  });
});

// ============================================================================
// 7. Evidence Health widget
// ============================================================================

describe("Phase IA-home-polish — Evidence Health widget", () => {
  it("derives counts from real signals only — never fabricates", () => {
    const cc: HomeCommandCenterInput = {
      sections: {
        pipelineDetail: {
          status: "ok",
          data: {
            evidence: {
              uploaded: 5,
              signed: 2,
              reported: 3,
              stuckUploading: 1,
            },
            reports: { ready: 3, missingFromSigned: 2, failed: 1 },
            packages: { ready: 2, missingFromReported: 1 },
            publicVerify: { published: 2, unpublished: 0, suspended: 0 },
          },
        },
      },
    };
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: cc,
      billing: null,
      reports: { items: Array.from({ length: 3 }, (_, i) => ({ evidenceId: `r${i}`, title: null, report: { available: true } })) },
      orgs: null,
    });
    expect(vm.health.needsReport).toBe(3); // missingFromSigned + failed
    expect(vm.health.timestampIssues).toBe(1); // stuckUploading
    expect(vm.health.verificationMissing).toBe(1);
    expect(vm.health.allClear).toBe(false);
    // No OTS signal on the self-serve allowlist → 0 (not invented).
    expect(vm.health.anchorPending).toBe(0);
  });

  it("allClear when every signal is zero AND user has evidence", () => {
    const cc: HomeCommandCenterInput = {
      sections: {
        pipelineDetail: {
          status: "ok",
          data: {
            evidence: { uploaded: 1, signed: 0, reported: 0, stuckUploading: 0 },
            reports: { ready: 0, missingFromSigned: 0, failed: 0 },
            packages: { ready: 0, missingFromReported: 0, failed: 0 },
            publicVerify: { published: 0, unpublished: 0, suspended: 0 },
          },
        },
      },
    };
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: cc,
      billing: null,
      reports: null,
      orgs: null,
    });
    expect(vm.health.allClear).toBe(true);
  });

  it("EvidenceHealthCard is rendered in the dashboard layout", () => {
    const DASH = readWeb(
      "components/home-experience/SelfServeHomeDashboard.tsx",
    );
    expect(DASH).toMatch(/<EvidenceHealthCard\s+health=\{vm\.health\}/);
  });
});

// ============================================================================
// 8. Compact Quick Actions
// ============================================================================

describe("Phase IA-home-polish — Compact Quick Actions", () => {
  it("FREE/PAYG only see Upload, Create case, View reports", () => {
    const free = normalizeHomeViewModel({
      plan: "FREE",
      commandCenter: null,
      billing: null,
      reports: null,
      orgs: null,
    });
    const freeKeys = free.quickActions
      .filter((a) => a.visible)
      .map((a) => a.key);
    expect(freeKeys).toEqual(["upload", "create_case", "open_reports"]);

    const payg = normalizeHomeViewModel({
      plan: "PAYG",
      commandCenter: null,
      billing: null,
      reports: null,
      orgs: null,
    });
    const paygKeys = payg.quickActions
      .filter((a) => a.visible)
      .map((a) => a.key);
    expect(paygKeys).toEqual(["upload", "create_case", "open_reports"]);
  });

  it("PRO/TEAM see intake + invite as well", () => {
    const pro = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: null,
      billing: null,
      reports: null,
      orgs: null,
    });
    const proKeys = pro.quickActions
      .filter((a) => a.visible)
      .map((a) => a.key);
    expect(proKeys).toContain("create_intake_link");
    expect(proKeys).toContain("invite_teammate");
  });

  it("every visible quick action carries a valid in-app href", () => {
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: null,
      billing: null,
      reports: null,
      orgs: null,
    });
    for (const a of vm.quickActions.filter((x) => x.visible)) {
      expect(a.href).toMatch(/^\/[a-z][a-z0-9-]/);
    }
  });

  it("CompactQuickActions is rendered in the dashboard header", () => {
    const DASH = readWeb(
      "components/home-experience/SelfServeHomeDashboard.tsx",
    );
    expect(DASH).toMatch(
      /<CompactQuickActions\s+actions=\{vm\.quickActions\}/,
    );
  });
});

// ============================================================================
// 9. Layout ordering: Trust appears near middle, NOT at the bottom only
// ============================================================================

describe("Phase IA-home-polish — layout ordering", () => {
  it("dashboard renders the new sections AND keeps Trust above the bottom", () => {
    const DASH = readWeb(
      "components/home-experience/SelfServeHomeDashboard.tsx",
    );

    // Sequence of section components in the JSX tree:
    const order: string[] = [];
    const components = [
      "CompactQuickActions",
      "WorkspaceSnapshot",
      "NextActionCard",
      "StorageUsageCard",
      "RecentEvidence",
      "RecentCases",
      "RecentReports",
      "PipelineSnapshot",
      "RecentActivity",
      "EvidenceHealthCard",
      "TeamActivityCard",
      "GettingStartedChecklist",
      "TrustSummary",
      "IntegrityAlerts",
    ];
    for (const c of components) {
      const idx = DASH.indexOf(`<${c}`);
      if (idx >= 0) order.push(`${c}@${idx}`);
    }
    expect(order.length).toBe(components.length);
    expect(DASH.indexOf("<CompactQuickActions")).toBeLessThan(
      DASH.indexOf("<WorkspaceSnapshot"),
    );
    expect(DASH.indexOf("<RecentActivity")).toBeLessThan(
      DASH.indexOf("<TrustSummary"),
    );
    expect(DASH.indexOf("<EvidenceHealthCard")).toBeLessThan(
      DASH.indexOf("<TrustSummary"),
    );
  });
});

// ============================================================================
// 10. Counter scope contract — reports/evidence/cases share scope
// ============================================================================

describe("Phase IA-home-polish — counter scope contract", () => {
  it("/v1/reports filter pins workspace AND useHomeData hook passes the active workspace id", () => {
    const HOOK = readWeb("components/home-experience/useHomeData.ts");
    expect(HOOK).toMatch(/\/v1\/reports\?teamId=/);
  });

  it("reports list defines the report count, not pipelineDetail", () => {
    // Even if backend invents a phantom pipelineDetail.reports.ready
    // (the bug scenario), reports tile reflects ACTUAL reports.length.
    const vm = normalizeHomeViewModel({
      plan: "PRO",
      commandCenter: {
        sections: {
          pipelineDetail: {
            status: "ok",
            data: {
              evidence: { uploaded: 0, signed: 0, reported: 0 },
              reports: { ready: 99, missingFromSigned: 0, failed: 0 },
              packages: { ready: 0 },
              publicVerify: { published: 0, unpublished: 0, suspended: 0 },
            },
          },
        },
      },
      billing: null,
      reports: { items: [] },
      orgs: null,
    });
    expect(vm.snapshot.find((t) => t.key === "reports")?.value).toBe("0");
  });
});

// ============================================================================
// 11. Sidebar surfaces are still correct (cross-cut from earlier bugs)
// ============================================================================

describe("Phase IA-home-polish — sidebar still correct", () => {
  it("All Tools gated to platform admin", () => {
    const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(SIDEBAR).toMatch(
      /isPlatformAdmin \? \([\s\S]{0,800}data-sidebar-group="All Tools"/,
    );
  });

  it("/tools route classified as INTERNAL with notFound policy", () => {
    const TIERS = readWeb("lib/surface/tiers.ts");
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/tools",\s*tier:\s*"INTERNAL",\s*directAccessPolicy:\s*"notFound"/,
    );
  });

  it("/intake-links route classified as PROFESSIONAL (visible to PRO/TEAM)", () => {
    const TIERS = readWeb("lib/surface/tiers.ts");
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/intake-links",\s*tier:\s*"PROFESSIONAL"/,
    );
  });
});
