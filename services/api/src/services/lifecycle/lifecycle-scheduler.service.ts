/**
 * THE LIFECYCLE TICK (members audit LIFE-11, 2026-10-25).
 *
 * Account, organization and workspace closures used to execute only as a side
 * effect of the notification digest run: each processor sat in a `try {} catch
 * {}` with an EMPTY catch, after a schedule-schema check that could refuse the
 * whole run, so a closure could fail forever without a log line, a metric or a
 * retry — and stopped entirely whenever digests did.
 *
 * This is the one entry point for lifecycle execution. It is scheduled by the
 * worker (`lifecycle-sweep`, through `POST /v1/internal/lifecycle/run`) and is
 * still invoked by the digest run for continuity; both are safe at once,
 * because every request row is claimed by a guarded update and every closure
 * leg is idempotent. Each processor also carries its own REAPER for requests
 * an interrupted run left in PROCESSING.
 *
 * A failing processor is logged, counted and reported in the summary; it never
 * stops the processors after it.
 */
import { processAccountClosures } from "../identity/account-closure.service.js";
import { processOrganizationClosures } from "../organization/org-closure.service.js";
import { processWorkspaceClosures } from "../workspace/workspace-closure.service.js";
import { bump } from "../ops/metrics.service.js";
import { warn as logWarn } from "../../utils/logger.js";

/**
 * The registered work this module recovers (Point 5 recovery ownership):
 * `SWEEP_NAMES.LIFECYCLE`. Keys, not values — the shared registry owns the name.
 */
export const RECOVERED_WORK_TYPES = ["LIFECYCLE"] as const;

export type LifecycleTickSummary = {
  ranAt: string;
  processors: Record<"accountClosures" | "organizationClosures" | "workspaceClosures", "ok" | "failed">;
  failures: number;
};

export async function runLifecycleTick(now: Date = new Date()): Promise<LifecycleTickSummary> {
  const summary: LifecycleTickSummary = {
    ranAt: now.toISOString(),
    processors: { accountClosures: "ok", organizationClosures: "ok", workspaceClosures: "ok" },
    failures: 0,
  };
  const step = async (
    name: keyof LifecycleTickSummary["processors"],
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch (err) {
      summary.processors[name] = "failed";
      summary.failures += 1;
      bump("lifecycle_tick_processor_failed_total");
      logWarn("lifecycle.tick.processor_failed", {
        processor: name,
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  };
  await step("accountClosures", () => processAccountClosures(now));
  await step("organizationClosures", () => processOrganizationClosures(now));
  await step("workspaceClosures", () => processWorkspaceClosures(now));
  bump("lifecycle_tick_completed_total");
  return summary;
}
