/**
 * Phase 32.8C+++++++ — Telemetry health evaluator.
 *
 * Reads the freshest WorkerTelemetrySnapshot + QueueTelemetrySnapshot
 * rows and returns a deterministic OpsHealthState — distinguishing
 * "worker silent for 12 min" (STALE) from "worker process dead"
 * (UNAVAILABLE) from "no rows ever written" (DISCONNECTED).
 *
 * Hard rules:
 *   - Never throws. A read failure returns `UNAVAILABLE` with
 *     `recoverable: true`, NOT a thrown exception.
 *   - Bounded reads.
 *   - The canonical source check (worker process via heartbeat row)
 *     is what lets us tell STALE apart from FAILED.
 */

import { getWorkerFleetHealth } from "../operations/worker-liveness.service.js";
import type { OpsHealthState } from "./types.js";
import { severityForStatus } from "./types.js";

/**
 * OPS-001 / OPS-009 — ONE liveness authority.
 *
 * This evaluator used to run its own heartbeat detector (10-minute
 * thresholds, beside the 15-minute Operations probe and the canonical
 * 180-second fleet authority) and to grade `QueueTelemetrySnapshot` rows
 * WHERE teamId = the workspace — rows that only a Home page load ever wrote.
 * It now asks the canonical worker-fleet authority and answers in coarse,
 * customer-safe words: no worker ids, no ages, no queue internals. The
 * `teamId` is accepted for contract compatibility and is deliberately not
 * read, because background-processing health has no workspace.
 */
export async function evaluateTelemetryHealth(_input: {
  teamId: string;
}): Promise<OpsHealthState> {
  let fleet: Awaited<ReturnType<typeof getWorkerFleetHealth>>;
  try {
    fleet = await getWorkerFleetHealth();
  } catch {
    return finalize({
      status: "UNAVAILABLE",
      reason: "Background-processing health could not be read on this cycle. It will be checked again; nothing about your records has changed.",
      recoverable: true,
      lastSuccessfulRunAt: null,
      retrying: true,
      degradedSince: null,
      canonicalSourceHealthy: false,
    });
  }
  switch (fleet.state) {
    case "HEALTHY":
      return finalize({
        status: "HEALTHY",
        reason: "Background processing is running.",
        recoverable: true,
        lastSuccessfulRunAt: fleet.lastHeartbeatAtUtc,
        retrying: false,
        degradedSince: null,
        canonicalSourceHealthy: true,
      });
    case "STALE":
      return finalize({
        status: "STALE",
        reason: "Background processing is delayed. Queued work is kept and continues when processing recovers; the platform team is alerted.",
        recoverable: true,
        lastSuccessfulRunAt: fleet.lastHeartbeatAtUtc,
        retrying: true,
        degradedSince: fleet.lastHeartbeatAtUtc,
        canonicalSourceHealthy: false,
      });
    case "STOPPED":
    case "NOT_MEASURED":
      return finalize({
        status: "DISCONNECTED",
        reason: "Background processing has not reported in yet. Queued work is kept.",
        recoverable: true,
        lastSuccessfulRunAt: fleet.lastHeartbeatAtUtc,
        retrying: false,
        degradedSince: null,
        canonicalSourceHealthy: false,
      });
    default:
      return finalize({
        status: "UNAVAILABLE",
        reason: "Background-processing health could not be read on this cycle. It will be checked again; nothing about your records has changed.",
        recoverable: true,
        lastSuccessfulRunAt: null,
        retrying: true,
        degradedSince: null,
        canonicalSourceHealthy: false,
      });
  }
}

function finalize(input: Omit<OpsHealthState, "severity">): OpsHealthState {
  return {
    ...input,
    severity: severityForStatus(input.status),
  };
}

