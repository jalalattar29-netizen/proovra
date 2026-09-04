/**
 * Phase IA-home-v2 — workflow-centric self-serve Home view model.
 *
 * The Home is no longer a database mirror (inventory counters). It is an
 * operational surface that answers, top to bottom:
 *
 *   1. What needs my attention right now?        → heroAction
 *   2. What submissions require review?           → submissions
 *   3. What external collection is in flight?     → collection
 *   4. What evidence has integrity issues?        → recentEvidence (+ trust)
 *   5. Which cases are incomplete?                → caseHealth
 *   6. What reports are ready?                    → recentReports
 *   7. Is my evidence trustworthy?                → trustState
 *   8. What happened recently?                    → activity
 *
 * STRICT DATA RULES (enforced by phase-ia-home-v2 tests):
 *   - Every value is wired to a real backend field. No invented data,
 *     no hardcoded completion, no static trust copy, no pipeline
 *     approximation where a real source exists.
 *   - The enterprise-section blocklist still applies — self-serve never
 *     sees reviewer-ops / governance / intelligence data.
 *   - When data is missing, return empty/null — the UI renders an
 *     honest empty state, never a placeholder number.
 *
 * Data sources (all pre-existing except trust-summary, which is a thin
 * real aggregate over the Evidence table added in this phase):
 *   - GET /v1/dashboard/command-center?teamId=
 *   - GET /v1/dashboard/trust-summary?teamId=        (NEW, real counts)
 *   - GET /v1/reports?teamId=
 *   - GET /v1/billing/overview
 *   - GET /v1/workflow/intake-links?teamId=
 *   - GET /v1/me/inbox                               (intake categories)
 *   - GET /v1/communications/messages?teamId=&purpose=INTAKE_LINK
 *   - envelope.organizations
 */

// ============================================================================
// Plan helpers
// ============================================================================

import {
  HOME_CONDITION_REPRESENTATION,
  PLATFORM_ADVISORY_PRIORITY,
  UNRECOGNISED_SOURCE_PRIORITY,
  representationFor,
  type HomeOperationsSourceId,
} from "./operations-condition-map";

export type HomePlan = "FREE" | "PAYG" | "PRO" | "TEAM" | null;

/** Which kind of workspace the user is currently in. */
export type ActiveSpaceType = "PERSONAL" | "ORGANIZATION" | null;

/**
 * Track 1A (surface-tier removal, 2026-07-28) — SERVER-projected
 * commercial entitlements consumed by the Home decisions. Sourced from
 * the canonical `envelope.planFeatures` (backend PLAN_CAPABILITIES
 * projection) and resolved FAIL-CLOSED (unknown → false) by
 * `normalizeHomeViewModel`. The view model never derives an
 * entitlement from the raw plan name — `plan` is retained for DISPLAY
 * only (e.g. the `data-self-serve-plan` attribute).
 */
export type HomePlanFeatures = {
  intakeIncluded: boolean;
  teamCollaborationIncluded: boolean;
  reportsIncluded: boolean;
};

// ============================================================================
// Phase HOME-CTA-NORMALIZATION — single source of truth for Home CTA
// destinations. Every Home surface that points at "review integrity"
// (Workspace Priorities row, Operational Queue card, future surfaces)
// imports the SAME constant; the destination dataset is then
// guaranteed to match the count Home displays, and a future change
// only needs to land here.
//
// The header CTA is deliberately a NEUTRAL navigation target
// ("Evidence Queue", unfiltered) — the operational decisions live in
// the queue + priorities cards, not in the header.
// ============================================================================

/**
 * Records where `verificationStatus IN (REVIEW_REQUIRED, FAILED)` —
 * the exact dataset behind `trustSummary.needingAttention`
 * (see services/api/src/services/dashboard/trust-summary.service.ts:110-115).
 */
export const HOME_INTEGRITY_REVIEW_HREF =
  "/evidence?verificationStatus=REVIEW_REQUIRED,FAILED";

/**
 * Records where `tsaStatus` falls in the `tsaBucket("failed")` union
 * (FAILED | REJECTED | ERROR, trust-summary.service.ts:64).
 */
export const HOME_TSA_FAILURES_HREF = "/evidence?tsaStatus=FAILED,REJECTED,ERROR";

/**
 * Records where `otsStatus` falls in the `otsBucket("pending")` union
 * (PENDING | UPGRADING | QUEUED, trust-summary.service.ts:71).
 */
export const HOME_OTS_PENDING_HREF = "/evidence?otsStatus=PENDING,UPGRADING,QUEUED";

/**
 * Records where `otsStatus` falls in the `otsBucket("failed")` union
 * (FAILED | ERRORED | ERROR, trust-summary.service.ts:105) — the SAME union
 * the canonical `trust.otsFailed` aggregate counts.
 *
 * CLOSURE PASS (2026-08-22). The terminal-anchoring priority used to link to
 * the notification list, which is not a place anybody can fix an unanchored
 * record. It now links here, to exactly the records the count describes, so
 * the number on Home and the rows behind the link are the same population by
 * construction rather than by coincidence.
 */
export const HOME_ANCHORING_FAILURES_HREF =
  "/evidence?otsStatus=FAILED,ERRORED,ERROR";

/**
 * Records where verification is not yet public (NOT_PUBLISHED or
 * UNPUBLISHED — both fold into the `publicVerify.unpublished` count).
 */
export const HOME_PUBLISH_VERIFICATION_HREF =
  "/evidence?publicVerifyState=NOT_PUBLISHED,UNPUBLISHED";

/** Unfiltered Evidence queue — the canonical "primary workspace" link. */
export const HOME_EVIDENCE_QUEUE_HREF = "/evidence";

// ============================================================================
// View-model types — what the UI sees
// ============================================================================

/** The single highest-priority thing the user should do right now. */
export type HeroAction = {
  kind:
    | "review_submissions"
    | "generate_reports"
    | "complete_packages"
    | "fix_integrity"
    | "publish_verification"
    | "complete_cases"
    | "capture_first"
    | "create_first_case"
    | "generate_first_report"
    | "request_evidence"
    | "caught_up";
  /** Headline — the thing that needs doing. */
  title: string;
  /** One-line plain-language explanation. */
  detail: string;
  /** How many items this action covers (0 = onboarding-style). */
  count: number;
  /** Direct action target. */
  href: string;
  ctaLabel: string;
  tone: "action" | "warn" | "calm";
};

/** A submission awaiting the user's review decision. */
export type SubmissionRow = {
  id: string;
  /** Request title (submitter identity is not on the inbox item). */
  title: string;
  /** RESPONSE_RECEIVED / UNDER_REVIEW / NEEDS_MORE_INFO / PARTIALLY_FULFILLED */
  status: string;
  statusLabel: string;
  receivedAt: string;
  overdue: boolean;
  /** /evidence-requests/:id */
  href: string;
};

/** An active external intake link + its latest delivery state. */
export type CollectionRow = {
  id: string;
  label: string;
  // Phase HOME-FIELD-WIRING (Ticket 4) — `status` was removed: rows
  // are pre-filtered to ACTIVE links, so the field was a constant
  // with no UI or test consumer.
  usedCount: number;
  maxUses: number | null;
  /** Rendered as "expires …" on the intake link row (Ticket 4). */
  expiresAtUtc: string;
  /** Most recent delivery for this link, if any message matched. */
  delivery: {
    /** Communication message id — the retry endpoint target. */
    messageId: string;
    channel: string;
    status: string;
    statusLabel: string;
    /** True only when the latest delivery is a terminal/retryable failure. */
    failed: boolean;
    /** Delivery/sent/failed timestamp — rendered on the chip (Ticket 4). */
    at: string | null;
  } | null;
  href: string;
};

/**
 * Aggregate counters for the Request & Collect header — every value is a
 * real count derived from the active intake links + their latest
 * delivery + the submission inbox. No estimates.
 */
export type CollectionStats = {
  /** Intake links currently ACTIVE in this workspace. */
  activeLinks: number;
  /**
   * Phase HOME-FIELD-WIRING (Ticket 2) — intake-link messages with a
   * real `deliveredAtUtc`. Distinct from link counts: this counts
   * confirmed deliveries.
   */
  delivered: number;
  /** ACTIVE links that have not yet been used (awaiting a response). */
  awaitingResponse: number;
  /**
   * Submissions awaiting the user's review decision — inbox category
   * `intake_submission_pending_review` (EvidenceRequest
   * RESPONSE_RECEIVED / UNDER_REVIEW, unassigned), workspace-scoped,
   * UNSLICED count.
   */
  pendingReview: number;
  /**
   * Submissions returned for more material — inbox category
   * `intake_required_items_missing` (PARTIALLY_FULFILLED /
   * NEEDS_MORE_INFO), workspace-scoped, UNSLICED count.
   */
  needsMoreInfo: number;
  /** ACTIVE links whose latest delivery attempt failed. */
  failedDeliveries: number;
};

/** A real operational failure the user can act on, from the inbox. */
export type NeedsFixingRow = {
  id: string;
  /** report_failure | verification_package_failure | ots_failure */
  category: string;
  categoryLabel: string;
  title: string;
  detail: string;
  /** Critical (terminal) vs high (often transient). */
  critical: boolean;
  occurredAt: string;
  /** Deep-link to the page where the failure is fixed (evidence integrity tab). */
  href: string;
};

export type RecentEvidenceRow = {
  id: string;
  title: string;
  status: string;
  /** Real integrity verdict from Evidence.verificationStatus. */
  verificationStatus: string | null;
  /** True when this evidence id appears in the integrity-watch list. */
  needsAttention: boolean;
  createdAt: string;
  href: string;
};

export type RecentReportRow = {
  evidenceId: string;
  evidenceTitle: string;
  version: number | null;
  generatedAtUtc: string | null;
  reportReady: boolean;
  packageReady: boolean;
  href: string;
  actions: {
    open: string;
    /**
     * API path (NOT an app route) — UI must call apiFetch and open the
     * returned presigned URL. Direct <a href> navigation will 404
     * because the browser sends no Authorization header.
     */
    reportPdfApiPath: string | null;
    packageZipApiPath: string | null;
    verify: string | null;
  };
};

/** A case carrying an incompleteness / blocker signal. */
export type CaseHealthRow = {
  caseId: string;
  caseName: string;
  evidenceCount: number;
  unreviewedCount: number;
  overdueReviewCount: number;
  openEscalationsCount: number;
  hasActiveLegalHold: boolean;
  /** Plain-language summary of why this case needs attention. */
  reason: string;
  href: string;
};

/** Live trust posture — every number is a real COUNT. */
export type TrustState = {
  totalEvidence: number;
  tsaStamped: number;
  tsaPending: number;
  tsaFailed: number;
  /**
   * Phase HOME-FIELD-WIRING (Ticket 3B) — records with no TSA attempt
   * yet (trust-summary `tsa.none`). Neutral state, not a failure.
   */
  tsaNone: number;
  otsAnchored: number;
  otsPending: number;
  otsFailed: number;
  /** Records with no OTS anchoring yet (`ots.none`). Neutral state. */
  otsNone: number;
  /**
   * Evidence carrying an Ed25519 signature. NOT a readiness signal —
   * signing happens before the report worker runs, so this can read
   * 100% while every record is missing a deliverable. Use only for
   * the Trust State card row labelled "Signed records".
   */
  signed: number;
  /**
   * Phase HOME-TRUTH-FIX — end-to-end ready predicate (status=REPORTED
   * ∧ has Report ∧ has Package ∧ not suspended). The headline KPI uses
   * THIS, not `signed`.
   */
  endToEndReady: number;
  /** Evidence stuck at SIGNED with no Report row. Operational issue. */
  signedWithoutReport: number;
  /** Evidence at REPORTED with no Package row. Operational issue. */
  reportedWithoutPackage: number;
  verifyPublished: number;
  /** Public verification links that were live but are now suspended. */
  verifySuspended: number;
  needingAttention: number;
  /** True when there is genuinely nothing to show yet. */
  empty: boolean;
};

export type StorageUsage = {
  usedLabel: string | null;
  limitLabel: string | null;
  usagePercent: number | null;
  nearLimit: boolean;
  limitReached: boolean;
  /**
   * Capacity projection: roughly how many more records fit at the
   * current average record size. Derived from the REAL usagePercent +
   * evidence count (records ≈ count·(100/percent − 1)). null when it
   * can't be computed honestly (no usage yet, full, or no records).
   */
  forecastRecords: number | null;
  upgradeHref: string;
};

export type ActivityEvent = {
  id: string;
  kind:
    | "evidence_finalized"
    | "report_generated"
    | "package_generated"
    | "verification_published"
    | "request_more_sent"
    | "lifecycle_transition"
    | "destruction_review"
    | "hold_placed"
    | "hold_released"
    | "escalation_opened"
    | "incident_opened"
    | "intake_link_created"
    | "intake_delivered"
    | "intake_failed"
    | "submission_received";
  label: string;
  occurredAt: string;
  href: string;
  /**
   * Phase HOME-INTELLIGENCE — identical labels inside one day bucket
   * collapse to a single row ("Report generated ×3"); the newest
   * occurrence keeps its timestamp. Undefined/1 ⇒ single event.
   */
  repeatCount?: number;
};

/** Activity bucketed into Today / Yesterday / Earlier. */
export type ActivityGroup = {
  key: "today" | "yesterday" | "earlier";
  label: string;
  events: ActivityEvent[];
};

/** Work-centric team strip (replaces roster headcount). */
export type TeamWork = {
  submissionsAwaitingReview: number;
  reportsToday: number;
  members: number;
  pendingInvites: number;
  manageHref: string;
};

export type ChecklistStep = {
  key:
    | "capture_first"
    | "create_first_case"
    | "first_report"
    | "share_verification";
  label: string;
  done: boolean;
  visible: boolean;
  href: string;
};

/**
 * Phase HOME-INTELLIGENCE — a ranked, explained workspace action for
 * ACTIVE users. Every priority is derived from live operational data
 * (often COMBINING domains — e.g. reports ready + verification
 * unpublished); never static copy, never fabricated.
 */
export type WorkspacePriority = {
  key:
    | "tsa_failures"
    | "anchoring_terminal"
    | "resolve_integrity"
    | "review_submissions"
    | "complete_packages"
    | "matters_need_reports"
    | "ots_pending"
    | "publish_verification"
    | "reports_ready"
    | "storage_pressure"
    | "create_intake_link"
    /*
     * Operational conditions, one key per registry source id.
     *
     * Templated rather than enumerated so the SOURCE registry stays the single
     * list; what is exhaustively checked is the REPRESENTATION
     * (`HOME_CONDITION_REPRESENTATION` is a Record over the closed source-id
     * union, so a new id without a representation does not compile).
     */
    | `ops:${HomeOperationsSourceId}`
    /** Every PLATFORM_INTERNAL condition, collapsed into one advisory row. */
    | "platform_service_degraded"
    /** Version skew only: the server named a source this build does not know. */
    | "operations_condition_unrecognised";
  /** critical > warning > info — drives ranking and the chip. */
  severity: "critical" | "warning" | "info";
  /** evidence / matter / report / package / verification / intake / trust / storage. */
  domains: string[];
  /** Real count behind the priority (0 ⇒ the priority is omitted). */
  count: number;
  /** What happened — "14 records need integrity review". */
  label: string;
  /** Why it matters / what happens if ignored, in plain language. */
  whyItMatters: string;
  /** The recommended next step, as a sentence. */
  recommendedAction: string;
  /** CTA label for the action button. */
  actionLabel: string;
  href: string;
  /**
   * The REAL source API fields this decision derives from
   * (endpoint.field notation) — auditability, never marketing.
   */
  derivedFrom: string[];
};

/** Header counts for the Case Health card. */
export type CaseHealthSummary = {
  /** Cases missing required/linked evidence (real cc counter). */
  gapsCount: number;
  /** Cases carrying an open escalation/blocker. */
  blockersCount: number;
  /**
   * Phase HOME-FIELD-WIRING (Ticket 3A) — workspace-level counters the
   * API already exposed but the VM previously dropped:
   * `caseOperations.data.unlinkedEvidenceCount` (records not attached
   * to any matter) and `.unreviewedEvidenceCount` (records not yet
   * reviewed). NOTE: the per-case `topCases[].unreviewedCount` is
   * hardcoded 0 server-side — these SECTION-level counters are the
   * only accurate source.
   */
  unlinkedCount: number;
  unreviewedCount: number;
};

// ============================================================================
// Operational surface types (world-class Home)
// ============================================================================

// PHASE 4C (2026-08-22) — `OperationalQueueItem` removed. It described a row
// of the notification-feed-derived queue Home used to build for itself; the
// queue, its renderer and its severity mapping all went with it. Home now
// consumes `HomeOperationsSummary`, which is a projection of shared workspace
// truth rather than a shape Home computes.

/** A matter/case row — work-centric, shows portfolio + what needs work. */
export type ActiveMatterRow = {
  caseId: string;
  caseName: string;
  evidenceCount: number;
  unreviewedCount: number;
  overdueReviewCount: number;
  openEscalationsCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
  /** True when this matter has any incompleteness/blocker signal. */
  needsWork: boolean;
  /**
   * Phase HOME-INTELLIGENCE — true when at least one report exists for
   * evidence in this matter (per-case aggregate, with /v1/reports
   * items[].caseId as fallback for older payloads).
   */
  hasReport: boolean;
  /**
   * Phase HOME-DECISIONS — per-matter deliverable readiness from the
   * bounded caseOperations aggregates (records with ≥1 report / ≥1
   * package / a live public verify page).
   */
  reportsReadyCount: number;
  packagesReadyCount: number;
  verifyLiveCount: number;
  /**
   * Where this matter sits in the deliverable chain:
   *   needs_report → missing_package → needs_publication → ready.
   * "none" when the matter has no evidence yet.
   */
  verificationStatus:
    | "ready"
    | "needs_publication"
    | "missing_package"
    | "needs_report"
    | "none";
  /**
   * Matter verdict: "action_required" (open escalations / overdue
   * reviews), "needs_work" (deliverable chain incomplete or unreviewed
   * work), "healthy".
   */
  verdict: "healthy" | "needs_work" | "action_required";
  /** Plain-language status, e.g. "2 unreviewed · 1 blocked" or "On track". */
  statusLabel: string;
  href: string;
};

