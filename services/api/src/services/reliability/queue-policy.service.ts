/**
 * Phase 12 — Queue policy documentation + inspection.
 *
 * The actual queue retry settings live in the worker package
 * (`services/worker/src/queue.ts`). This module is the canonical
 * description of those settings as the API understands them, so the
 * reliability UI can render a stable + accurate picture without
 * cross-loading worker code into the API binary.
 *
 * If queue settings in the worker change, update the constants here.
 * A test in services/api/test/reliability.test.ts asserts the worker
 * source file still contains the documented attempts/backoff strings
 * so this stays in sync.
 */

export type QueuePolicy = {
  queueName: string;
  attempts: number;
  /** Initial backoff delay in milliseconds. */
  backoffInitialMs: number;
  backoffType: "exponential" | "fixed";
  /** Whether failed jobs are retained for inspection. */
  retainFailed: boolean;
  /** Optional dedicated DLQ name (Phase 10 / Phase 12 — only report uses one today). */
  deadLetterQueue: string | null;
  /**
   * Operational note for the reliability UI. Plain English, no
   * internal jargon — operators read this.
   */
  notes: string;
};

export const REPORT_QUEUE_POLICY: QueuePolicy = {
  queueName: "report",
  attempts: 5,
  backoffInitialMs: 1000,
  backoffType: "exponential",
  retainFailed: true,
  deadLetterQueue: "report-dlq",
  notes:
    "Report generation jobs retry up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s). Repeatedly failing jobs land on report-dlq for operator triage; failed jobs are NOT auto-deleted.",
};

export const OTS_UPGRADE_QUEUE_POLICY: QueuePolicy = {
  queueName: "ots-upgrade",
  attempts: 20,
  backoffInitialMs: 60_000,
  backoffType: "exponential",
  retainFailed: true,
  deadLetterQueue: null,
  notes:
    "OTS upgrade jobs retry up to 20 times with exponential backoff starting at 60s. Bitcoin anchoring is inherently slow, so attempts are high. Failed jobs remain in the failed state for operator inspection (no auto-deletion).",
};

export const EVIDENCE_PURGE_QUEUE_POLICY: QueuePolicy = {
  queueName: "evidence-purge",
  attempts: 5,
  backoffInitialMs: 60_000,
  backoffType: "exponential",
  retainFailed: true,
  deadLetterQueue: null,
  notes:
    "Soft-deleted evidence purge runs up to 5 times with 60s exponential backoff. Failed purges are surfaced for operator review and never silently dropped.",
};

export function listQueuePolicies(): QueuePolicy[] {
  return [
    REPORT_QUEUE_POLICY,
    OTS_UPGRADE_QUEUE_POLICY,
    EVIDENCE_PURGE_QUEUE_POLICY,
  ];
}
