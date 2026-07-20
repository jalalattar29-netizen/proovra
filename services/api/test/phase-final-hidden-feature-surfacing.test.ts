/**
 * Phase Final-Hidden-Feature-Surfacing — contract test.
 *
 * Asserts that the 10 documented hidden backend features now have
 * UI surfaces wired to real endpoints. Each pin checks:
 *
 *   - The shared `HiddenFeaturePanels.tsx` barrel exports the panel.
 *   - The host page (or component) imports + mounts the panel.
 *   - The corresponding backend endpoint exists in the route file.
 *
 * No mock data — every panel calls a real API path. Loading / empty /
 * error / forbidden states are part of the panel's render logic.
 *
 * The 11th feature (CaseSiuReviewIndicator) was already surfaced
 * in `SiuPanel.tsx` (existing `reviewIndicators` block) — pinned
 * separately for completeness.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

const PANELS = read("apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx");

describe("Phase Final-Hidden-Feature-Surfacing — barrel exports 8 panel components", () => {
  // (2026-07-20) `WorkspacePersonaProfileCard` was removed with the
  // workspace-persona / workflow-personalization feature (9 → 8 panels).
  const EXPORTS = [
    "CaseRiskPanel",
    "EvidenceAiCategorizationCard",
    "ImmutableStorageDriftSection",
    "MfaRecoveryApprovalHistoryBlock",
    "EvidenceRequestEventsTab",
    "OrgHealthSnapshotCard",
    "ReviewerRoutingRecommendationsPane",
    "AccessAnomaliesCard",
  ];
  for (const name of EXPORTS) {
    it(`exports ${name}`, () => {
      expect(PANELS).toMatch(new RegExp(`export\\s+function\\s+${name}\\b`));
    });
  }
});

describe("Phase Final-Hidden-Feature-Surfacing — panels call real backend endpoints", () => {
  const ENDPOINTS = [
    "/v1/cases/${encodeURIComponent(caseId)}/risk",
    "/v1/evidence/${encodeURIComponent(evidenceId)}/ai-categorization",
    "/v1/governance/immutable-storage-checks?",
    "/v1/identity/mfa-admin/recovery-requests/${encodeURIComponent(",
    "/v1/evidence-requests/${encodeURIComponent(requestId)}/events",
    // (2026-07-20) The workspace-persona endpoint was removed with the
    // workspace-persona / workflow-personalization feature.
    "/v1/dashboard/org-health?teamId=",
    "/v1/reviewer/routing-recommendations?teamId=",
    "/v1/security-center/access-anomalies?teamId=",
  ];
  for (const path of ENDPOINTS) {
    it(`calls ${path}`, () => {
      expect(PANELS).toContain(path);
    });
  }
  it("contains no mock/fake/placeholder data strings", () => {
    expect(PANELS).not.toMatch(/lorem ipsum/i);
    expect(PANELS).not.toMatch(/TODO:.*replace/i);
    expect(PANELS).not.toMatch(/data:\s*\[\s*\{[^}]*sample/i);
  });
});

describe("Phase Final-Hidden-Feature-Surfacing — new backend endpoints registered", () => {
  it("dashboard.routes.ts registers /v1/dashboard/org-health", () => {
    const f = read("services/api/src/routes/dashboard.routes.ts");
    expect(f).toMatch(/"\/v1\/dashboard\/org-health"/);
    expect(f).toMatch(/getLatestOrgHealthSnapshot/);
  });
  it("dashboard.routes.ts registers /v1/reviewer/routing-recommendations", () => {
    const f = read("services/api/src/routes/dashboard.routes.ts");
    expect(f).toMatch(/"\/v1\/reviewer\/routing-recommendations"/);
    expect(f).toMatch(/listReviewerRoutingRecommendations/);
  });
  it("dashboard.routes.ts registers /v1/security-center/access-anomalies", () => {
    const f = read("services/api/src/routes/dashboard.routes.ts");
    expect(f).toMatch(/"\/v1\/security-center\/access-anomalies"/);
    expect(f).toMatch(/listWorkspaceAccessAnomalies/);
  });
  it("mfa-admin.routes.ts registers /v1/identity/mfa-admin/recovery-requests/:requestId/approvals", () => {
    const f = read("services/api/src/routes/mfa-admin.routes.ts");
    expect(f).toMatch(
      /"\/v1\/identity\/mfa-admin\/recovery-requests\/:requestId\/approvals"/,
    );
    expect(f).toMatch(/listRecoveryRequestApprovals/);
  });
  it("mfa-recovery service exposes listRecoveryRequestApprovals", () => {
    const f = read("services/api/src/services/security/mfa-recovery-request.service.ts");
    expect(f).toMatch(/export async function listRecoveryRequestApprovals/);
    // Tenancy guard: must check team admin role.
    expect(f).toMatch(/role:\s*\{\s*in:\s*\["OWNER",\s*"ADMIN"\]/);
  });
});

describe("Phase Final-Hidden-Feature-Surfacing — host pages mount each panel", () => {
  it("MatterWorkspace mounts CaseRiskPanel", () => {
    const f = read("apps/web/components/cases-experience/MatterWorkspace.tsx");
    expect(f).toMatch(/CaseRiskPanel/);
    expect(f).toMatch(/<CaseRiskPanel\s+caseId/);
  });
  it("/evidence/[id] surfaces AI categorization via the canonical AiCategorizationPanel", () => {
    // Phase EVIDENCE-AI-CONSOLIDATION — the prior two-component
    // chain (`AiCategorizationCardWhenActive` wrapping the
    // hidden-feature `EvidenceAiCategorizationCard`) was
    // consolidated into a single canonical surface,
    // `<AiCategorizationPanel>`, which hits the same backend
    // endpoint and carries one disclaimer + the DISABLED handling
    // inline. The hidden-feature card is no longer mounted on
    // this page; the feature still surfaces via the canonical
    // panel below.
    const f = read("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx");
    expect(f).toMatch(/<AiCategorizationPanel\s+evidenceId/);
    const panel = read(
      "apps/web/app/(app)/evidence/components/AiCategorizationPanel.tsx",
    );
    expect(panel).toMatch(/\/v1\/evidence\/\$\{evidenceId\}\/ai-categorization/);
  });
  it("/governance/lifecycle mounts ImmutableStorageDriftSection", () => {
    const f = read("apps/web/app/(app)/governance/lifecycle/page.tsx");
    expect(f).toMatch(/ImmutableStorageDriftSection/);
    expect(f).toMatch(/<ImmutableStorageDriftSection\s+teamId/);
  });
  it("/security-center/mfa-recovery mounts MfaRecoveryApprovalHistoryBlock", () => {
    const f = read("apps/web/app/(app)/security-center/mfa-recovery/page.tsx");
    expect(f).toMatch(/MfaRecoveryApprovalHistoryBlock/);
    expect(f).toMatch(/<MfaRecoveryApprovalHistoryBlock\s+requestId/);
  });
  it("/evidence-requests/[id] mounts EvidenceRequestEventsTab", () => {
    const f = read("apps/web/app/(app)/evidence-requests/[id]/page.tsx");
    expect(f).toMatch(/EvidenceRequestEventsTab/);
    expect(f).toMatch(/<EvidenceRequestEventsTab\s+requestId/);
  });
  // (2026-07-20) The "/settings/persona mounts WorkspacePersonaProfileCard"
  // test was removed with the workspace-persona / workflow-personalization
  // feature — both the page and the panel were physically deleted.
  it("/security-center mounts OrgHealthSnapshotCard + AccessAnomaliesCard", () => {
    const f = read("apps/web/app/(app)/security-center/page.tsx");
    expect(f).toMatch(/AccessAnomaliesCard/);
    expect(f).toMatch(/<AccessAnomaliesCard\s+teamId/);
    expect(f).toMatch(/OrgHealthSnapshotCard/);
    expect(f).toMatch(/<OrgHealthSnapshotCard\s+teamId/);
  });
  it("ReviewerConsole mounts ReviewerRoutingRecommendationsPane", () => {
    const f = read("apps/web/components/reviewer-experience/ReviewerConsole.tsx");
    expect(f).toMatch(/ReviewerRoutingRecommendationsPane/);
    expect(f).toMatch(/<ReviewerRoutingRecommendationsPane\s+teamId/);
  });
  it("SiuPanel already renders reviewIndicators (CaseSiuReviewIndicator surfaced pre-existing)", () => {
    const f = read("apps/web/app/(app)/cases/components/SiuPanel.tsx");
    expect(f).toMatch(/profile\.reviewIndicators/);
    expect(f).toMatch(/data-testid="siu-indicators"/);
  });
});
