"use client";

/**
 * Phase 32.8D — Case workspace (tabbed) detail page.
 *
 * Sourced from `GET /v1/cases/:id/workspace`. Browsing is side-effect-
 * free; explicit mutation actions (rename, share, link/unlink evidence)
 * continue to live on the existing audited /v1/cases/:id endpoints
 * accessible from the evidence-detail surface and admin tooling.
 *
 * Phase 38.13 — wrapped in canonical PageRouteGate inheriting from the
 * parent `workspace.cases` route. Access (capability + active-space) is
 * decided once at the gate; the inner detail component renders only
 * when access is ALLOWED.
 */

import { useParams } from "next/navigation";

import { CaseWorkspace } from "../../../../components/cases-experience/CaseWorkspace";
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
  const raw = params?.id;
  const caseId = Array.isArray(raw) ? raw[0] : raw;
  if (!caseId) {
    return null;
  }
  return <CaseWorkspace caseId={caseId} />;
}
