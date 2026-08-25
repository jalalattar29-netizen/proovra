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
import { workspaceIncidentWhere } from "../observability/incident-scope.js";
import {
  projectConditionGroups,
  type OperationsConditionGroup,
} from "./operations-grouping.service.js";
import {
  latestWorkspaceOperationsRun,
  mayAssertOperationsClear,
  type ClearRefusalReason,
  type OperationsReadiness,
  type WorkspaceOperationsRunSnapshot,
} from "@proovra/shared-runtime";

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
  /**
   * Open and owned by NOBODY.
   *
   * The counterpart to `assignedToMe`, and the field a shared workspace
   * triages from: work with an owner is being handled, work without one is
   * waiting on whoever looks first. It is derived from the SAME scan as every
   * other field here — a second query could disagree with `open` in the gap
   * between two reads, and a summary whose parts do not add up is worse than
   * one that is coarse.
   *
   * In a single-operator workspace this is `open` minus whatever that one
   * operator has taken, which is not a distinction worth a card. The CONSUMER
   * declines to render it (there is no OPERATIONS_ASSIGN there); the number
   * itself stays correct for every workspace.
   */
  unassigned: number;
  /**
   * SLA COUNTERS, from the SAME projection the rows carry.
   *
   * These replace the former `overdue` count, which was a fixed 48-hour age
   * heuristic. That heuristic was a SECOND authority on lateness: a row could
   * show BREACHED against the workspace's own four-hour promise while this
   * card counted it as fine, and vice versa. Two answers to "is this late?"
   * on one screen is worse than either answer alone, because the operator has
   * no way to tell which one to act on.
   *
   * Conditions with no recorded promise are counted in `slaUntracked` and
   * are deliberately absent from `slaBreached`: they predate the SLA
   * authority, so counting them as broken promises would manufacture failures
   * out of missing records.
   */
  slaBreached: number;
  slaAtRisk: number;
  slaOnTrack: number;
  slaUntracked: number;

  /**
   * PHASE 2.3 — the honesty contract, carried WITH the numbers rather than
   * beside them. `complete: false` means these counts are a floor, not a
   * total, and nothing may be rendered as an all-clear.
   */
  complete: boolean;
  mayAssertAllClear: boolean;
  /** Why the read was incomplete, when it was. Null otherwise. */
  incompleteReason: string | null;

  /**
   * WORKSPACE-SCOPE CONVERGENCE (§8) — RECONCILIATION FRESHNESS.
   *
   * `complete` above answers "did the incident-table read finish?". That was
   * never enough, and the gap is the defect this section closes: an incident
   * table can be read completely and be EMPTY because nothing has ever
   * scanned the workspace. Read completeness is not discovery completeness,
   * and only the second licenses the word "clear".
   *
   * These carry the state of the workspace's most recent discovery run, so a
   * consumer can tell "we looked, thoroughly, minutes ago, and found nothing"
   * from "nothing has ever looked".
   */
  /**
   * The grouped queue (§11).
   *
   * 34 Evidence records that each failed to be timestamped are 34 conditions,
   * and they stay 34 conditions — this is a PRESENTATION projection over the
   * same rows the counters above were computed from, never a merge. Each group
   * reports `affectedCount` and a bounded sample; per-record drill-down and
   * per-record lifecycle are unchanged.
   */
  groups: OperationsConditionGroup[];
  readiness: OperationsReadiness;
  /** Null when no run has ever been recorded. */
  reconciliation: WorkspaceOperationsRunSnapshot | null;
  /**
   * Bounded reason `mayAssertAllClear` is false. Null when it is true.
   *
   * Distinct from `incompleteReason`, which is about the incident READ. This
   * one is about whether the workspace may be DESCRIBED as clear, which is a
   * strictly stronger question.
   */
  clearRefusalReason: ClearRefusalReason | null;
};

/**
 * REMOVED (Phase B closure): `UNATTENDED_OVERDUE_HOURS`.
 *
 * A fixed 48-hour age threshold was a second authority on lateness, competing
 * with the workspace's own SLA promise. The two disagreed by construction —
 * a four-hour promise breached at hour five while this called it fine, and a
 * seven-day promise was called overdue at hour forty-nine.
 *
 * Lateness is now measured in exactly one place: the persisted SLA cycle. Age
 * is still SHOWN on every row as plain elapsed time, which is an observation
 * and not a verdict, and nothing counts it.
 */

/**
 * A generous bound on one summary read. Reaching it is reported, never
 * swallowed — see `complete`.
 */
const SUMMARY_SCAN_BOUND = 5000;

/**
 * What counts as UNRESOLVED work.
 *
 * SUPPRESSED is included, and that is a deliberate correction. Suppression
 * silences NOTIFICATION; the condition itself is still unresolved and still
 * unfixed. Excluding it would let a workspace improve its own SLA numbers by
 * suppressing whatever it was about to miss, which makes the number a measure
 * of button-pressing rather than of commitments met.
 *
 * The queue's DEFAULT VIEW still hides suppressed conditions — that is what
 * suppression is for — and they remain reachable through the status filter.
 * Hiding something from a default view and removing it from the truth are
 * different acts, and only the first is what an operator asked for.
 */
