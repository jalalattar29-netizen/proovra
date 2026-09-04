/**
 * PHASE 5 §4 — HOW AN API REQUEST AND A WORKER RESULT FIND EACH OTHER.
 *
 * An operator replays a failed job. The API accepts it and the row says
 * `queued`; some time later the worker runs it and writes `completed` or
 * `error`. Those are two rows in an append-only log, written by two processes,
 * and unless they share a key the Admin audit can show both without anyone
 * being able to tell that the second is the outcome of the first.
 *
 * A generated correlation id would not work here: the API would have to hand
 * it to the worker through the job payload, and a job that is being RE-run
 * already exists — its payload was written before the replay was requested.
 *
 * So the correlation is DERIVED rather than generated. Both sides already hold
 * the queue name and the job id, so both can compute the same reference with
 * no channel between them and no change to any job payload. It is stable
 * across worker retries of the same job, which is what makes "this attempt is
 * a retry of that request" expressible at all.
 */

/** The `resourceType` both the API and the worker write for a queue job. */
export const QUEUE_JOB_RESOURCE_TYPE = "queue_job";

/**
 * The `resourceId` both sides derive.
 *
 * Bounded to the audit column's 128 characters. Queue names are short and job
 * ids are provider-generated, so the cap is a guard rather than a routine
 * truncation — but a silently over-long value would be rejected at the
 * database and lose the row, which is worse than a bounded one.
 */
export function queueJobCorrelationRef(queueName: string, jobId: string): string {
  const raw = `${queueName}:${jobId}`;
  return raw.length <= 128 ? raw : raw.slice(0, 128);
}

/** Split a correlation reference back into its parts, for readers. */
export function parseQueueJobCorrelationRef(
  ref: string,
): { queueName: string; jobId: string } | null {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { queueName: ref.slice(0, idx), jobId: ref.slice(idx + 1) };
}
