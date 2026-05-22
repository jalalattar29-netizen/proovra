/**
 * Phase 32.8C+++++++ — Operational health state types.
 *
 * Shared diagnostic shape every subsystem health evaluator returns.
 * The dashboard uses this to render severity correctly — STALE and
 * DEGRADED are AMBER (operational subsystem still alive, projection
 * delayed); UNAVAILABLE and FAILED are RED (real operational danger).
 */

export type OpsHealthStatus =
  | "HEALTHY"
  | "STALE"
  | "DEGRADED"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "FAILED"
  | "DISCONNECTED";

export type OpsHealthSeverity =
  | "info" // HEALTHY
  | "amber" // STALE / DEGRADED / PARTIAL
  | "warning" // DEGRADED with active operator attention needed
  | "high" // UNAVAILABLE — read failed but canonical source alive
  | "critical" // FAILED — operational danger
  | "muted"; // DISCONNECTED — subsystem not deployed

/**
 * Deterministic operational diagnostic. Every subsystem returns this
 * shape so the dashboard can render the same severity ladder
 * everywhere.
 */
export type OpsHealthState = {
  status: OpsHealthStatus;
  severity: OpsHealthSeverity;
  /** Bounded operator-safe reason string. */
  reason: string;
  /**
   * Whether the subsystem is expected to recover on its next cycle
   * without operator action. STALE/DEGRADED telemetry is typically
   * `recoverable: true`. FAILED is typically `false`.
   */
  recoverable: boolean;
  /**
   * ISO timestamp of the last successful run / sample. NULL when the
   * subsystem has never produced a sample.
   */
  lastSuccessfulRunAt: string | null;
  /** Whether a retry/poll is currently in flight. */
  retrying: boolean;
  /**
   * When the subsystem entered DEGRADED/STALE state (ISO). NULL while
   * healthy.
   */
  degradedSince: string | null;
  /**
   * Whether the CANONICAL upstream source is still operational —
   * critical: if the canonical SecurityEvent log / worker process is
   * fine, then a rollup-read failure is DEGRADED not FAILED.
   */
  canonicalSourceHealthy: boolean;
};

/**
 * Map an OpsHealthStatus to the severity tone used by SectionShell
 * and the colour ladder used by the dashboard CSS.
 */
export function severityForStatus(status: OpsHealthStatus): OpsHealthSeverity {
  switch (status) {
    case "HEALTHY":
      return "info";
    case "STALE":
    case "PARTIAL":
      return "amber";
    case "DEGRADED":
      return "warning";
    case "UNAVAILABLE":
      return "high";
    case "FAILED":
      return "critical";
    case "DISCONNECTED":
      return "muted";
  }
}

/**
 * Bounded operator-readable label for an OpsHealthStatus.
 */
export function labelForStatus(status: OpsHealthStatus): string {
  switch (status) {
    case "HEALTHY":
      return "Healthy";
    case "STALE":
      return "Telemetry stale";
    case "DEGRADED":
      return "Degraded read";
    case "PARTIAL":
      return "Partial read";
    case "UNAVAILABLE":
      return "Read unavailable";
    case "FAILED":
      return "Failed";
    case "DISCONNECTED":
      return "Disconnected";
  }
}
