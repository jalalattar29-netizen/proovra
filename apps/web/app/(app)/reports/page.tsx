/**
 * Phase 32.8D — Reports & Artifacts enterprise index.
 *
 * Delegates to the new `ReportsIndex` component, which renders the
 * artifact lifecycle / deliverables system sourced from
 * `/v1/reports/artifacts` (read-only aggregator, side-effect-free).
 *
 * Phase 38.7 — wrapped in canonical PageRouteGate so access denial
 * renders a structured state via the canonical registry + resolver.
 */

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReportsIndex } from "../../../components/reports-experience/ReportsIndex";

export default function ReportsPage() {
  return (
    <PageRouteGate routeId="workspace.reports">
      <ReportsIndex />
    </PageRouteGate>
  );
}
