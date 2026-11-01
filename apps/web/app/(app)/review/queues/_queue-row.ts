/**
 * THE QUEUE ROW, READ FROM WHAT THE API SENDS (RT-019).
 *
 * `GET /v1/reviewer-ops/queue` returns the reviewer-ops workflow projection:
 * `workflowId`, `lifecycleState`, and a `legacy` block carrying the due date.
 * This page read `id`, `status` and `dueAt` straight off that object. None of
 * them exist there, so the first populated queue threw on `r.id.slice`, which
 * is why only a viewer with rows saw the crash. The rows are mapped once, here,
 * so the table renders one known shape.
 */
export type QueueRow = {
  id: string;
  evidenceId: string;
  status: string;
  priority: string;
  assignedToUserId: string | null;
  dueAt: string | null;
};

type QueueProjection = {
  workflowId: string;
  evidenceId: string;
  lifecycleState: string;
  priority: string;
  assignedToUserId: string | null;
  legacy?: { dueAt?: string | null } | null;
};

export function toQueueRow(projection: QueueProjection): QueueRow {
  return {
    id: projection.workflowId,
    evidenceId: projection.evidenceId,
    status: projection.lifecycleState,
    priority: projection.priority,
    assignedToUserId: projection.assignedToUserId ?? null,
    dueAt: projection.legacy?.dueAt ?? null,
  };
}