/** One stage in the intake lifecycle pipeline. */
export type IntakeStage = {
  /**
   * Phase HOME-FIELD-WIRING (Ticket 2) — each key maps to a DISTINCT
   * backend count (see CollectionStats). The old "received" stage was
   * removed: a total-received counter (including accepted submissions)
   * is not exposed by any consumed endpoint, and an "Accepted /
   * Converted" stage is likewise not exposed — both are hidden rather
   * than duplicated from another number.
   */
  key:
    | "active"
    | "delivered"
    | "awaiting"
    | "in_review"
    | "needs_more"
    | "failed";
  label: string;
  count: number;
  tone: "ok" | "warn" | "danger" | "neutral";
};

/** Intake collection lifecycle — counts + per-link rows. */
export type IntakePipeline = {
  stages: IntakeStage[];
  links: CollectionRow[];
  /** True when there is no intake activity at all (drives empty state). */
  empty: boolean;
};

/** Report/package production status — ready / pending / failed. */
/**
 * Phase HOME-INTELLIGENCE — an aggregate deliverable issue with a real
 * count and a working route. No retry buttons are fabricated: failed
 * deliverables surface as OperationalIncident inbox items, so the
 * action navigates to the surface where the fix lives.
 */
export type DeliverableIssue = {
  key: "failed_deliverables" | "package_gap" | "publish_ready" | "suspended_verification";
  label: string;
  count: number;
  tone: "danger" | "warn" | "action";
  actionLabel: string;
  href: string;
};

/**
 * Phase HOME-EXEC — the one-glance executive state of the workspace.
 * Composed purely from the decision engine + health verdict; every
 * sentence is backed by the same real counters (derivedFrom lists
 * them). Zero-data users get an onboarding summary, never fake health.
 */
export type ExecutiveSummary = {
  overallStatus:
    | "healthy"
    | "needs_attention"
    | "action_required"
    | "critical"
    | "onboarding";
  statusLabel: string;
  summaryTitle: string;
  summarySentence: string;
  /** The single highest-ranked cause (decision label), null when healthy. */
  topCause: string | null;
  affectedCount: number;
  recommendedAction: string | null;
  actionLabel: string | null;
  actionHref: string | null;
  /** Up to two next-ranked decision labels. */
  secondarySignals: string[];
  derivedFrom: string[];
};

export type ReportProduction = {
  reportsReady: number;
  packagesReady: number;
  reportsPending: number;
  packagesPending: number;
  reportsFailed: number;
  packagesFailed: number;
  /** Cross-signal "needs action" issues (Phase HOME-INTELLIGENCE). */
  needsAction: DeliverableIssue[];
  /** Latest generated reports with their deliverable actions. */
  recent: RecentReportRow[];
};

/**
 * The canonical workspace Operations summary, as Home receives it.
 *
 * Every field is a projection of `GET /v1/ops/summary`, which reads SHARED
 * operational truth. Home adds nothing to it and recomputes none of it.
 */
export type HomeOperationsSummary = {
  /**
   * False when the summary could not be loaded, or when the caller has no
   * Operations capability in this workspace. Both are honest absences and
   * neither may be rendered as "no issues".
   */
  available: boolean;
  /** Unresolved conditions (OPEN + ACKNOWLEDGED). */
  open: number;
  critical: number;
  high: number;
  warning: number;
  /** Unattended and past the overdue age. */
  overdue: number;
  /** Assigned to the viewer specifically. */
  assignedToMe: number;
  /**
   * PHASE 2.3 — false when the underlying read was bounded or failed. NO
   * surface may render "0 issues" / "all clear" while this is false.
   */
  mayAssertAllClear: boolean;
  /**
   * WHY the all-clear was refused — the server's own bounded verdict, carried
   * through rather than guessed at.
   *
   * `mayAssertAllClear: false` has NINE distinct causes and they do not mean
   * the same thing to a reader. Three of them are read failures
   * (`PARTIAL_SOURCES`, `TRUNCATED_SOURCE`, `INCIDENT_READ_INCOMPLETE`), five
   * are "nothing has looked recently enough" (`NEVER_RUN`, `RUNNING`,
   * `STALE`, `FAILED`, `STALLED`), and one — `UNRESOLVED_CONDITIONS` — is the
   * opposite of a failure: the sweep read everything and FOUND open
   * conditions.
   *
   * The shared runtime's own docblock says the reason is "ordered from most to
   * least specific so the caller renders the most useful sentence". Home never
   * received it, so it rendered one sentence for all nine.
   *
   * Null when the all-clear was granted, or when the summary itself could not
   * be loaded (`available: false` already says that).
   */
  clearRefusalReason: HomeClearRefusalReason | null;
  /** Where the operator goes to act on any of it. Home links; it never acts. */
  href: string;
};

/**
 * The server's `ClearRefusalReason`, mirrored.
 *
 * Declared as a union rather than `string` so a new server reason cannot slip
 * through the UI as an unhandled case — the exhaustive switch that renders it
 * stops compiling instead.
 */
export type HomeClearRefusalReason =
  | "NEVER_RUN"
  | "RUNNING"
  | "STALE"
  | "FAILED"
  | "STALLED"
  | "PARTIAL_SOURCES"
  | "TRUNCATED_SOURCE"
  | "INCIDENT_READ_INCOMPLETE"
  | "UNRESOLVED_CONDITIONS";

/** A verifiable record the user can open on the public verify page. */
export type VerifiableRecord = {
  evidenceId: string;
  title: string;
  verifyHref: string;
};

/**
 * Public verification posture — a user-facing deliverable status. Only
 * the three REAL publicVerifyState values are surfaced (live / not
 * published / suspended); we deliberately do NOT invent a "pending"
 * verification state because the backend has none.
 */
export type VerificationHealth = {
  live: number;
  unpublished: number;
  suspended: number;
  /** Recently verifiable records (have a package → public verify works). */
  verifiable: VerifiableRecord[];
  /**
   * Phase HOME-INTELLIGENCE — cross-signal verification issues, each a
   * real aggregate count: packages ready but verification unpublished
   * (pipeline.publicVerify × packages), and reported evidence missing
   * a package. Recent verify-view analytics exist only on a
   * per-evidence endpoint (review-workspace) — NOT shown here rather
   * than fetched N+1 (documented future capability).
   */
  issues: DeliverableIssue[];
  /**
   * Phase HOME-DECISIONS — recently published verification pages,
   * projected from the command-center timeline's
   * `verification_published` events (Evidence.publicVerifyPublishedAtUtc).
   */
  recentPublications: Array<{ label: string; href: string; occurredAt: string }>;
  /** True when there is no evidence yet (zero scaffold). */
  empty: boolean;
};

/** A single workspace-health metric with a good/warn/problem verdict. */
export type WorkspaceHealthMetric = {
  key: string;
  label: string;
  value: number | string;
  tone: "ok" | "warn" | "danger" | "neutral";
};

// ============================================================================
// Phase HOME-KPI — premium dashboard surfaces (KPIs, activity series,
// type distribution, rich recent-evidence rows). Every number is
// derived from real backend data; the evidence-list sample is labelled
// as a sample when it is one.
// ============================================================================

export type HomeKpi = {
  key: "evidence" | "matters" | "trust" | "deliverables" | "intake";
  label: string;
  /** Pre-formatted display value ("334", "92%", "12 / 3"). */
  value: string;
  /** One-line context: what changed or what the number means. */
  subtitle: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  /** Last-7-day daily counts for the sparkline; null = not enough data. */
  spark: number[] | null;
  href: string;
  /** FREE-plan lock (intake KPI only). */
  locked?: boolean;
};

export type ActivityPoint = {
  /** Short day label, e.g. "Mon 9". */
  dayLabel: string;
  evidence: number;
  reports: number;
};

/**
 * THE RANGES A READER CAN ASK FOR.
 *
 * Named by what they mean, not by a number of days, because the BUCKET is not
 * the range: six months of daily columns is 180 unreadable ticks, so the wider
 * ranges group. Each entry carries both, so the chart never has to guess.
 */
export const ACTIVITY_RANGES = [
  { id: "14d", label: "Last 14 days", days: 14, bucketDays: 1 },
  { id: "1m", label: "Last month", days: 30, bucketDays: 1 },
  { id: "3m", label: "Last 3 months", days: 91, bucketDays: 7 },
  { id: "6m", label: "Last 6 months", days: 182, bucketDays: 14 },
] as const;

export type EvidenceActivityRangeId = (typeof ACTIVITY_RANGES)[number]["id"];

export type EvidenceActivitySeries = {
  /** Oldest → newest. One point per BUCKET, not per day. */
  points: ActivityPoint[];
  totalEvidence: number;
  totalReports: number;
  /** True when the 100-record list cap may truncate the series. */
  sampled: boolean;
  /** Which range produced these points. */
  rangeId: EvidenceActivityRangeId;
  /** How many days each column covers — 1 for the daily ranges. */
  bucketDays: number;
};

export type EvidenceTypeSlice = {
  key: string;
  label: string;
  count: number;
  /** Percent of the sampled records, rounded; slices sum to ~100. */
  percent: number;
};

export type EvidenceTypeDistribution = {
  slices: EvidenceTypeSlice[];
  sampleSize: number;
  /** True when the list cap means this is the latest-N sample. */
  sampled: boolean;
  /**
   * Phase HOME-RECORDS-BY-TYPE — provenance of the counts.
   *   - "workspace-aggregate": every active non-deleted row was counted
   *     by the API service (records-by-type.service.ts). The donut
   *     reflects the whole workspace.
   *   - "latest-sample": legacy fallback when the new endpoint is
   *     unavailable; counts come from the latest-100 evidence list.
   *     The widget must surface this as "Latest N records sampled".
   */
  source: "workspace-aggregate" | "latest-sample";
};

export type RichRecentEvidenceRow = {
  id: string;
  title: string;
  typeKey: string;
  typeLabel: string;
  caseId: string | null;
  createdAt: string;
  trustChip: { label: string; tone: "ok" | "warn" | "danger" | "neutral" };
  href: string;
};

export type HomeViewModel = {
  plan: HomePlan;
  /**
   * Track 1A — SERVER-projected plan entitlements (envelope.planFeatures).
   * The dashboard derives every entitlement decision from these booleans;
   * it never branches on the raw plan name.
   */
  features: HomePlanFeatures;
  /** True when the server projection actually carried reportsIncluded. */
  reportsIncludedKnown: boolean;
  /** Active workspace id — needed for workspace-scoped mutations (retry). */
  workspaceId: string | null;
  /** Workspace display name for the greeting line. */
  workspaceName: string | null;
  kpis: HomeKpi[];
  activitySeries: EvidenceActivitySeries;
  /** The same activity, bucketed for each range the reader can choose. */
  activitySeriesByRange: Record<EvidenceActivityRangeId, EvidenceActivitySeries>;
  typeDistribution: EvidenceTypeDistribution;
  /**
   * Phase HOME-RECORDS-BY-TYPE — "Preserved files by type" view.
   * One count per EvidencePart row (a multipart record with 5 images +
   * 1 PDF contributes 6 file counts). Distinct from `typeDistribution`
   * which counts Evidence ROWS. Null when the backend aggregate
   * endpoint is unavailable — the widget hides the toggle in that case
   * rather than mixing records and files.
   */
  preservedFilesByType: EvidenceTypeDistribution | null;
  richRecentEvidence: RichRecentEvidenceRow[];
  /** Count of open inbox items — drives the header notification dot. */
  inboxCount: number;
  heroAction: HeroAction;
  /** The prioritized list of actionable items — Home's first widget. */
  /**
   * ATTENTION ARCHITECTURE PHASE 4C (2026-08-22) — CONSUMED, NOT COMPUTED.
   *
   * This replaced `operationalQueue: OperationalQueueItem[]`, which Home
   * built itself out of `/v1/me/inbox` via `buildOperationalQueue()`. That
   * made one person's NOTIFICATION FEED the source of the WORKSPACE'S
   * operational health: archiving a notification lowered the workspace's
   * issue count, deferring one hid a problem until tomorrow, and two admins
   * looking at the same workspace saw two different healths while the work
   * itself had not changed.
   *
   * Home now consumes the canonical workspace summary (`GET /v1/ops/summary`)
   * and derives nothing. When the summary cannot be loaded, `available` is
   * false and Home says so — it does NOT fall back to the notification feed,
   * because a substitute health number is worse than an absent one.
   */
  operations: HomeOperationsSummary;
  submissions: SubmissionRow[];
  /** Real failures the user can act on (report/package/OTS). */
  needsFixing: NeedsFixingRow[];
  collection: CollectionRow[];
  collectionStats: CollectionStats;
  intakePipeline: IntakePipeline;
  reportProduction: ReportProduction;
  verificationHealth: VerificationHealth;
  workspaceHealth: WorkspaceHealthMetric[];
  activeMatters: ActiveMatterRow[];
  recentEvidence: RecentEvidenceRow[];
  caseHealth: CaseHealthRow[];
  caseHealthSummary: CaseHealthSummary;
  trustState: TrustState;
  activity: ActivityGroup[];
  // Phase HOME-FIELD-WIRING (Ticket 4) — field audit outcome:
  //   * `submissions`, `needsFixing`, `collection`, `collectionStats`,
  //     `caseHealth`, `recentEvidence`, `HeroAction.count`, and
  //     `SubmissionRow.status/statusLabel` are KEPT: they are tested
  //     intermediates (phase-ia-home-v2) that also feed derived
  //     widgets (queue, pipeline, hero, evidence-count fallback).
  //   * `recentReports` is now INTERNAL only (feeds reportProduction +
  //     verificationHealth; no UI/test consumer on the VM).
  //   * `hasAnyData` was REMOVED (no consumer anywhere).
  storage: StorageUsage | null;
  teamWork: TeamWork | null;
  checklist: ChecklistStep[];
  /** True once every visible checklist step is done — UI collapses it. */
  checklistComplete: boolean;
  /**
   * Phase HOME-POLISH — onboarding renders for TRULY NEW users only:
   * zero evidence AND zero reports AND zero matters AND zero live
   * verification pages. Active users get Workspace Priorities instead.
   */
  showGettingStarted: boolean;
  /** Real prioritized actions for active users (replaces onboarding). */
  workspacePriorities: WorkspacePriority[];
  /** Overall workspace verdict derived from the health metric tones. */
  workspaceHealthOverall: "healthy" | "needs_attention" | "action_required";
  /** Phase HOME-EXEC — the one-glance executive state band. */
  executiveSummary: ExecutiveSummary;
};

// ============================================================================
// Raw input shapes (verified against backend projections)
// ============================================================================

export type HomeCommandCenterInput = {
  sections?: {
    recentEvidence?: {
      status?: string;
      items?: Array<{
        id: string;
        title: string;
        status: string;
        verificationStatus?: string | null;
        createdAt: string;
        caseId?: string | null;
      }>;
    };
    caseOperations?: {
      status?: string;
      data?: {
        activeCasesCount?: number;
        casesWithEvidenceGapsCount?: number;
        unreviewedEvidenceCount?: number;
        unlinkedEvidenceCount?: number;
        topCases?: Array<{
          caseId: string;
          caseName: string;
          evidenceCount: number;
          unreviewedCount?: number;
          overdueReviewCount?: number;
          openEscalationsCount?: number;
          hasActiveLegalHold?: boolean;
          lastActivityAtUtc?: string | null;
          // Phase HOME-DECISIONS — per-matter deliverable readiness
          // (bounded aggregates added to the caseOperations projection).
          reportsReadyCount?: number;
          packagesReadyCount?: number;
          verifyLiveCount?: number;
        }>;
      } | null;
    };
    pipelineDetail?: {
      status?: string;
      data?: {
        evidence?: {
          created?: number;
          uploading?: number;
          uploaded?: number;
          signed?: number;
          reported?: number;
          stuckUploading?: number;
        };
        reports?: {
          ready?: number;
          queued?: number;
          failed?: number;
          missingFromSigned?: number;
        };
        packages?: {
          ready?: number;
          queued?: number;
          blocked?: number;
          failed?: number;
          missingFromReported?: number;
        };
        publicVerify?: {
          published?: number;
          unpublished?: number;
          suspended?: number;
        };
      } | null;
    };
    timeline?: {
      status?: string;
      // Phase HOME-FIELD-WIRING (Ticket 3C) — the API also emits
      // `subtitle` and `severity` per item; Home's one-line activity
      // rows render neither (severity is conveyed by the kind-colored
      // dot), so they are deliberately EXCLUDED from this input type
      // rather than carried as dead fields.
      items?: Array<{
        id: string;
        kind?: string;
        occurredAt?: string;
        label?: string;
        href?: string;
      }>;
    };
    custodyIntegrityAnomalies?: {
      status?: string;
      items?: Array<{
        evidenceId: string;
        title?: string;
        reasonCode?: string;
        severity?: string;
        href?: string;
      }>;
    };
    deepIntegrityWatch?: {
      meta?: { status?: string };
      items?: Array<{
        evidenceId?: string;
        title?: string;
        reasonCode?: string;
        severity?: string;
        href?: string;
      }>;
    };
  };
};

