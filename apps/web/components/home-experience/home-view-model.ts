/**
 * Phase IA-self-serve-home-rebuild — self-serve Home view model.
 *
 * The Home page consumes three existing endpoints:
 *
 *   1. GET /v1/dashboard/command-center?teamId=<id>
 *      — the same envelope the enterprise CommandCenter renders.
 *        Self-serve ONLY consumes an allowlist of sections from it.
 *
 *   2. GET /v1/billing/overview
 *      — storage usage + plan entitlement + storage add-ons.
 *
 *   3. GET /v1/reports
 *      — user-scoped report list (added in
 *        Phase IA-self-serve-regression-fix). Falls back gracefully
 *        when the workspace-scoped aggregator is empty.
 *
 *   (Optional, additive) GET /v1/me/operational-priorities
 *      — onboarding signals for the Getting Started checklist.
 *
 * STRICT BOUNDARY RULES:
 *
 *   * The normalizer is the ONE place the raw command-center envelope
 *     is touched. UI components NEVER see the raw envelope — they only
 *     see the sanitized view model below.
 *
 *   * `normalizeCommandCenter()` filters out every enterprise section:
 *     reviewerOrchestration, workloadEngine, reviewerCapacity,
 *     governancePosture, queueCongestion, queueWorkerTelemetry,
 *     incidents, predictiveRisk, accessSecurityAnomalies,
 *     accessSecurityClassifier, organizationalIntelligenceV2,
 *     organizationalHealth, operationalGraph, crossCaseIntelligenceV2,
 *     relationshipIntelligence. If any of those drift into the
 *     view model later, the source-contract test in
 *     `phase-ia-self-serve-home-rebuild.test.ts` trips.
 *
 *   * Vocabulary translation lives here too: the enterprise field
 *     `organizationalIntelligence` → "Your activity"; routing-queue
 *     items with `affectedDomain ∈ {reviewer_ops, governance,
 *     intelligence, security}` are dropped before the Next Action
 *     card sees them.
 *
 *   * NEVER fabricate values. When data is missing, return null /
 *     empty arrays — the components render an empty state.
 *
 * This file has no runtime React imports; it's a pure projection
 * that's directly testable in vitest.
 */

// ============================================================================
// Plan + tier helpers
// ============================================================================

export type HomePlan = "FREE" | "PAYG" | "PRO" | "TEAM" | null;

/** Plans that should see Team Activity + Intake Links on Home. */
export function isProOrTeam(plan: HomePlan): boolean {
  return plan === "PRO" || plan === "TEAM";
}

/** Plans that see the FREE reports locked notice instead of normal reports. */
export function isFreePlan(plan: HomePlan): boolean {
  return plan === "FREE";
}

// ============================================================================
// View-model types — what the UI sees
// ============================================================================

export type SnapshotTile = {
  /** Stable key for `data-snapshot-key` attribute + test selectors. */
  key:
    | "evidence_records"
    | "cases"
    | "reports"
    | "verification_links"
    | "storage";
  /** Short label (3 words max). */
  label: string;
  /** Display value already formatted (e.g. "12", "1.2 GB / 5 GB", "—"). */
  value: string;
  /** Plain-language hint shown under the value when present. */
  hint: string | null;
  /** Click-through target when the user taps the tile. */
  href: string | null;
};

export type RecentEvidenceRow = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  href: string;
};

export type RecentCaseRow = {
  caseId: string;
  caseName: string;
  evidenceCount: number;
  lastActivityAtUtc: string | null;
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
};

export type PipelineStageTile = {
  /** Stable key for testing. */
  key:
    | "uploaded"
    | "signed"
    | "timestamped"
    | "reported"
    | "verification"
    | "anchored";
  label: string;
  value: number;
  /** When non-null, surfaces a small "Pending" / "Stuck" hint. */
  tone: "neutral" | "ok" | "warn";
};

