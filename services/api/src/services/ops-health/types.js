/**
 * Phase 32.8C+++++++ — Operational health state types.
 *
 * Shared diagnostic shape every subsystem health evaluator returns.
 * The dashboard uses this to render severity correctly — STALE and
 * DEGRADED are AMBER (operational subsystem still alive, projection
 * delayed); UNAVAILABLE and FAILED are RED (real operational danger).
 */
/**
 * Map an OpsHealthStatus to the severity tone used by SectionShell
 * and the colour ladder used by the dashboard CSS.
 */
export function severityForStatus(status) {
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
export function labelForStatus(status) {
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