export type HomeTrustSummaryInput = {
  totalEvidence?: number;
  /**
   * CLOSURE PASS (2026-08-22) — CANONICAL INTAKE COUNTS.
   *
   * `submissionsAwaitingReview` used to be counted out of the caller's own
   * /v1/me/inbox items, which made a workspace fact move when that one person
   * archived a notification and capped it at the feed's per-category take.
   * These come from `EvidenceRequest`, the intake domain's own rows, over the
   * whole workspace and with no recipient in the predicate.
   */
  intake?: {
    submissionsAwaitingReview?: number;
    submissionsNeedingMoreInfo?: number;
  };
  tsa?: { stamped?: number; pending?: number; failed?: number; none?: number };
  ots?: { anchored?: number; pending?: number; failed?: number; none?: number };
  /**
   * Evidence carrying an Ed25519 signature. NOTE: this is NOT the
   * headline-KPI predicate — signing happens before the report worker
   * runs, so this can read 100% while every record is missing a
   * deliverable. Used only by the Trust State card (labelled "Signed
   * records") and the per-section visualisations.
   */
  signed?: number;
  /**
   * Phase HOME-TRUTH-FIX — backend-computed end-to-end readiness:
   * status=REPORTED ∧ has Report ∧ has Package ∧ not suspended ∧ not
   * deleted. This is the predicate the headline "End-to-end ready"
   * KPI uses. Cannot show green when the report worker has stalled.
   */
  endToEndReady?: number;
  /**
   * Count of evidence with status=SIGNED and no Report row. Surfaces
   * as an Operational Issue on Home (not a content-integrity issue).
   */
  signedWithoutReport?: number;
  /**
   * Count of evidence with status=REPORTED and no VerificationPackage
   * row. Surfaces as an Operational Issue on Home.
   */
  reportedWithoutPackage?: number;
  publicVerify?: { published?: number; unpublished?: number; suspended?: number };
  needingAttention?: number;
};

export type HomeBillingInput = {
  workspaces?: {
    personal?: {
      storage?: {
        usedLabel?: string;
        limitLabel?: string;
        usagePercent?: number | null;
        nearLimit?: boolean;
        limitReached?: boolean;
      };
    };
  };
};

export type HomeReportsInput = {
  items?: Array<{
    evidenceId: string;
    title: string | null;
    status?: string;
    createdAt?: string;
    /**
     * Phase HOME-INTELLIGENCE — the matter this evidence belongs to.
     * Emitted by /v1/reports since its inception (Evidence.caseId,
     * reports.routes.ts), previously dropped here. Powers per-matter
     * report-readiness on Active Matters.
     */
    caseId?: string | null;
    report?: { available?: boolean; version?: number | null; generatedAtUtc?: string | null };
    package?: { available?: boolean; version?: number | null; generatedAtUtc?: string | null };
  }>;
};

export type HomeIntakeLinksInput = {
  links?: Array<{
    id: string;
    recipientLabel?: string | null;
    recipientPhone?: string | null;
    workflowTemplateSlug?: string;
    status: string;
    usedCount: number;
    maxUses: number | null;
    expiresAtUtc: string;
    createdAt?: string;
  }>;
};

export type HomeInboxInput = {
  items?: Array<{
    id: string;
    category: string;
    title: string;
    body?: string;
    href: string;
    occurredAt: string;
    dueAt?: string | null;
    context?: Record<string, string | number | null>;
  }>;
};

export type HomeCommunicationsInput = {
  messages?: Array<{
    id: string;
    channel: string;
    status: string;
    createdAt: string;
    sentAtUtc?: string | null;
    deliveredAtUtc?: string | null;
    failedAtUtc?: string | null;
    relatedIntakeLinkId?: string | null;
  }>;
};

export type HomeOrgsInput = ReadonlyArray<{
  id: string;
  name: string | null;
  displayName: string | null;
  memberCount: number;
  role: string | null;
  membershipStatus: string;
}>;

/** GET /v1/evidence?limit=100&sort=newest — list projection subset. */
export type HomeEvidenceListInput = {
  items?: Array<{
    id: string;
    title?: string | null;
    displayFileName?: string | null;
    type?: string;
    mimeType?: string | null;
    captureMethod?: string | null;
    status?: string;
    verificationStatus?: string | null;
    latestReportVersion?: number | null;
    reportReady?: boolean;
    createdAt?: string;
    caseId?: string | null;
    teamId?: string | null;
  }>;
  pageInfo?: { hasMore?: boolean };
};

// ----------------------------------------------------------------------------
// Phase HOME-RECORDS-BY-TYPE — backend aggregation envelope.
//
// Shape mirrors `RecordsByTypeResponse` from the API service
// (services/api/src/services/dashboard/records-by-type.service.ts).
// The hook fetches /v1/dashboard/records-by-type and passes the raw
// JSON straight in; partial-failure returns null so the view-model uses
// the latest-100 sample classifier instead. The substitution is NOT
// silent: the distribution carries `source: "latest-sample"` and the
// widget renders it, so an approximate count is never presented as an
// authoritative workspace total.
// ----------------------------------------------------------------------------
export type HomeRecordsByTypeInput = {
  records?: {
    total?: number;
    byCategory?: Record<string, number>;
  };
  files?: {
    total?: number;
    byCategory?: Record<string, number>;
  };
};

// ============================================================================
// Enterprise blocklist (defence in depth)
// ============================================================================

export const ENTERPRISE_ONLY_SECTIONS: ReadonlyArray<string> = [
  "workloadEngine",
  "reviewerOrchestration",
  "reviewerCapacity",
  "governancePosture",
  "queueCongestion",
  "queueWorkerTelemetry",
  "incidents",
  "predictiveRisk",
  "accessSecurityAnomalies",
  "accessSecurityClassifier",
  "organizationalIntelligenceV2",
  "organizationalHealth",
  "operationalGraph",
  "crossCaseIntelligenceV2",
  "relationshipIntelligence",
];

// ============================================================================
// Small helpers
// ============================================================================

const INTAKE_SUBMISSION_CATEGORIES = new Set([
  "intake_submission_pending_review",
  "intake_required_items_missing",
]);

/**
 * Operational FAILURE categories surfaced in the "Needs fixing" strip.
 * All three are real, persisted terminal failures from /v1/me/inbox
 * (report/package OperationalIncident rows + Evidence.otsStatus=FAILED).
 * We deliberately exclude PENDING / RETRY lifecycle noise.
 */
const INBOX_FAILURE_CATEGORIES = new Set([
  "report_failure",
  "verification_package_failure",
  "ots_failure",
]);

const FAILURE_CATEGORY_LABELS: Record<string, string> = {
  report_failure: "Report generation",
  verification_package_failure: "Verification package",
  ots_failure: "Blockchain anchoring",
};

/** Latest-delivery statuses we treat as an actionable failure. */
const FAILED_DELIVERY_STATUSES = new Set(["FAILED", "UNDELIVERED"]);

function statusLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function roundToOneDp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function deliveryStatusLabel(s: string): string {
  switch (s.toUpperCase()) {
    case "QUEUED":
      return "Queued";
    case "SENT":
      return "Sent";
    case "DELIVERED":
      return "Delivered";
    case "FAILED":
    case "UNDELIVERED":
      return "Failed";
    case "RETRY_SCHEDULED":
      return "Retrying";
    case "CANCELLED":
      return "Cancelled";
    default:
      return statusLabel(s);
  }
}

// ============================================================================
// Builders
// ============================================================================

/** Set of evidence ids flagged by the integrity engines (real signal). */
function integrityFlaggedIds(cc: HomeCommandCenterInput | null): Set<string> {
  const ids = new Set<string>();
  for (const it of cc?.sections?.custodyIntegrityAnomalies?.items ?? []) {
    if (it.evidenceId) ids.add(it.evidenceId);
  }
  for (const it of cc?.sections?.deepIntegrityWatch?.items ?? []) {
    if (it.evidenceId) ids.add(it.evidenceId);
  }
  return ids;
}

function buildSubmissions(args: {
  inbox: HomeInboxInput | null;
  workspaceId: string | null;
}): SubmissionRow[] {
  const items = args.inbox?.items ?? [];
  const now = Date.now();
  return items
    .filter((it) => INTAKE_SUBMISSION_CATEGORIES.has(it.category))
    // Scope to the active workspace — the inbox aggregates across every
    // team the user belongs to, so we filter by context.teamId.
    .filter(
      (it) =>
        !args.workspaceId ||
        !it.context?.teamId ||
        String(it.context.teamId) === args.workspaceId,
    )
    .slice(0, 6)
    .map((it) => {
      const status = String(it.context?.status ?? "");
      const dueOverdue = it.dueAt ? Date.parse(it.dueAt) < now : false;
      return {
        id: it.id,
        title: String(it.context?.requestTitle ?? it.title),
        status,
        statusLabel: status ? statusLabel(status) : "Awaiting review",
        receivedAt: it.occurredAt,
        overdue: dueOverdue,
        href: it.href,
      };
    });
}

