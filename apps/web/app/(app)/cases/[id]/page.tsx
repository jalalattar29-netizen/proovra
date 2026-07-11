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
import Link from "next/link";

import { MatterWorkspace } from "../../../../components/cases-experience/MatterWorkspace";
// Phase CASE-DETAIL-PERSONAL-UX — Personal / Small-Business workspaces
// render a simplified 5-tab Case Detail (Overview / Evidence / Reports
// & Packages / Notes / Settings). The richer enterprise MatterWorkspace
// keeps its 12-tab surface; we just route between the two using the
// same `/investigation` surface tier we use for evidence-graph and
// cases-list advanced controls. Backend selectors + routes are
// unchanged for both audiences.
import { SimpleCaseDetail } from "../../../../components/cases-experience/simple-case-detail/SimpleCaseDetail";
import { canAccessSurface } from "../../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../../lib/surface/useSurfaceUserContext";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalBreadcrumb } from "../../../../components/navigation/OperationalBreadcrumb";

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
  // Phase CASE-DETAIL-PERSONAL-UX — same gate as the Cases list page.
  // ENTERPRISE/investigation workspaces keep the 12-tab MatterWorkspace
  // surface; Personal / small-team workspaces get the 5-tab
  // SimpleCaseDetail with no SLA / Risk / SIU / Audit / Holds /
  // Decisions / Assignments / Graph / Timeline. Backend routes are
  // identical for both audiences.
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeAdvancedCaseOps = canAccessSurface(
    surfaceUserCtx,
    "/investigation",
  );

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
      {canSeeAdvancedCaseOps ? (
        <>
          {/* Phase B — operational breadcrumb on the enterprise Matter
              Workspace only. The personal SimpleCaseDetail renders its own
              breadcrumb INSIDE the dark case header (§2/§10), so we do NOT
              also emit this external one for that surface. */}
          <OperationalBreadcrumb
            routeId="workspace.cases"
            items={[
              { label: "Cases", href: "/cases" },
              { label: caseId },
            ]}
          />
          {/* Phase 14 — deep link from the canonical case detail
              surface into the canonical /search surface, scoped to
              this case. Enterprise-only — Personal users don't need
              cross-document Discovery from this surface. */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              padding: "0 16px",
              marginBottom: 4,
            }}
            data-cases-detail-search-pivot
          >
            <Link
              href={`/search?caseId=${encodeURIComponent(caseId)}`}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "#1e40af",
                textDecoration: "none",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 999,
                padding: "4px 12px",
              }}
            >
              View evidence in Search
            </Link>
          </div>
          <MatterWorkspace caseId={caseId} onOpenEvidence={onOpenEvidence} />
        </>
      ) : (
        <SimpleCaseDetail caseId={caseId} onOpenEvidence={onOpenEvidence} />
      )}
    </>
  );
}
