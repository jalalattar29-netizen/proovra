/**
 * RETIRED ROUTE (team remediation T-078, stage D) — redirect only.
 * Reviewer metrics are Monitoring → Metrics now.
 */
import { redirect } from "next/navigation";

import { monitoringHref } from "../../../../lib/reviewer-workspace/monitoring-sections";

export default function MetricsRetired(): never {
  redirect(monitoringHref("metrics"));
}
