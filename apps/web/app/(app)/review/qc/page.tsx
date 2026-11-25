/**
 * RETIRED ROUTE (team remediation T-078, stage D) — redirect only.
 * Quality control is Monitoring → Quality now (human QC first; Copilot output
 * checks apart, T-080).
 */
import { redirect } from "next/navigation";

import { monitoringHref } from "../../../../lib/reviewer-workspace/monitoring-sections";

export default function QcRetired(): never {
  redirect(monitoringHref("quality"));
}
