/**
 * Phase 32.8D — Reports & Artifacts enterprise index.
 *
 * Delegates to the new `ReportsIndex` component, which renders the
 * artifact lifecycle / deliverables system sourced from
 * `/v1/reports/artifacts` (read-only aggregator, side-effect-free).
 *
 * Phase 38.7 — wrapped in canonical PageRouteGate so access denial
 * renders a structured state via the canonical registry + resolver.
 *
 * NO PLAN NOTICE ABOVE THE PAGE (2026-08-27).
 *
 * A FREE workspace used to get `FreeReportsLockedNotice` — an upgrade panel
 * with a feature checklist — stacked above the real page, so the surface an
 * operator came to use opened with a sales pitch and the reports they already
 * had sat underneath it. Every plan now renders the same shell.
 *
 * This changed NOTHING about entitlement. Report generation, report download
 * and verification-package download are gated by the backend, and the row-level
 * controls still read the server-projected capability; a plan that does not
 * include reports still cannot produce one. What is gone is a banner that
 * described that restriction before the user had asked to do anything.
 */
"use client";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReportsIndex } from "../../../components/reports-experience/ReportsIndex";

export default function ReportsPage() {
  return (
    <PageRouteGate routeId="workspace.reports">
      <ReportsIndex />
    </PageRouteGate>
  );
}
