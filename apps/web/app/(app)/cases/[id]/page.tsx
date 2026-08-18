"use client";

/**
 * Phase C1 — Canonical Matter Workspace (tabbed) detail page.
 *
 * Sourced from `GET /v1/cases/:id/matter-workspace`. The eleven tabs
 * (Overview · Evidence · Timeline · Graph · Holds · Decisions · Risk ·
 * Communications · Assignments · Audit · Export) surface the Phase
 * 32.8D MatterWorkspaceEnvelope.
 *
 * Phase G4.2 — The legacy `/cases/[id]/classic` scroll-spy surface is
 * retired. Its URL now redirects to this canonical surface; the
 * `onOpenClassic` plumbing is removed. Per-domain mutation surfaces
 * (evidence detail, governance/holds, reviewer-ops, intake) own the
 * audited write paths.
 *
 * Phase 38.13 — wrapped in canonical PageRouteGate inheriting from the
 * parent `workspace.cases` route. Access (capability + active-space) is
 * decided once at the gate; the inner component renders only when
 * access is ALLOWED.
 */

import { useParams, useRouter } from "next/navigation";
import { useCallback } from "react";

import { MatterWorkspace } from "../../../../components/cases-experience/MatterWorkspace";
// Phase CASE-DETAIL-PERSONAL-UX — Personal / Small-Business workspaces
// render a simplified 5-tab Case Detail (Overview / Evidence / Reports
// & Packages / Notes / Settings). The richer enterprise MatterWorkspace
// keeps its 12-tab surface; we just route between the two using the
// same `/investigation` surface tier we use for evidence-graph and
// cases-list advanced controls. Backend selectors + routes are
// unchanged for both audiences.
import { SimpleCaseDetail } from "../../../../components/cases-experience/simple-case-detail/SimpleCaseDetail";
import { useEnterpriseSurfaceAccess } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

export default function CaseDetailPage() {
  return (
    <PageRouteGate routeId="workspace.cases">
      <CaseDetailPageInner />
    </PageRouteGate>
  );
}

function CaseDetailPageInner() {
  const params = useParams<{ id?: string | string[] }>();
  const router = useRouter();
  const raw = params?.id;
  const caseId = Array.isArray(raw) ? raw[0] : raw;
  // Phase CASE-DETAIL-PERSONAL-UX / Track 1A — same gate as the Cases
  // list page. Enterprise workspaces keep the 12-tab MatterWorkspace
  // surface; Personal / small-team workspaces get the 5-tab
  // SimpleCaseDetail with no SLA / Risk / SIU / Audit / Holds /
  // Decisions / Assignments / Graph / Timeline. Backend routes are
  // identical for both audiences. Server-projected boolean only.
  const canSeeAdvancedCaseOps = useEnterpriseSurfaceAccess();

  const onOpenEvidence = useCallback(
    (evidenceId: string) => {
      router.push(`/evidence/${encodeURIComponent(evidenceId)}`);
    },
    [router],
  );

  if (!caseId) {
    return null;
  }

  return (
    <>
      {/* UNIVERSAL CASE DETAILS.
          Both branches render the SAME shell, page plane, breadcrumb, header
          anatomy, tabs, cards, buttons, status language and states — the
          difference is the CONTENT each surfaces, not the design system.

          Two enterprise-only chrome pieces were removed from this file
          because they duplicated what the shared header now provides:
            - <OperationalBreadcrumb>: the shared CaseDetailHeader renders
              the one canonical breadcrumb for every branch, so Enterprise
              no longer emitted a second, differently-shaped one.
            - the inline hex-coloured "View evidence in Search" pill: it now
              rides the canonical .app-secondary-action inside the shared
              header's secondary-action slot. */}
      {canSeeAdvancedCaseOps ? (
        <MatterWorkspace caseId={caseId} onOpenEvidence={onOpenEvidence} />
      ) : (
        <SimpleCaseDetail caseId={caseId} onOpenEvidence={onOpenEvidence} />
      )}
    </>
  );
}
