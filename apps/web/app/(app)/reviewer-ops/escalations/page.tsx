/**
 * RETIRED ROUTE (team remediation T-078, stage D) — redirect only.
 *
 * Escalations are a section of the one Monitoring area now
 * (`/reviewer-ops/sla?section=escalations`). A notification or Operations link
 * carrying `?escalationId=` keeps it, so the linked escalation is still
 * highlighted.
 */
import { redirect } from "next/navigation";

import { monitoringHref } from "../../../../lib/reviewer-workspace/monitoring-sections";

export default async function EscalationsRetired({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const params = (await searchParams) ?? {};
  const raw = params.escalationId;
  const escalationId = Array.isArray(raw) ? raw[0] : raw;
  redirect(monitoringHref("escalations", escalationId ? { escalationId } : undefined));
}