export type StorageUsage = {
  usedLabel: string | null;
  limitLabel: string | null;
  usagePercent: number | null;
  nearLimit: boolean;
  limitReached: boolean;
  upgradeHref: string;
};

export type NextAction = {
  kind:
    | "capture"
    | "create_case"
    | "generate_report"
    | "create_intake_link"
    | "invite_teammate"
    | "review_evidence_missing_report"
    | "review_evidence_missing_package"
    | "fix_failed_report"
    | "caught_up";
  label: string;
  hint: string;
  href: string;
};

export type IntegrityAlert = {
  id: string;
  title: string;
  /** Plain-language self-serve copy — NEVER the raw reasonCode. */
  body: string;
  severity: "warn" | "danger";
  href: string;
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
  /** Hidden when the user's plan doesn't include this step. */
  visible: boolean;
  href: string;
};

export type TeamActivity = {
  ownedTeamCount: number;
  totalMemberCount: number;
  pendingInviteCount: number;
  /** First few orgs for the Team Activity card. */
  teams: Array<{
    id: string;
    name: string;
    memberCount: number;
    role: string | null;
  }>;
  manageHref: string;
};

/** Full home view model the dashboard consumes. */
export type HomeViewModel = {
  plan: HomePlan;
  snapshot: SnapshotTile[];
  nextAction: NextAction;
  recentEvidence: RecentEvidenceRow[];
  recentCases: RecentCaseRow[];
  recentReports: RecentReportRow[];
  pipeline: PipelineStageTile[];
  storage: StorageUsage | null;
  teamActivity: TeamActivity | null;
  integrityAlerts: IntegrityAlert[];
  checklist: ChecklistStep[];
  /** True when the view model has at least one signal from real data. */
  hasAnyData: boolean;
};

// ============================================================================
// Inputs — the raw fetched shapes the normalizer accepts.
// We type these structurally so the normalizer is portable for tests.
// ============================================================================