/** Index the latest delivery message per intake link (newest first). */
function latestDeliveryByLink(
  communications: HomeCommunicationsInput | null,
): Map<string, { messageId: string; channel: string; status: string; at: string | null }> {
  const latestByLink = new Map<
    string,
    { messageId: string; channel: string; status: string; at: string | null }
  >();
  const msgs = [...(communications?.messages ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  for (const m of msgs) {
    if (!m.relatedIntakeLinkId) continue;
    if (latestByLink.has(m.relatedIntakeLinkId)) continue;
    latestByLink.set(m.relatedIntakeLinkId, {
      messageId: m.id,
      channel: m.channel,
      status: m.status,
      at: m.deliveredAtUtc ?? m.sentAtUtc ?? m.failedAtUtc ?? m.createdAt,
    });
  }
  return latestByLink;
}

function buildCollection(args: {
  intakeLinks: HomeIntakeLinksInput | null;
  communications: HomeCommunicationsInput | null;
}): CollectionRow[] {
  const links = (args.intakeLinks?.links ?? []).filter(
    (l) => l.status === "ACTIVE",
  );
  const latestByLink = latestDeliveryByLink(args.communications);
  /*
   * BOUNDED ABOVE WHAT THE CARD SHOWS.
   *
   * This sliced to exactly five, and the Intake card renders five — so
   * `links.length > INTAKE_PREVIEW_LIMIT` could never be true and the
   * "View intake →" footer was unreachable for every workspace, however many
   * links it had. The projection has to carry at least one more than the card
   * displays for the card to be able to say there are more.
   *
   * Still bounded: this is a preview, not the intake list, and ten rows is the
   * most any Home card has ever needed to decide "is there more than this?".
   */
  return links.slice(0, 10).map((l) => {
    const d = latestByLink.get(l.id) ?? null;
    return {
      id: l.id,
      label: l.recipientLabel ?? l.recipientPhone ?? l.workflowTemplateSlug ?? "Intake link",
      usedCount: l.usedCount,
      maxUses: l.maxUses,
      expiresAtUtc: l.expiresAtUtc,
      delivery: d
        ? {
            messageId: d.messageId,
            channel: d.channel,
            status: d.status,
            statusLabel: deliveryStatusLabel(d.status),
            failed: FAILED_DELIVERY_STATUSES.has(d.status.toUpperCase()),
            at: d.at,
          }
        : null,
      // Opens the real intake-links page with this link's delivery
      // drawer pre-opened (the page reads ?linkId=).
      href: `/intake-links?linkId=${encodeURIComponent(l.id)}`,
    };
  });
}

/**
 * Request & Collect header counters — all derived from real state, no
 * estimates. `awaitingResponse` = ACTIVE links never used;
 * `failedDeliveries` = ACTIVE links whose latest send failed.
 */
/**
 * Phase HOME-FIELD-WIRING (Ticket 2) — every stat is a DISTINCT real
 * count. The old shape reused one `receivedSubmissions` number for two
 * pipeline stages; the pipeline now reads four independent sources:
 * intake links (IL), delivery messages (CM), and the two intake inbox
 * categories (IB), each counted separately.
 */
function buildCollectionStats(args: {
  intakeLinks: HomeIntakeLinksInput | null;
  communications: HomeCommunicationsInput | null;
  inbox: HomeInboxInput | null;
  workspaceId: string | null;
}): CollectionStats {
  const active = (args.intakeLinks?.links ?? []).filter(
    (l) => l.status === "ACTIVE",
  );
  const latestByLink = latestDeliveryByLink(args.communications);
  let failedDeliveries = 0;
  for (const l of active) {
    const d = latestByLink.get(l.id);
    if (d && FAILED_DELIVERY_STATUSES.has(d.status.toUpperCase())) {
      failedDeliveries += 1;
    }
  }

  // Confirmed deliveries — messages with a real deliveredAtUtc.
  const delivered = (args.communications?.messages ?? []).filter(
    (m) => m.deliveredAtUtc != null,
  ).length;

  // Workspace-scoped UNSLICED inbox counts per intake category (the
  // SubmissionRow list is capped at 6 for display; stage counts must
  // not inherit that cap).
  const inWorkspace = (it: NonNullable<HomeInboxInput["items"]>[number]) =>
    !args.workspaceId ||
    !it.context?.teamId ||
    String(it.context.teamId) === args.workspaceId;
  const items = args.inbox?.items ?? [];
  const pendingReview = items.filter(
    (it) => it.category === "intake_submission_pending_review" && inWorkspace(it),
  ).length;
  const needsMoreInfo = items.filter(
    (it) => it.category === "intake_required_items_missing" && inWorkspace(it),
  ).length;

  return {
    activeLinks: active.length,
    delivered,
    awaitingResponse: active.filter((l) => (l.usedCount ?? 0) === 0).length,
    pendingReview,
    needsMoreInfo,
    failedDeliveries,
  };
}

/**
 * "Needs fixing" — real operational failures from the inbox, scoped to
 * the active workspace. Same workspace-scoping tolerance as submissions:
 * include items with no teamId context, or whose teamId matches.
 */
function buildNeedsFixing(args: {
  inbox: HomeInboxInput | null;
  workspaceId: string | null;
}): NeedsFixingRow[] {
  const items = args.inbox?.items ?? [];
  return items
    .filter((it) => INBOX_FAILURE_CATEGORIES.has(it.category))
    .filter(
      (it) =>
        !args.workspaceId ||
        !it.context?.teamId ||
        String(it.context.teamId) === args.workspaceId,
    )
    .slice(0, 6)
    .map((it) => {
      const failureCode = String(it.context?.failureCode ?? "");
      // OTS global-budget exhaustion is terminal; everything else is
      // operator-actionable (often transient infra).
      const critical =
        it.category === "ots_failure"
          ? failureCode.includes("OTS_GLOBAL_BUDGET_EXHAUSTED")
          : false;
      return {
        id: it.id,
        category: it.category,
        categoryLabel: FAILURE_CATEGORY_LABELS[it.category] ?? statusLabel(it.category),
        title: it.title,
        detail: it.body ?? "",
        critical,
        occurredAt: it.occurredAt,
        href: it.href,
      };
    });
}

function buildRecentEvidence(args: {
  cc: HomeCommandCenterInput | null;
  reportsInput: HomeReportsInput | null;
  flagged: Set<string>;
}): RecentEvidenceRow[] {
  const items = args.cc?.sections?.recentEvidence?.items ?? [];
  if (items.length > 0) {
    return items.slice(0, 5).map((it) => ({
      id: it.id,
      title: it.title || it.id,
      status: it.status,
      verificationStatus: it.verificationStatus ?? null,
      needsAttention: args.flagged.has(it.id),
      createdAt: it.createdAt,
      href: `/evidence/${encodeURIComponent(it.id)}`,
    }));
  }
  // Fallback: reports prove evidence exists when recentEvidence is empty.
  const reports = args.reportsInput?.items ?? [];
  return reports.slice(0, 5).map((r) => ({
    id: r.evidenceId,
    title: r.title || r.evidenceId,
    status: r.status ?? "SIGNED",
    verificationStatus: null,
    needsAttention: args.flagged.has(r.evidenceId),
    createdAt: r.createdAt ?? r.report?.generatedAtUtc ?? new Date(0).toISOString(),
    href: `/evidence/${encodeURIComponent(r.evidenceId)}`,
  }));
}

function buildRecentReports(
  reportsInput: HomeReportsInput | null,
): RecentReportRow[] {
  const items = reportsInput?.items ?? [];
  return items
    .filter((r) => r.report?.available)
    .slice(0, 5)
    .map((r) => {
      const evidenceId = r.evidenceId;
      const open = `/evidence/${encodeURIComponent(evidenceId)}`;
      // Phase HOME-PROOF — these are API paths (not app routes). The UI
      // calls them through apiFetch and opens the returned presigned
      // URL in a new tab. The previous shape rendered them as <a href>
      // which navigated to the API host without an Authorization
      // header and 404'd.
      const reportPdfApiPath = r.report?.available
        ? `/v1/evidence/${encodeURIComponent(evidenceId)}/report/latest`
        : null;
      const packageZipApiPath = r.package?.available
        ? `/v1/evidence/${encodeURIComponent(evidenceId)}/verification-package`
        : null;
      // Canonical public verify page is /verify/:evidenceId (the
      // [token] route segment accepts the evidence id — matches
      // buildVerificationUrl in evidence-library-formatters.ts).
      const verify = r.package?.available
        ? `/verify/${encodeURIComponent(evidenceId)}`
        : null;
      return {
        evidenceId,
        evidenceTitle: r.title ?? evidenceId,
        version: r.report?.version ?? null,
        generatedAtUtc: r.report?.generatedAtUtc ?? null,
        reportReady: r.report?.available === true,
        packageReady: r.package?.available === true,
        href: open,
        actions: { open, reportPdfApiPath, packageZipApiPath, verify },
      };
    });
}

function buildCaseHealth(cc: HomeCommandCenterInput | null): CaseHealthRow[] {
  const topCases = cc?.sections?.caseOperations?.data?.topCases ?? [];
  const out: CaseHealthRow[] = [];
  for (const c of topCases) {
    const unreviewed = c.unreviewedCount ?? 0;
    const overdue = c.overdueReviewCount ?? 0;
    const escalations = c.openEscalationsCount ?? 0;
    // Only surface cases that carry a real incompleteness/blocker signal.
    if (unreviewed === 0 && overdue === 0 && escalations === 0) continue;
    const reasons: string[] = [];
    if (unreviewed > 0) reasons.push(`${unreviewed} unreviewed`);
    if (overdue > 0) reasons.push(`${overdue} overdue`);
    if (escalations > 0) reasons.push(`${escalations} blocked`);
    out.push({
      caseId: c.caseId,
      caseName: c.caseName,
      evidenceCount: c.evidenceCount,
      unreviewedCount: unreviewed,
      overdueReviewCount: overdue,
      openEscalationsCount: escalations,
      hasActiveLegalHold: c.hasActiveLegalHold === true,
      reason: reasons.join(" · "),
      href: `/cases/${encodeURIComponent(c.caseId)}`,
    });
  }
  return out.slice(0, 5);
}

function buildTrustState(
  summary: HomeTrustSummaryInput | null,
): TrustState {
  const s = summary ?? {};
  const totalEvidence = s.totalEvidence ?? 0;
  return {
    totalEvidence,
    tsaStamped: s.tsa?.stamped ?? 0,
    tsaPending: s.tsa?.pending ?? 0,
    tsaFailed: s.tsa?.failed ?? 0,
    tsaNone: s.tsa?.none ?? 0,
    otsAnchored: s.ots?.anchored ?? 0,
    otsPending: s.ots?.pending ?? 0,
    otsFailed: s.ots?.failed ?? 0,
    otsNone: s.ots?.none ?? 0,
    signed: s.signed ?? 0,
    endToEndReady: s.endToEndReady ?? 0,
    signedWithoutReport: s.signedWithoutReport ?? 0,
    reportedWithoutPackage: s.reportedWithoutPackage ?? 0,
    verifyPublished: s.publicVerify?.published ?? 0,
    verifySuspended: s.publicVerify?.suspended ?? 0,
    needingAttention: s.needingAttention ?? 0,
    empty: totalEvidence === 0,
  };
}

/**
 * Capacity projection from REAL inputs only. If `evidenceCount` records
 * consume `usagePercent`% of the quota, the average record fills
 * `usagePercent/evidenceCount`% — so the remaining `(100 − usagePercent)`%
 * holds roughly `evidenceCount·(100/usagePercent − 1)` more records. We
 * never fabricate a byte size; when we can't compute honestly we return
 * null and the UI simply omits the forecast.
 */
function forecastRecordsRemaining(
  usagePercent: number | null,
  evidenceCount: number,
): number | null {
  if (usagePercent == null || !Number.isFinite(usagePercent)) return null;
  if (usagePercent <= 0 || usagePercent >= 100) return null;
  if (evidenceCount <= 0) return null;
  const remaining = Math.floor(evidenceCount * (100 / usagePercent - 1));
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  return remaining;
}

function buildStorage(
  billing: HomeBillingInput | null,
  evidenceCount: number,
): StorageUsage | null {
  const s = billing?.workspaces?.personal?.storage;
  if (!s) return null;
  const polishLabel = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const m = raw.match(/^(\d+(?:\.\d+)?)(\s.*)$/);
    if (!m) return raw;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return raw;
    const rounded =
      Math.abs(n - Math.round(n)) < 0.005
        ? String(Math.round(n))
        : n.toFixed(2).replace(/\.?0+$/, "");
    return `${rounded}${m[2]}`;
  };
  const usagePercent =
    typeof s.usagePercent === "number" ? roundToOneDp(s.usagePercent) : null;
  return {
    usedLabel: polishLabel(s.usedLabel),
    limitLabel: polishLabel(s.limitLabel),
    usagePercent,
    nearLimit: s.nearLimit === true,
    limitReached: s.limitReached === true,
    forecastRecords: forecastRecordsRemaining(usagePercent, evidenceCount),
    upgradeHref: "/billing",
  };
}

const ACTIVITY_KIND_LABELS: Record<string, { kind: ActivityEvent["kind"]; label: string }> = {
  evidence_finalized: { kind: "evidence_finalized", label: "Evidence finalized" },
  report_generated: { kind: "report_generated", label: "Report generated" },
  package_generated: { kind: "package_generated", label: "Verification package generated" },
  hold_placed: { kind: "hold_placed", label: "Legal hold placed" },
  hold_released: { kind: "hold_released", label: "Legal hold released" },
  // Phase HOME-FIELD-WIRING (Ticket 3C) — timeline kinds the API
  // already emitted but the VM silently filtered. Self-serve labels;
  // raw event names never leak to the UI.
  lifecycle_transition: { kind: "lifecycle_transition", label: "Evidence lifecycle updated" },
  destruction_review: { kind: "destruction_review", label: "Retention review recorded" },
  // Phase HOME-INTELLIGENCE — projected by the new command-center
  // timeline source over Evidence.publicVerifyPublishedAtUtc.
  verification_published: { kind: "verification_published", label: "Verification published" },
};

function dayBucket(iso: string, nowMs: number): "today" | "yesterday" | "earlier" {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "earlier";
  const dayMs = 86_400_000;
  const startOfToday = Math.floor(nowMs / dayMs) * dayMs;
  if (t >= startOfToday) return "today";
  if (t >= startOfToday - dayMs) return "yesterday";
  return "earlier";
}

function buildActivity(args: {
  cc: HomeCommandCenterInput | null;
  reportsInput: HomeReportsInput | null;
  intakeLinks: HomeIntakeLinksInput | null;
  communications: HomeCommunicationsInput | null;
  inbox: HomeInboxInput | null;
  submissions: SubmissionRow[];
  nowMs: number;
}): ActivityGroup[] {
  const events: ActivityEvent[] = [];
  const linkLabelById = new Map<string, string>();
  for (const link of args.intakeLinks?.links ?? []) {
    const label =
      link.recipientLabel?.trim() ||
      link.recipientPhone?.trim() ||
      link.workflowTemplateSlug?.trim() ||
      "Intake link";
    linkLabelById.set(link.id, label);
  }

  // 0. Intake submission lifecycle — a real external contributor sent
  //    evidence. occurredAt is the genuine inbox receipt time.
  for (const sub of args.submissions) {
    if (!sub.receivedAt) continue;
    events.push({
      id: `sub:${sub.id}`,
      kind: "submission_received",
      label: `Submission received — ${sub.title}`,
      occurredAt: sub.receivedAt,
      href: sub.href,
    });
  }
  for (const item of args.inbox?.items ?? []) {
    if (
      item.category !== "intake_required_items_missing" ||
      !item.occurredAt
    ) {
      continue;
    }
    events.push({
      id: `req-more:${item.id}`,
      kind: "request_more_sent",
      label: `Request more sent — ${item.title}`,
      occurredAt: item.occurredAt,
      href: item.href,
    });
  }

  // 1. command-center.timeline — real evidence/report/package/hold events.
  for (const it of args.cc?.sections?.timeline?.items ?? []) {
    const mapped = ACTIVITY_KIND_LABELS[(it.kind ?? "").toLowerCase()];
    if (!mapped || !it.occurredAt) continue;
    // Phase HOME-POLISH — never render "… — Untitled" spam: when the
    // backend label carries no real entity name, fall back to the
    // canonical event label instead.
    const rawLabel = (it.label ?? "").trim();
    const isUntitled =
      rawLabel.length === 0 || /\buntitled\b\s*$/i.test(rawLabel);
    events.push({
      id: `tl:${it.id}`,
      kind: mapped.kind,
      label: isUntitled ? mapped.label : rawLabel,
      occurredAt: it.occurredAt,
      href: it.href ?? "/notifications",
    });
  }

  // 2. Intake link creation — real createdAt from the links list.
  for (const l of args.intakeLinks?.links ?? []) {
    if (!l.createdAt) continue;
    const label = linkLabelById.get(l.id) ?? "Intake link";
    events.push({
      id: `link:${l.id}`,
      kind: "intake_link_created",
      label: `Intake link created — ${label}`,
      occurredAt: l.createdAt,
      href: `/intake-links?linkId=${encodeURIComponent(l.id)}`,
    });
  }

  // 3. Delivery events — real sent/delivered/failed from communications.
  for (const m of args.communications?.messages ?? []) {
    const linkLabel = m.relatedIntakeLinkId
      ? linkLabelById.get(m.relatedIntakeLinkId)
      : null;
    if (m.deliveredAtUtc) {
      events.push({
        id: `msg-d:${m.id}`,
        kind: "intake_delivered",
        label: linkLabel
          ? `Intake link delivered — ${linkLabel}`
          : `Intake link delivered (${m.channel})`,
        occurredAt: m.deliveredAtUtc,
        href: "/intake-links",
      });
    } else if (m.failedAtUtc) {
      events.push({
        id: `msg-f:${m.id}`,
        kind: "intake_failed",
        label: linkLabel
          ? `Delivery failed — ${linkLabel}`
          : `Intake delivery failed (${m.channel})`,
        occurredAt: m.failedAtUtc,
        href: "/intake-links",
      });
    }
  }

  // Dedup + newest first + cap.
  const seen = new Set<string>();
  const deduped: ActivityEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    deduped.push(e);
  }
  deduped.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const capped = deduped.slice(0, 12);

  // Group by relative day.
  const groups: Record<"today" | "yesterday" | "earlier", ActivityEvent[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const e of capped) {
    groups[dayBucket(e.occurredAt, args.nowMs)].push(e);
  }

  // Phase HOME-INTELLIGENCE — collapse identical labels inside one day
  // bucket ("Report generated" ×3 → one row with repeatCount). The
  // newest occurrence keeps its id/time/href; titled events with
  // distinct labels never merge.
  const collapse = (list: ActivityEvent[]): ActivityEvent[] => {
    const byLabel = new Map<string, ActivityEvent>();
    for (const e of list) {
      const k = `${e.kind}:${e.label}`;
      const prior = byLabel.get(k);
      if (!prior) {
        byLabel.set(k, { ...e });
      } else {
        prior.repeatCount = (prior.repeatCount ?? 1) + 1;
      }
    }
    return [...byLabel.values()];
  };

  const out: ActivityGroup[] = [];
  if (groups.today.length) out.push({ key: "today", label: "Today", events: collapse(groups.today) });
  if (groups.yesterday.length)
    out.push({ key: "yesterday", label: "Yesterday", events: collapse(groups.yesterday) });
  if (groups.earlier.length)
    out.push({ key: "earlier", label: "Earlier", events: collapse(groups.earlier) });
  return out;
}

function buildTeamWork(args: {
  /** SERVER-projected `planFeatures.teamCollaborationIncluded` (fail-closed). */
  teamCollaborationIncluded: boolean;
  activeSpaceType: ActiveSpaceType;
  orgs: HomeOrgsInput | null;
  workspaceId: string | null;
  submissionsCount: number;
  reportsToday: number;
}): TeamWork | null {
  // Team Work is ONLY meaningful inside an organization workspace.
  // A PRO user sitting in their Personal Space must NOT see it, even
  // if they belong to a team elsewhere (Phase 10 rule).
  if (args.activeSpaceType !== "ORGANIZATION") return null;
  if (!args.teamCollaborationIncluded) return null;
  const orgs = args.orgs ?? [];
  // Scope to the active workspace's org when we can match it; otherwise
  // fall back to the active orgs the user owns.
  const active = orgs.filter((o) => o.membershipStatus === "ACTIVE");
  const scoped = args.workspaceId
    ? active.filter((o) => o.id === args.workspaceId)
    : active;
  const orgsForCount = scoped.length > 0 ? scoped : active;
  const members = orgsForCount.reduce((sum, o) => sum + (o.memberCount ?? 0), 0);
  const pending = orgs.filter((o) => o.membershipStatus === "PENDING").length;
  return {
    submissionsAwaitingReview: args.submissionsCount,
    reportsToday: args.reportsToday,
    members,
    pendingInvites: pending,
    manageHref: "/collaboration-teams",
  };
}

/**
 * Phase HOME-POLISH — onboarding is for TRULY NEW users only. The card
 * is the compact "Start your first evidence workflow" with the four
 * core steps. Intake/teammate steps were removed from onboarding —
 * they reappear naturally as Workspace Priorities once real work
 * exists.
 */
function buildChecklist(args: {
  evidenceCount: number;
  caseCount: number;
  reportCount: number;
  verifyPublished: number;
}): ChecklistStep[] {
  return [
    {
      key: "capture_first",
      label: "Capture evidence",
      done: args.evidenceCount > 0,
      visible: true,
      href: "/capture",
    },
    {
      key: "create_first_case",
      label: "Create a case",
      done: args.caseCount > 0,
      visible: true,
      href: "/cases",
    },
    {
      key: "first_report",
      label: "Generate report",
      done: args.reportCount > 0,
      visible: true,
      href: "/reports",
    },
    {
      key: "share_verification",
      label: "Share verification",
      // Real signal: at least one public verification page is live.
      done: args.verifyPublished > 0,
      visible: true,
      href: "/evidence",
    },
  ];
}

/**
 * Phase HOME-INTELLIGENCE — ranked Workspace Priorities for ACTIVE
 * users. Each rule combines REAL operational counters across domains
 * and carries a plain-language reason + recommended action. Ranking:
 * critical > warning > info, ties broken by affected count. Zero-count
 * rules never emit; zero data emits nothing (the UI shows all-clear).
 */
/**
 * Fold the workspace's open operational conditions into the priority list.
 *
 * DEDUPE IS SEMANTIC, NOT TEXTUAL. A condition whose representation is MERGE
 * names the Home priority that already states the same fact, by key. Where that
 * priority is present the condition adds nothing — the Home row is derived from
 * an uncapped aggregate and already carries the real count and the right
 * action, whereas the condition is a bounded scan of the same subject. Where it
 * is ABSENT the condition is still not invented as a row: its absence means the
 * aggregate said zero, and two sources disagreeing is not a reason to show the
 * quieter one twice. Either way, nothing is matched on a display string.
 *
 * PLATFORM_INTERNAL conditions collapse into one advisory row however many
 * there are, because they are the same platform fault seen from one workspace.
 *
 * An unrecognised source id produces the version-skew row — never silence.
 */
function mergeOperationalConditions(
  derived: WorkspacePriority[],
  groups: ReadonlyArray<HomeOperationsConditionGroup> | null,
): WorkspacePriority[] {
  if (!groups || groups.length === 0) return derived;

  const out = [...derived];
  const present = new Set(derived.map((p) => p.key));
  let platformConditions = 0;
  let unrecognised = 0;

  for (const group of groups) {
    if (!group || typeof group.sourceId !== "string") continue;
    if (group.statusPosture && group.statusPosture !== "OPEN") continue;

    const representation = representationFor(group.sourceId);
    if (!representation) {
      unrecognised += 1;
      continue;
    }

    if (representation.kind === "MERGE") {
      // Accounted for by an existing row (or by an aggregate that said zero).
      continue;
    }
    if (representation.kind === "PLATFORM") {
      platformConditions += group.conditionCount || 1;
      continue;
    }

    const key = `ops:${group.sourceId}` as WorkspacePriority["key"];
    if (present.has(key)) continue;
    present.add(key);
    out.push({
      key,
      severity: representation.severity,
      domains: [...representation.domains],
      // The condition count is the real one the projection carries; the record
      // count is used where the source counts records rather than conditions.
      count: group.affectedRecordCount ?? group.conditionCount ?? 1,
      label: representation.label,
      whyItMatters: representation.whyItMatters,
      recommendedAction: representation.recommendedAction,
      actionLabel: representation.actionLabel,
      href: representation.href,
      derivedFrom: [`ops/summary.groups.${group.sourceId}`],
    });
  }

  if (platformConditions > 0) {
    out.push({
      ...PLATFORM_ADVISORY_PRIORITY,
      key: PLATFORM_ADVISORY_PRIORITY.key as WorkspacePriority["key"],
      domains: [...PLATFORM_ADVISORY_PRIORITY.domains],
      count: platformConditions,
      derivedFrom: ["ops/summary.groups[audience=PLATFORM_INTERNAL]"],
    });
  }
  if (unrecognised > 0) {
    out.push({
      ...UNRECOGNISED_SOURCE_PRIORITY,
      key: UNRECOGNISED_SOURCE_PRIORITY.key as WorkspacePriority["key"],
      domains: [...UNRECOGNISED_SOURCE_PRIORITY.domains],
      count: unrecognised,
      derivedFrom: ["ops/summary.groups[sourceId not in HOME_CONDITION_REPRESENTATION]"],
    });
  }

  // Same ordering rule the rest of Home uses: severity first, order preserved
  // within a severity so derived rows keep precedence over condition rows.
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank[a.p.severity] - rank[b.p.severity] || a.i - b.i)
    .map((x) => x.p);
}

