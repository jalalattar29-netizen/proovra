/**
 * THE SURFACED PANELS BELONG TO THE LIGHT CONTENT PLANE.
 *
 * These panels mount on the matter Overview, Security Center, Governance
 * Lifecycle, MFA recovery, Evidence requests and the reviewer console. They
 * were written for a retired dark page, so on the shipped light background the
 * whole block was near-white on near-white. V-020 is the same panel: a bare
 * "100" with no scale, beside the word "NONE".
 *
 * The response shapes below are what `GET /v1/cases/:id/risk-snapshot` sends
 * (services/api/src/routes/case-workspace.routes.ts).
 */

import fs from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  AccessAnomaliesCard,
  CaseRiskPanel,
} from "../../components/hidden-feature-panels/HiddenFeaturePanels";

const webRoot = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(webRoot, relative), "utf8");

const snapshot = {
  riskScore: 100,
  riskLevel: "NONE",
  evidenceGapCount: 0,
  openIncidentCount: 0,
  activeWorkflowCount: 0,
  overdueWorkflowCount: 0,
  governanceBlockerCount: 0,
  reviewerPressureScore: 0,
  auditReadinessScore: 100,
  custodyConcernCount: 0,
  integrityConcernCount: 0,
  packageReportGapCount: 0,
  reasonCodes: [] as string[],
  recommendedAction: "Workspace operating within risk tolerance.",
  sampledAtUtc: "2026-10-31T18:35:06.000Z",
};

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("V-020: the matter risk score has a scale", () => {
  it("says what the number is out of and which way is good", async () => {
    apiFetch.mockResolvedValue({ snapshot });
    render(<CaseRiskPanel caseId="case-1" />);
    expect(await screen.findByText("/ 100")).toBeTruthy();
    expect(screen.getByText(/Higher is safer/)).toBeTruthy();
  });

  it("names the level in words, not the engine's enum", async () => {
    apiFetch.mockResolvedValue({
      snapshot: { ...snapshot, riskScore: 62, riskLevel: "MEDIUM" },
    });
    render(<CaseRiskPanel caseId="case-1" />);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.queryByText("MEDIUM")).toBeNull();
  });

  it("does not present NONE as a raw word", async () => {
    apiFetch.mockResolvedValue({ snapshot });
    render(<CaseRiskPanel caseId="case-1" />);
    expect(await screen.findByText("No risk signals")).toBeTruthy();
    expect(screen.queryByText("NONE")).toBeNull();
  });

  it("explains every reason code, and shows an unknown one in plain words", async () => {
    apiFetch.mockResolvedValue({
      snapshot: { ...snapshot, reasonCodes: ["WORKFLOW_OVERDUE", "SOMETHING_NEW"] },
    });
    render(<CaseRiskPanel caseId="case-1" />);
    expect(await screen.findByText("A workflow is past its due date")).toBeTruthy();
    expect(screen.getByText("Something new")).toBeTruthy();
    expect(screen.queryByText("WORKFLOW_OVERDUE")).toBeNull();
  });

  it("does not set the recommendation in italics (V-019)", async () => {
    apiFetch.mockResolvedValue({ snapshot });
    render(<CaseRiskPanel caseId="case-1" />);
    const line = await screen.findByText(/Recommended:/);
    expect(line.style.fontStyle).toBe("");
  });

  it("shows no scale when there is no score yet (negative control)", async () => {
    apiFetch.mockResolvedValue({ snapshot: { ...snapshot, riskScore: null } });
    render(<CaseRiskPanel caseId="case-1" />);
    await screen.findByText("Evidence gaps:", { exact: false });
    expect(screen.queryByText("/ 100")).toBeNull();
  });
});

describe("access anomalies speak to the customer", () => {
  it("shows words where the row carried enums", async () => {
    apiFetch.mockResolvedValue({
      anomalies: [
        {
          id: "a1",
          category: "PERMISSION_DENIED_BURST",
          severity: "HIGH",
          status: "OPEN",
          sampleEventType: "permission_denied",
          count: 20,
          actorUserId: null,
          windowStartUtc: "2026-10-31T18:00:00.000Z",
          windowEndUtc: "2026-10-31T19:00:00.000Z",
          summary: null,
        },
      ],
    });
    render(<AccessAnomaliesCard teamId="team-1" />);
    expect(await screen.findByText("Permission denied burst")).toBeTruthy();
    expect(screen.queryByText("PERMISSION_DENIED_BURST")).toBeNull();
    expect(document.body.textContent).not.toMatch(/OPEN \/ ACKNOWLEDGED/);
  });
});

describe("no panel keeps a dark-surface colour", () => {
  it("uses no near-white ink and no 4% white card", () => {
    const source = read("components/hidden-feature-panels/HiddenFeaturePanels.tsx");
    expect(source).not.toContain("#dce1de");
    expect(source).not.toContain("220,225,222");
    expect(source).not.toContain("rgba(255,255,255,0.04)");
    expect(source).not.toMatch(/fontStyle:\s*"italic"/);
  });

  it("gives the usage pages the same treatment", () => {
    for (const file of [
      "components/dashboard/styles.ts",
      "components/dashboard/DashboardShell.tsx",
      "app/(app)/operations/batch-analysis/page.tsx",
      "app/(app)/operations/quotas/page.tsx",
    ]) {
      const source = read(file);
      expect(source, file).not.toContain("site-velvet-bg");
      expect(source, file).not.toMatch(/194,\s*204,\s*201/);
      expect(source, file).not.toContain("#d8e0dd");
    }
  });
});

describe("the .cc-* grammar has a stylesheet", () => {
  it("defines every name the administration and governance surfaces render", () => {
    const css = read("components/command-center/command-center.css");
    const consumers = [
      "components/workspace-admin/WorkspaceAdministrationHome.tsx",
      "components/workspace-admin/WorkspaceAdminPanel.tsx",
      "components/workspace-admin/WorkspaceAuditTab.tsx",
      "components/governance-experience/GovernanceControlPlane.tsx",
      "app/(app)/organizations/[id]/admin/layout.tsx",
    ];
    const used = new Set<string>();
    for (const file of consumers) {
      for (const match of read(file).matchAll(/className="([^"]+)"/g)) {
        for (const name of match[1].split(/\s+/)) {
          if (name.startsWith("cc-")) used.add(name);
        }
      }
    }
    expect(used.size).toBeGreaterThan(15);
    for (const name of used) {
      expect(css, name).toMatch(new RegExp(`\\.${name}[\\s,{:]`));
    }
  });
});
