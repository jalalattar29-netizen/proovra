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
   * WHICH SOURCE OWNS THIS CONDITION, AND WHAT THAT SOURCE PERMITS.
   *
   * Resolved on the SERVER from the condition's own fingerprint and projected
   * per row. The browser renders the decision and never makes one: it has no
   * input that would let it, which is the only way a client-side action gate
   * stays honest.
   *
   * Optional on the wire so an older server's response still renders. Absent
   * is treated as "no manual resolution offered" by `toRowModel`, which is the
   * fail-closed direction — a Resolve control that should not have been there
   * is worse than one that is briefly missing.
   */
  lifecycle?: IncidentLifecycle;
  /**
   * THE CURRENT AGGREGATE VALUE, for a source that carries one.
   *
   * A DIFFERENT QUANTITY from `occurrenceCount` and from a group's member
   * count. Rendered with its own label for exactly that reason: 26 affected
   * records, 4 observations and 1 condition are three true numbers about one
   * row, and a surface that prints them interchangeably is lying.
   */
  metric?: ConditionMetric | null;
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
 * The source contract, as projected.
 *
 * `manualResolution` is the PROJECTION answer — may a Resolve control be
 * offered — and is deliberately not the same question the server asks when the
 * request arrives. A SOURCE_TRUTH condition is never offered Resolve because
 * its recovery closes it automatically; if a stale tab posts one anyway, the
 * server refuses it against a live probe.
 */
export type IncidentLifecycle = {
  sourceId: string;
  /** FINGERPRINT, CATEGORY_RESIDUAL or UNREGISTERED. */
  sourceMatch: string;
  /** SOURCE_TRUTH, OPERATOR_DECISION or NO_DIRECT_RESOLUTION. */
  resolutionAuthority: string;
  /** TENANT_ACTIONABLE, TENANT_ADVISORY or PLATFORM_INTERNAL. */
  audience: string;
  /** PER_RECORD, AGGREGATE or EVENT. */
  cardinality: string;
  recoveryPolicy: string;
  manualResolution: boolean;
};

