/**
 * PLATFORM CONDITIONS — worker liveness and real queue failures, once each.
 *
 * WHY THIS EXISTS (OPS-001 / OPS-002 / OPS-009 / OPS-022)
 * -------------------------------------------------------
 * Workspace discovery used to invent platform health per tenant: a "queue
 * telemetry sampler delayed" condition measured from Home page loads, a
 * "queue retry storm" counted from re-observed workspace conditions, and one
 * copy of the global worker heartbeat per workspace. Meanwhile a real BullMQ
 * job that exhausted its retries reached no Operations surface at all.
 *
 * This module is the ONE writer of the platform's own conditions. It owns no
 * telemetry and no queue state: it ASKS the existing authorities —
 *
 *   * getWorkerFleetHealth   (worker-liveness.service)  — is a worker alive?
 *   * getQueueInventory / listFailedJobs (queue-inventory.service) — which
 *     queues have jobs that failed after exhausting their retries recently?
 *
 * — and records what they answer as PLATFORM-scoped conditions through the
 * canonical incident authority (`recordIncident({ platform: true })`), with a
 * STABLE fingerprint per fact, closing them through the same canonical
 * source-recovery resolver when the authority reports recovery. An authority
 * that cannot be read changes nothing: no open, no close.
 *
 * The jobs themselves stay in the queue console. A condition points there.
 */

import type { IncidentSeverity } from "@proovra/shared";
import { buildConditionMetric } from "@proovra/shared-runtime";

import {
  recordIncident,
  resolveConditionFromSourceRecovery,
} from "../observability/incident.service.js";
import type { SourceObservation } from "./operations-source-probes.js";

/** A job that exhausted its retries inside this window keeps a queue failing. */
export const QUEUE_FAILURE_WINDOW_MS = 60 * 60 * 1000;
/** At this many recent final failures on one queue the condition is HIGH. */
export const QUEUE_FAILURE_HIGH_COUNT = 5;

export const WORKER_HEARTBEAT_FINGERPRINT = "platform:worker_heartbeat_stale";
const QUEUE_FINGERPRINT_PREFIX = "platform:job_failure:";

export function queueFailureFingerprint(queueName: string): string {
  return `${QUEUE_FINGERPRINT_PREFIX}${queueName}`;
}

export function queueNameFromPlatformFingerprint(fingerprint: string): string | null {
  return fingerprint.startsWith(QUEUE_FINGERPRINT_PREFIX)
    ? fingerprint.slice(QUEUE_FINGERPRINT_PREFIX.length) || null
    : null;
}

/** The canonical worker-fleet verdict, as an observation. */
export async function observeWorkerFleetHeartbeat(now: Date): Promise<SourceObservation> {
  const { getWorkerFleetHealth } = await import("./worker-liveness.service.js");
  const fleet = await getWorkerFleetHealth({ nowMs: now.getTime() });
  const ageSeconds = fleet.lastHeartbeatAgeSeconds ?? null;
  const base = {
    observedAtUtc: now,
    currentValue: ageSeconds === null ? undefined : Math.round(ageSeconds / 60),
    thresholdValue: Math.round(fleet.staleAfterSeconds / 60),
    criticalThresholdValue: Math.round((fleet.staleAfterSeconds * 4) / 60),
    unit: "minutes" as const,
  };
  switch (fleet.state) {
    case "HEALTHY":
      return { ...base, activity: "RECOVERED" };
    case "STALE":
      return {
        ...base,
        activity: "ACTIVE",
        severity:
          ageSeconds !== null && ageSeconds > fleet.staleAfterSeconds * 4
            ? ("CRITICAL" as IncidentSeverity)
            : ("HIGH" as IncidentSeverity),
      };
    // Every instance recorded a clean shutdown: not a fault in itself, and
    // not proof of health either. NOT_MEASURED / UNAVAILABLE: unknown.
    default:
      return { ...base, activity: "UNKNOWN" };
  }
}

/** Final job failures on one queue inside the window, from the queue inventory. */
export async function observeQueueRecentFailures(
  queueName: string | null,
  now: Date,
): Promise<SourceObservation> {
  if (!queueName) return { activity: "NOT_APPLICABLE", observedAtUtc: now };
  const { listFailedJobs } = await import("./queue-inventory.service.js");
  const page = await listFailedJobs(queueName, 50);
  const since = now.getTime() - QUEUE_FAILURE_WINDOW_MS;
  const recent = page.jobs.filter((j) => j.failedAtUtc && Date.parse(j.failedAtUtc) >= since).length;
  return {
    activity: recent > 0 ? "ACTIVE" : "RECOVERED",
    observedAtUtc: now,
    currentValue: recent,
    thresholdValue: 1,
    criticalThresholdValue: QUEUE_FAILURE_HIGH_COUNT,
    unit: "items",
    truncated: page.jobs.length >= page.limit && recent >= page.limit,
    severity: (recent >= QUEUE_FAILURE_HIGH_COUNT ? "HIGH" : "WARNING") as IncidentSeverity,
  };
}