function buildWorkspacePriorities(args: {
  /** SERVER-projected `planFeatures.intakeIncluded` (fail-closed). */
  intakeIncluded: boolean;
  trust: TrustState;
  pipeline: PipelineData;
  submissionsCount: number;
  collectionStats: CollectionStats;
  reportCount: number;
  mattersNeedingWork: number;
  reportsReady: number;
  storage: StorageUsage | null;
}): WorkspacePriority[] {
  const p = args.pipeline ?? null;
  const out: WorkspacePriority[] = [];

  // ---- critical -----------------------------------------------------------
  if (args.storage?.limitReached) {
    out.push({
      key: "storage_pressure",
      severity: "critical",
      domains: ["storage"],
      count: 1,
      label: "Storage limit reached",
      whyItMatters: "New captures are blocked until space is freed or the plan is topped up.",
      recommendedAction: "Manage storage or upgrade before capturing more evidence.",
      actionLabel: "Manage storage",
      href: "/billing",
      derivedFrom: ["billing/overview.workspaces.personal.storage.limitReached"],
    });
  }
  if (args.trust.tsaFailed > 0) {
    out.push({
      key: "tsa_failures",
      severity: "critical",
      domains: ["trust", "evidence"],
      count: args.trust.tsaFailed,
      label: `${args.trust.tsaFailed} TSA timestamp${args.trust.tsaFailed === 1 ? "" : "s"} failed`,
      whyItMatters: "Failed timestamping weakens time-based evidence confidence for these records.",
      recommendedAction: "Open the affected records and review their timestamp state.",
      actionLabel: "Open affected records",
      // Phase HOME-CTA-NORMALIZATION — single source of truth.
      href: HOME_TSA_FAILURES_HREF,
      derivedFrom: ["dashboard/trust-summary.tsa.failed"],
    });
  }
  if (args.trust.otsFailed > 0) {
    // ==================================================================
    // CLOSURE PASS (2026-08-22) — THIS ROW STOPPED READING THE MAILBOX.
    //
    // It counted `needsFixing.filter(critical).length`, and `needsFixing`
    // is built from the caller's own `/v1/me/inbox` items — its own
    // `derivedFrom` said so: "me/inbox.category=ots_failure...". So the
    // number of TERMINAL ANCHORING FAILURES in a workspace fell when one
    // person archived a notification, and two operators saw two different
    // counts for a fact about the records themselves.
    //
    // It was also CAPPED: the feed pulls at most PER_CATEGORY_TAKE rows per
    // category, so a workspace with more failures than the cap silently
    // under-reported. `trust.otsFailed` is the canonical dashboard/
    // trust-summary aggregate over Evidence — uncapped, shared, and the same
    // number the Verification Summary already shows on the Operations tab.
    //
    // The CTA moved with it: a notification list is not where you fix an
    // unanchored record; the filtered Evidence view is.
    // ==================================================================
    out.push({
      key: "anchoring_terminal",
      severity: "critical",
      domains: ["trust", "evidence"],
      count: args.trust.otsFailed,
      label: `${args.trust.otsFailed} anchoring failure${args.trust.otsFailed === 1 ? "" : "s"} are terminal`,
      whyItMatters: "Blockchain anchoring cannot be retried for these records — they will stay unanchored.",
      recommendedAction: "Open each failure to decide how to document the gap.",
      actionLabel: "Open affected records",
      href: HOME_ANCHORING_FAILURES_HREF,
      derivedFrom: ["dashboard/trust-summary.ots.failed"],
    });
  }

  // ---- warning ------------------------------------------------------------
  if (args.trust.needingAttention > 0) {
    out.push({
      key: "resolve_integrity",
      severity: "warning",
      domains: ["trust", "evidence"],
      count: args.trust.needingAttention,
      label: `${args.trust.needingAttention} record${args.trust.needingAttention === 1 ? "" : "s"} need integrity review`,
      whyItMatters: "These records may not be ready for trusted reports or external verification.",
      recommendedAction: "Review each flagged record's integrity verdict.",
      actionLabel: "Review integrity",
      // Phase HOME-CTA-NORMALIZATION — single source of truth shared
      // by this priority, the Operational Queue "Records need an
      // integrity review" CTA, and any future surface.
      href: HOME_INTEGRITY_REVIEW_HREF,
      derivedFrom: ["dashboard/trust-summary.needingAttention"],
    });
  }
  if (args.submissionsCount > 0) {
    out.push({
      key: "review_submissions",
      severity: "warning",
      domains: ["intake"],
      count: args.submissionsCount,
      label: `${args.submissionsCount} submission${args.submissionsCount === 1 ? "" : "s"} waiting for review`,
      whyItMatters: "External evidence is not part of the trusted record until you review it.",
      recommendedAction: "Review and accept or return each submission.",
      actionLabel: "Review submissions",
      // The intake queue is where a submission is reviewed; a notification
      // list is not. Free and paid users alike land on the same surface,
      // because reviewing your own intake is not a workbench action.
      href: "/evidence-requests?status=RESPONSE_RECEIVED,UNDER_REVIEW",
      derivedFrom: ["dashboard/trust-summary.intake.submissionsAwaitingReview"],
    });
  }
  const packagesMissing =
    p?.packages?.queued ?? p?.packages?.missingFromReported ?? 0;
  if (packagesMissing > 0) {
    out.push({
      key: "complete_packages",
      severity: "warning",
      domains: ["report", "package"],
      count: packagesMissing,
      label: `${packagesMissing} package${packagesMissing === 1 ? " is" : "s are"} missing`,
      whyItMatters: "Verification packages are needed for portable external review of reported evidence.",
      recommendedAction: "Complete the missing packages from the reports surface.",
      actionLabel: "Complete packages",
      href: "/reports",
      derivedFrom: ["dashboard/command-center.pipelineDetail.packages.queued"],
    });
  }
  if (args.mattersNeedingWork > 0) {
    out.push({
      key: "matters_need_reports",
      severity: "warning",
      domains: ["matter", "report"],
      count: args.mattersNeedingWork,
      label: `${args.mattersNeedingWork} matter${args.mattersNeedingWork === 1 ? "" : "s"} need${args.mattersNeedingWork === 1 ? "s" : ""} evidence work`,
      whyItMatters: "These matters have gaps or missing deliverables in their evidence chain.",
      recommendedAction: "Open each matter and complete its report, package, or review work.",
      actionLabel: "Open matters",
      href: "/cases",
      derivedFrom: [
        "dashboard/command-center.caseOperations.topCases",
        "reports.items.caseId",
      ],
    });
  }
  if (args.storage?.nearLimit && !args.storage.limitReached) {
    out.push({
      key: "storage_pressure",
      severity: "warning",
      domains: ["storage"],
      count: 1,
      label: "Storage is close to its limit",
      whyItMatters: "Uploads may be blocked if the workspace reaches its storage limit.",
      recommendedAction: "Free space or extend storage before it runs out.",
      actionLabel: "Manage storage",
      href: "/billing",
      derivedFrom: ["billing/overview.workspaces.personal.storage.nearLimit"],
    });
  }
  if (args.trust.otsPending > 0) {
    out.push({
      key: "ots_pending",
      severity: "warning",
      domains: ["trust"],
      count: args.trust.otsPending,
      label: `${args.trust.otsPending} OTS proof${args.trust.otsPending === 1 ? " is" : "s are"} still pending`,
      whyItMatters: "Bitcoin anchoring can take time, but long-pending proofs should be checked.",
      recommendedAction: "Review the anchoring status of the pending records.",
      actionLabel: "Review anchoring",
      // Phase HOME-CTA-NORMALIZATION — single source of truth.
      href: HOME_OTS_PENDING_HREF,
      derivedFrom: ["dashboard/trust-summary.ots.pending"],
    });
  }

  // ---- info ---------------------------------------------------------------
  const unpublished = p?.publicVerify?.unpublished ?? 0;
  if (unpublished > 0 && args.reportCount > 0) {
    out.push({
      key: "publish_verification",
      severity: "info",
      domains: ["verification", "report"],
      count: unpublished,
      label: `${unpublished} record${unpublished === 1 ? " is" : "s are"} ready but not publicly verifiable`,
      whyItMatters: "External recipients cannot independently verify these records yet.",
      recommendedAction: "Publish their verification pages so links can be shared.",
      actionLabel: "Publish verification",
      // Phase HOME-CTA-NORMALIZATION — single source of truth.
      href: HOME_PUBLISH_VERIFICATION_HREF,
      derivedFrom: ["dashboard/command-center.pipelineDetail.publicVerify.unpublished"],
    });
  }
  if (args.reportsReady > 0) {
    out.push({
      key: "reports_ready",
      severity: "info",
      domains: ["report"],
      count: args.reportsReady,
      label: `${args.reportsReady} report${args.reportsReady === 1 ? " is" : "s are"} ready to share`,
      whyItMatters: "These records already have report output available for download or review.",
      recommendedAction: "Open report production to download or share them.",
      actionLabel: "Open reports",
      href: "/reports",
      derivedFrom: ["dashboard/command-center.pipelineDetail.reports.ready"],
    });
  }
  if (args.intakeIncluded && args.collectionStats.activeLinks === 0) {
    out.push({
      key: "create_intake_link",
      severity: "info",
      domains: ["intake"],
      count: 1,
      label: "Create an intake link to request evidence",
      whyItMatters: "Evidence from clients, witnesses, or sources arrives tracked and reviewable.",
      recommendedAction: "Create a secure intake link and send it to your contributor.",
      actionLabel: "Create link",
      href: "/intake-links?new=1",
      derivedFrom: ["workflow/intake-links.links.status=ACTIVE"],
    });
  }

  // Rank: severity first, then affected count.
  const rank = { critical: 2, warning: 1, info: 0 } as const;
  out.sort((a, b) => rank[b.severity] - rank[a.severity] || b.count - a.count);
  return out.slice(0, 5);
}

/**
 * Phase HOME-EXEC — compose the executive summary from the decision
 * engine + raw trust counters. Status floor rules (spec):
 *   - TSA failures / terminal anchoring / storage limit  → critical
 *   - integrity attention / failed output / suspended    → action_required
 *   - OTS pending, unsigned, submissions, gaps, near-limit→ needs_attention
 *   - none of the above (with data)                       → healthy
 *   - zero data                                           → onboarding
 * Never "healthy" while any trust/integrity signal is open.
 */
function buildExecutiveSummary(args: {
  showGettingStarted: boolean;
  trust: TrustState;
  priorities: WorkspacePriority[];
  reportProduction: ReportProduction;
  verificationHealth: VerificationHealth;
  storage: StorageUsage | null;
}): ExecutiveSummary {
  if (args.showGettingStarted) {
    return {
      overallStatus: "onboarding",
      statusLabel: "Getting started",
      summaryTitle: "Start your first evidence workflow",
      summarySentence:
        "Capture evidence, create a case, generate a report, and share verification — this summary becomes live workspace health as you work.",
      topCause: null,
      affectedCount: 0,
      recommendedAction: "Capture your first evidence record.",
      actionLabel: "Capture evidence",
      actionHref: "/capture",
      secondarySignals: [],
      derivedFrom: [
        "dashboard/trust-summary.totalEvidence",
        "reports.items.length",
        "dashboard/command-center.caseOperations.activeCasesCount",
      ],
    };
  }

  const failedOutput =
    args.reportProduction.reportsFailed + args.reportProduction.packagesFailed;
  const unsigned = Math.max(0, args.trust.totalEvidence - args.trust.signed);

  const overallStatus: ExecutiveSummary["overallStatus"] =
    args.trust.tsaFailed > 0 ||
    args.trust.otsFailed > 0 ||
    args.storage?.limitReached
      ? "critical"
      : args.trust.needingAttention > 0 ||
          failedOutput > 0 ||
          args.trust.verifySuspended > 0
        ? "action_required"
        : args.priorities.some((p) => p.severity !== "info") ||
            unsigned > 0 ||
            args.trust.otsPending > 0
          ? "needs_attention"
          : "healthy";

  const top = args.priorities[0] ?? null;
  const statusLabel =
    overallStatus === "critical"
      ? "Critical"
      : overallStatus === "action_required"
        ? "Action required"
        : overallStatus === "needs_attention"
          ? "Needs attention"
          : "Healthy";

  if (overallStatus === "healthy") {
    return {
      overallStatus,
      statusLabel,
      summaryTitle: "Workspace is healthy",
      summarySentence:
        "Evidence, reports, packages, and verification are operating normally.",
      topCause: null,
      affectedCount: 0,
      recommendedAction: null,
      actionLabel: null,
      actionHref: null,
      secondarySignals: args.priorities.slice(0, 2).map((p) => p.label),
      derivedFrom: [
        "dashboard/trust-summary.tsa.failed",
        "dashboard/trust-summary.needingAttention",
        "dashboard/trust-summary.ots.pending",
        "dashboard/command-center.pipelineDetail.reports.failed",
      ],
    };
  }

  // Sentence: the top cause + its consequence (from the decision).
  const summarySentence = top
    ? `${top.label} — ${top.whyItMatters}`
    : overallStatus === "needs_attention" && unsigned > 0
      ? `${unsigned} record${unsigned === 1 ? "" : "s"} are not signed yet — signing completes their integrity chain.`
      : "Operational signals need review.";

  return {
    overallStatus,
    statusLabel,
    summaryTitle: top?.label ?? "Workspace needs review",
    summarySentence,
    topCause: top?.label ?? null,
    affectedCount: top?.count ?? unsigned,
    recommendedAction: top?.recommendedAction ?? null,
    actionLabel: top?.actionLabel ?? null,
    actionHref: top?.href ?? null,
    secondarySignals: args.priorities.slice(1, 3).map((p) => p.label),
    derivedFrom: top
      ? top.derivedFrom
      : ["dashboard/trust-summary.signed", "dashboard/trust-summary.totalEvidence"],
  };
}

function pickHeroAction(args: {
  /** SERVER-projected `planFeatures.intakeIncluded` (fail-closed). */
  intakeIncluded: boolean;
  cc: HomeCommandCenterInput | null;
  submissions: SubmissionRow[];
  trust: TrustState;
  caseHealth: CaseHealthRow[];
  evidenceCount: number;
  caseCount: number;
  reportCount: number;
}): HeroAction {
  const pipeline = args.cc?.sections?.pipelineDetail?.data;

  // 1. Submissions awaiting review — the most time-sensitive external work.
  if (args.submissions.length > 0) {
    const n = args.submissions.length;
    return {
      kind: "review_submissions",
      title: `${n} submission${n === 1 ? "" : "s"} awaiting your review`,
      detail: "An external contributor sent evidence. Review, accept, or request more.",
      count: n,
      href: args.submissions[0].href,
      ctaLabel: "Review now",
      tone: "action",
    };
  }

  // 2. Reports that should exist but don't (signed evidence, no report).
  const missingReports =
    (pipeline?.reports?.missingFromSigned ?? 0) + (pipeline?.reports?.failed ?? 0);
  if (missingReports > 0) {
    return {
      kind: "generate_reports",
      title: `${missingReports} record${missingReports === 1 ? "" : "s"} need a report`,
      detail: "Signed evidence is ready to be finalized into a PDF report.",
      count: missingReports,
      href: "/reports",
      ctaLabel: "Generate reports",
      tone: "action",
    };
  }

  // 3. Packages missing for reported evidence.
  const missingPackages =
    (pipeline?.packages?.missingFromReported ?? 0) +
    (pipeline?.packages?.blocked ?? 0) +
    (pipeline?.packages?.failed ?? 0);
  if (missingPackages > 0) {
    return {
      kind: "complete_packages",
      title: `${missingPackages} verification package${missingPackages === 1 ? "" : "s"} to complete`,
      detail: "A report exists but its verification package didn't finish.",
      count: missingPackages,
      href: "/reports",
      ctaLabel: "Complete packages",
      tone: "warn",
    };
  }

  // 4. Integrity issues — real trust failures need a human.
  if (args.trust.needingAttention > 0) {
    return {
      kind: "fix_integrity",
      title: `${args.trust.needingAttention} record${args.trust.needingAttention === 1 ? "" : "s"} need an integrity review`,
      detail: "These records didn't pass an integrity check — review before sharing.",
      count: args.trust.needingAttention,
      // Phase HOME-CTA-NORMALIZATION — share the single integrity
      // href so the heroAction CTA, the Operational Queue card and the
      // Workspace Priorities row all open the exact same dataset that
      // matches `needingAttention`.
      href: HOME_INTEGRITY_REVIEW_HREF,
      ctaLabel: "Review integrity",
      tone: "warn",
    };
  }

  // 5. Verification ready but not published.
  const unpublished = pipeline?.publicVerify?.unpublished ?? 0;
  if (unpublished > 0 && args.reportCount > 0) {
    return {
      kind: "publish_verification",
      title: `${unpublished} record${unpublished === 1 ? "" : "s"} ready to publish`,
      detail: "Make a public verification link available so others can verify your evidence.",
      count: unpublished,
      // Phase HOME-CTA-NORMALIZATION — single source of truth.
      href: HOME_PUBLISH_VERIFICATION_HREF,
      ctaLabel: "Publish verification",
      tone: "action",
    };
  }

  // 6. Cases with gaps.
  if (args.caseHealth.length > 0) {
    return {
      kind: "complete_cases",
      title: `${args.caseHealth.length} case${args.caseHealth.length === 1 ? "" : "s"} need attention`,
      detail: "Some matters have unreviewed evidence or blockers.",
      count: args.caseHealth.length,
      href: args.caseHealth[0].href,
      ctaLabel: "Open case",
      tone: "warn",
    };
  }

  // 7. Onboarding fall-through.
  if (args.evidenceCount === 0) {
    return {
      kind: "capture_first",
      title: "Capture your first evidence record",
      detail: "Upload a file or capture from your camera to get started.",
      count: 0,
      href: "/capture",
      ctaLabel: "Capture evidence",
      tone: "calm",
    };
  }
  if (args.reportCount === 0) {
    return {
      kind: "generate_first_report",
      title: "Generate your first report",
      detail: "Turn a completed evidence record into a shareable PDF report.",
      count: 0,
      href: "/reports",
      ctaLabel: "Open Reports",
      tone: "calm",
    };
  }
  if (args.intakeIncluded) {
    return {
      kind: "request_evidence",
      title: "Request evidence from someone",
      detail: "Send a secure intake link to a client, source, witness, or contributor.",
      count: 0,
      href: "/intake-links",
      ctaLabel: "Create intake link",
      tone: "calm",
    };
  }
  return {
    kind: "caught_up",
    title: "You're all caught up",
    detail: "No submissions, reports, or integrity issues need you right now.",
    count: 0,
    href: "/capture",
    ctaLabel: "Capture evidence",
    tone: "calm",
  };
}

