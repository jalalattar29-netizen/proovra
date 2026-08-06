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
 * Phase IA-self-serve-simplification — FREE-plan users see a
 * polished locked-state notice above the existing ReportsIndex. The
 * downstream report download endpoints are still backend-gated; the
 * notice is the UX-layer affordance that explains the upgrade.
 */
"use client";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReportsIndex } from "../../../components/reports-experience/ReportsIndex";
import { FreeReportsLockedNotice } from "../../../components/reports-experience/FreeReportsLockedNotice";
import { usePlanFeature } from "../../../lib/platform-context";

export default function ReportsPage() {
  // Track 1A (surface-tier removal) — the locked notice follows the
  // SERVER-projected `planFeatures.reportsIncluded` entitlement (the
  // backend PLAN_CAPABILITIES projection; FREE excludes reports). Plans
  // that include reports — and the loading/unknown state — see
  // ReportsIndex unmodified. A KNOWN `false` renders the locked notice
  // ABOVE ReportsIndex so the user still sees any existing report they
  // may have generated under a prior entitlement, but the upgrade
  // affordance is the dominant call-to-action.
  const reportsIncluded = usePlanFeature("reportsIncluded");
  return (
    <PageRouteGate routeId="workspace.reports">
      {reportsIncluded === false ? <FreeReportsLockedNotice /> : null}
      <ReportsIndex />
    </PageRouteGate>
  );
}
