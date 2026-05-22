/**
 * Phase 32.8D — Reports & Artifacts enterprise index.
 *
 * Delegates to the new `ReportsIndex` component, which renders the
 * artifact lifecycle / deliverables system sourced from
 * `/v1/reports/artifacts` (read-only aggregator, side-effect-free).
 */

import { ReportsIndex } from "../../../components/reports-experience/ReportsIndex";

export default function ReportsPage() {
  return <ReportsIndex />;
}
