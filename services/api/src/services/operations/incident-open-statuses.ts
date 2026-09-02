/**
 * WHAT "OPEN" MEANS FOR AN OPERATIONAL INCIDENT.
 *
 * ===========================================================================
 * WHY THIS IS A FILE AND NOT A LITERAL
 * ===========================================================================
 * Six places answered this question and they did not agree:
 *
 *   admin/overview.service.ts            status: "OPEN"
 *   admin/platform-health.service.ts     ["OPEN", "ACKNOWLEDGED"]
 *   admin/workspaces.service.ts          status: "OPEN"
 *   operations/evidence-health.service.ts ["OPEN", "ACKNOWLEDGED"]
 *   dashboard/incident-correlation.service.ts ["OPEN", "ACKNOWLEDGED"]
 *   operations/platform-health-snapshot.service.ts status: "OPEN"
 *
 * So Admin Overview and System Health printed different incident counts for
 * the same platform at the same moment, and neither was wrong about its own
 * predicate. An operator reconciling two consoles cannot tell a real change
 * from a definitional one, and the natural conclusion — that one of the pages
 * is broken — is the wrong conclusion.
 *
 * ===========================================================================
 * WHICH ANSWER, AND WHY
 * ===========================================================================
 * ACKNOWLEDGED counts as unresolved.
 *
 * An acknowledged incident is one a human has looked at and NOT fixed. The
 * condition is still live, the thing it describes is still happening, and
 * excluding it produces a console where acknowledging an incident makes it
 * disappear from the headline count. That is an interface that rewards
 * clicking "acknowledge" — precisely the wrong incentive on an operations
 * surface — and it is why the lifecycle keeps ACKNOWLEDGED and RESOLVED as
 * separate states rather than collapsing them.
 *
 * The narrower reading is not defensible for a HEADLINE. It is defensible for
 * a queue of things nobody has triaged yet, which is a different question and
 * has its own name below.
 */

import type { Prisma } from "@prisma/client";

/**
 * Unresolved: the condition is still live, whether or not a human has seen it.
 *
 * This is the count a headline, a badge or an "N incidents" figure means.
 */
export const UNRESOLVED_INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED"] as const;

/**
 * Untriaged: nobody has acknowledged it yet.
 *
 * A genuinely different question — "what has nobody looked at?" — and the only
 * legitimate use of the narrower predicate. Naming it separately is what stops
 * it being reached for by accident when the answer wanted was the one above.
 */
export const UNTRIAGED_INCIDENT_STATUSES = ["OPEN"] as const;

/** `where` fragment for the unresolved population. */
export function unresolvedIncidentWhere(): Prisma.OperationalIncidentWhereInput {
  return { status: { in: [...UNRESOLVED_INCIDENT_STATUSES] } };
}

/** `where` fragment for the untriaged population. */
export function untriagedIncidentWhere(): Prisma.OperationalIncidentWhereInput {
  return { status: { in: [...UNTRIAGED_INCIDENT_STATUSES] } };
}
