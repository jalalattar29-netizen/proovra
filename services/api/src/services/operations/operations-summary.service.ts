/**
 * THE CANONICAL WORKSPACE OPERATIONS SUMMARY (Attention Architecture, 4C.2).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REPLACES
 * ---------------------------------------------------------------------------
 * Home used to answer "how healthy is this workspace?" like this:
 *
 *     Home  ->  GET /v1/me/inbox  ->  buildOperationalQueue()  ->  health
 *
 * That chain reads ONE PERSON'S NOTIFICATION FEED and reports the result as
 * the WORKSPACE'S operational state. Every personal decision in that feed
 * therefore moved a shared number: archiving a notification dropped the
 * workspace's issue count, deferring one hid a problem from the dashboard
 * until tomorrow, and two admins looking at the same workspace saw two
 * different healths. The work had not changed at all.
 *
 * This module is the replacement. It reads SHARED operational truth —
 * `OperationalIncident`, scoped to the workspace — and knows nothing about who
 * is asking beyond whether they may see it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 * It is not a second lifecycle. It PROJECTS the incident authority: it counts
 * and it groups, and it never decides that anything is resolved. Domains that
 * own their own condition lifecycle (Evidence integrity, review escalation,
 * intake) keep it; this summary reports what those authorities currently say.
 *
 * ---------------------------------------------------------------------------
 * HONESTY (Phase 2.2 / 2.3)
 * ---------------------------------------------------------------------------
 * Every field is accompanied by `complete`. When the underlying read could not
 * be completed, `complete` is false and `mayAssertAllClear` is false, and NO
 * consumer may render "0 issues" or "everything healthy". Home renders an
 * unavailable state instead — and specifically does NOT fall back to deriving
 * health from the notification feed, which is the exact substitution this
 * module exists to remove.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type OperationsSummary = {
  workspaceId: string;
  generatedAtUtc: string;

  /** Conditions that are OPEN or ACKNOWLEDGED — i.e. still unresolved. */
  open: number;
  /** Of the open set, by severity. */
  critical: number;
  high: number;
  warning: number;
  info: number;

  /** Open and ACKNOWLEDGED — somebody has said they have it. */
  acknowledged: number;
  /** Open and assigned to the CALLER, when a caller is supplied. */
  assignedToMe: number;
  /** Open and past the age at which an unattended condition is overdue. */
  overdue: number;

  /**
   * PHASE 2.3 — the honesty contract, carried WITH the numbers rather than
   * beside them. `complete: false` means these counts are a floor, not a
   * total, and nothing may be rendered as an all-clear.
   */
  complete: boolean;
  mayAssertAllClear: boolean;
  /** Why the read was incomplete, when it was. Null otherwise. */
  incompleteReason: string | null;
};

/**
 * How long an unattended OPEN condition may sit before it is overdue.
 *
 * Deliberately a property of the CONDITION rather than of any SLA
 * configuration: this summary must produce a number for every workspace,
 * including the ones that have never configured an SLA, and inventing an SLA
 * for them would be worse than measuring plain age.
 */
export const UNATTENDED_OVERDUE_HOURS = 48;

/**
 * A generous bound on one summary read. Reaching it is reported, never
 * swallowed — see `complete`.
 */
const SUMMARY_SCAN_BOUND = 5000;

const UNRESOLVED_STATUSES = [
  prismaPkg.IncidentStatus.OPEN,
  prismaPkg.IncidentStatus.ACKNOWLEDGED,
] as const;

export type OperationsSummaryInput = {
  workspaceId: string;
  /**
   * The caller, for `assignedToMe` only. The summary is otherwise identical
   * for every member of the workspace, which is the property that makes two
   * admins agree about the workspace's state.
   */
  viewerUserId?: string | null;
  now?: Date;
};

export async function buildOperationsSummary(
  input: OperationsSummaryInput,
  client: PrismaClient = defaultPrisma,
): Promise<OperationsSummary> {
  const now = input.now ?? new Date();
  const overdueBefore = new Date(
    now.getTime() - UNATTENDED_OVERDUE_HOURS * 60 * 60 * 1000,
  );

  let rows: Array<{
    severity: prismaPkg.IncidentSeverity;
    status: prismaPkg.IncidentStatus;
    firstSeenAtUtc: Date;
    assignedOperatorUserId: string | null;
  }>;
  try {
    rows = await client.operationalIncident.findMany({
      where: {
        teamId: input.workspaceId,
        status: { in: [...UNRESOLVED_STATUSES] },
      },
      select: {
        severity: true,
        status: true,
        firstSeenAtUtc: true,
        assignedOperatorUserId: true,
      },
      // The bound is deliberately larger than any plausible real backlog, so
      // hitting it means something is wrong rather than that a workspace is
      // busy — and it is reported either way.
      take: SUMMARY_SCAN_BOUND + 1,
      orderBy: [{ firstSeenAtUtc: "asc" }],
    });
  } catch {
    // A FAILED read is not a healthy workspace. It is an unknown one, and the
    // envelope says so rather than returning a confident set of zeros.
    return unavailableSummary(input.workspaceId, now, "SOURCE_FAILED");
  }

  const complete = rows.length <= SUMMARY_SCAN_BOUND;
  const bounded = complete ? rows : rows.slice(0, SUMMARY_SCAN_BOUND);

  const viewerUserId = input.viewerUserId ?? null;
  let critical = 0;
  let high = 0;
  let warning = 0;
  let info = 0;
  let acknowledged = 0;
  let assignedToMe = 0;
  let overdue = 0;

  for (const row of bounded) {
    switch (row.severity) {
      case prismaPkg.IncidentSeverity.CRITICAL:
        critical += 1;
        break;
      case prismaPkg.IncidentSeverity.HIGH:
        high += 1;
        break;
      case prismaPkg.IncidentSeverity.WARNING:
        warning += 1;
        break;
      default:
        info += 1;
    }
    if (row.status === prismaPkg.IncidentStatus.ACKNOWLEDGED) acknowledged += 1;
    if (viewerUserId && row.assignedOperatorUserId === viewerUserId) {
      assignedToMe += 1;
    }
    // Overdue means UNATTENDED and old. An acknowledged condition has an
    // owner, so ageing it into "overdue" would punish the operator who picked
    // it up and reward the workspace that ignored it.
    if (
      row.status === prismaPkg.IncidentStatus.OPEN &&
      row.firstSeenAtUtc.getTime() <= overdueBefore.getTime()
    ) {
      overdue += 1;
    }
  }

  return {
    workspaceId: input.workspaceId,
    generatedAtUtc: now.toISOString(),
    open: bounded.length,
    critical,
    high,
    warning,
    info,
    acknowledged,
    assignedToMe,
    overdue,
    complete,
    mayAssertAllClear: complete,
    incompleteReason: complete ? null : "SCAN_BOUND_REACHED",
  };
}

/**
 * The shape a consumer receives when the summary could not be produced.
 *
 * Zeros with `complete: false`, NOT zeros that look like good news. The two
 * booleans are what a UI must read before it renders any reassuring string;
 * `open: 0` on its own is meaningless here and is present only so the type
 * stays total.
 */
export function unavailableSummary(
  workspaceId: string,
  now: Date,
  reason: string,
): OperationsSummary {
  return {
    workspaceId,
    generatedAtUtc: now.toISOString(),
    open: 0,
    critical: 0,
    high: 0,
    warning: 0,
    info: 0,
    acknowledged: 0,
    assignedToMe: 0,
    overdue: 0,
    complete: false,
    mayAssertAllClear: false,
    incompleteReason: reason,
  };
}