// ============================================================================
// Operational surface builders (world-class Home)
// ============================================================================

type PipelineData = NonNullable<
  NonNullable<HomeCommandCenterInput["sections"]>["pipelineDetail"]
>["data"];

/**
 * PHASE 4C (2026-08-22) — `buildOperationalQueue()` IS GONE.
 *
 * It assembled a workspace "operational queue" out of the caller's own
 * notification feed plus a handful of Home-local slices, and Home rendered the
 * result as workspace health. Nothing about it was shared: a second admin's
 * queue was a different queue over the same workspace, and every personal
 * read/archive/defer moved it.
 *
 * The replacement is `GET /v1/ops/summary`, backed by
 * `services/api/src/services/operations/operations-summary.service.ts`, which
 * counts SHARED `OperationalIncident` rows scoped to the workspace. Home
 * consumes that summary and links to /operations; it computes nothing and it
 * mutates nothing.
 */

// PHASE 4C (2026-08-22) — `failureType()` removed with the queue it mapped
// categories into. Its only caller was `buildOperationalQueue()`.

/**
 * Active Matters — the work-centric matter portfolio. Shows the most
 * relevant active cases (needs-work first, then on-track), each with a
 * real status. Sourced from command-center caseOperations.topCases.
 */
function buildActiveMatters(
  cc: HomeCommandCenterInput | null,
  /**
   * Phase HOME-INTELLIGENCE — caseIds that have at least one evidence
   * record with an available report (derived from /v1/reports
   * items[].caseId — already emitted, previously dropped).
   */
  reportCaseIds: ReadonlySet<string>,
): ActiveMatterRow[] {
  const topCases = cc?.sections?.caseOperations?.data?.topCases ?? [];
  const rows: ActiveMatterRow[] = topCases.map((c) => {
    const unreviewed = c.unreviewedCount ?? 0;
    const overdue = c.overdueReviewCount ?? 0;
    const escalations = c.openEscalationsCount ?? 0;
    // Phase HOME-DECISIONS — per-matter deliverable counts from the
    // bounded caseOperations aggregates; /v1/reports caseIds remain
    // the fallback for older payloads without the new fields.
    const reportsReadyCount =
      c.reportsReadyCount ?? (reportCaseIds.has(c.caseId) ? 1 : 0);
    const packagesReadyCount = c.packagesReadyCount ?? 0;
    const verifyLiveCount = c.verifyLiveCount ?? 0;
    const hasReport = reportsReadyCount > 0;

    // Deliverable-chain position (only real counts; "none" = no evidence).
    const verificationStatus: ActiveMatterRow["verificationStatus"] =
      c.evidenceCount === 0
        ? "none"
        : !hasReport
          ? "needs_report"
          : packagesReadyCount === 0
            ? "missing_package"
            : verifyLiveCount === 0
              ? "needs_publication"
              : "ready";

    const chainIncomplete =
      c.evidenceCount > 0 && verificationStatus !== "ready";
    const needsWork =
      unreviewed > 0 || overdue > 0 || escalations > 0 || chainIncomplete;
    const reasons: string[] = [];
    if (unreviewed > 0) reasons.push(`${unreviewed} unreviewed`);
    if (overdue > 0) reasons.push(`${overdue} overdue`);
    if (escalations > 0) reasons.push(`${escalations} blocked`);
    if (verificationStatus === "needs_report") reasons.push("no report yet");
    else if (verificationStatus === "missing_package") reasons.push("package missing");
    else if (verificationStatus === "needs_publication") reasons.push("verification not published");
    const verdict: ActiveMatterRow["verdict"] =
      escalations > 0 || overdue > 0
        ? "action_required"
        : needsWork
          ? "needs_work"
          : "healthy";
    return {
      caseId: c.caseId,
      caseName: c.caseName,
      evidenceCount: c.evidenceCount,
      unreviewedCount: unreviewed,
      overdueReviewCount: overdue,
      openEscalationsCount: escalations,
      hasActiveLegalHold: c.hasActiveLegalHold === true,
      lastActivityAtUtc: c.lastActivityAtUtc ?? null,
      needsWork,
      hasReport,
      reportsReadyCount,
      packagesReadyCount,
      verifyLiveCount,
      verificationStatus,
      verdict,
      statusLabel: reasons.length > 0 ? reasons.join(" · ") : "On track",
      href: `/cases/${encodeURIComponent(c.caseId)}`,
    };
  });
  // Action-required first, then needs-work, then healthy.
  const rank = { action_required: 2, needs_work: 1, healthy: 0 } as const;
  rows.sort((a, b) => rank[b.verdict] - rank[a.verdict]);
  return rows.slice(0, 6);
}

/**
 * Intake Pipeline — the collection lifecycle, not a link count. Every
 * stage count is a real number from intake links + communications +
 * the submission inbox.
 */
function buildIntakePipeline(args: {
  collection: CollectionRow[];
  stats: CollectionStats;
}): IntakePipeline {
  const s = args.stats;
  // Phase HOME-FIELD-WIRING (Ticket 2) — six stages, six DISTINCT
  // real counts (links / deliveries / unused links / the two intake
  // inbox categories / failed deliveries). No stage shares a source.
  const stages: IntakeStage[] = [
    { key: "active", label: "Active links", count: s.activeLinks, tone: "neutral" },
    { key: "delivered", label: "Delivered", count: s.delivered, tone: s.delivered > 0 ? "ok" : "neutral" },
    { key: "awaiting", label: "Awaiting response", count: s.awaitingResponse, tone: s.awaitingResponse > 0 ? "warn" : "neutral" },
    { key: "in_review", label: "Pending review", count: s.pendingReview, tone: s.pendingReview > 0 ? "warn" : "neutral" },
    { key: "needs_more", label: "Needs more info", count: s.needsMoreInfo, tone: s.needsMoreInfo > 0 ? "warn" : "neutral" },
    { key: "failed", label: "Failed sends", count: s.failedDeliveries, tone: s.failedDeliveries > 0 ? "danger" : "neutral" },
  ];
  return {
    stages,
    links: args.collection,
    empty:
      s.activeLinks === 0 &&
      args.collection.length === 0 &&
      s.pendingReview === 0 &&
      s.needsMoreInfo === 0,
  };
}

/**
 * Report Production — ready / pending / failed status for the
 * deliverables users pay for. Counts come from the command-center
 * pipeline projection; rows from the reports list.
 */
function buildReportProduction(args: {
  pipeline: PipelineData;
  recentReports: RecentReportRow[];
}): ReportProduction {
  const p = args.pipeline ?? null;
  const reportsReady =
    p?.reports?.ready ?? args.recentReports.filter((r) => r.reportReady).length;
  const packagesReady =
    p?.packages?.ready ?? args.recentReports.filter((r) => r.packageReady).length;
  // Phase HOME-FIELD-WIRING (Ticket 1) — pending double-count fix.
  // The command-center API emits `missingFromSigned` as a LITERAL
  // ALIAS of `reports.queued` (command-center.service.ts — both are
  // `reportsQueued = max(0, signed − reportsReady)`), and
  // `missingFromReported` as an alias of `packages.queued`. The old
  // `queued + missingFromSigned` sum therefore showed DOUBLE the real
  // backlog. Authoritative meaning of the single counter:
  //   reports.queued / missingFromSigned   = signed records with no
  //                                          report yet (eligible).
  //   packages.queued / missingFromReported = reported records with no
  //                                          package yet (eligible).
  //   *.failed                              = failed generation
  //                                          (OperationalIncident).
  // We read `queued` and fall back to its alias for older payloads —
  // never both.
  const reportsPending = p?.reports?.queued ?? p?.reports?.missingFromSigned ?? 0;
  const packagesPending =
    p?.packages?.queued ?? p?.packages?.missingFromReported ?? 0;
  const reportsFailed = p?.reports?.failed ?? 0;
  const packagesFailed = (p?.packages?.failed ?? 0) + (p?.packages?.blocked ?? 0);

  // Phase HOME-INTELLIGENCE — cross-signal "needs action" issues.
  // Every count is a real aggregate; failed deliverables live as
  // OperationalIncident inbox items, so the action routes there (no
  // fabricated retry — no retry endpoint exists for report jobs).
  const unpublished = p?.publicVerify?.unpublished ?? 0;
  const needsAction: DeliverableIssue[] = [];
  if (reportsFailed + packagesFailed > 0) {
    needsAction.push({
      key: "failed_deliverables",
      label: "Failed deliverables need attention",
      count: reportsFailed + packagesFailed,
      tone: "danger",
      actionLabel: "Open inbox",
      href: "/notifications",
    });
  }
  if (packagesPending > 0) {
    needsAction.push({
      key: "package_gap",
      label: "Reported evidence missing a package",
      count: packagesPending,
      tone: "warn",
      actionLabel: "Open reports",
      href: "/reports",
    });
  }
  if (reportsReady > 0 && unpublished > 0) {
    needsAction.push({
      key: "publish_ready",
      label: "Reports ready but verification not published",
      count: Math.min(reportsReady, unpublished),
      tone: "action",
      actionLabel: "Publish verification",
      href: "/evidence",
    });
  }

  return {
    reportsReady,
    packagesReady,
    reportsPending,
    packagesPending,
    reportsFailed,
    packagesFailed,
    needsAction,
    recent: args.recentReports,
  };
}

/**
 * Verification Health — the public-verify deliverable status. Counts are
 * the REAL publicVerifyState aggregates from trust-summary; verifiable
 * rows are reports whose package is ready (the public verify page works).
 */
function buildVerificationHealth(args: {
  trust: TrustState;
  recentReports: RecentReportRow[];
  pipeline: PipelineData;
  cc: HomeCommandCenterInput | null;
}): VerificationHealth {
  // Phase HOME-DECISIONS — recent publications from the timeline's
  // verification_published events (real publish timestamps).
  const recentPublications = (args.cc?.sections?.timeline?.items ?? [])
    .filter((it) => it.kind === "verification_published" && it.occurredAt)
    .sort((a, b) => ((a.occurredAt ?? "") < (b.occurredAt ?? "") ? 1 : -1))
    .slice(0, 3)
    .map((it) => ({
      label: it.label ?? "Verification published",
      href: it.href ?? "/evidence",
      occurredAt: it.occurredAt as string,
    }));
  const verifiable: VerifiableRecord[] = args.recentReports
    .filter((r) => r.packageReady && r.actions.verify)
    .slice(0, 5)
    .map((r) => ({
      evidenceId: r.evidenceId,
      title: r.evidenceTitle,
      verifyHref: r.actions.verify as string,
    }));

  // Phase HOME-INTELLIGENCE — cross-signal issues (all real aggregates).
  const p = args.pipeline ?? null;
  const packagesReady = p?.packages?.ready ?? 0;
  const verifyUnpublished = p?.publicVerify?.unpublished ?? 0;
  const packagesMissing =
    p?.packages?.queued ?? p?.packages?.missingFromReported ?? 0;
  const issues: DeliverableIssue[] = [];
  if (packagesReady > 0 && verifyUnpublished > 0) {
    issues.push({
      key: "publish_ready",
      label: "Package ready but verification not published",
      count: Math.min(packagesReady, verifyUnpublished),
      tone: "action",
      actionLabel: "Publish verification",
      href: "/evidence",
    });
  }
  if (packagesMissing > 0) {
    issues.push({
      key: "package_gap",
      label: "Report ready but package missing",
      count: packagesMissing,
      tone: "warn",
      actionLabel: "Open reports",
      href: "/reports",
    });
  }
  // Phase HOME-EXEC — suspended verification is action-required: a
  // previously shareable page is no longer externally verifiable.
  if (args.trust.verifySuspended > 0) {
    issues.unshift({
      key: "suspended_verification",
      label: "Suspended verification needs review",
      count: args.trust.verifySuspended,
      tone: "danger",
      actionLabel: "Open evidence",
      href: "/evidence",
    });
  }

  return {
    live: args.trust.verifyPublished,
    unpublished: args.trust.empty ? 0 : Math.max(0, args.trust.totalEvidence - args.trust.verifyPublished - args.trust.verifySuspended),
    suspended: args.trust.verifySuspended,
    verifiable,
    issues,
    recentPublications,
    empty: args.trust.empty,
  };
}

/**
 * Workspace Health — a single work-state overview. Each metric carries a
 * good/warning/problem verdict rather than being a raw inventory counter.
 */
function buildWorkspaceHealth(args: {
  pipeline: PipelineData;
  trust: TrustState;
  submissions: SubmissionRow[];
  needsFixing: NeedsFixingRow[];
  activeCasesCount: number;
  reportsReady: number;
  reportsPending: number;
  reportsFailed: number;
  packagesPending: number;
  packagesFailed: number;
  storage: StorageUsage | null;
}): WorkspaceHealthMetric[] {
  // Phase HOME-TRUTH-FIX —
  //   * "Records complete" → "Records reported" (label honesty: the
  //     metric counts evidence with status=REPORTED; "complete" reads
  //     as end-to-end deliverable-complete, which it is NOT).
  //   * Added "Operational issues" — sum of stuck-SIGNED +
  //     stuck-REPORTED + open report/package failure incidents +
  //     pending counts. The previous "Integrity issues" only counted
  //     `verificationStatus IN ('REVIEW_REQUIRED','FAILED')`, which
  //     STAYS 0 / GREEN during the puppeteer __name failure mode —
  //     the exact gap this fix closes.
  //   * "Reports ready" now uses `warn` tone when signed evidence
  //     exists but zero reports are ready (was permanently `neutral`
  //     at 0, hiding the failure visually).
  //   * "Integrity issues" wording deliberately kept narrow:
  //     verificationStatus-flagged records only. Deliverable-pipeline
  //     issues live under "Operational issues" to avoid implying a
  //     content-integrity failure where there is none.
  const p = args.pipeline ?? null;
  const reported = p?.evidence?.reported ?? 0;
  const signed = p?.evidence?.signed ?? 0;
  const needReport = p?.reports?.missingFromSigned ?? 0;
  const submissionsWaiting = args.submissions.length;
  // PHASE 4C — DOMAIN-DERIVED ONLY.
  //
  // This read `args.trust.needingAttention + args.needsFixing.length`, and
  // `needsFixing` was built from the caller's own `/v1/me/inbox` items. So a
  // workspace's "integrity issues" tile counted whatever happened to be
  // visible in ONE person's notification feed at that moment, and fell when
  // they archived something. `trust.needingAttention` is domain state
  // (evidence verificationStatus) and is what this metric is actually about.
  const integrityIssues = args.trust.needingAttention;
  const operationalIssues =
    args.trust.signedWithoutReport +
    args.trust.reportedWithoutPackage +
    args.reportsFailed +
    args.packagesFailed;
  // Reports-ready tone is warn (not neutral) when finalised evidence
  // exists but no report has been produced — surfaces the failure
  // visually even if the operator only scans tones.
  const reportsReadyTone: WorkspaceHealthMetric["tone"] =
    args.reportsReady > 0
      ? "ok"
      : signed > 0
        ? "warn"
        : "neutral";
  const storageTone: WorkspaceHealthMetric["tone"] = args.storage?.limitReached
    ? "danger"
    : args.storage?.nearLimit
      ? "warn"
      : "ok";
  const storageValue = args.storage?.usagePercent != null ? `${args.storage.usagePercent}%` : "—";
  // Phase HOME-COPY — plainer, less forensic-flavoured labels.
  //   * "Records reported" → "Records with a report" — describes
  //     what the count actually is (records that have at least one
  //     produced report) without verbing "report" in a way that
  //     implied legal reporting.
  //   * "Operational issues" → "Records with delivery issues" —
  //     "Operational" is enterprise jargon; the delivery wording
  //     makes the connection to the failed reports/packages tile
  //     explicit.
  //   * "Integrity issues" → "Records flagged for review" — the
  //     prior wording read as a forensic finding; PROOVRA does NOT
  //     determine integrity as fact, only surfaces records that
  //     warrant human review.
  return [
    { key: "complete", label: "Records with a report", value: reported, tone: reported > 0 ? "ok" : "neutral" },
    { key: "need_report", label: "Need a report", value: needReport, tone: needReport > 0 ? "warn" : "ok" },
    { key: "active_cases", label: "Active matters", value: args.activeCasesCount, tone: "neutral" },
    { key: "submissions", label: "Submissions waiting", value: submissionsWaiting, tone: submissionsWaiting > 0 ? "warn" : "ok" },
    { key: "reports_ready", label: "Reports ready", value: args.reportsReady, tone: reportsReadyTone },
    { key: "operational", label: "Records with delivery issues", value: operationalIssues, tone: operationalIssues > 0 ? "danger" : "ok" },
    { key: "integrity", label: "Records flagged for review", value: integrityIssues, tone: integrityIssues > 0 ? "danger" : "ok" },
    { key: "storage", label: "Storage used", value: storageValue, tone: storageTone },
  ];
}

// ============================================================================
// Main normalizer
// ============================================================================

// ============================================================================
// Phase HOME-KPI builders — pure, real-data-only.
// ============================================================================

type WorkspaceEvidenceItem = NonNullable<HomeEvidenceListInput["items"]>[number];

/**
 * Scope the user-wide /v1/evidence list to the ACTIVE workspace.
 * Personal spaces also accept legacy `teamId null` rows (pre-backfill
 * databases); organization workspaces are strict.
 */
function scopeEvidenceList(args: {
  list: HomeEvidenceListInput | null;
  workspaceId: string | null;
  activeSpaceType: ActiveSpaceType;
}): WorkspaceEvidenceItem[] {
  const items = args.list?.items ?? [];
  if (!args.workspaceId) return items;
  if (args.activeSpaceType === "ORGANIZATION") {
    return items.filter((it) => it.teamId === args.workspaceId);
  }
  return items.filter(
    (it) => it.teamId === args.workspaceId || it.teamId == null,
  );
}

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  PHOTO: "Images",
  VIDEO: "Videos",
  AUDIO: "Audio",
  DOCUMENT: "Documents",
  SCREEN: "Screen captures",
};

