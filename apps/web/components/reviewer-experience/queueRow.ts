/**
 * THE QUEUE ROW, READ FROM WHAT THE API SENDS (RT-019, TEAM-SPEC §3).
 *
 * `GET /v1/reviewer-ops/queue` — and the `queue` / `mine` sections of
 * `GET /v1/reviewer-ops/console`, which reuse the same service — return the
 * reviewer-ops workflow projection: `workflowId`, `lifecycleState`, and a
 * `legacy` block carrying the stage and due date.
 *
 * Two pages read that payload. `/review/queues` mapped it here; the `/review`
 * console read `id`, `stage`, `status` and `dueAtUtc` straight off the object.
 * None of those exist there, so the console showed "—" for Stage, Status and
 * Due, disabled every row checkbox and left the a/e/m shortcuts dead. Both
 * pages now map rows once, through this function, so they render one known
 * shape.
 */
export type QueueRow = {
  /** The workflow id (`workflowId` on the wire). */
  id: string;
  evidenceId: string;
  /** Lifecycle state (`lifecycleState` on the wire), e.g. ASSIGNED. */
  status: string;
  /** Review stage (`legacy.stage`), e.g. FIRST_REVIEW; null when absent. */
  stage: string | null;
  priority: string;
  assignedToUserId: string | null;
  /** Due date (`legacy.dueAt`); null when the workflow has none. */
  dueAt: string | null;
  /** SLA rollup (`slaRollupState`); null when the projection omits it. */
  slaState: string | null;
  /**
   * T-086 (stage D) — the assignee as the server names them (display name or
   * masked e-mail); null when unassigned or when an older API omits it.
   */
  assignee: { displayName: string | null; maskedEmail: string | null } | null;
};

export type QueueProjection = {
  workflowId: string;
  evidenceId: string;
  lifecycleState: string;
  priority: string;
  assignedToUserId: string | null;
  slaRollupState?: string | null;
  legacy?: { dueAt?: string | null; stage?: string | null } | null;
  assignee?: { displayName?: string | null; maskedEmail?: string | null } | null;
};

export function toQueueRow(projection: QueueProjection): QueueRow {
  return {
    id: projection.workflowId,
    evidenceId: projection.evidenceId,
    status: projection.lifecycleState,
    stage: projection.legacy?.stage ?? null,
    priority: projection.priority,
    assignedToUserId: projection.assignedToUserId ?? null,
    dueAt: projection.legacy?.dueAt ?? null,
    slaState: projection.slaRollupState ?? null,
    assignee: projection.assignee
      ? {
          displayName: typeof projection.assignee.displayName === "string" ? projection.assignee.displayName : null,
          maskedEmail: typeof projection.assignee.maskedEmail === "string" ? projection.assignee.maskedEmail : null,
        }
      : null,
  };
}

/** Map a list, dropping anything that is not a workflow projection. */
export function toQueueRows(rows: ReadonlyArray<unknown> | null | undefined): QueueRow[] {
  if (!Array.isArray(rows)) return [];
  const out: QueueRow[] = [];
  for (const raw of rows) {
    const r = raw as Partial<QueueProjection> | null;
    if (!r || typeof r.workflowId !== "string" || r.workflowId.length === 0) continue;
    out.push(
      toQueueRow({
        workflowId: r.workflowId,
        evidenceId: typeof r.evidenceId === "string" ? r.evidenceId : "",
        lifecycleState: typeof r.lifecycleState === "string" ? r.lifecycleState : "",
        priority: typeof r.priority === "string" ? r.priority : "",
        assignedToUserId: typeof r.assignedToUserId === "string" ? r.assignedToUserId : null,
        slaRollupState: typeof r.slaRollupState === "string" ? r.slaRollupState : null,
        legacy: r.legacy ?? null,
        assignee: r.assignee && typeof r.assignee === "object" ? r.assignee : null,
      }),
    );
  }
  return out;
}

/** Lifecycle states in which no inline action is offered. */
export const TERMINAL_QUEUE_STATES: ReadonlySet<string> = new Set([
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
  "CANCELLED",
  "CLOSED",
]);

export function isQueueRowActionable(row: QueueRow): boolean {
  return row.id.length > 0 && !TERMINAL_QUEUE_STATES.has(row.status.toUpperCase());
}
