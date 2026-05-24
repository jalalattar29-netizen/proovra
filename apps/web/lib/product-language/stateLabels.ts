/**
 * PHASE R4 — Canonical state / status labels.
 *
 * The single source of truth for user-facing copy of runtime,
 * workflow, governance, review, and lifecycle states. Backend
 * enums are mapped through this dictionary into operational
 * language. Surfaces that need to render a state label MUST go
 * through `formatStateLabel()` (or import the constant directly)
 * rather than emitting the raw enum value.
 *
 * Hard rules:
 *
 *   1. No ALL_CAPS values reach the user. Every enum has an
 *      operational equivalent here.
 *
 *   2. "Unknown" is reserved for truly indeterminate state — we
 *      prefer "Pending review", "Not configured", "Status pending",
 *      or a specific operational state name.
 *
 *   3. The fallback for an unmapped status is "Status pending" —
 *      operationally neutral, NEVER "Unknown" or the raw enum.
 *
 *   4. Backend enums (the keys here) are stable identifiers. Adding
 *      a new key is fine; renaming or removing a key is a
 *      coordinated breaking change.
 */

/** Runtime severity → operational label. Reflects R1 + R2 cleanup. */
export const RUNTIME_SEVERITY_LABELS = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  INCIDENT_ACTIVE: "Incident",
  CRITICAL: "Critical",
  UNKNOWN: "Status pending",
} as const;

/** Reviewer-workflow lifecycle stage → operational label. */
export const REVIEW_WORKFLOW_STAGE_LABELS = {
  QUEUED: "Queued",
  ASSIGNED: "Assigned",
  IN_REVIEW: "In review",
  NEEDS_MORE_INFO: "Needs more info",
  RESPONSE_RECEIVED: "Response received",
  APPROVED_INTERNAL: "Approved (internal)",
  REJECTED_INSUFFICIENT: "Rejected (insufficient)",
  ESCALATED: "Escalated",
  REOPENED: "Reopened",
  CLOSED: "Closed",
} as const;

/** SLA status → operational label. */
export const SLA_STATUS_LABELS = {
  ON_TRACK: "On track",
  DUE_SOON: "Due soon",
  OVERDUE: "Overdue",
  BREACHED: "Breached",
  PAUSED: "Paused",
} as const;

/** Storage / billing addon status → operational label. */
export const BILLING_ADDON_STATUS_LABELS = {
  ACTIVE: "Active",
  PENDING: "Pending",
  PAST_DUE: "Past due",
  CANCELED: "Canceled",
  EXPIRED: "Expired",
  FAILED: "Failed",
} as const;

/** Workspace setup / onboarding state → operational label. */
export const WORKSPACE_SETUP_LABELS = {
  COMPLETE: "Setup complete",
  IN_PROGRESS: "Setup in progress",
  INCOMPLETE: "Setup incomplete",
  NOT_STARTED: "Setup needed",
} as const;

/** Generic fallback when a backend value isn't in any dictionary. */
export const STATE_FALLBACK_LABEL = "Status pending" as const;

/**
 * Format a backend enum into a user-facing label. Always returns a
 * non-empty operational string. NEVER returns "Unknown".
 */
export function formatStateLabel(
  dict: Readonly<Record<string, string>>,
  raw: string | null | undefined,
): string {
  if (!raw) return STATE_FALLBACK_LABEL;
  const upper = String(raw).trim().toUpperCase();
  if (!upper) return STATE_FALLBACK_LABEL;
  const hit = dict[upper];
  if (hit) return hit;
  // Truly unknown enum — surface as the neutral fallback. We do NOT
  // expose the raw ALL_CAPS value to users.
  return STATE_FALLBACK_LABEL;
}
