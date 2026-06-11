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

export type HomePlan = "FREE" | "PAYG" | "PRO" | "TEAM" | null;

/** Which kind of workspace the user is currently in. */
export type ActiveSpaceType = "PERSONAL" | "ORGANIZATION" | null;

export function isProOrTeam(plan: HomePlan): boolean {
  return plan === "PRO" || plan === "TEAM";
}
export function isFreePlan(plan: HomePlan): boolean {
  return plan === "FREE";
}

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
  /** ACTIVE / EXPIRED / REVOKED */
  status: string;
  usedCount: number;
  maxUses: number | null;
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
  /** ACTIVE links that have not yet been used (awaiting a response). */
  awaitingResponse: number;
  /** Submissions sitting in the review queue (received, not yet reviewed). */
  receivedSubmissions: number;
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
    reportPdf: string | null;
    packageZip: string | null;
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
  otsAnchored: number;
  otsPending: number;
  otsFailed: number;
  signed: number;
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
    | "first_intake_link"
    | "invite_first_teammate";
  label: string;
  done: boolean;
  visible: boolean;
  href: string;
};

/** Header counts for the Case Health card. */
export type CaseHealthSummary = {
  /** Cases missing required/linked evidence (real cc counter). */
  gapsCount: number;
  /** Cases carrying an open escalation/blocker. */
  blockersCount: number;
};

// ============================================================================
// Operational surface types (world-class Home)
// ============================================================================

/**
 * A single thing the user can act on right now. The Operational Queue is
 * the prioritized list of these — the first major widget on Home. Every
 * item is sourced from real backend state; `action.inline` items can be
 * resolved without leaving Home (today: failed-delivery retry), the rest
 * deep-link to the working detail/page route and are flagged
 * `fallback: true` so we never pretend an inline flow exists.
 */
export type OperationalQueueItem = {
  id: string;
  type:
    | "review_submission"
    | "retry_delivery"
    | "report_failure"
    | "package_failure"
    | "ots_failure"
    | "generate_report"
    | "complete_package"
    | "publish_verification"
    | "fix_integrity"
    | "complete_case";
  /** Short category label, e.g. "Submission waiting review". */
  label: string;
  /** The specific entity / count this item concerns. */
  title: string;
  /** Real timestamp where one exists (receipt, failure time); else null. */
  occurredAt: string | null;
  severity: "critical" | "warn" | "action";
  action: {
    /** "retry_delivery" runs an inline POST; "navigate" opens a route. */
    kind: "retry_delivery" | "navigate";
    label: string;
    href: string;
    /** Communication message id — only for inline retry. */
    messageId?: string;
  };
  /** True when the action is a navigation fallback (no inline flow yet). */
  fallback: boolean;
};

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
  /** Plain-language status, e.g. "2 unreviewed · 1 blocked" or "On track". */
  statusLabel: string;
  href: string;
};