const HOME_EVIDENCE_CATEGORY_ORDER = [
  "Images",
  "Documents",
  "Videos",
  "Audio",
  "Archives",
  "Folders",
  "Other Files",
] as const;

function normalizeMime(mime: string | null | undefined): string {
  return String(mime ?? "").trim().toLowerCase();
}

function isArchiveMime(mime: string): boolean {
  return [
    "application/zip",
    "application/x-zip-compressed",
    "application/gzip",
    "application/x-gzip",
    "application/x-7z-compressed",
    "application/x-rar-compressed",
    "application/vnd.rar",
    "application/x-tar",
    "application/x-bzip2",
  ].includes(mime);
}

function isDocumentMime(mime: string): boolean {
  if (mime === "application/pdf") return true;
  if (mime.startsWith("text/")) return true;
  if (mime.includes("json") || mime.includes("xml")) return true;
  if (mime.includes("msword")) return true;
  if (mime.includes("officedocument")) return true;
  if (mime.includes("spreadsheet")) return true;
  if (mime.includes("presentation")) return true;
  if (mime === "application/rtf" || mime === "text/rtf") return true;
  return false;
}

/**
 * Phase HOME-PROOF — Evidence by Type classification.
 *
 * The backend EvidenceType enum is only PHOTO/VIDEO/AUDIO/DOCUMENT.
 * We compose a richer 7-category UI taxonomy (Images / Documents /
 * Videos / Audio / Archives / Folders / Other Files) using the
 * authoritative mimeType + EvidenceType signals.
 *
 * BUG FIX: the previous implementation short-circuited
 * `captureMethod === "MULTIPART_PACKAGE"` to "Folders" BEFORE inspecting
 * the MIME type, which meant an uploaded PDF, image, or video that
 * happened to be ingested through the multipart code path was
 * mislabelled as a folder. The correct precedence is:
 *
 *   1. authoritative file-content signals — MIME, then the backend
 *      EvidenceType enum (a record's substantive nature wins);
 *   2. only THEN, if no specific category fits, treat
 *      MULTIPART_PACKAGE as a "Folder" (a true container record with
 *      no single file content type);
 *   3. otherwise "Other Files".
 *
 * The category set itself is documented as a UI-only taxonomy
 * (Archives / Folders / Other Files are not EvidenceType enum values).
 */
function classifyHomeEvidenceCategory(it: WorkspaceEvidenceItem): (typeof HOME_EVIDENCE_CATEGORY_ORDER)[number] {
  const captureMethod = String(it.captureMethod ?? "").toUpperCase();
  const mime = normalizeMime(it.mimeType);
  const type = String(it.type ?? "").toUpperCase();
  const mimeIsGeneric = mime === "application/octet-stream" || mime === "binary/octet-stream";

  // 1. Specific MIME types — the file's actual content is the most
  //    authoritative signal. Catches the classic PDF-mislabelled-as-
  //    folder bug: a real document MIME pins the record to Documents
  //    even when its capture path was multipart.
  if (mime && isArchiveMime(mime)) return "Archives";
  if (mime.startsWith("image/")) return "Images";
  if (mime.startsWith("video/")) return "Videos";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime && isDocumentMime(mime)) return "Documents";

  // 2. EvidenceType enum — used when MIME is absent or generic. The
  //    enum is still authoritative for media (PHOTO/VIDEO/AUDIO) even
  //    when MIME is silent. For DOCUMENT we only commit to "Documents"
  //    when MIME is *truly absent* (legacy records); a generic
  //    "octet-stream" MIME on a DOCUMENT row reflects an unknown
  //    binary and should fall through to either Folders (if part of a
  //    multipart capture) or Other Files.
  if (!mime || mimeIsGeneric) {
    if (type === "PHOTO") return "Images";
    if (type === "VIDEO") return "Videos";
    if (type === "AUDIO") return "Audio";
    if (type === "DOCUMENT" && !mime) return "Documents";
  }

  // 3. Container record with no resolvable file-content category.
  if (captureMethod === "MULTIPART_PACKAGE") return "Folders";

  return "Other Files";
}

function evidenceTypeLabel(raw: string | undefined): string {
  const key = (raw ?? "").toUpperCase();
  return EVIDENCE_TYPE_LABELS[key] ?? "Other";
}

/** Honest per-row trust chip from REAL Evidence columns only. */
function recentEvidenceTrustChip(it: WorkspaceEvidenceItem): {
  label: string;
  tone: "ok" | "warn" | "danger" | "neutral";
} {
  const verdict = (it.verificationStatus ?? "").toUpperCase();
  if (verdict === "FAILED" || verdict === "REVIEW_REQUIRED") {
    return { label: "Flagged for review", tone: "danger" };
  }
  if (it.reportReady === true) {
    return { label: "Report ready", tone: "ok" };
  }
  const status = (it.status ?? "").toUpperCase();
  if (status === "REPORTED") return { label: "Report ready", tone: "ok" };
  // Phase HOME-COPY-FIX — "Sealed" overclaimed legal closure (court-
  // sealed / final). The actual state is just status === "SIGNED" —
  // the Ed25519 signature column is populated. Rename to "Signed" so
  // the chip matches the underlying state and carries no legal
  // overclaim. The KPI subtitle was cleaned up earlier (task #49);
  // this completes the rename for the per-row chip.
  if (status === "SIGNED") return { label: "Signed", tone: "ok" };
  if (status === "UPLOADING" || status === "CREATED") {
    return { label: "In progress", tone: "warn" };
  }
  if (status === "UPLOADED") return { label: "Needs report", tone: "warn" };
  return { label: "Recorded", tone: "neutral" };
}

/**
 * Phase HOME-POLISH — title fallback hierarchy. Never spam the generic
 * default when a real name exists, and never show a raw UUID:
 *   1. evidence title
 *   2. original/display filename
 *   3. "Case evidence — <type>" when linked to a matter
 *   4. "<type> record · <short id>" as the last resort
 */
function recentEvidenceTitle(it: WorkspaceEvidenceItem): string {
  const title = it.title?.trim();
  if (title && !/^digital evidence record$/i.test(title)) return title;
  const file = it.displayFileName?.trim();
  if (file) return file;
  const typeLabel = evidenceTypeLabel(it.type);
  if (it.caseId) return `Case evidence — ${typeLabel}`;
  return `${typeLabel} record · ${it.id.slice(0, 8)}`;
}

function buildRichRecentEvidence(
  scoped: WorkspaceEvidenceItem[],
): RichRecentEvidenceRow[] {
  return scoped.slice(0, 6).map((it) => ({
    id: it.id,
    title: recentEvidenceTitle(it),
    typeKey: (it.type ?? "OTHER").toUpperCase(),
    typeLabel: evidenceTypeLabel(it.type),
    caseId: it.caseId ?? null,
    createdAt: it.createdAt ?? "",
    trustChip: recentEvidenceTrustChip(it),
    href: `/evidence/${encodeURIComponent(it.id)}`,
  }));
}

