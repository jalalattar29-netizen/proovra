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
    channel: string;
    status: string;
    statusLabel: string;
    at: string | null;
  } | null;
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
    | "intake_failed";
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

/** A workflow launcher — opens/launches a flow, never duplicates nav. */
export type WorkflowLauncher = {
  key:
    | "capture"
    | "request_evidence"
    | "review_submission"
    | "generate_report"
    | "publish_verification";
  label: string;
  href: string;
  visible: boolean;
};

export type HomeViewModel = {
  plan: HomePlan;
  heroAction: HeroAction;
  launchers: WorkflowLauncher[];
  submissions: SubmissionRow[];
  collection: CollectionRow[];
  recentEvidence: RecentEvidenceRow[];
  recentReports: RecentReportRow[];
  caseHealth: CaseHealthRow[];
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

function buildCollection(args: {
  intakeLinks: HomeIntakeLinksInput | null;
  communications: HomeCommunicationsInput | null;
}): CollectionRow[] {
  const links = (args.intakeLinks?.links ?? []).filter(
    (l) => l.status === "ACTIVE",
  );
  // Index latest message per intake link.
  const latestByLink = new Map<
    string,
    { channel: string; status: string; at: string | null }
  >();
  const msgs = [...(args.communications?.messages ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  for (const m of msgs) {
    if (!m.relatedIntakeLinkId) continue;
    if (latestByLink.has(m.relatedIntakeLinkId)) continue;
    latestByLink.set(m.relatedIntakeLinkId, {
      channel: m.channel,
      status: m.status,
      at: m.deliveredAtUtc ?? m.sentAtUtc ?? m.failedAtUtc ?? m.createdAt,
    });
  }
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
            channel: d.channel,
            status: d.status,
            statusLabel: deliveryStatusLabel(d.status),
            at: d.at,
          }
        : null,
      href: `/intake-links?linkId=${encodeURIComponent(l.id)}`,
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
      const verify = r.package?.available
        ? `/v/${encodeURIComponent(evidenceId)}`
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
    needingAttention: s.needingAttention ?? 0,
    empty: totalEvidence === 0,
  };
}

function buildStorage(billing: HomeBillingInput | null): StorageUsage | null {
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
  return {
    usedLabel: polishLabel(s.usedLabel),
    limitLabel: polishLabel(s.limitLabel),
    usagePercent:
      typeof s.usagePercent === "number" ? roundToOneDp(s.usagePercent) : null,
    nearLimit: s.nearLimit === true,
    limitReached: s.limitReached === true,
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
  nowMs: number;
}): ActivityGroup[] {
  const events: ActivityEvent[] = [];

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
  orgs: HomeOrgsInput | null;
  workspaceId: string | null;
  submissionsCount: number;
  reportsToday: number;
}): TeamWork | null {
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

function buildLaunchers(plan: HomePlan): WorkflowLauncher[] {
  const pro = isProOrTeam(plan);
  return [
    { key: "capture", label: "Capture evidence", href: "/capture", visible: true },
    {
      key: "request_evidence",
      label: "Request evidence",
      href: "/intake-links",
      visible: pro,
    },
    {
      key: "review_submission",
      label: "Review submissions",
      href: "/evidence-requests",
      visible: pro,
    },
    {
      key: "generate_report",
      label: "Generate report",
      href: "/reports",
      visible: true,
    },
    {
      key: "publish_verification",
      label: "Publish verification",
      href: "/evidence",
      visible: true,
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
// Main normalizer
// ============================================================================

export type NormalizeInputs = {
  plan: HomePlan;
  workspaceId: string | null;
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
  const storage = buildStorage(inputs.billing);
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
  const collection = buildCollection({
    intakeLinks: inputs.intakeLinks,
    communications: inputs.communications,
  });

  // Counters used by hero + checklist (all workspace-scoped).
  const evCounts = cc?.sections?.pipelineDetail?.data?.evidence;
  const evidenceCount =
    (evCounts?.uploaded ?? 0) + (evCounts?.signed ?? 0) + (evCounts?.reported ?? 0) ||
    trustState.totalEvidence ||
    recentEvidence.length;
  const caseCount = cc?.sections?.caseOperations?.data?.activeCasesCount ?? 0;
  const reportCount = inputs.reports?.items?.length ?? 0;
  const intakeLinkCount = inputs.intakeLinks?.links?.length ?? 0;

  // Reports generated today (real generatedAtUtc).
  const startOfToday = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const reportsToday = (inputs.reports?.items ?? []).filter((r) => {
    const t = r.report?.generatedAtUtc ? Date.parse(r.report.generatedAtUtc) : NaN;
    return Number.isFinite(t) && t >= startOfToday;
  }).length;

  const teamWork = buildTeamWork({
    plan: inputs.plan,
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
    nowMs,
  });

  const launchers = buildLaunchers(inputs.plan);

  const hasAnyData =
    evidenceCount > 0 ||
    reportCount > 0 ||
    submissions.length > 0 ||
    collection.length > 0 ||
    caseHealth.length > 0 ||
    trustState.totalEvidence > 0 ||
    activity.length > 0 ||
    storage?.usedLabel != null;

  return {
    plan: inputs.plan,
    heroAction,
    launchers,
    submissions,
    collection,
    recentEvidence,
    recentReports,
    caseHealth,
    trustState,
    activity,
    storage,
    teamWork,
    checklist,
    checklistComplete,
    hasAnyData,
  };
}
