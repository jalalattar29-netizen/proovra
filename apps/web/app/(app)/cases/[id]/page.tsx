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
      {/* Phase B — operational breadcrumb on the canonical Matter
          Workspace. Preserves the workspace + Phase B group context as
          operators drill into a matter. */}
      <OperationalBreadcrumb
        routeId="workspace.cases"
        items={[
          { label: "Cases", href: "/cases" },
          { label: caseId },
        ]}
      />
      <MatterWorkspace
        caseId={caseId}
        onOpenEvidence={onOpenEvidence}
      />
    </>
  );
}
