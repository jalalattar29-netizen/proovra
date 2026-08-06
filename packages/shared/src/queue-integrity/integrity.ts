/**
 * PHASE 12 — POINT 5: registry self-checks and the operator diagnostics shape.
 *
 * Every rule here corresponds to one Point-5 completion metric, so the test
 * that calls `findRegistryIntegrityViolations` IS the measurement rather than a
 * paraphrase of it. The checks run as a test, not at import time: a malformed
 * registry should fail the build, not take down a booting worker.
 */

import {
  DLQ_QUEUE_NAMES,
  JOB_NAMES,
  QUEUE_FAMILIES,
  QUEUE_NAMES,
  SWEEP_NAMES,
  isKnownJobName,
  isKnownQueueName,
  isKnownSweepName,
  type QueueFamily,
} from "./names.js";
import {
  CANONICAL_PAYLOAD_SCHEMA_VERSION,
  FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS,
  type JobExecutionState,
} from "./payload.js";
import {
  CANONICAL_WORK_REGISTRY,
  DLQ_SINKS,
  type WorkRegistryEntry,
} from "./registry.js";

export type RegistryIntegrityViolation = {
  workName: string;
  rule: string;
  detail: string;
};

export function findRegistryIntegrityViolations(
  registry: ReadonlyArray<WorkRegistryEntry> = CANONICAL_WORK_REGISTRY,
): RegistryIntegrityViolation[] {
  const v: RegistryIntegrityViolation[] = [];
  const push = (workName: string, rule: string, detail: string) =>
    v.push({ workName, rule, detail });

  const seenNames = new Set<string>();
  const seenPrefixes = new Set<string>();
  const seenQueues = new Set<string>();

  for (const e of registry) {
    // -- identity ----------------------------------------------------------
    if (seenNames.has(e.workName)) {
      push(e.workName, "DuplicateProcessorImplementations", "work name registered more than once");
    }
    seenNames.add(e.workName);

    if (e.transport === "bullmq") {
      if (!isKnownJobName(e.workName)) {
        push(e.workName, "JobNameMismatches", "not declared in JOB_NAMES");
      }
      if (!e.queueName) {
        push(e.workName, "JobNameMismatches", "bullmq transport with no queue name");
      } else {
        if (!isKnownQueueName(e.queueName)) {
          push(e.workName, "JobNameMismatches", "queue name not declared in QUEUE_NAMES");
        }
        if (seenQueues.has(e.queueName)) {
          push(e.workName, "DuplicateHandlerRegistrations", `queue ${e.queueName} claimed by two entries`);
        }
        seenQueues.add(e.queueName);
      }
      if (!e.jobIdPrefix) {
        push(e.workName, "JobsWithoutDeterministicId", "bullmq job with no job-id prefix");
      } else if (seenPrefixes.has(e.jobIdPrefix)) {
        push(e.workName, "JobNameMismatches", `job id prefix "${e.jobIdPrefix}" is not unique`);
      } else {
        seenPrefixes.add(e.jobIdPrefix);
      }
    }

    if (e.transport === "db_outbox_sweep") {
      if (!isKnownSweepName(e.workName)) {
        push(e.workName, "UnregisteredDbSweeps", "not declared in SWEEP_NAMES");
      }
      if (e.queueName) {
        push(e.workName, "JobNameMismatches", "sweep must not declare a bullmq queue");
      }
      if (e.jobIdPrefix) {
        push(e.workName, "JobNameMismatches", "sweep must not declare a job-id prefix");
      }
    }

    // -- implementation state ---------------------------------------------
    if (e.implementation !== "CURRENT_RUNTIME") {
      push(e.workName, "TargetOnlyEntriesInClosureRegistry", `implementation is ${e.implementation}`);
    }

    // -- durable authority -------------------------------------------------
    if (!e.durableAuthority.model.trim()) {
      push(e.workName, "JobsWithoutDurableAuthority", "no durable authority model");
    }
    if (!e.durableAuthority.tenantSource.trim()) {
      push(e.workName, "JobsWithoutDurableAuthority", "no tenant derivation declared");
    }
    if (!e.durableAuthority.createdBySynchronousPath) {
      push(e.workName, "JobsWithoutDurableAuthority", "authority row is not created by an authorized synchronous path");
    }

    // -- ownership ---------------------------------------------------------
    for (const [field, label] of [
      [e.canonicalProducer, "canonicalProducer"],
      [e.canonicalProcessor, "canonicalProcessor"],
      [e.workerRegistration, "workerRegistration"],
      [e.terminalWriter, "terminalWriter"],
      [e.reconciler, "reconciler"],
    ] as const) {
      if (!field.trim()) {
        push(e.workName, "RegistryPhantomEntries", `${label} is empty`);
      }
    }

    // -- idempotency + claim ----------------------------------------------
    if (e.idempotency.length === 0) {
      push(e.workName, "JobsWithoutIdempotency", "no idempotency strategy declared");
    }
    if (!e.claim && !e.idempotency.includes("upsert_by_natural_key")) {
      push(
        e.workName,
        "JobsWithoutIdempotency",
        "no atomic claim, and the effect is not a natural-key upsert that converges on duplicate execution",
      );
    }

    // -- payload + retry ---------------------------------------------------
    if (e.schemaVersion !== CANONICAL_PAYLOAD_SCHEMA_VERSION) {
      push(e.workName, "UnversionedPayloads", `schemaVersion ${e.schemaVersion} is not canonical`);
    }
    if (e.retry.attempts < 1 || e.retry.timeoutMs < 1) {
      push(e.workName, "UnboundedRetryPolicy", "retry policy is not bounded");
    }
    if (
      e.recovery.strandedQueuedThresholdMs < 1 ||
      e.recovery.processingLeaseTimeoutMs < 1 ||
      e.recovery.reconcileBatchSize < 1
    ) {
      push(e.workName, "JobsWithoutReconciler", "recovery policy is not bounded");
    }
  }

  // -- family mapping ------------------------------------------------------
  const familyCounts = new Map<QueueFamily, number>();
  for (const f of QUEUE_FAMILIES) familyCounts.set(f, 0);
  for (const e of registry) {
    if (!familyCounts.has(e.family)) {
      push(e.workName, "UnclassifiedQueueEntries", `unknown family "${e.family}"`);
      continue;
    }
    familyCounts.set(e.family, familyCounts.get(e.family)! + 1);
    if (!e.familyReason.trim()) {
      push(e.workName, "UnclassifiedQueueEntries", "family assigned with no stated reason");
    }
  }
  for (const [family, count] of familyCounts) {
    if (count === 0) {
      push(family, "QueueFamilyCount", "family has no registered work");
    }
  }

  // -- conservation --------------------------------------------------------
  const bullmqJobNames = new Set(
    registry.filter((e) => e.transport === "bullmq").map((e) => e.workName),
  );
  for (const name of Object.values(JOB_NAMES)) {
    if (!bullmqJobNames.has(name)) {
      push(name, "UnregisteredBullMqJobs", "declared in JOB_NAMES but absent from the registry");
    }
  }

  const sweepNames = new Set(
    registry.filter((e) => e.transport === "db_outbox_sweep").map((e) => e.workName),
  );
  for (const name of Object.values(SWEEP_NAMES)) {
    if (!sweepNames.has(name)) {
      push(name, "UnregisteredDbSweeps", "declared in SWEEP_NAMES but absent from the registry");
    }
  }

  // Every declared queue is either processed by exactly one job or is a DLQ
  // sink. A queue that is neither is unregistered — the exact gap that lets a
  // producer write jobs nobody reads.
  const dlq = new Set<string>(DLQ_QUEUE_NAMES);
  const sinkNames = new Set(DLQ_SINKS.map((s) => s.queueName));
  for (const q of Object.values(QUEUE_NAMES)) {
    if (dlq.has(q)) {
      if (!sinkNames.has(q)) {
        push(q, "UnregisteredBullMqQueues", "DLQ queue with no registered sink");
      }
      continue;
    }
    if (!seenQueues.has(q)) {
      push(q, "UnregisteredBullMqQueues", "queue has no registered job");
    }
  }

  return v;
}