/** The structured current value. Mirrors `ConditionMetricSnapshot`. */
export type ConditionMetric = {
  currentValue: number;
  previousValue: number | null;
  delta: number | null;
  thresholdValue: number;
  criticalThresholdValue: number | null;
  unit: string;
  observedAtUtc: string;
  /** True when the last observation FAILED and these are the previous values. */
  stale: boolean;
  truncated: boolean;
  affectedEntityType: string | null;
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
  /** No promise was ever recorded for this condition. */
  | "UNTRACKED_LEGACY"
  /** A cycle exists but the workspace had no policy when it qualified. */
  | "NOT_APPLICABLE"
  | "ON_TRACK"
  | "AT_RISK"
  | "BREACHED"
  | "ACKNOWLEDGED"
  | "RESOLVED";

export type IncidentSla = {
  posture: SlaPosture;
  /** Which commitment the live posture is measured against. */
  obligation: "ACKNOWLEDGEMENT" | "RESOLUTION" | "NONE";
  dueAtUtc: string | null;
  targetHours: number | null;
  /**
   * The immutable policy version that governed this cycle. Present so a
   * reader can tell that two conditions were judged against different
   * promises; never used by the browser to compute anything.
   */
  policyVersionId: string | null;
  cycleNumber: number | null;
  /** Latched facts, kept even after the posture moves on. */
  acknowledgementBreached: boolean;
  resolutionBreached: boolean;
};

/**
 * The SLA VOCABULARY this page speaks, sent once per page.
 *
 * Deliberately carries no hours. Hours belong to an individual condition's
 * recorded promise, and a page-level number would invite the browser to
 * recompute a deadline from it — which is the second authority this closure
 * removed.
 */
export type SlaEnvelope = {
  postures: SlaPosture[];
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
  /**
   * SLA counters, from the SAME projection the rows carry — so a card and the
   * list it summarises cannot disagree about whether something is late.
   *
   * `slaUntracked` counts conditions with no recorded promise. They are
   * deliberately absent from `slaBreached`: counting a record that predates
   * the SLA authority as a broken promise would manufacture a failure that
   * never happened.
   */
  slaBreached: number;
  slaAtRisk: number;
  slaOnTrack: number;
  slaUntracked: number;
  /** Closed conditions. Counted by the same authority, disjoint from `open`. */
  resolved: number;
  complete: boolean;
  mayAssertAllClear: boolean;
  incompleteReason: string | null;

  /**
   * WORKSPACE-SCOPE CONVERGENCE (§8) — the state of the workspace's most
   * recent DISCOVERY run.
   *
   * `complete` above answers "did the incident-table read finish?", which an
   * empty table satisfies. An incident table is empty when nothing has ever
   * scanned the workspace, so that field alone once licensed "workspace
   * operations are clear" over workspaces that had never been examined.
   *
   * This is what lets the surface distinguish "we looked, thoroughly, minutes
   * ago, and found nothing" from "nothing has ever looked" — two states that
   * previously rendered the same reassuring sentence.
   */
  readiness?: OperationsReadiness;
  /** Bounded reason the all-clear is refused. Null when it is permitted. */
  clearRefusalReason?: ClearRefusalReason | null;
  /** The durable run facts, for the operator-facing detail line. */
  reconciliation?: {
    startedAtUtc: string;
    completedAtUtc: string | null;
    sources: {
      requiredSources: string[];
      successfulSources: string[];
      failedSources: string[];
      truncatedSources: string[];
      /**
       * WHY each failed source failed. One entry per id in `failedSources`.
       *
       * Optional because a run recorded by an older image has no such key,
       * and a workspace whose last run predates this field must render as
       * "reason not recorded" rather than crash the page.
       */
      sourceFailures?: OperationsSourceFailure[];
    };
    safeFailureCategory: string | null;
  } | null;
};

/**
 * Mirrors the server vocabulary exactly. Never a parallel spelling.
 *
 * `retryable` is the field the surface branches on, and it is deliberately
 * SERVER-COMPUTED: whether pressing a button again could help is a fact about
 * the failure, not a guess the browser should make. A deployment/schema
 * disagreement does not become false because an operator tried twice.
 */
export type OperationsSourceFailure = {
  sourceId: string;
  stage: "SCAN" | "WRITE" | "UNKNOWN";
  category: string;
  retryable: boolean;
};

/** Mirrors the server vocabulary exactly. Never a parallel spelling. */
export type OperationsReadiness =
  | "NEVER_RUN"
  | "RUNNING"
  | "READY"
  | "PARTIAL"
  | "STALE"
  | "FAILED"
  | "STALLED";

export type ClearRefusalReason =
  | "NEVER_RUN"
  | "RUNNING"
  | "STALE"
  | "FAILED"
  | "STALLED"
  | "PARTIAL_SOURCES"
  | "TRUNCATED_SOURCE"
  | "INCIDENT_READ_INCOMPLETE"
  | "UNRESOLVED_CONDITIONS";

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
  /**
   * May create and manage WORKSPACE-SHARED saved views.
   *
   * Deliberately separate from every other flag here: it is the only one that
   * governs shared CONFIGURATION rather than an incident. A reader keeps full
   * authority over their own PRIVATE views without it.
   */
  canManageSharedViews: boolean;
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
  /**
   * The optimistic-concurrency token, echoed back on every update.
   *
   * Two operators editing one shared view otherwise produce a silent lost
   * update: both saves succeed and the first person's change is gone with no
   * error anywhere.
   */
  updatedAt: string;
  /** The stored filters, in the queue's own vocabulary. */
  filter: {
    teamId: string;
    sla?: string;
    status?: string;
    severity?: string;
    category?: string;
    owner?: string;
    q?: string;
    sort?: string;
  };
};
