/**
 * PHASE 12 — POINT 5: the worker's ONE processor entry point.
 *
 * Every BullMQ processor begins the same way and it is worth having that
 * beginning in one place, because the interesting part is what it REFUSES:
 *
 *   1. Decode strictly. An unknown field, an unknown schema version, a
 *      malformed traceparent or a missing reference is a rejection — and the
 *      rejection happens before any database call, so a tampered payload
 *      causes exactly zero mutation.
 *   2. Report what a draining legacy job tried to assert. Authority-shaped
 *      fields that rode along on a pre-Point-5 payload are logged BY NAME and
 *      their values are unreachable.
 *   3. Hand back the reference and nothing else. The processor's next move is
 *      to load the durable row and derive tenant, policy and lifecycle state
 *      from it.
 *
 * A rejection is deliberately NON-retryable. A payload that cannot be decoded
 * will not decode on the fifth attempt either; retrying it burns the queue's
 * attempt budget and hides the event behind a wall of identical failures. The
 * counter incremented here is what an operator alerts on.
 */

import {
  LegacyJobQuarantined,
  QueuePayloadRejected,
  decodeJobPayload,
  getWorkEntryOrThrow,
  type WorkName,
  type WorkRegistryEntry,
} from "@proovra/shared";

import { bump } from "@proovra/shared-runtime/ops";

import { logger } from "./logger.js";

export type JobLike = {
  id?: string | number | null;
  name?: string | null;
  data: unknown;
  attemptsMade?: number;
};

export type CanonicalJobContext = {
  entry: WorkRegistryEntry;
  /** The durable authority row's id. The only value a processor may believe. */
  commandId: string;
  traceId: string;
  traceparent: string | null;
  legacy: boolean;
  requestId: string;
  attempt: number;
};

/**
 * A payload this worker refuses to run.
 *
 * `retryable: false` is carried explicitly rather than implied so the caller's
 * error handling does not have to special-case the class.
 */
export class UnprocessableJobPayload extends Error {
  readonly code: string;
  readonly retryable = false as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UnprocessableJobPayload";
    this.code = code;
  }
}

/**
 * Decode a job for a registered unit of work.
 *
 * Throws `UnprocessableJobPayload` on any rejection. Callers that must not fail
 * the BullMQ job (a processor whose queue has no DLQ) catch it and complete
 * with a bounded terminal outcome; callers that want the job to land in the
 * dead-letter queue let it propagate.
 */
export function decodeCanonicalJob(
  workName: WorkName,
  job: JobLike,
  options: { requestId: string },
): CanonicalJobContext {
  const entry = getWorkEntryOrThrow(workName);
  const attempt = (job.attemptsMade ?? 0) + 1;

  // A job that arrived on the right queue under the WRONG name is not a
  // decoding problem — it means a producer is writing to a queue it does not
  // own, and running it would apply one family's processor to another's
  // reference.
  if (job.name && job.name !== entry.workName) {
    bump("queue_job_name_mismatch_total");
    logger.error(
      {
        requestId: options.requestId,
        jobId: job.id ?? null,
        expected: entry.workName,
        received: job.name,
        event: "queue.job_name_mismatch",
      },
      "queue.job_name_mismatch",
    );
    throw new UnprocessableJobPayload(
      "job_name_mismatch",
      `${entry.workName}: job arrived named "${job.name}"`,
    );
  }

  let decoded;
  try {
    decoded = decodeJobPayload(
      { jobName: entry.workName, schemaVersion: entry.schemaVersion },
      job.data,
    );
  } catch (err) {
    // A quarantined legacy job is NOT a malformed payload and must not be
    // counted as one. It is a job that was legitimately produced before its
    // durable authority row was mandatory, and it cannot be run without
    // inventing the authority it never carried. It propagates so the processor
    // can dead-letter it with a bounded reason — visible to an operator,
    // replayable through the authorized route, and producing no side effect on
    // the way out.
    if (err instanceof LegacyJobQuarantined) {
      bump("queue_legacy_quarantined_total");
      logger.error(
        {
          requestId: options.requestId,
          jobId: job.id ?? null,
          workName: entry.workName,
          reason: err.reason,
          // NAMES only, as everywhere else.
          discardedAuthorityFields: err.discardedAuthorityFields,
          event: "queue.legacy_job_quarantined",
        },
        "queue.legacy_job_quarantined",
      );
      throw err;
    }
    const code =
      err instanceof QueuePayloadRejected ? err.code : "malformed_payload";
    const offending =
      err instanceof QueuePayloadRejected ? err.offendingFields : [];
    bump("queue_payload_rejected_total");
    if (code === "unknown_schema_version" || code === "unversioned_payload") {
      bump("queue_schema_version_rejected_total");
    }
    logger.error(
      {
        requestId: options.requestId,
        jobId: job.id ?? null,
        workName: entry.workName,
        code,
        // NAMES only. The values are never read and never logged.
        offendingFields: offending,
        event: "queue.payload_rejected",
      },
      "queue.payload_rejected",
    );
    throw new UnprocessableJobPayload(
      code,
      `${entry.workName}: payload rejected (${code})`,
    );
  }

  if (decoded.legacy) {
    bump("queue_legacy_payload_total");
    logger.warn(
      {
        requestId: options.requestId,
        jobId: job.id ?? null,
        workName: entry.workName,
        // What the old payload TRIED to assert, by name. Every one of these
        // was discarded before this line ran.
        discardedAuthorityFields: decoded.discardedAuthorityFields,
        event: "queue.legacy_payload_drained",
      },
      "queue.legacy_payload_drained",
    );
  }

  return {
    entry,
    commandId: decoded.commandId,
    traceId: decoded.traceId,
    traceparent: decoded.traceparent,
    legacy: decoded.legacy,
    requestId: options.requestId,
    attempt,
  };
}