/**
 * Entries whose declared family is ambiguous because the same work name appears
 * under more than one family. Separate from the duplicate-name check so the
 * `JobsMappedToMultipleFamilies` metric reads directly.
 */
export function findJobsMappedToMultipleFamilies(
  registry: ReadonlyArray<WorkRegistryEntry> = CANONICAL_WORK_REGISTRY,
): string[] {
  const byName = new Map<string, Set<QueueFamily>>();
  for (const e of registry) {
    const set = byName.get(e.workName) ?? new Set<QueueFamily>();
    set.add(e.family);
    byName.set(e.workName, set);
  }
  return [...byName].filter(([, fams]) => fams.size > 1).map(([n]) => n);
}

// ===========================================================================
// Operator diagnostics
// ===========================================================================

/**
 * The bounded shape the operations surface may render for a unit of work.
 *
 * Deliberately narrow: no secret, no token, no raw PII, no storage credential,
 * no signed URL, and the workspace id only where the caller is already
 * authorized for that workspace. If a field is not in this type it does not
 * reach an operator screen.
 */
export type WorkDiagnosticsProjection = {
  commandId: string;
  traceId: string | null;
  family: QueueFamily;
  workName: string;
  queueName: string | null;
  state: JobExecutionState | string;
  attempt: number;
  queuedAgeMs: number | null;
  claimedAtUtc: string | null;
  leaseExpiresAtUtc: string | null;
  terminalReasonCode: string | null;
  nextAttemptAtUtc: string | null;
  reconcilerOutcome: string | null;
  duplicateReplayCount: number;
  providerDeliveryId: string | null;
  /** Only populated for callers already authorized on this workspace. */
  workspaceId: string | null;
};

export type QueueFamilyHealthProjection = {
  family: QueueFamily;
  workName: string;
  queuedCount: number;
  processingCount: number;
  stuckCount: number;
  oldestQueuedAgeMs: number | null;
  expiredLeaseCount: number;
  failedTerminalCount: number;
  unknownPendingReconciliationCount: number;
  duplicateReplayCount: number;
  lastReconciliationAtUtc: string | null;
  denialReasonCounts: Record<string, number>;
};

/**
 * Keys a diagnostics projection may never contain. Derived from the payload
 * catalog so a field added to one is automatically policed in the other.
 */
export const DIAGNOSTICS_FORBIDDEN_KEYS: ReadonlyArray<string> = [
  ...FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS.filter((f) => f !== "workspaceId"),
  "body",
  "payload",
  "message",
  "html",
  "responseBody",
];

/**
 * Strip anything a diagnostics consumer must never see.
 *
 * Applied at the projection boundary rather than trusted to callers: an
 * operator console that renders one unexpected field is a leak, and the set of
 * people who will ever add a field to a diagnostics row is larger than the set
 * who will read this comment.
 */
export function assertDiagnosticsSafe(row: Record<string, unknown>): void {
  const offending = Object.keys(row).filter((k) =>
    DIAGNOSTICS_FORBIDDEN_KEYS.some((f) => f.toLowerCase() === k.toLowerCase()),
  );
  if (offending.length > 0) {
    throw new Error(
      `diagnostics projection may not carry: ${offending.join(", ")}`,
    );
  }
}