/** Narrowed shape of the slice of the command-center envelope we read. */
export type HomeCommandCenterInput = {
  sections?: {
    recentEvidence?: {
      status?: string;
      items?: Array<{
        id: string;
        title: string;
        status: string;
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
        topCases?: Array<{
          caseId: string;
          caseName: string;
          evidenceCount: number;
          lastActivityAtUtc: string | null;
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
    organizationalIntelligence?: {
      status?: string;
      data?: {
        evidenceCreatedLast24h?: number;
        evidenceCreatedLast7d?: number;
        evidenceFinalizedLast7d?: number;
        reportsGeneratedLast7d?: number;
        packagesGeneratedLast7d?: number;
        activityLast7d?: number;
      } | null;
    };
    custodyIntegrityAnomalies?: {
      status?: string;
      items?: Array<{
        evidenceId: string;
        title: string;
        reasonCode: string;
        severity: string;
        href: string;
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
    routingQueue?: {
      meta?: { status?: string };
      items?: Array<{
        id: string;
        title: string;
        severity: string;
        affectedDomain?: string;
        primaryRoute?: string;
        href?: string;
      }>;
    };
  };
};

/** Narrowed shape of /v1/billing/overview the storage card reads. */
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

/** Narrowed shape of GET /v1/reports the recent reports card reads. */
export type HomeReportsInput = {
  items?: Array<{
    evidenceId: string;
    title: string | null;
    report?: {
      available?: boolean;
      version?: number | null;
      generatedAtUtc?: string | null;
    };
    package?: { available?: boolean };
  }>;
};

/** Narrowed shape of envelope.organizations for Team Activity. */
export type HomeOrgsInput = ReadonlyArray<{
  id: string;
  name: string | null;
  displayName: string | null;
  memberCount: number;
  role: string | null;
  membershipStatus: string;
}>;

// ============================================================================
// Enterprise blocklist (defense in depth)
// ============================================================================

/**
 * Sections that MUST NEVER reach the self-serve view model, even if the
 * backend accidentally populates them on a PERSONAL workspace. Drives
 * the source-contract test that pins our boundary.
 */
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

/**
 * Routing-queue item domains we drop when picking a Next Action.
 * Anything from reviewer_ops / governance / security / intelligence /
 * incidents is enterprise-only or sensitive — never surfaced to
 * self-serve users.
 */
const ENTERPRISE_DOMAINS = new Set([
  "reviewer_ops",
  "governance",
  "intelligence",
  "security",
  "incidents",
  "queue_health",
]);

// ============================================================================
// Plain-language translations for integrity reasonCodes
// ============================================================================

function translateIntegrityReason(code: string | undefined): string {
  switch (code) {
    case "INTEGRITY_FAILED":
      return "The integrity check on this record didn't pass — review before sharing.";
    case "INTEGRITY_REVIEW_REQUIRED":
      return "This record's integrity needs a manual review.";
    case "REPORT_BUT_NO_PACKAGE":
      return "Report is ready but the verification package didn't generate. Try regenerating.";
    case "PACKAGE_BUT_NO_REPORT":
      return "A verification package exists for this record, but the PDF report is missing.";
    case "PACKAGE_BLOCKED":
      return "The verification package is blocked. Open the record to see why.";
    default:
      return "This record needs your attention.";
  }
}

function severityToAlertTone(s: string | undefined): "warn" | "danger" {
  const lower = (s ?? "").toLowerCase();
  if (lower === "critical" || lower === "danger" || lower === "high") {
    return "danger";
  }
  return "warn";
}

// ============================================================================
// Normalizer — the boundary
// ============================================================================

type SnapshotInputs = {
  pipeline?: HomeCommandCenterInput["sections"];
  reportsInput?: HomeReportsInput | null;
  storage?: StorageUsage | null;
};

function buildSnapshot(inputs: SnapshotInputs): SnapshotTile[] {
  const p = inputs.pipeline ?? {};

  const pipelineData = p.pipelineDetail?.data ?? null;
  const evidenceTotal = pipelineData
    ? (pipelineData.evidence?.uploaded ?? 0) +
      (pipelineData.evidence?.signed ?? 0) +
      (pipelineData.evidence?.reported ?? 0)
    : null;

  const recentEvidenceCount = p.recentEvidence?.items?.length ?? null;
  const evidenceValue =
    evidenceTotal != null && evidenceTotal > 0
      ? String(evidenceTotal)
      : recentEvidenceCount != null && recentEvidenceCount > 0
        ? String(recentEvidenceCount)
        : "0";

  const cases = p.caseOperations?.data?.activeCasesCount;
  const casesValue =
    typeof cases === "number" ? String(cases) : "0";

  const reportsReady = pipelineData?.reports?.ready ?? null;
  const reportsListLen = inputs.reportsInput?.items?.length ?? null;
  const reportsValue =
    reportsReady != null && reportsReady > 0
      ? String(reportsReady)
      : reportsListLen != null && reportsListLen > 0
        ? String(reportsListLen)
        : "0";

  const published = pipelineData?.publicVerify?.published ?? null;
  const verifyValue =
    published != null && published >= 0 ? String(published) : "0";

  const storageValue =
    inputs.storage?.usedLabel && inputs.storage?.limitLabel
      ? `${inputs.storage.usedLabel} / ${inputs.storage.limitLabel}`
      : "—";
  const storageHint =
    inputs.storage?.usagePercent != null
      ? `${inputs.storage.usagePercent}% used`
      : null;

  return [
    {
      key: "evidence_records",
      label: "Evidence records",
      value: evidenceValue,
      hint: null,
      href: "/evidence",
    },
    {
      key: "cases",
      label: "Cases",
      value: casesValue,
      hint: null,
      href: "/cases",
    },
    {
      key: "reports",
      label: "Reports",
      value: reportsValue,
      hint: null,
      href: "/reports",
    },
    {
      key: "verification_links",
      label: "Verification links",
      value: verifyValue,
      hint: null,
      href: "/evidence",
    },
    {
      key: "storage",
      label: "Storage",
      value: storageValue,
      hint: storageHint,
      href: "/billing",
    },
  ];
}

function buildRecentEvidence(
  cc: HomeCommandCenterInput | null,
): RecentEvidenceRow[] {
  const items = cc?.sections?.recentEvidence?.items ?? [];
  return items.slice(0, 5).map((it) => ({
    id: it.id,
    title: it.title || it.id,
    status: it.status,
    createdAt: it.createdAt,
    href: `/evidence/${encodeURIComponent(it.id)}`,
  }));
}

function buildRecentCases(
  cc: HomeCommandCenterInput | null,
): RecentCaseRow[] {
  const items = cc?.sections?.caseOperations?.data?.topCases ?? [];
  return items.slice(0, 5).map((it) => ({
    caseId: it.caseId,
    caseName: it.caseName,
    evidenceCount: it.evidenceCount,
    lastActivityAtUtc: it.lastActivityAtUtc ?? null,
    href: `/cases/${encodeURIComponent(it.caseId)}`,
  }));
}

function buildRecentReports(
  reportsInput: HomeReportsInput | null,
): RecentReportRow[] {
  const items = reportsInput?.items ?? [];
  return items
    .filter((r) => r.report?.available)
    .slice(0, 5)
    .map((r) => ({
      evidenceId: r.evidenceId,
      evidenceTitle: r.title ?? r.evidenceId,
      version: r.report?.version ?? null,
      generatedAtUtc: r.report?.generatedAtUtc ?? null,
      reportReady: r.report?.available === true,
      packageReady: r.package?.available === true,
      href: `/evidence/${encodeURIComponent(r.evidenceId)}`,
    }));
}

function buildPipeline(
  cc: HomeCommandCenterInput | null,
): PipelineStageTile[] {
  const d = cc?.sections?.pipelineDetail?.data ?? null;
  const ev = d?.evidence ?? {};
  const rep = d?.reports ?? {};
  const pkg = d?.packages ?? {};
  const ver = d?.publicVerify ?? {};

  const uploadedTotal =
    (ev.uploaded ?? 0) + (ev.signed ?? 0) + (ev.reported ?? 0);

  return [
    {
      key: "uploaded",
      label: "Uploaded",
      value: uploadedTotal,
      tone: (ev.stuckUploading ?? 0) > 0 ? "warn" : "neutral",
    },
    {
      key: "signed",
      label: "Signed",
      value: (ev.signed ?? 0) + (ev.reported ?? 0),
      tone: "neutral",
    },
    {
      key: "timestamped",
      label: "Timestamped",
      value: ev.reported ?? 0,
      tone: "neutral",
    },
    {
      key: "reported",
      label: "Reported",
      value: rep.ready ?? 0,
      tone: (rep.failed ?? 0) > 0 ? "warn" : "neutral",
    },
    {
      key: "verification",
      label: "Verification published",
      value: ver.published ?? 0,
      tone: "neutral",
    },
    {
      key: "anchored",
      label: "Packages ready",
      value: pkg.ready ?? 0,
      tone: (pkg.failed ?? 0) > 0 ? "warn" : "neutral",
    },
  ];
}

function buildStorage(
  billing: HomeBillingInput | null,
): StorageUsage | null {
  const s = billing?.workspaces?.personal?.storage;
  if (!s) return null;
  return {
    usedLabel: s.usedLabel ?? null,
    limitLabel: s.limitLabel ?? null,
    usagePercent:
      typeof s.usagePercent === "number" ? Math.round(s.usagePercent) : null,
    nearLimit: s.nearLimit === true,
    limitReached: s.limitReached === true,
    upgradeHref: "/billing",
  };
}

function pickNextAction(args: {
  plan: HomePlan;
  cc: HomeCommandCenterInput | null;
  evidenceCount: number;
  caseCount: number;
  reportCount: number;
}): NextAction {
  const { plan, cc } = args;

  // 1. Highest priority — a routing-queue item the self-serve user
  //    can act on. We drop enterprise-domain items.
  const candidates = cc?.sections?.routingQueue?.items ?? [];
  const acceptable = candidates.find(
    (it) =>
      !ENTERPRISE_DOMAINS.has(it.affectedDomain ?? "") &&
      typeof (it.primaryRoute ?? it.href) === "string",
  );
  if (acceptable) {
    const route = acceptable.primaryRoute ?? acceptable.href!;
    return {
      kind: "review_evidence_missing_report",
      label: acceptable.title,
      hint: "Open the record to continue.",
      href: route,
    };
  }

  // 2. Pipeline-derived priorities.
  const pipeline = cc?.sections?.pipelineDetail?.data;
  if ((pipeline?.reports?.failed ?? 0) > 0) {
    return {
      kind: "fix_failed_report",
      label: "Retry a failed report",
      hint: "One of your reports didn't generate. Open it to retry.",
      href: "/reports",
    };
  }
  if ((pipeline?.reports?.missingFromSigned ?? 0) > 0) {
    return {
      kind: "generate_report",
      label: "Generate a missing report",
      hint: "You have signed evidence without a report yet.",
      href: "/reports",
    };
  }
  if ((pipeline?.packages?.missingFromReported ?? 0) > 0) {
    return {
      kind: "review_evidence_missing_package",
      label: "Complete a missing verification package",
      hint: "A report was generated but its package didn't finish.",
      href: "/reports",
    };
  }

  // 3. Onboarding-shaped fallbacks based on counts.
  if (args.evidenceCount === 0) {
    return {
      kind: "capture",
      label: "Capture your first evidence record",
      hint: "Upload a file or capture from your camera.",
      href: "/capture",
    };
  }
  if (args.caseCount === 0) {
    return {
      kind: "create_case",
      label: "Create your first case",
      hint: "Group related evidence together.",
      href: "/cases",
    };
  }
  if (args.reportCount === 0) {
    return {
      kind: "generate_report",
      label: "Generate your first report",
      hint: "Pick a record and open Reports to finalize it.",
      href: "/reports",
    };
  }
  if (isProOrTeam(plan)) {
    return {
      kind: "create_intake_link",
      label: "Create an intake link",
      hint: "Invite a contributor to upload evidence directly into your workspace.",
      href: "/intake-links",
    };
  }
  return {
    kind: "caught_up",
    label: "You're caught up",
    hint: "Capture new evidence or invite a teammate when you're ready.",
    href: "/capture",
  };
}

function buildIntegrityAlerts(
  cc: HomeCommandCenterInput | null,
): IntegrityAlert[] {
  const out: IntegrityAlert[] = [];
  const custody = cc?.sections?.custodyIntegrityAnomalies?.items ?? [];
  for (const item of custody) {
    out.push({
      id: `custody:${item.evidenceId}`,
      title: item.title,
      body: translateIntegrityReason(item.reasonCode),
      severity: severityToAlertTone(item.severity),
      href: item.href,
    });
  }
  const deep = cc?.sections?.deepIntegrityWatch?.items ?? [];
  for (const item of deep) {
    if (!item.evidenceId || !item.title) continue;
    out.push({
      id: `deep:${item.evidenceId}`,
      title: item.title,
      body: translateIntegrityReason(item.reasonCode),
      severity: severityToAlertTone(item.severity),
      href:
        item.href ?? `/evidence/${encodeURIComponent(item.evidenceId)}`,
    });
  }
  // Cap to 5 so the card stays compact.
  return out.slice(0, 5);
}

function buildChecklist(args: {
  plan: HomePlan;
  evidenceCount: number;
  caseCount: number;
  reportCount: number;
  teamCount: number;
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
      done: false, // we don't have a count endpoint without a new API
      visible: pro,
      href: "/intake-links",
    },
    {
      key: "invite_first_teammate",
      label: "Invite a teammate",
      done: args.teamCount > 0,
      visible: pro,
      href: "/teams",
    },
  ];
}

function buildTeamActivity(args: {
  plan: HomePlan;
  orgs: HomeOrgsInput | null;
}): TeamActivity | null {
  if (!isProOrTeam(args.plan)) return null;
  const orgs = args.orgs ?? [];
  const active = orgs.filter((o) => o.membershipStatus === "ACTIVE");
  const pending = orgs.filter((o) => o.membershipStatus === "PENDING");
  const totalMembers = active.reduce((sum, o) => sum + (o.memberCount ?? 0), 0);
  return {
    ownedTeamCount: active.length,
    totalMemberCount: totalMembers,
    pendingInviteCount: pending.length,
    teams: active.slice(0, 3).map((o) => ({
      id: o.id,
      name: o.displayName ?? o.name ?? "Team",
      memberCount: o.memberCount ?? 0,
      role: o.role,
    })),
    manageHref: "/teams",
  };
}

// ============================================================================
// Main normalizer
// ============================================================================

export type NormalizeInputs = {
  plan: HomePlan;
  commandCenter: HomeCommandCenterInput | null;
  billing: HomeBillingInput | null;
  reports: HomeReportsInput | null;
  orgs: HomeOrgsInput | null;
};

export function normalizeHomeViewModel(
  inputs: NormalizeInputs,
): HomeViewModel {
  // Pull the slice of command-center we accept. The full envelope
  // may contain enterprise sections we MUST NOT consume — restricting
  // to the allowlist below is defence in depth on top of what the
  // hook drops upstream.
  const cc = inputs.commandCenter;
  const storage = buildStorage(inputs.billing);
  const recentEvidence = buildRecentEvidence(cc);
  const recentCases = buildRecentCases(cc);
  const recentReports = buildRecentReports(inputs.reports);
  const pipeline = buildPipeline(cc);

  const evidenceCount =
    (cc?.sections?.pipelineDetail?.data?.evidence?.signed ?? 0) +
    (cc?.sections?.pipelineDetail?.data?.evidence?.reported ?? 0) +
    (cc?.sections?.pipelineDetail?.data?.evidence?.uploaded ?? 0);
  const caseCount = cc?.sections?.caseOperations?.data?.activeCasesCount ?? 0;
  const reportCount = recentReports.length;

  const snapshot = buildSnapshot({
    pipeline: cc?.sections,
    reportsInput: inputs.reports,
    storage,
  });

  const teamActivity = buildTeamActivity({
    plan: inputs.plan,
    orgs: inputs.orgs,
  });

  const integrityAlerts = buildIntegrityAlerts(cc);

  const checklist = buildChecklist({
    plan: inputs.plan,
    evidenceCount,
    caseCount,
    reportCount,
    teamCount: teamActivity?.ownedTeamCount ?? 0,
  });

  const nextAction = pickNextAction({
    plan: inputs.plan,
    cc,
    evidenceCount,
    caseCount,
    reportCount,
  });

  const hasAnyData =
    snapshot.some((t) => t.value !== "0" && t.value !== "—") ||
    recentEvidence.length > 0 ||
    recentCases.length > 0 ||
    recentReports.length > 0 ||
    integrityAlerts.length > 0 ||
    (storage?.usedLabel != null);

  return {
    plan: inputs.plan,
    snapshot,
    nextAction,
    recentEvidence,
    recentCases,
    recentReports,
    pipeline,
    storage,
    teamActivity,
    integrityAlerts,
    checklist,
    hasAnyData,
  };
}