/**
 * Resolve a workspace id into a workspace that is actually allowed to be
 * worked on, or null.
 *
 * Several units of work — the four graph syncs and the organization-health
 * refresh — address a WORKSPACE rather than a row inside one. Their command id
 * is therefore a workspace id, and the temptation is to treat that as
 * "payload-trusted tenancy". It is not the same thing, and the difference is
 * what this function makes true: the id is a REFERENCE that must resolve to a
 * live row before anything happens, and lifecycle is re-read from the
 * organization at run time.
 *
 * A tampered id is bounded rather than escalating: it can only cause another
 * workspace's own projection to be rebuilt from that workspace's own
 * authoritative rows. It moves no data across a tenant boundary, grants
 * nothing, and is idempotent. What it must NOT be able to do is run against a
 * suspended organization, and that is exactly what the status check below
 * refuses.
 */
export async function resolveActiveWorkspace(
  prisma: {
    team: {
      findUnique(args: unknown): Promise<{ id: string; organizationId: string } | null>;
    };
    organization: {
      findUnique(args: unknown): Promise<{ id: string; status: string } | null>;
    };
  },
  workspaceId: string,
): Promise<{ workspaceId: string; organizationId: string } | null> {
  const workspace = await prisma.team.findUnique({
    where: { id: workspaceId },
    select: { id: true, organizationId: true },
  });
  if (!workspace) return null;

  // Lifecycle lives on the Organization: a Team has no status column of its
  // own, and every Team belongs to exactly one Organization. Suspension is
  // applied there, so that is where it must be read.
  const organization = await prisma.organization.findUnique({
    where: { id: workspace.organizationId },
    select: { id: true, status: true },
  });
  if (!organization || organization.status !== "ACTIVE") return null;

  return {
    workspaceId: workspace.id,
    organizationId: organization.id,
  };
}

/**
 * Deny a job whose durable row resolves to a workspace the row itself does not
 * agree on.
 *
 * Two ids are compared, both loaded from persistence — never one from the wire.
 * A processor calls this after loading its authority row and the row's related
 * entity, to catch a target that was moved or rebound between enqueue and
 * execution.
 */
export function assertSameWorkspace(input: {
  workName: string;
  requestId: string;
  authorityWorkspaceId: string | null | undefined;
  targetWorkspaceId: string | null | undefined;
}): string {
  const a = input.authorityWorkspaceId ?? null;
  const b = input.targetWorkspaceId ?? null;
  if (!a || !b || a !== b) {
    bump("queue_workspace_mismatch_total");
    logger.error(
      {
        requestId: input.requestId,
        workName: input.workName,
        // Whether each side resolved, not which workspace: a mismatch log is
        // read by operators across tenants.
        authorityResolved: !!a,
        targetResolved: !!b,
        event: "queue.workspace_mismatch",
      },
      "queue.workspace_mismatch",
    );
    throw new UnprocessableJobPayload(
      "workspace_mismatch",
      `${input.workName}: authority row and target disagree on workspace`,
    );
  }
  return a;
}