function buildTypeDistribution(args: {
  scoped: WorkspaceEvidenceItem[];
  listHasMore: boolean;
}): EvidenceTypeDistribution {
  const counts = new Map<string, number>();
  for (const it of args.scoped) {
    const label = classifyHomeEvidenceCategory(it);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = args.scoped.length;
  const slices: EvidenceTypeSlice[] = HOME_EVIDENCE_CATEGORY_ORDER
    .map((label) => [label, counts.get(label) ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => ({
      key: label.toUpperCase().replace(/\s+/g, "_"),
      label,
      count,
      percent: total > 0 ? Math.round((count / total) * 100) : 0,
    }));
  return {
    slices,
    sampleSize: total,
    sampled: args.listHasMore,
    source: "latest-sample",
  };
}

/**
 * Phase HOME-RECORDS-BY-TYPE — convert a backend-aggregated
 * { total, byCategory: {Images: n, ...} } envelope into the
 * EvidenceTypeDistribution shape the donut consumes. Always
 * `source: "workspace-aggregate"` and `sampled: false` — the
 * counts cover every active non-deleted row in scope.
 *
 * Defensive about category names: only keys in the canonical
 * 7-category order are rendered; anything else is dropped silently
 * (frontend cannot fabricate a slice the UI doesn't have an icon
 * for). Categories are emitted in the canonical display order.
 */
function buildTypeDistributionFromAggregate(aggregate: {
  total?: number;
  byCategory?: Record<string, number>;
}): EvidenceTypeDistribution {
  const byCategory = aggregate.byCategory ?? {};
  const total = Number.isFinite(aggregate.total)
    ? Number(aggregate.total)
    : Object.values(byCategory).reduce(
        (sum, n) => sum + (Number.isFinite(n) ? Number(n) : 0),
        0,
      );
  const slices: EvidenceTypeSlice[] = HOME_EVIDENCE_CATEGORY_ORDER
    .map((label) => {
      const raw = byCategory[label];
      const count = Number.isFinite(raw) ? Number(raw) : 0;
      return [label, count] as const;
    })
    .filter(([, count]) => count > 0)
    .map(([label, count]) => ({
      key: label.toUpperCase().replace(/\s+/g, "_"),
      label,
      count,
      percent: total > 0 ? Math.round((count / total) * 100) : 0,
    }));
  return {
    slices,
    sampleSize: total,
    sampled: false,
    source: "workspace-aggregate",
  };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * ONE SERIES FOR ONE RANGE.
 *
 * Generalised from a hard-coded fourteen daily columns. The window and the
 * bucket width both come from the range, so "last 6 months" is thirteen
 * fortnightly columns rather than 182 ticks nobody can read.
 *
 * The SOURCE is unchanged: the same scoped evidence list and the same report
 * timestamps this projection already had. Nothing is fetched differently and no
 * count is invented — a longer window simply reaches further back through the
 * records already in hand, which is also why `sampled` matters more the wider
 * the range goes.
 */
function buildActivitySeriesForRange(args: {
  scoped: WorkspaceEvidenceItem[];
  reports: HomeReportsInput | null;
  listHasMore: boolean;
  nowMs: number;
  range: (typeof ACTIVITY_RANGES)[number];
}): EvidenceActivitySeries {
  const dayMs = 86_400_000;
  const { days, bucketDays } = args.range;
  const buckets = Math.ceil(days / bucketDays);
  const startOfToday = Math.floor(args.nowMs / dayMs) * dayMs;
  /** The instant after the newest bucket ends. */
  const horizon = startOfToday + dayMs;
  const evidence = new Array<number>(buckets).fill(0);
  const reports = new Array<number>(buckets).fill(0);

  // Index 0 is the NEWEST bucket, counting backwards — the same orientation
  // the daily version used, so the reversal below is unchanged.
  const bucket = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const idx = Math.floor((horizon - 1 - t) / (dayMs * bucketDays));
    return idx >= 0 && idx < buckets ? idx : null;
  };

  for (const it of args.scoped) {
    const idx = bucket(it.createdAt);
    if (idx != null) evidence[idx] += 1;
  }
  for (const r of args.reports?.items ?? []) {
    const idx = bucket(r.report?.generatedAtUtc ?? null);
    if (idx != null) reports[idx] += 1;
  }

  const points: ActivityPoint[] = [];
  for (let i = buckets - 1; i >= 0; i -= 1) {
    // The label names where the bucket STARTS, which for a week or a fortnight
    // is the only honest thing to call it.
    const bucketStart = horizon - (i + 1) * dayMs * bucketDays;
    const d = new Date(bucketStart);
    points.push({
      dayLabel:
        bucketDays === 1
          ? `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}`
          : `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`,
      evidence: evidence[i]!,
      reports: reports[i]!,
    });
  }
  return {
    points,
    totalEvidence: evidence.reduce((a, b) => a + b, 0),
    totalReports: reports.reduce((a, b) => a + b, 0),
    sampled: args.listHasMore,
    rangeId: args.range.id,
    bucketDays,
  };
}

/**
 * Every range, built once.
 *
 * The reader switches between them with no round trip, because all four read
 * the same records that are already loaded. Building them eagerly costs four
 * passes over a bounded list and removes an entire loading state.
 */
function buildActivitySeriesByRange(args: {
  scoped: WorkspaceEvidenceItem[];
  reports: HomeReportsInput | null;
  listHasMore: boolean;
  nowMs: number;
}): Record<EvidenceActivityRangeId, EvidenceActivitySeries> {
  const out = {} as Record<EvidenceActivityRangeId, EvidenceActivitySeries>;
  for (const range of ACTIVITY_RANGES) {
    out[range.id] = buildActivitySeriesForRange({ ...args, range });
  }
  return out;
}


function formatKpiNumber(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function buildKpis(args: {
  /** SERVER-projected `planFeatures.intakeIncluded` (fail-closed). */
  intakeIncluded: boolean;
  trust: TrustState;
  scoped: WorkspaceEvidenceItem[];
  listHasMore: boolean;
  caseCount: number;
  caseHealthSummary: CaseHealthSummary;
  reportProduction: ReportProduction;
  collectionStats: CollectionStats;
  submissionsCount: number;
  nowMs: number;
}): HomeKpi[] {
  const dayMs = 86_400_000;
  const startOfToday = Math.floor(args.nowMs / dayMs) * dayMs;

  // 7-day sparkline + delta from the (scoped) evidence list sample.
  const spark = new Array<number>(7).fill(0);
  for (const it of args.scoped) {
    const t = it.createdAt ? Date.parse(it.createdAt) : NaN;
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((startOfToday + dayMs - 1 - t) / dayMs);
    if (idx >= 0 && idx < 7) spark[6 - idx] += 1;
  }
  const last7 = spark.reduce((a, b) => a + b, 0);
  const totalEvidence = args.trust.totalEvidence;
  const evidenceSubtitle =
    totalEvidence === 0
      ? "No records yet — capture your first"
      : last7 > 0
        ? `+${last7}${args.listHasMore && last7 >= 100 ? "+" : ""} in the last 7 days`
        : "No new records this week";

  const mattersAttention =
    args.caseHealthSummary.gapsCount + args.caseHealthSummary.blockersCount;

  // Phase HOME-TRUTH-FIX — End-to-end ready KPI.
  //
  // BEFORE this pass, the headline KPI was "Trust ready" computed as
  // `signed / totalEvidence` where `signed` only meant the Ed25519
  // signature column was non-null. Signing happens BEFORE the report
  // worker runs, so the KPI could read 100% while every fresh capture
  // was stuck at SIGNED with no Report and no VerificationPackage
  // (the exact failure mode of the puppeteer __name regression we
  // fixed). The subtitle's word "sealed" compounded the misreading.
  //
  // The KPI now uses `endToEndReady` — a backend-computed predicate
  // that requires status=REPORTED ∧ has Report ∧ has Package ∧ not
  // suspended. It CANNOT read green when the report worker has
  // stalled.
  //
  // The Trust State card still shows `signed` correctly labelled as
  // "Signed records" so no information is lost; it just no longer
  // anchors the headline KPI.
  const endToEndReady = args.trust.endToEndReady;
  const stuck =
    args.trust.signedWithoutReport + args.trust.reportedWithoutPackage;
  const trustValue =
    totalEvidence >= 10
      ? `${Math.round((endToEndReady / Math.max(1, totalEvidence)) * 100)}%`
      : formatKpiNumber(endToEndReady);
  const trustSubtitle =
    totalEvidence === 0
      ? "End-to-end readiness appears with your first record"
      : stuck > 0
        ? `${formatKpiNumber(endToEndReady)} of ${formatKpiNumber(totalEvidence)} have report + package · ${formatKpiNumber(stuck)} need attention`
        : `${formatKpiNumber(endToEndReady)} of ${formatKpiNumber(totalEvidence)} have report + package · ${formatKpiNumber(args.trust.verifyPublished)} verify pages live`;

  const rp = args.reportProduction;
  const deliverablesFailed = rp.reportsFailed + rp.packagesFailed;
  const deliverablesPending = rp.reportsPending + rp.packagesPending;

  const cs = args.collectionStats;
  // Track 1A — the intake KPI lock follows the SERVER-projected
  // commercial entitlement, not the plan name.
  const pro = args.intakeIncluded;

  return [
    {
      key: "evidence",
      label: "Total evidence",
      value: formatKpiNumber(totalEvidence),
      subtitle: evidenceSubtitle,
      tone: totalEvidence > 0 ? "ok" : "neutral",
      spark: last7 > 0 ? spark : null,
      href: "/evidence",
    },
    {
      key: "matters",
      label: "Active matters",
      value: formatKpiNumber(args.caseCount),
      subtitle:
        args.caseCount === 0
          ? "No open matters"
          : mattersAttention > 0
            ? `${mattersAttention} need${mattersAttention === 1 ? "s" : ""} attention`
            : "All matters on track",
      tone:
        mattersAttention > 0 ? "warn" : args.caseCount > 0 ? "ok" : "neutral",
      spark: null,
      href: "/cases",
    },
    {
      // Key kept as "trust" to preserve any consumers that filter by
      // it (deep-linked banners, e2e tests). Label + formula are the
      // operationally-truthful ones.
      key: "trust",
      label: "End-to-end ready",
      value: trustValue,
      subtitle: trustSubtitle,
      tone:
        args.trust.needingAttention > 0
          ? "danger"
          : stuck > 0
            ? "warn"
            : endToEndReady > 0
              ? "ok"
              : "neutral",
      spark: null,
      href: "/evidence",
    },
    {
      key: "deliverables",
      label: "Reports & packages",
      value: `${formatKpiNumber(rp.reportsReady)} / ${formatKpiNumber(rp.packagesReady)}`,
      subtitle:
        deliverablesFailed > 0
          ? `${deliverablesFailed} failed · ${deliverablesPending} pending`
          : deliverablesPending > 0
            ? `${deliverablesPending} pending`
            : rp.reportsReady + rp.packagesReady > 0
              ? "ready reports / packages"
              : "No deliverables yet",
      tone:
        deliverablesFailed > 0
          ? "danger"
          : deliverablesPending > 0
            ? "warn"
            : rp.reportsReady + rp.packagesReady > 0
              ? "ok"
              : "neutral",
      spark: null,
      href: "/reports",
    },
    {
      key: "intake",
      label: "Intake & submissions",
      value: pro
        ? `${formatKpiNumber(cs.activeLinks)} / ${formatKpiNumber(args.submissionsCount)}`
        : "—",
      subtitle: !pro
        ? "Included with PRO"
        : cs.failedDeliveries > 0
          ? `${cs.failedDeliveries} failed deliver${cs.failedDeliveries === 1 ? "y" : "ies"}`
          : args.submissionsCount > 0
            ? `${args.submissionsCount} awaiting review`
            : cs.activeLinks > 0
              ? "links active / pending review"
              : "No active intake links",
      tone: !pro
        ? "neutral"
        : cs.failedDeliveries > 0
          ? "danger"
          : args.submissionsCount > 0
            ? "warn"
            : cs.activeLinks > 0
              ? "ok"
              : "neutral",
      spark: null,
      href: pro ? "/intake-links" : "/billing",
      locked: !pro,
    },
  ];
}

/**
 * The raw shape of `GET /v1/ops/summary`'s `summary` field.
 *
 * Only the fields Home reads are declared. It is a projection of shared
 * workspace truth; nothing here is per-recipient.
 */
export type HomeOperationsSummaryInput = {
  open: number;
  critical: number;
  high: number;
  warning: number;
  overdue: number;
  assignedToMe: number;
  mayAssertAllClear: boolean;
  /** `GET /v1/ops/summary` has always sent this; Home simply never read it. */
  clearRefusalReason?: HomeClearRefusalReason | null;
  /**
   * The open conditions, grouped by their canonical `sourceId`.
   *
   * This is what lets Home say WHAT is unresolved rather than merely that
   * something is. The endpoint has always projected it; Home read the counts
   * beside it and ignored the groups themselves.
   */
  groups?: ReadonlyArray<HomeOperationsConditionGroup> | null;
};

/** One group of open conditions sharing a source, as `/v1/ops/summary` projects it. */
export type HomeOperationsConditionGroup = {
  /** The stable registry id. The ONLY thing keyed on — never the title. */
  sourceId: string;
  conditionCount: number;
  /** Records behind the group where the source counts records; null otherwise. */
  affectedRecordCount?: number | null;
  severity?: string | null;
  statusPosture?: string | null;
};

export type NormalizeInputs = {
  /** DISPLAY-ONLY plan label (e.g. the data-self-serve-plan attribute). */
  plan: HomePlan;
  /**
   * Track 1A — SERVER-projected `envelope.planFeatures` entitlements.
   * All Home entitlement decisions read these; unknown/absent values
   * resolve fail-closed (false).
   */
  planFeatures?: Partial<HomePlanFeatures> | null;
  workspaceId: string | null;
  /** Active workspace display name (greeting line). */
  workspaceName?: string | null;
  activeSpaceType: ActiveSpaceType;
  commandCenter: HomeCommandCenterInput | null;
  trustSummary: HomeTrustSummaryInput | null;
  billing: HomeBillingInput | null;
  reports: HomeReportsInput | null;
  intakeLinks: HomeIntakeLinksInput | null;
  inbox: HomeInboxInput | null;
  /**
   * ATTENTION ARCHITECTURE PHASE 4C (2026-08-22) — GET /v1/ops/summary.
   *
   * THE canonical workspace Operations summary. Home CONSUMES this and does
   * not derive it. `null` means the summary could not be loaded, or the
   * caller holds no Operations capability in this workspace — both are
   * honest absences, and Home renders an unavailable state rather than
   * substituting a health number derived from `inbox` above.
   */
  operationsSummary?: HomeOperationsSummaryInput | null;
  communications: HomeCommunicationsInput | null;
  orgs: HomeOrgsInput | null;
  /** GET /v1/evidence?limit=100 — KPI sparkline / chart / donut source. */
  evidenceList?: HomeEvidenceListInput | null;
  /**
   * Phase HOME-RECORDS-BY-TYPE — GET /v1/dashboard/records-by-type.
   * Workspace-aggregated counts for the Records/Files donut. When
   * null/undefined the view-model falls back to the legacy
   * latest-100 classifier for records (no fallback for files —
   * `preservedFilesByType` becomes null).
   */
  recordsByType?: HomeRecordsByTypeInput | null;
  /** Injected for deterministic day-bucketing in tests. */
  nowMs?: number;
};

export function normalizeHomeViewModel(
  inputs: NormalizeInputs,
): HomeViewModel {
  const cc = inputs.commandCenter;
  const nowMs = inputs.nowMs ?? Date.now();

  // Track 1A — resolve the server-projected entitlements FAIL-CLOSED.
  const features: HomePlanFeatures = {
    intakeIncluded: inputs.planFeatures?.intakeIncluded === true,
    teamCollaborationIncluded:
      inputs.planFeatures?.teamCollaborationIncluded === true,
    reportsIncluded: inputs.planFeatures?.reportsIncluded === true,
  };
  // While the envelope is loading the reports entitlement is UNKNOWN —
  // expose that tri-state so upsell copy is not shown prematurely.
  const reportsIncludedKnown =
    typeof inputs.planFeatures?.reportsIncluded === "boolean";

  const flagged = integrityFlaggedIds(cc);
  const trustState = buildTrustState(inputs.trustSummary);
  const recentEvidence = buildRecentEvidence({
    cc,
    reportsInput: inputs.reports,
    flagged,
  });
  const recentReports = buildRecentReports(inputs.reports);
  const caseHealth = buildCaseHealth(cc);
  // CLOSURE PASS — `submissions` remains the caller's PERSONAL list of
  // submissions addressed to them (it feeds the "Your recent work" style
  // rows, which are legitimately per-person). The workspace-level COUNT that
  // drives the "What needs attention" priority no longer comes from it — see
  // `submissionsAwaitingReview` below.
  const submissions = buildSubmissions({
    inbox: inputs.inbox,
    workspaceId: inputs.workspaceId,
  });
  /**
   * THE canonical workspace count of submissions waiting for a review
   * decision. `dashboard/trust-summary.intake.submissionsAwaitingReview` is
   * an uncapped `EvidenceRequest` count owned by the intake domain; the
   * personal feed is not consulted.
   */
  const submissionsAwaitingReview =
    inputs.trustSummary?.intake?.submissionsAwaitingReview ?? 0;
  const needsFixing = buildNeedsFixing({
    inbox: inputs.inbox,
    workspaceId: inputs.workspaceId,
  });
  const collection = buildCollection({
    intakeLinks: inputs.intakeLinks,
    communications: inputs.communications,
  });
  const collectionStats = buildCollectionStats({
    intakeLinks: inputs.intakeLinks,
    communications: inputs.communications,
    inbox: inputs.inbox,
    workspaceId: inputs.workspaceId,
  });

  // Case Health header counters — real cc signals.
  const caseHealthSummary: CaseHealthSummary = {
    gapsCount: cc?.sections?.caseOperations?.data?.casesWithEvidenceGapsCount ?? 0,
    blockersCount: caseHealth.filter((c) => c.openEscalationsCount > 0).length,
    // Ticket 3A — previously exposed by the API but dropped here.
    unlinkedCount: cc?.sections?.caseOperations?.data?.unlinkedEvidenceCount ?? 0,
    unreviewedCount:
      cc?.sections?.caseOperations?.data?.unreviewedEvidenceCount ?? 0,
  };

  // Counters used by hero + checklist (all workspace-scoped).
  const evCounts = cc?.sections?.pipelineDetail?.data?.evidence;
  const evidenceCount =
    (evCounts?.uploaded ?? 0) + (evCounts?.signed ?? 0) + (evCounts?.reported ?? 0) ||
    trustState.totalEvidence ||
    recentEvidence.length;
  const caseCount = cc?.sections?.caseOperations?.data?.activeCasesCount ?? 0;
  const reportCount = inputs.reports?.items?.length ?? 0;

  // Storage forecast needs the real record count, so build it here.
  const storage = buildStorage(inputs.billing, evidenceCount);

  // Reports generated today (real generatedAtUtc).
  const startOfToday = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const reportsToday = (inputs.reports?.items ?? []).filter((r) => {
    const t = r.report?.generatedAtUtc ? Date.parse(r.report.generatedAtUtc) : NaN;
    return Number.isFinite(t) && t >= startOfToday;
  }).length;

  const teamWork = buildTeamWork({
    teamCollaborationIncluded: features.teamCollaborationIncluded,
    activeSpaceType: inputs.activeSpaceType,
    orgs: inputs.orgs,
    workspaceId: inputs.workspaceId,
    submissionsCount: submissionsAwaitingReview,
    reportsToday,
  });

  const checklist = buildChecklist({
    evidenceCount,
    caseCount,
    reportCount,
    verifyPublished: trustState.verifyPublished,
  });
  const visibleSteps = checklist.filter((s) => s.visible);
  const checklistComplete =
    visibleSteps.length > 0 && visibleSteps.every((s) => s.done);

  // Phase HOME-POLISH — onboarding is for TRULY NEW users only.
  // Any real work (evidence, reports, matters, live verification)
  // permanently retires the Getting Started card.
  const showGettingStarted =
    evidenceCount === 0 &&
    reportCount === 0 &&
    caseCount === 0 &&
    trustState.verifyPublished === 0;

  const heroAction = pickHeroAction({
    intakeIncluded: features.intakeIncluded,
    cc,
    submissions,
    trust: trustState,
    caseHealth,
    evidenceCount,
    caseCount,
    reportCount,
  });

  const activity = buildActivity({
    cc,
    reportsInput: inputs.reports,
    intakeLinks: inputs.intakeLinks,
    communications: inputs.communications,
    inbox: inputs.inbox,
    submissions,
    nowMs,
  });

  // Operational surfaces — all composed from the slices above + the real
  // command-center pipeline projection. No new fetches, no fabrication.
  const pipeline = cc?.sections?.pipelineDetail?.data ?? null;
  const reportProduction = buildReportProduction({ pipeline, recentReports });
  // PHASE 4C — CONSUMED. `inputs.operationsSummary` is the response of the
  // canonical `GET /v1/ops/summary`; null means it could not be loaded or the
  // caller holds no Operations capability here. Either way Home reports an
  // honest absence rather than substituting a number it derived itself.
  const operations: HomeOperationsSummary = inputs.operationsSummary
    ? {
        available: true,
        open: inputs.operationsSummary.open,
        critical: inputs.operationsSummary.critical,
        high: inputs.operationsSummary.high,
        warning: inputs.operationsSummary.warning,
        overdue: inputs.operationsSummary.overdue,
        assignedToMe: inputs.operationsSummary.assignedToMe,
        mayAssertAllClear: inputs.operationsSummary.mayAssertAllClear,
        clearRefusalReason:
          inputs.operationsSummary.clearRefusalReason ?? null,
        href: "/operations",
      }
    : {
        available: false,
        open: 0,
        critical: 0,
        high: 0,
        warning: 0,
        overdue: 0,
        assignedToMe: 0,
        // UNAVAILABLE IS NOT HEALTHY. The zeros above exist only so the type
        // stays total; this flag is what any UI must read first.
        mayAssertAllClear: false,
        // No summary means no verdict to carry; `available: false` is the
        // fact the UI renders in that case.
        clearRefusalReason: null,
        href: "/operations",
      };
  // Phase HOME-INTELLIGENCE — caseIds that already have a report
  // (from /v1/reports items[].caseId — exposed all along).
  const reportCaseIds = new Set<string>(
    (inputs.reports?.items ?? [])
      .filter((r) => r.report?.available && r.caseId)
      .map((r) => String(r.caseId)),
  );
  const activeMatters = buildActiveMatters(cc, reportCaseIds);
  const intakePipeline = buildIntakePipeline({ collection, stats: collectionStats });
  const verificationHealth = buildVerificationHealth({
    trust: trustState,
    recentReports,
    pipeline,
    cc,
  });
  const workspaceHealth = buildWorkspaceHealth({
    pipeline,
    trust: trustState,
    submissions,
    needsFixing,
    activeCasesCount: caseCount,
    reportsReady: reportProduction.reportsReady,
    // Phase HOME-TRUTH-FIX — Operational Issues needs the failed +
    // pending counts so a stalled report worker shows in the health
    // card without having to scroll to the Report Production section.
    reportsPending: reportProduction.reportsPending,
    reportsFailed: reportProduction.reportsFailed,
    packagesPending: reportProduction.packagesPending,
    packagesFailed: reportProduction.packagesFailed,
    storage,
  });

  // Phase HOME-KPI — premium dashboard surfaces (all real data).
  const scopedEvidence = scopeEvidenceList({
    list: inputs.evidenceList ?? null,
    workspaceId: inputs.workspaceId,
    activeSpaceType: inputs.activeSpaceType,
  });
  const listHasMore = inputs.evidenceList?.pageInfo?.hasMore === true;
  const kpis = buildKpis({
    intakeIncluded: features.intakeIncluded,
    trust: trustState,
    scoped: scopedEvidence,
    listHasMore,
    caseCount,
    caseHealthSummary,
    reportProduction,
    collectionStats,
    submissionsCount: submissions.length,
    nowMs,
  });
  const activitySeriesByRange = buildActivitySeriesByRange({
    scoped: scopedEvidence,
    reports: inputs.reports,
    listHasMore,
    nowMs,
  });
  // The 14-day view is one of the four, never a second computation of it.
  const activitySeries = activitySeriesByRange["14d"];
  // Phase HOME-RECORDS-BY-TYPE — prefer the workspace-aggregate
  // endpoint (counts every active non-deleted row). Use the latest-100
  // sample classifier ONLY if that request failed; the widget surfaces
  // `source` so users can tell which is which.
  const recordsAggregate = inputs.recordsByType?.records;
  const typeDistribution =
    recordsAggregate &&
    (typeof recordsAggregate.total === "number" ||
      recordsAggregate.byCategory)
      ? buildTypeDistributionFromAggregate(recordsAggregate)
      : buildTypeDistribution({ scoped: scopedEvidence, listHasMore });
  const filesAggregate = inputs.recordsByType?.files;
  const preservedFilesByType =
    filesAggregate &&
    (typeof filesAggregate.total === "number" || filesAggregate.byCategory)
      ? buildTypeDistributionFromAggregate(filesAggregate)
      : null;
  const richRecentEvidence = buildRichRecentEvidence(scopedEvidence);
  const inboxCount = (inputs.inbox?.items ?? []).length;

  // Phase HOME-INTELLIGENCE — ranked active-user priorities (cross-
  // domain signals) + overall health verdict.
  const derivedPriorities = buildWorkspacePriorities({
    intakeIncluded: features.intakeIncluded,
    trust: trustState,
    pipeline,
    submissionsCount: submissions.length,
    collectionStats,
    reportCount,
    // CLOSURE PASS (2026-08-22) — `criticalFailuresCount` is gone. It was
    // `needsFixing.filter(critical).length`, i.e. a count of the caller's own
    // notification items, handed to a workspace-level priority row. The row
    // now reads `trust.otsFailed`, the canonical uncapped aggregate.
    mattersNeedingWork: activeMatters.filter((m) => m.verdict !== "healthy").length,
    reportsReady: reportProduction.reportsReady,
    storage,
  });
  /*
   * OPERATIONAL CONDITIONS BECOME PRIORITIES TOO.
   *
   * `mayAssertAllClear` is refused by ANY unresolved condition, from any of
   * the 37 registered sources, while the list above is derived from trust,
   * pipeline, submissions, collection, report, matter and storage signals.
   * Everything in that gap used to be invisible here — which is how a
   * workspace ended up with a refused all-clear beside an empty list.
   *
   * The mapping decides what each source means to a customer; this merges its
   * output into the SAME priority model, so ordering, severity, styling and
   * actions are the ones every other row already uses. There is no second
   * renderer.
   */
  const workspacePriorities = mergeOperationalConditions(
    derivedPriorities,
    inputs.operationsSummary?.groups ?? null,
  );
  const workspaceHealthOverall: HomeViewModel["workspaceHealthOverall"] =
    workspaceHealth.some((m) => m.tone === "danger")
      ? "action_required"
      : workspaceHealth.some((m) => m.tone === "warn")
        ? "needs_attention"
        : "healthy";

  // Phase HOME-EXEC — composed from the decision engine + trust floors.
  const executiveSummary = buildExecutiveSummary({
    showGettingStarted,
    trust: trustState,
    priorities: workspacePriorities,
    reportProduction,
    verificationHealth,
    storage,
  });

  return {
    plan: inputs.plan,
    features,
    reportsIncludedKnown,
    workspaceId: inputs.workspaceId,
    workspaceName: inputs.workspaceName ?? null,
    kpis,
    activitySeries,
    activitySeriesByRange,
    typeDistribution,
    preservedFilesByType,
    richRecentEvidence,
    inboxCount,
    heroAction,
    operations,
    submissions,
    needsFixing,
    collection,
    collectionStats,
    intakePipeline,
    reportProduction,
    verificationHealth,
    workspaceHealth,
    activeMatters,
    recentEvidence,
    caseHealth,
    caseHealthSummary,
    trustState,
    activity,
    storage,
    teamWork,
    checklist,
    checklistComplete,
    showGettingStarted,
    workspacePriorities,
    workspaceHealthOverall,
    executiveSummary,
  };
}
