/**
 * Phase G4.2 — Classic Matter Workspace retired.
 *
 * The legacy scroll-spy surface at `/cases/[id]/classic` is no
 * longer the primary mutation surface. Phase C1's Matter Workspace
 * (tabbed) at `/cases/[id]` is the canonical view, and per-domain
 * mutation surfaces (evidence detail, governance/holds,
 * reviewer-ops, assignments, intake) own the audited write paths.
 *
 * This page redirects to the canonical Matter Workspace so deep
 * links bookmarked against the classic URL continue to land
 * somewhere safe. No page body renders — the redirect happens
 * server-side at request time.
 *
 * Hard rules:
 *   * Same `params.id` is forwarded — deep links keep working.
 *   * No data fetch, no audit emission, no custody event — this is
 *     a navigation-only surface.
 *   * The classic CaseWorkspace component is retained in
 *     `apps/web/components/cases-experience/CaseWorkspace.tsx` for
 *     historical reference but is no longer mounted by any route.
 *     A future cleanup PR may delete it; that deletion is tracked as
 *     a separate, well-scoped change rather than smuggled into the
 *     retirement PR.
 */

import { redirect } from "next/navigation";

// Next.js 15+ passes route params as a Promise to server components.
// We await it once and forward the operator to the canonical Matter
// Workspace surface.
export default async function ClassicCaseWorkspacePage({
  params,
}: {
  params: Promise<{ id?: string | string[] }>;
}) {
  const { id } = await params;
  const caseId = Array.isArray(id) ? id[0] : id;
  if (!caseId) {
    redirect("/cases");
  }
  redirect(`/cases/${encodeURIComponent(caseId)}`);
}
