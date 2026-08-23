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
  acknowledgedAtUtc: string | null;
  resolvedAtUtc: string | null;
  /**
   * The condition's posture against the workspace's OWN published SLA.
   *
   * Absent when the workspace's commitment could not be resolved — in which
   * case the surface says nothing about lateness rather than measuring
   * against a default nobody agreed to.
   */
  sla?: IncidentSla;
};

/**
 * SLA POSTURE.
 *
 * Resolved entirely on the server from recorded instants and the workspace's
 * policy. The browser renders the verdict and never recomputes it: a second
 * threshold in the client is a second SLA authority, and the two would
 * disagree the first time the policy changed.
 */
export type SlaPosture =
  | "ON_TRACK"
  | "DUE_SOON"
  | "BREACHED"
  | "MET"
  | "MET_LATE"
  | "NOT_APPLICABLE";

export type IncidentSla = {
  posture: SlaPosture;
  /** Which commitment the posture is measured against. */
  obligation: "RESPONSE" | "RESOLUTION";
  dueAtUtc: string | null;
  targetHours: number | null;
};

/** The workspace's commitment, sent once per page beside the rows. */
export type SlaEnvelope = {
  responseHours: number;
  resolutionHours: number;
  dueSoonHours: number;
  /** The postures the SERVER considers "needs attention on time grounds". */
  attentionPostures: SlaPosture[];
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

/** `GET /v1/ops/incidents/:id` — the detail plus its remediation projection. */
export type IncidentDetailResponse = {
  incident: IncidentDetail;
  remediation: ProjectedRemediation;
};

export type IncidentListResponse = {
  /** The workspace's SLA commitment, or null when it could not be resolved. */
  sla?: SlaEnvelope | null;
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

// ---------------------------------------------------------------------------
// REMEDIATION
//
// The server's projection of what THIS caller may do about ONE condition. It
// arrives already authorized and already filtered for eligibility — there is
// deliberately no input here from which the browser could re-derive either,
// which is what keeps a client-side action gate from existing at all.
// ---------------------------------------------------------------------------

export type RemediationDisposition =
  | "DIRECT_REMEDIATION"
  | "SAFE_DEEP_LINK"
  | "READ_ONLY_GUIDANCE"
  | "NO_SAFE_REMEDIATION_AUTHORITY";

export type RemediationAction = {
  actionId: string;
  label: string;
  description: string;
  /** Ask before spending real work. */
  confirm: boolean;
  /** Asynchronous work reports ACCEPTED, never a completion. */
  async: boolean;
};

export type ProjectedRemediation = {
  disposition: RemediationDisposition;
  actions: RemediationAction[];
  deepLink: { href: string; label: string } | null;
  guidance: string | null;
  /** Present only for NO_SAFE_REMEDIATION_AUTHORITY. */
  unsafeReason: string | null;
};

/**
 * What happened to a remediation REQUEST.
 *
 * `QUEUED` is a terminal answer to the request and says nothing about the
 * work. There is no `SUCCEEDED` here because the browser cannot observe one.
 */
export type RemediationResult =
  | "QUEUED"
  | "ALREADY_IN_PROGRESS"
  | "ALREADY_SATISFIED"
  | "REFUSED"
  | "NOT_ELIGIBLE"
  | "QUEUE_UNAVAILABLE"
  | "FAILED";

export type RemediationOutcome = {
  result: RemediationResult;
  message: string;
  reference?: string;
};

// ---------------------------------------------------------------------------
// BULK ACTIONS
// ---------------------------------------------------------------------------

/**
 * `POST /v1/ops/bulk-actions` — the run and its PER-TARGET items.
 *
 * The items are what make a sweep readable. A run-level status alone cannot
 * distinguish "nothing moved" from "most of it moved", and those need
 * different next actions from the operator.
 */
export type BulkActionResponse = {
  run?: { id: string; status: string };
  items?: Array<{
    id: string;
    targetType: string;
    targetId: string;
    status: string;
    errorCode: string | null;
    completedAtUtc: string | null;
  }>;
  idempotentReplay?: boolean;
};

// ---------------------------------------------------------------------------
// SAVED VIEWS
// ---------------------------------------------------------------------------

/**
 * A named set of queue filters.
 *
 * It stores a QUESTION and never an answer: no count, no timestamp of what
 * was true when it was saved, no cached rows. Anything resembling a result
 * would be stale the instant it was written.
 */
export type OperationsSavedView = {
  id: string;
  name: string;
  description: string | null;
  /** PRIVATE is the author's alone; TEAM is visible to the workspace. */
  visibility: "PRIVATE" | "TEAM";
  pinned: boolean;
  createdByUserId: string;
  /** Only the author may delete it, and only the server decides who that is. */
  ownedByViewer: boolean;
  createdAt: string;
  updatedAt: string;
  /** The stored filters, in the queue's own vocabulary. */
  filter: {
    teamId: string;
    status?: string;
    severity?: string;
    category?: string;
    owner?: string;
    q?: string;
    sort?: string;
  };
};