export type PlatformConditionsResult = {
  heartbeat: SourceObservation["activity"];
  queues: Record<string, SourceObservation["activity"]>;
  recorded: number;
  resolved: number;
};

/**
 * One pass over the platform's own conditions. Never throws: a failure to
 * read an authority leaves its condition exactly as it was.
 */
export async function reconcilePlatformConditions(
  options: { now?: Date } = {},
): Promise<PlatformConditionsResult> {
  const now = options.now ?? new Date();
  const result: PlatformConditionsResult = { heartbeat: "UNKNOWN", queues: {}, recorded: 0, resolved: 0 };

  // ---- worker liveness -----------------------------------------------------
  try {
    const hb = await observeWorkerFleetHeartbeat(now);
    result.heartbeat = hb.activity;
    if (hb.activity === "ACTIVE") {
      await recordIncident({
        sourceId: "platform.worker_heartbeat_stale",
        teamId: null,
        platform: true,
        category: "WORKER",
        severity: hb.severity ?? "HIGH",
        fingerprint: WORKER_HEARTBEAT_FINGERPRINT,
        title: "Worker heartbeat stale",
        safeSummary:
          "No live background worker has reported a heartbeat inside its liveness window. Report, package, anchoring and search work is not being processed.",
        runbookSlug: "worker-heartbeat-stale",
        metric: hb.currentValue === undefined
          ? undefined
          : buildConditionMetric({
              currentValue: hb.currentValue,
              thresholdValue: hb.thresholdValue ?? 0,
              criticalThresholdValue: hb.criticalThresholdValue ?? null,
              unit: "minutes",
              observedAtUtc: now,
              truncated: false,
              affectedEntityType: null,
            }),
      });
      result.recorded += 1;
    } else if (hb.activity === "RECOVERED") {
      const r = await resolveConditionFromSourceRecovery({
        teamId: null,
        platform: true,
        fingerprint: WORKER_HEARTBEAT_FINGERPRINT,
        safeMessage: "A live background worker reported a heartbeat inside its liveness window. Resolved from the worker-fleet liveness authority.",
      });
      if (r.resolved) result.resolved += 1;
    }
  } catch {
    result.heartbeat = "UNKNOWN";
  }

  // ---- queues --------------------------------------------------------------
  let queueNames: Array<{ name: string; label: string; health: string }> = [];
  try {
    const { getQueueInventory } = await import("./queue-inventory.service.js");
    queueNames = (await getQueueInventory()).map((q) => ({ name: q.queueName, label: q.label, health: q.health }));
  } catch {
    queueNames = [];
  }
  for (const q of queueNames) {
    // An unreachable or unprobed queue is unknown, never healthy.
    if (q.health === "outage" || q.health === "unknown" || q.health === "disabled" || q.health === "unconfigured") {
      result.queues[q.name] = "UNKNOWN";
      continue;
    }
    try {
      const obs = await observeQueueRecentFailures(q.name, now);
      result.queues[q.name] = obs.activity;
      const fingerprint = queueFailureFingerprint(q.name);
      if (obs.activity === "ACTIVE") {
        await recordIncident({
          sourceId: "job.background_failure",
          teamId: null,
          platform: true,
          category: "WORKER",
          severity: obs.severity ?? "WARNING",
          fingerprint,
          title: `Background jobs failing: ${q.label}`.slice(0, 180),
          safeSummary: `Jobs on the ${q.label} queue failed after exhausting their retries within the last hour. Inspect and replay eligible jobs in the platform queue console.`,
          relatedJobId: q.name,
          runbookSlug: "queue-failed-jobs",
          metric: buildConditionMetric({
            currentValue: obs.currentValue ?? 0,
            thresholdValue: 1,
            criticalThresholdValue: QUEUE_FAILURE_HIGH_COUNT,
            unit: "items",
            observedAtUtc: now,
            truncated: obs.truncated === true,
            affectedEntityType: null,
          }),
        });
        result.recorded += 1;
      } else if (obs.activity === "RECOVERED") {
        const r = await resolveConditionFromSourceRecovery({
          teamId: null,
          platform: true,
          fingerprint,
          safeMessage: `No job on the ${q.label} queue has failed after exhausting its retries within the last hour. Resolved from the queue inventory.`,
        });
        if (r.resolved) result.resolved += 1;
      }
    } catch {
      result.queues[q.name] = "UNKNOWN";
    }
  }
  return result;
}
