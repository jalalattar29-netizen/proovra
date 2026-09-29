/**
 * ET-Q-09 — what the worker's job-event handlers log and how they classify a
 * failure. Separate from index.ts (which boots the runtime on import) so the
 * rules are testable.
 */

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

/**
 * The OTS processor throws OTS_UPGRADE_ATTEMPT_FAILED for a transient calendar
 * failure (the attempt is recorded and BullMQ retries). The classifier keyed on
 * "NOT_ANCHORED_YET", which nothing throws any more, so every transient attempt
 * raised Sentry and an ots-upgrade_job_failed operational alert — up to 20 per
 * job. A pending retry is a pending retry until the LAST attempt, which is a
 * real failure.
 */
export const OTS_PENDING_RETRY_CODES: ReadonlySet<string> = new Set([
  "OTS_UPGRADE_ATTEMPT_FAILED",
  "NOT_ANCHORED_YET",
]);

export function isExpectedOtsPendingError(
  jobKind: string,
  err: unknown,
  job?: { attemptsMade: number; opts?: { attempts?: number } },
): boolean {
  if (jobKind !== "ots-upgrade") return false;
  if (!OTS_PENDING_RETRY_CODES.has(errorMessage(err).trim())) return false;
  const attempts = job?.opts?.attempts ?? 1;
  return job ? job.attemptsMade < attempts : true;
}

/**
 * The canonical payload carries commandId (the durable row the job acts on),
 * never evidenceId, so logs and Sentry read that. A legacy payload's
 * evidenceId is used only when there is no commandId.
 */
export function jobCommandId(job: { data?: unknown }): string | undefined {
  const d = (job.data ?? {}) as { commandId?: unknown; evidenceId?: unknown };
  if (typeof d.commandId === "string" && d.commandId) return d.commandId;
  return typeof d.evidenceId === "string" && d.evidenceId ? d.evidenceId : undefined;
}

/** A job that has spent its last attempt: BullMQ will not run it again. */
export function isFinalAttempt(job: { attemptsMade: number; opts?: { attempts?: number } }): boolean {
  return job.attemptsMade >= (job.opts?.attempts ?? 1);
}

/** An error's own code (never its message or stack), bounded, for a DLQ record. */
export function boundedErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return String((err as { code: string }).code).slice(0, 64);
  }
  if (err instanceof Error && /^[A-Z0-9_:.-]{1,64}$/.test(err.message.trim())) return err.message.trim();
  return err instanceof Error ? err.name.slice(0, 64) : "UNKNOWN";
}
