"use client";

/**
 * Phase 32.8D — Case workspace (tabbed) detail page.
 *
 * Sourced from `GET /v1/cases/:id/workspace`. Browsing is side-effect-
 * free; explicit mutation actions (rename, share, link/unlink evidence)
 * continue to live on the existing audited /v1/cases/:id endpoints
 * accessible from the evidence-detail surface and admin tooling.
 */

import { useParams } from "next/navigation";

import { CaseWorkspace } from "../../../../components/cases-experience/CaseWorkspace";

export default function CaseDetailPage() {
  const params = useParams<{ id?: string | string[] }>();
  const raw = params?.id;
  const caseId = Array.isArray(raw) ? raw[0] : raw;
  if (!caseId) {
    return null;
  }
  return <CaseWorkspace caseId={caseId} />;
}
