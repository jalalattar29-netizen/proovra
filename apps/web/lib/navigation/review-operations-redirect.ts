/**
 * Team remediation T-007 — where a retired `/review/operations` link lands:
 * the review Inbox, on the queue matching the stage filter it carried.
 */
/** The old stage filter → the Inbox queue that shows the same reviews. */
const STAGE_TO_QUEUE: Readonly<Record<string, string>> = {
  QUEUED: "UNASSIGNED",
  ASSIGNED: "MY_REVIEWS",
  IN_REVIEW: "MY_REVIEWS",
  ESCALATED: "ESCALATED",
  APPROVED_INTERNAL: "COMPLETED_RECENTLY",
  REJECTED_INSUFFICIENT: "COMPLETED_RECENTLY",
  CLOSED: "COMPLETED_RECENTLY",
};

export function reviewOperationsRedirectTarget(params: Record<string, string | string[] | undefined>): string {
  const raw = params.stage ?? params.queue;
  const stage = (Array.isArray(raw) ? raw[0] : raw)?.toUpperCase() ?? "";
  const queue = STAGE_TO_QUEUE[stage];
  return queue ? `/review/queues?queue=${encodeURIComponent(queue)}` : "/review";
}