/** One stage in the intake lifecycle pipeline. */
export type IntakeStage = {
  key: "active" | "awaiting" | "received" | "in_review" | "failed";
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
export type ReportProduction = {
  reportsReady: number;
  packagesReady: number;
  reportsPending: number;
  packagesPending: number;
  reportsFailed: number;
  packagesFailed: number;
  /** Latest generated reports with their deliverable actions. */
  recent: RecentReportRow[];
};

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

export type HomeViewModel = {
  plan: HomePlan;
  /** Active workspace id — needed for workspace-scoped mutations (retry). */
  workspaceId: string | null;
  heroAction: HeroAction;
  /** The prioritized list of actionable items — Home's first widget. */
  operationalQueue: OperationalQueueItem[];
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
  recentReports: RecentReportRow[];
  caseHealth: CaseHealthRow[];
  caseHealthSummary: CaseHealthSummary;
  trustState: TrustState;
  activity: ActivityGroup[];
  storage: StorageUsage | null;
  teamWork: TeamWork | null;
  checklist: ChecklistStep[];
  /** True once every visible checklist step is done — UI collapses it. */
  checklistComplete: boolean;
  hasAnyData: boolean;
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
      items?: Array<{
        id: string;
        kind?: string;
        occurredAt?: string;
        label?: string;
        subtitle?: string;
        href?: string;
        severity?: string;
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
  tsa?: { stamped?: number; pending?: number; failed?: number; none?: number };
  ots?: { anchored?: number; pending?: number; failed?: number; none?: number };
  signed?: number;
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
  return links.slice(0, 5).map((l) => {
    const d = latestByLink.get(l.id) ?? null;
    return {
      id: l.id,
      label: l.recipientLabel ?? l.recipientPhone ?? l.workflowTemplateSlug ?? "Intake link",
      status: l.status,
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
function buildCollectionStats(args: {
  intakeLinks: HomeIntakeLinksInput | null;
  communications: HomeCommunicationsInput | null;
  receivedSubmissions: number;
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
  return {
    activeLinks: active.length,
    awaitingResponse: active.filter((l) => (l.usedCount ?? 0) === 0).length,
    receivedSubmissions: args.receivedSubmissions,
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
      const reportPdf = r.report?.available
        ? `/v1/evidence/${encodeURIComponent(evidenceId)}/report/latest`
        : null;
      const packageZip = r.package?.available
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
        actions: { open, reportPdf, packageZip, verify },
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
    otsAnchored: s.ots?.anchored ?? 0,
    otsPending: s.ots?.pending ?? 0,
    otsFailed: s.ots?.failed ?? 0,
    signed: s.signed ?? 0,
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
  escalation_opened: { kind: "escalation_opened", label: "Review escalation opened" },
  incident_opened: { kind: "incident_opened", label: "Incident opened" },
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
  submissions: SubmissionRow[];
  nowMs: number;
}): ActivityGroup[] {
  const events: ActivityEvent[] = [];

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

  // 1. command-center.timeline — real evidence/report/package/hold events.
  for (const it of args.cc?.sections?.timeline?.items ?? []) {
    const mapped = ACTIVITY_KIND_LABELS[(it.kind ?? "").toLowerCase()];
    if (!mapped || !it.occurredAt) continue;
    events.push({
      id: `tl:${it.id}`,
      kind: mapped.kind,
      label: it.label ?? mapped.label,
      occurredAt: it.occurredAt,
      href: it.href ?? "/inbox",
    });
  }

  // 2. Intake link creation — real createdAt from the links list.
  for (const l of args.intakeLinks?.links ?? []) {
    if (!l.createdAt) continue;
    events.push({
      id: `link:${l.id}`,
      kind: "intake_link_created",
      label: "Intake link created",
      occurredAt: l.createdAt,
      href: `/intake-links?linkId=${encodeURIComponent(l.id)}`,
    });
  }

  // 3. Delivery events — real sent/delivered/failed from communications.
  for (const m of args.communications?.messages ?? []) {
    if (m.deliveredAtUtc) {
      events.push({
        id: `msg-d:${m.id}`,
        kind: "intake_delivered",
        label: `Intake link delivered (${m.channel})`,
        occurredAt: m.deliveredAtUtc,
        href: "/intake-links",
      });
    } else if (m.failedAtUtc) {
      events.push({
        id: `msg-f:${m.id}`,
        kind: "intake_failed",
        label: `Intake delivery failed (${m.channel})`,
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
  const out: ActivityGroup[] = [];
  if (groups.today.length) out.push({ key: "today", label: "Today", events: groups.today });
  if (groups.yesterday.length)
    out.push({ key: "yesterday", label: "Yesterday", events: groups.yesterday });
  if (groups.earlier.length)
    out.push({ key: "earlier", label: "Earlier", events: groups.earlier });
  return out;
}

function buildTeamWork(args: {
  plan: HomePlan;
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
  if (!isProOrTeam(args.plan)) return null;
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
    manageHref: "/teams",
  };
}

function buildChecklist(args: {
  plan: HomePlan;
  evidenceCount: number;
  caseCount: number;
  reportCount: number;
  intakeLinkCount: number;
  teamMemberCount: number;
}): ChecklistStep[] {
  const pro = isProOrTeam(args.plan);
  return [
    {
      key: "capture_first",
      label: "Capture your first evidence record",
      done: args.evidenceCount > 0,
      visible: true,
      href: "/capture",
    },
    {
      key: "create_first_case",
      label: "Create your first case",
      done: args.caseCount > 0,
      visible: true,
      href: "/cases",
    },
    {
      key: "first_report",
      label: "Generate or unlock your first report",
      done: args.reportCount > 0,
      visible: true,
      href: "/reports",
    },
    {
      key: "first_intake_link",
      label: "Create an intake link",
      // Real signal: an intake link row exists in this workspace.
      done: args.intakeLinkCount > 0,
      visible: pro,
      href: "/intake-links",
    },
    {
      key: "invite_first_teammate",
      label: "Invite a teammate",
      // Real signal: the active org has more than just the owner.
      done: args.teamMemberCount > 1,
      visible: pro,
      href: "/teams",
    },
  ];
}

function pickHeroAction(args: {
  plan: HomePlan;
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
      href: "/evidence",
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
      href: "/evidence",
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
  if (isProOrTeam(args.plan)) {
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
 * The Operational Queue — the prioritized list of things the user can act
 * on now. Built ENTIRELY from real backend state already in the view
 * model. Inline actions are used where a real flow exists (failed-delivery
 * retry); everything else deep-links to the working route and is flagged
 * `fallback: true`. When this list is empty the dashboard shows the
 * onboarding/caught-up hero instead.
 */
function buildOperationalQueue(args: {
  submissions: SubmissionRow[];
  needsFixing: NeedsFixingRow[];
  collection: CollectionRow[];
  caseHealth: CaseHealthRow[];
  trust: TrustState;
  pipeline: PipelineData;
  reportCount: number;
}): OperationalQueueItem[] {
  const items: OperationalQueueItem[] = [];
  const p = args.pipeline ?? null;

  // 1. Critical operational failures first (terminal OTS, etc.).
  for (const f of args.needsFixing.filter((f) => f.critical)) {
    items.push({
      id: `fix:${f.id}`,
      type: failureType(f.category),
      label: `${f.categoryLabel} failed`,
      title: f.title,
      occurredAt: f.occurredAt,
      severity: "critical",
      action: { kind: "navigate", label: "Open to fix", href: f.href },
      fallback: true,
    });
  }

  // 2. Submissions waiting — a real person is waiting on a decision.
  for (const s of args.submissions) {
    items.push({
      id: `sub:${s.id}`,
      type: "review_submission",
      label: s.overdue ? "Submission overdue" : "Submission waiting review",
      title: s.title,
      occurredAt: s.receivedAt,
      severity: s.overdue ? "warn" : "action",
      action: { kind: "navigate", label: "Review", href: s.href },
      fallback: true,
    });
  }

  // 3. Failed deliveries — inline retry (a real flow that exists today).
  for (const c of args.collection) {
    if (!c.delivery?.failed) continue;
    items.push({
      id: `deliver:${c.delivery.messageId}`,
      type: "retry_delivery",
      label: "Delivery failed",
      title: c.label,
      occurredAt: c.delivery.at,
      severity: "warn",
      action: {
        kind: "retry_delivery",
        label: "Retry delivery",
        href: c.href,
        messageId: c.delivery.messageId,
      },
      fallback: false,
    });
  }

  // 4. Non-critical operational failures (report/package — often transient).
  for (const f of args.needsFixing.filter((f) => !f.critical)) {
    items.push({
      id: `fix:${f.id}`,
      type: failureType(f.category),
      label: `${f.categoryLabel} failed`,
      title: f.title,
      occurredAt: f.occurredAt,
      severity: "warn",
      action: { kind: "navigate", label: "Open to fix", href: f.href },
      fallback: true,
    });
  }

  // 5. Evidence ready for a report (signed, no report yet).
  const reportsToGenerate = p?.reports?.missingFromSigned ?? 0;
  if (reportsToGenerate > 0) {
    items.push({
      id: "gen:reports",
      type: "generate_report",
      label: "Records ready for a report",
      title: `${reportsToGenerate} signed record${reportsToGenerate === 1 ? "" : "s"} can be finalized`,
      occurredAt: null,
      severity: "action",
      action: { kind: "navigate", label: "Generate reports", href: "/reports" },
      fallback: true,
    });
  }

  // 6. Packages to complete (report exists, package missing/blocked).
  const packagesToComplete =
    (p?.packages?.missingFromReported ?? 0) + (p?.packages?.blocked ?? 0);
  if (packagesToComplete > 0) {
    items.push({
      id: "complete:packages",
      type: "complete_package",
      label: "Verification packages to complete",
      title: `${packagesToComplete} report${packagesToComplete === 1 ? "" : "s"} missing a package`,
      occurredAt: null,
      severity: "warn",
      action: { kind: "navigate", label: "Complete packages", href: "/reports" },
      fallback: true,
    });
  }

  // 7. Verification ready to publish.
  const unpublished = p?.publicVerify?.unpublished ?? 0;
  if (unpublished > 0 && args.reportCount > 0) {
    items.push({
      id: "publish:verify",
      type: "publish_verification",
      label: "Verification ready to publish",
      title: `${unpublished} record${unpublished === 1 ? "" : "s"} can be made publicly verifiable`,
      occurredAt: null,
      severity: "action",
      action: { kind: "navigate", label: "Publish verification", href: "/evidence" },
      fallback: true,
    });
  }

  // 8. Integrity needing attention.
  if (args.trust.needingAttention > 0) {
    items.push({
      id: "integrity:attention",
      type: "fix_integrity",
      label: "Records need an integrity review",
      title: `${args.trust.needingAttention} record${args.trust.needingAttention === 1 ? "" : "s"} flagged`,
      occurredAt: null,
      severity: "warn",
      action: { kind: "navigate", label: "Review integrity", href: "/evidence" },
      fallback: true,
    });
  }

  // 9. Matters with incomplete work.
  for (const c of args.caseHealth) {
    items.push({
      id: `case:${c.caseId}`,
      type: "complete_case",
      label: "Matter needs work",
      title: `${c.caseName} · ${c.reason}`,
      occurredAt: null,
      severity: "warn",
      action: { kind: "navigate", label: "Open matter", href: c.href },
      fallback: true,
    });
  }

  return items.slice(0, 8);
}

function failureType(category: string): OperationalQueueItem["type"] {
  if (category === "report_failure") return "report_failure";
  if (category === "verification_package_failure") return "package_failure";
  return "ots_failure";
}

/**
 * Active Matters — the work-centric matter portfolio. Shows the most
 * relevant active cases (needs-work first, then on-track), each with a
 * real status. Sourced from command-center caseOperations.topCases.
 */
function buildActiveMatters(cc: HomeCommandCenterInput | null): ActiveMatterRow[] {
  const topCases = cc?.sections?.caseOperations?.data?.topCases ?? [];
  const rows: ActiveMatterRow[] = topCases.map((c) => {
    const unreviewed = c.unreviewedCount ?? 0;
    const overdue = c.overdueReviewCount ?? 0;
    const escalations = c.openEscalationsCount ?? 0;
    const needsWork = unreviewed > 0 || overdue > 0 || escalations > 0;
    const reasons: string[] = [];
    if (unreviewed > 0) reasons.push(`${unreviewed} unreviewed`);
    if (overdue > 0) reasons.push(`${overdue} overdue`);
    if (escalations > 0) reasons.push(`${escalations} blocked`);
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
      statusLabel: reasons.length > 0 ? reasons.join(" · ") : "On track",
      href: `/cases/${encodeURIComponent(c.caseId)}`,
    };
  });
  // Needs-work matters first, then on-track; cap to keep Home scannable.
  rows.sort((a, b) => Number(b.needsWork) - Number(a.needsWork));
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
  const stages: IntakeStage[] = [
    { key: "active", label: "Active links", count: s.activeLinks, tone: "neutral" },
    { key: "awaiting", label: "Awaiting response", count: s.awaitingResponse, tone: s.awaitingResponse > 0 ? "warn" : "neutral" },
    { key: "received", label: "Responses received", count: s.receivedSubmissions, tone: s.receivedSubmissions > 0 ? "ok" : "neutral" },
    { key: "in_review", label: "Pending review", count: s.receivedSubmissions, tone: s.receivedSubmissions > 0 ? "warn" : "neutral" },
    { key: "failed", label: "Failed sends", count: s.failedDeliveries, tone: s.failedDeliveries > 0 ? "danger" : "neutral" },
  ];
  return {
    stages,
    links: args.collection,
    empty:
      s.activeLinks === 0 &&
      args.collection.length === 0 &&
      s.receivedSubmissions === 0,
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
  return {
    reportsReady,
    packagesReady,
    reportsPending: (p?.reports?.queued ?? 0) + (p?.reports?.missingFromSigned ?? 0),
    packagesPending: (p?.packages?.queued ?? 0) + (p?.packages?.missingFromReported ?? 0),
    reportsFailed: p?.reports?.failed ?? 0,
    packagesFailed: (p?.packages?.failed ?? 0) + (p?.packages?.blocked ?? 0),
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
}): VerificationHealth {
  const verifiable: VerifiableRecord[] = args.recentReports
    .filter((r) => r.packageReady && r.actions.verify)
    .slice(0, 5)
    .map((r) => ({
      evidenceId: r.evidenceId,
      title: r.evidenceTitle,
      verifyHref: r.actions.verify as string,
    }));
  return {
    live: args.trust.verifyPublished,
    unpublished: args.trust.empty ? 0 : Math.max(0, args.trust.totalEvidence - args.trust.verifyPublished - args.trust.verifySuspended),
    suspended: args.trust.verifySuspended,
    verifiable,
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
  storage: StorageUsage | null;
}): WorkspaceHealthMetric[] {
  const p = args.pipeline ?? null;
  const complete = p?.evidence?.reported ?? 0;
  const needReport = p?.reports?.missingFromSigned ?? 0;
  const submissionsWaiting = args.submissions.length;
  const integrityIssues = args.trust.needingAttention + args.needsFixing.length;
  const storageTone: WorkspaceHealthMetric["tone"] = args.storage?.limitReached
    ? "danger"
    : args.storage?.nearLimit
      ? "warn"
      : "ok";
  const storageValue = args.storage?.usagePercent != null ? `${args.storage.usagePercent}%` : "—";
  return [
    { key: "complete", label: "Records complete", value: complete, tone: complete > 0 ? "ok" : "neutral" },
    { key: "need_report", label: "Need a report", value: needReport, tone: needReport > 0 ? "warn" : "ok" },
    { key: "active_cases", label: "Active matters", value: args.activeCasesCount, tone: "neutral" },
    { key: "submissions", label: "Submissions waiting", value: submissionsWaiting, tone: submissionsWaiting > 0 ? "warn" : "ok" },
    { key: "reports_ready", label: "Reports ready", value: args.reportsReady, tone: args.reportsReady > 0 ? "ok" : "neutral" },
    { key: "integrity", label: "Integrity issues", value: integrityIssues, tone: integrityIssues > 0 ? "danger" : "ok" },
    { key: "storage", label: "Storage used", value: storageValue, tone: storageTone },
  ];
}

// ============================================================================
// Main normalizer
// ============================================================================

export type NormalizeInputs = {
  plan: HomePlan;
  workspaceId: string | null;
  activeSpaceType: ActiveSpaceType;
  commandCenter: HomeCommandCenterInput | null;
  trustSummary: HomeTrustSummaryInput | null;
  billing: HomeBillingInput | null;
  reports: HomeReportsInput | null;
  intakeLinks: HomeIntakeLinksInput | null;
  inbox: HomeInboxInput | null;
  communications: HomeCommunicationsInput | null;
  orgs: HomeOrgsInput | null;
  /** Injected for deterministic day-bucketing in tests. */
  nowMs?: number;
};

export function normalizeHomeViewModel(
  inputs: NormalizeInputs,
): HomeViewModel {
  const cc = inputs.commandCenter;
  const nowMs = inputs.nowMs ?? Date.now();

  const flagged = integrityFlaggedIds(cc);
  const trustState = buildTrustState(inputs.trustSummary);
  const recentEvidence = buildRecentEvidence({
    cc,
    reportsInput: inputs.reports,
    flagged,
  });
  const recentReports = buildRecentReports(inputs.reports);
  const caseHealth = buildCaseHealth(cc);
  const submissions = buildSubmissions({
    inbox: inputs.inbox,
    workspaceId: inputs.workspaceId,
  });
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
    receivedSubmissions: submissions.length,
  });

  // Case Health header counters — real cc signals.
  const caseHealthSummary: CaseHealthSummary = {
    gapsCount: cc?.sections?.caseOperations?.data?.casesWithEvidenceGapsCount ?? 0,
    blockersCount: caseHealth.filter((c) => c.openEscalationsCount > 0).length,
  };

  // Counters used by hero + checklist (all workspace-scoped).
  const evCounts = cc?.sections?.pipelineDetail?.data?.evidence;
  const evidenceCount =
    (evCounts?.uploaded ?? 0) + (evCounts?.signed ?? 0) + (evCounts?.reported ?? 0) ||
    trustState.totalEvidence ||
    recentEvidence.length;
  const caseCount = cc?.sections?.caseOperations?.data?.activeCasesCount ?? 0;
  const reportCount = inputs.reports?.items?.length ?? 0;
  const intakeLinkCount = inputs.intakeLinks?.links?.length ?? 0;

  // Storage forecast needs the real record count, so build it here.
  const storage = buildStorage(inputs.billing, evidenceCount);

  // Reports generated today (real generatedAtUtc).
  const startOfToday = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const reportsToday = (inputs.reports?.items ?? []).filter((r) => {
    const t = r.report?.generatedAtUtc ? Date.parse(r.report.generatedAtUtc) : NaN;
    return Number.isFinite(t) && t >= startOfToday;
  }).length;

  const teamWork = buildTeamWork({
    plan: inputs.plan,
    activeSpaceType: inputs.activeSpaceType,
    orgs: inputs.orgs,
    workspaceId: inputs.workspaceId,
    submissionsCount: submissions.length,
    reportsToday,
  });

  const checklist = buildChecklist({
    plan: inputs.plan,
    evidenceCount,
    caseCount,
    reportCount,
    intakeLinkCount,
    teamMemberCount: teamWork?.members ?? 0,
  });
  const visibleSteps = checklist.filter((s) => s.visible);
  const checklistComplete =
    visibleSteps.length > 0 && visibleSteps.every((s) => s.done);

  const heroAction = pickHeroAction({
    plan: inputs.plan,
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
    submissions,
    nowMs,
  });

  // Operational surfaces — all composed from the slices above + the real
  // command-center pipeline projection. No new fetches, no fabrication.
  const pipeline = cc?.sections?.pipelineDetail?.data ?? null;
  const reportProduction = buildReportProduction({ pipeline, recentReports });
  const operationalQueue = buildOperationalQueue({
    submissions,
    needsFixing,
    collection,
    caseHealth,
    trust: trustState,
    pipeline,
    reportCount,
  });
  const activeMatters = buildActiveMatters(cc);
  const intakePipeline = buildIntakePipeline({ collection, stats: collectionStats });
  const verificationHealth = buildVerificationHealth({ trust: trustState, recentReports });
  const workspaceHealth = buildWorkspaceHealth({
    pipeline,
    trust: trustState,
    submissions,
    needsFixing,
    activeCasesCount: caseCount,
    reportsReady: reportProduction.reportsReady,
    storage,
  });

  const hasAnyData =
    evidenceCount > 0 ||
    reportCount > 0 ||
    submissions.length > 0 ||
    needsFixing.length > 0 ||
    collection.length > 0 ||
    caseHealth.length > 0 ||
    trustState.totalEvidence > 0 ||
    activity.length > 0 ||
    storage?.usedLabel != null;

  return {
    plan: inputs.plan,
    workspaceId: inputs.workspaceId,
    heroAction,
    operationalQueue,
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
    recentReports,
    caseHealth,
    caseHealthSummary,
    trustState,
    activity,
    storage,
    teamWork,
    checklist,
    checklistComplete,
    hasAnyData,
  };
}