const UNRESOLVED_STATUSES = [
  prismaPkg.IncidentStatus.OPEN,
  prismaPkg.IncidentStatus.ACKNOWLEDGED,
  prismaPkg.IncidentStatus.SUPPRESSED,
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

  let rows: Array<{
    id: string;
    category: prismaPkg.IncidentCategory;
    fingerprint: string;
    title: string;
    safeSummary: string;
    severity: prismaPkg.IncidentSeverity;
    status: prismaPkg.IncidentStatus;
    firstSeenAtUtc: Date;
    lastSeenAtUtc: Date;
    occurrenceCount: number;
    relatedEvidenceId: string | null;
    assignedOperatorUserId: string | null;
  }>;
  try {
    rows = await client.operationalIncident.findMany({
      where: {
        // WORKSPACE-SCOPE CONVERGENCE — the canonical tenant predicate pins
        // `scope = WORKSPACE` alongside the workspace id, so a platform
        // incident and an unclassified orphan are both outside this summary by
        // construction. The summary is what Home and Operations both count
        // from; a row that leaks in here is a number two surfaces agree on and
        // both get wrong.
        ...workspaceIncidentWhere(input.workspaceId),
        status: { in: [...UNRESOLVED_STATUSES] },
      },
      select: {
        id: true,
        // WORKSPACE-SCOPE CONVERGENCE (§11) — the grouped queue projection is
        // built from THIS scan, not a second one. Conservation with `open` is
        // then true by construction rather than by two queries agreeing: the
        // sum of every group's affectedCount IS the number of rows counted
        // above, because it is the same array.
        category: true,
        fingerprint: true,
        title: true,
        safeSummary: true,
        severity: true,
        status: true,
        firstSeenAtUtc: true,
        lastSeenAtUtc: true,
        occurrenceCount: true,
        relatedEvidenceId: true,
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

  // The freshness half of the answer. Read AFTER the incidents so a run that
  // completes mid-summary cannot make a stale row set look certified — the run
  // snapshot is never newer than the rows it is vouching for.
  //
  // A failure here is not a clear workspace. It is an unknown one: the
  // snapshot stays null, readiness is NEVER_RUN, and the clear gate refuses.
  let run: WorkspaceOperationsRunSnapshot | null = null;
  try {
    run = await latestWorkspaceOperationsRun(client, input.workspaceId, now);
  } catch {
    run = null;
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
  let unassigned = 0;
  let slaBreached = 0;
  let slaAtRisk = 0;
  let slaOnTrack = 0;
  let slaUntracked = 0;

  // ONE cycle read for the whole summary, and the SAME projection the list
  // route uses. Counting by a predicate written here instead would be the
  // second authority this closure removes.
  const { loadSlaCycles, projectIncidentSla } = await import(
    "./incident-sla.js"
  );
  const cycles = await loadSlaCycles(
    { teamId: input.workspaceId, incidentIds: bounded.map((r) => r.id) },
    client,
  );

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
    if (row.assignedOperatorUserId === null) unassigned += 1;

    switch (
      projectIncidentSla(row.status, cycles.get(row.id) ?? null, now).posture
    ) {
      case "BREACHED":
        slaBreached += 1;
        break;
      case "AT_RISK":
        slaAtRisk += 1;
        break;
      case "ON_TRACK":
      case "ACKNOWLEDGED":
        slaOnTrack += 1;
        break;
      case "UNTRACKED_LEGACY":
      case "NOT_APPLICABLE":
        // No promise was recorded, so there is nothing to be behind on. Kept
        // as its own count rather than folded into "on track", because a
        // workspace with a large untracked backlog should be able to see that
        // its SLA coverage is incomplete.
        slaUntracked += 1;
        break;
      default:
        break;
    }
  }

  // Built from `bounded` — the same array every counter above was derived
  // from — so `totalAffected(groups) === open` holds without a second read.
  const groups = projectConditionGroups(bounded);

  const clearVerdict = mayAssertOperationsClear({
    run,
    incidentReadComplete: complete,
    unresolvedCount: bounded.length,
  });

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
    unassigned,
    slaBreached,
    slaAtRisk,
    slaOnTrack,
    slaUntracked,
    groups,
    complete,
    // THE GATE. Every condition in one call, because the failure mode this
    // guards against is a caller that checks three of five and forgets the
    // rest. `complete` alone used to license the all-clear; it licensed it
    // over workspaces nothing had ever scanned.
    mayAssertAllClear: clearVerdict.clear,
    incompleteReason: complete ? null : "SCAN_BOUND_REACHED",
    readiness: run?.readiness ?? "NEVER_RUN",
    reconciliation: run,
    clearRefusalReason: clearVerdict.clear ? null : clearVerdict.reason,
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
    unassigned: 0,
    slaBreached: 0,
    slaAtRisk: 0,
    slaOnTrack: 0,
    slaUntracked: 0,
    groups: [],
    complete: false,
    mayAssertAllClear: false,
    incompleteReason: reason,
    // An unreadable summary knows nothing about discovery either. NEVER_RUN
    // is the honest floor: it is the state that refuses every reassuring
    // string, which is what an unknown workspace needs.
    readiness: "NEVER_RUN",
    reconciliation: null,
    clearRefusalReason: "NEVER_RUN",
  };
}
