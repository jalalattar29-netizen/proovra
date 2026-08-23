/**
 * Operations workbench — the wire types.
 *
 * These mirror `GET /v1/ops/incidents`, `GET /v1/ops/incidents/:id` and
 * `GET /v1/ops/summary` exactly. They are written once, here, so no component
 * re-declares a narrower or wider shape and quietly disagrees with the server
 * about what a condition is.
 *
 * NOTE what is absent: there is no `health`, no `metrics`, no `counters` and
 * no `gauges` type in this route. Those belong to the PLATFORM observability
 * console and the tenant workbench does not read them — see the note at the
 * top of `page.tsx`.
 */

/** Canonical severities, in escalating order. */
export const INCIDENT_SEVERITIES = [
  "INFO",
  "WARNING",
  "HIGH",
  "CRITICAL",
] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** Canonical lifecycle states. */
export const INCIDENT_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "SUPPRESSED",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * The `IncidentCategory` enum, mirrored.
 *
 * Kept in the SAME order as `prisma/schema.prisma` so a diff between the two
 * is readable. A category the server adds and this list omits still renders —
 * the vocabulary falls back to the raw token rather than dropping the row,
 * because a condition nobody can see is the one failure mode this surface
 * exists to prevent.
 */
export const INCIDENT_CATEGORIES = [
  "UPLOAD",
  "REPORT",
  "PACKAGE",
  "WEBHOOK",
  "COMMUNICATIONS",
  "IDENTITY_SECURITY",
  "GOVERNANCE",
  "STORAGE",
  "AI",
  "INTEGRATION",
  "DATABASE",
  "WORKER",
  "RECONCILIATION",
  "EVIDENCE_INTEGRITY",
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

/** One row of `GET /v1/ops/incidents`. */
export type Incident = {
  id: string;
  category: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  safeSummary: string;
  fingerprint: string;
  occurrenceCount: number;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  requestId: string | null;
  traceId: string | null;
  relatedEvidenceId: string | null;
  relatedJobId: string | null;
  relatedProvider: string | null;
  runbookSlug: string | null;
  acknowledgedByUserId: string | null;
  resolvedByUserId: string | null;
  assignedOperatorUserId: string | null;
  assignedAtUtc: string | null;
};

export type IncidentTimelineEntry = {
  id: string;
  eventType: string;
  safeMessage: string;
  occurredAtUtc: string;
};

/** `GET /v1/ops/incidents/:id` — one condition plus its bounded history. */
export type IncidentDetail = Incident & {
  timeline: IncidentTimelineEntry[];
  timelineComplete: boolean;
};

export type IncidentListResponse = {
  incidents: Incident[];
  pagination?: { nextCursor: string | null; returned: number };
  completeness?: { complete: boolean; mayAssertAllClear: boolean };
};

/**
 * `GET /v1/ops/summary`.
 *
 * `complete` / `mayAssertAllClear` are NOT optional decoration. A consumer
 * that renders "operations are clear" without reading them is asserting an
 * all-clear over a read that may have failed, which is the one thing an
 * operations surface may never do.
 */
export type OperationsSummary = {
  workspaceId: string;
  generatedAtUtc: string;
  open: number;
  critical: number;
  high: number;
  warning: number;
  info: number;
  acknowledged: number;
  assignedToMe: number;
  unassigned: number;
  overdue: number;
  complete: boolean;
  mayAssertAllClear: boolean;
  incompleteReason: string | null;
};

export type AssignableOperator = {
  userId: string;
  displayName: string | null;
  email: string | null;
  role: string;
};

/**
 * What the caller may DO here, resolved by the server and passed down as one
 * object.
 *
 * Threading five booleans through every component is how a surface ends up
 * with a component that re-derives one of them from something else. This is
 * built once, in the orchestrator, from the capability envelope.
 */
export type OperationsCapabilities = {
  canAcknowledge: boolean;
  canResolve: boolean;
  canSuppress: boolean;
  canAssign: boolean;
  /** True when ANY mutation is available — decides whether actions render. */
  canActOnAnything: boolean;
};

/** The per-source load state. One source failing must not blank the others. */
export type SourceState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; requestId?: string };
