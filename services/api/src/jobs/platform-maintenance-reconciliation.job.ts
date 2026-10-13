/**
 * THE SCHEDULED PLATFORM MAINTENANCE SWEEP.
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * Two cron-secret routes carry recurring platform maintenance:
 *
 *   * `POST /v1/ops/reconcile`         -> `runMasterReconcile` (step-up and
 *     trusted-device TTL expiry, stuck-QUEUED communication cancellation, the
 *     multipart + upload-session reapers, graph reconcile, and the gauges
 *     `/v1/ops/metrics` reports);
 *   * `POST /v1/reliability/reconcile` -> `reconcileUploads` (STALLED /
 *     ABANDONED upload-session transitions and the SIGNED-but-object-missing
 *     REVIEW_REQUIRED flag).
 *
 * Nothing in the deployment called either route: no compose sidecar, no
 * scheduled workflow, and no worker scheduler. Their work ran only when a
 * human remembered to POST them. This sweep runs the SAME functions the routes
 * call, in-process, on the API's existing scheduler (the `setInterval` block in
 * `server.ts` that already drives the Operations and billing sweeps). It is
 * not a second implementation and not an HTTP self-call; the routes stay as
 * the manual trigger.
 *
 * OVERLAP
 * ---------------------------------------------------------------------------
 * Each step runs under the API's existing lease (`withLease`, Redis
 * `SET NX PX` with a per-holder token, falling back to process memory when
 * Redis is unavailable). A tick that finds the lease held skips that step; a
 * second replica, or a slow previous tick in this process, therefore never
 * runs the same step concurrently. The lease is released when the step
 * finishes; its TTL only bounds a holder that died mid-run, so a crash costs
 * at most one TTL of skipped ticks, never the schedule.
 *
 * FAILURE ISOLATION
 * ---------------------------------------------------------------------------
 *   * each step has its own try/catch: a failed master reconcile does not
 *     stop the upload reconcile on the same tick, and vice versa;
 *   * `runPlatformMaintenanceSweepSafe` never rejects, so the interval
 *     callback can never surface an unhandled rejection and the timer keeps
 *     firing; the next tick IS the retry (both steps are idempotent and
 *     bounded per call).
 */

import type { ReconcileStalledSummary } from "../services/reliability/upload-reconciliation.service.js";
import type { ReconcileSummary } from "../routes/ops.routes.js";

/** Default cadence. Matches the 5-minute granularity runMasterReconcile's own
 *  "QUEUED for more than 5 minutes" cancellation is written against. */
export const PLATFORM_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

/** Lease TTL per step: longer than any bounded step, short enough that a
 *  crashed holder frees the step within two ticks. */
export const PLATFORM_MAINTENANCE_LEASE_TTL_MS = 10 * 60 * 1000;

export const OPS_MASTER_RECONCILE_LEASE_KEY = "cron:ops-master-reconcile";
export const RELIABILITY_UPLOAD_RECONCILE_LEASE_KEY =
  "cron:reliability-upload-reconcile";

export type PlatformMaintenanceStepOutcome<T> =
  | { status: "completed"; summary: T; durationMs: number }
  | { status: "skipped_locked"; durationMs: number }
  | { status: "failed"; error: string; durationMs: number };

export type PlatformMaintenanceSweepResult = {
  trigger: string;
  masterReconcile: PlatformMaintenanceStepOutcome<ReconcileSummary>;
  uploadReconcile: PlatformMaintenanceStepOutcome<ReconcileStalledSummary>;
};

type SweepLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type PlatformMaintenanceDeps = {
  runMasterReconcile: () => Promise<ReconcileSummary>;
  reconcileUploads: () => Promise<ReconcileStalledSummary>;
  withLease: <T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
    onBusy: () => T | Promise<T>,
  ) => Promise<T>;
  captureException?: (err: unknown, context?: Record<string, unknown>) => void;
  logger?: SweepLogger;
};

async function defaultDeps(): Promise<PlatformMaintenanceDeps> {
  const [{ runMasterReconcile }, { reconcileUploads }, { withLease }, { captureException }] =
    await Promise.all([
      import("../routes/ops.routes.js"),
      import("../services/reliability/upload-reconciliation.service.js"),
      import("../services/rate-limit.js"),
      import("../observability/sentry.js"),
    ]);
  return {
    runMasterReconcile,
    reconcileUploads: () => reconcileUploads({}),
    withLease,
    captureException,
  };
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return "unknown";
}

async function runStep<T>(
  step: string,
  leaseKey: string,
  fn: () => Promise<T>,
  deps: PlatformMaintenanceDeps,
  trigger: string,
): Promise<PlatformMaintenanceStepOutcome<T>> {
  const startedAt = Date.now();
  try {
    const outcome = await deps.withLease<PlatformMaintenanceStepOutcome<T>>(
      leaseKey,
      PLATFORM_MAINTENANCE_LEASE_TTL_MS,
      async () => ({
        status: "completed",
        summary: await fn(),
        durationMs: Date.now() - startedAt,
      }),
      () => ({ status: "skipped_locked", durationMs: Date.now() - startedAt }),
    );
    if (outcome.status === "completed") {
      deps.logger?.info(
        { step, trigger, durationMs: outcome.durationMs, summary: outcome.summary },
        "platform_maintenance.step_completed",
      );
    } else {
      deps.logger?.info({ step, trigger }, "platform_maintenance.step_skipped_locked");
    }
    return outcome;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    deps.logger?.error(
      { step, trigger, durationMs, err },
      "platform_maintenance.step_failed",
    );
    try {
      deps.captureException?.(err, { job: "platform_maintenance", step, trigger });
    } catch {
      /* reporting must never fail the sweep */
    }
    return { status: "failed", error: safeErrorMessage(err), durationMs };
  }
}

/** One tick: master reconcile, then upload reconcile, each isolated. */
export async function runPlatformMaintenanceSweep(
  options: { trigger?: "scheduler" | "startup" | "cli" } = {},
  injected?: Partial<PlatformMaintenanceDeps>,
): Promise<PlatformMaintenanceSweepResult> {
  const fullyInjected = Boolean(
    injected?.runMasterReconcile && injected.reconcileUploads && injected.withLease,
  );
  const deps = {
    ...(fullyInjected ? {} : await defaultDeps()),
    ...injected,
  } as PlatformMaintenanceDeps;
  const trigger = options.trigger ?? "scheduler";

  const masterReconcile = await runStep(
    "ops_master_reconcile",
    OPS_MASTER_RECONCILE_LEASE_KEY,
    deps.runMasterReconcile,
    deps,
    trigger,
  );
  const uploadReconcile = await runStep(
    "reliability_upload_reconcile",
    RELIABILITY_UPLOAD_RECONCILE_LEASE_KEY,
    deps.reconcileUploads,
    deps,
    trigger,
  );
  return { trigger, masterReconcile, uploadReconcile };
}

/** Never-rejecting wrapper for the interval timer. */
export async function runPlatformMaintenanceSweepSafe(
  options: { trigger?: "scheduler" | "startup" | "cli" } = {},
  injected?: Partial<PlatformMaintenanceDeps>,
): Promise<PlatformMaintenanceSweepResult | null> {
  try {
    return await runPlatformMaintenanceSweep(options, injected);
  } catch (err) {
    try {
      injected?.logger?.error({ err }, "platform_maintenance.sweep_failed");
    } catch {
      /* never rethrow from the timer path */
    }
    return null;
  }
}
