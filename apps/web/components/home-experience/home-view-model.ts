/**
 * Phase IA-self-serve-home-rebuild + Phase IA-home-polish — self-serve
 * Home view model.
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
 *   3. GET /v1/reports?teamId=<id>
 *      — workspace-scoped report list (Phase IA-home-polish adds the
 *        `teamId` filter so the Home counter set stays consistent).
 *
 * STRICT BOUNDARY RULES:
 *
 *   * The normalizer is the ONE place the raw command-center envelope
 *     is touched. UI components NEVER see the raw envelope — they only
 *     see the sanitized view model below.
 *
 *   * `normalizeHomeViewModel()` filters out every enterprise section:
 *     reviewerOrchestration, workloadEngine, reviewerCapacity,
 *     governancePosture, queueCongestion, queueWorkerTelemetry,
 *     incidents, predictiveRisk, accessSecurityAnomalies,
 *     accessSecurityClassifier, organizationalIntelligenceV2,
 *     organizationalHealth, operationalGraph, crossCaseIntelligenceV2,
 *     relationshipIntelligence. If any of those drift into the
 *     view model later, the source-contract test trips.
 *
 *   * Vocabulary translation lives here too.
 *
 *   * NEVER fabricate values. When data is missing, return null /
 *     empty arrays — the components render an empty state.
 *
 *   * COUNTER CONSISTENCY: `reports` / `evidence_records` / `cases` MUST
 *     come from the same workspace scope so the dashboard cannot show
 *     impossible combinations like (0 evidence, 50 reports).
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
  key:
    | "evidence_records"
    | "cases"
    | "reports"
    | "verification_links"
    | "storage";
  label: string;
  value: string;
  hint: string | null;
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
  verifyHref: string | null;
  href: string;
  /** Per-row actions wired up only when underlying data is present. */
  actions: {
    open: string;
    reportPdf: string | null;
    packageZip: string | null;
    verify: string | null;
  };
};

export type PipelineStageTile = {
  key:
    | "uploaded"
    | "signed"
    | "timestamped"
    | "reported"
    | "verification"
    | "anchored";
  label: string;
  value: number;
  tone: "neutral" | "ok" | "warn";
};

export type StorageUsage = {
  usedLabel: string | null;
  limitLabel: string | null;
  /** 0–100, rounded to at most 1 decimal place. */
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
  visible: boolean;
  href: string;
};

export type TeamActivity = {
  ownedTeamCount: number;
  totalMemberCount: number;
  pendingInviteCount: number;
  teams: Array<{
    id: string;
    name: string;
    memberCount: number;
    role: string | null;
  }>;
  manageHref: string;
};

/** A single row in the Recent Activity timeline. */
export type ActivityEvent = {
  id: string;
  kind:
    | "evidence_uploaded"
    | "evidence_timestamped"
    | "report_generated"
    | "package_ready"
    | "verification_published"
    | "case_updated";
  label: string;
  occurredAt: string;
  href: string;
};

/** Evidence Health roll-up — only items with non-zero counts surface. */
export type EvidenceHealth = {
  complete: number;
  needsReport: number;
  timestampIssues: number;
  anchorPending: number;
  verificationMissing: number;
  integrityAlerts: number;
  allClear: boolean;
};

/** Compact secondary quick actions row at the top of Home. */
export type QuickAction = {
  key:
    | "upload"
    | "create_case"
    | "open_reports"
    | "create_intake_link"
    | "invite_teammate";
  label: string;
  href: string;
  visible: boolean;
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
  /** True when pipeline carries no signal — UI shows onboarding instead. */
  pipelineEmpty: boolean;
  storage: StorageUsage | null;
  teamActivity: TeamActivity | null;
  integrityAlerts: IntegrityAlert[];
  checklist: ChecklistStep[];
  activity: ActivityEvent[];
  health: EvidenceHealth;
  quickActions: QuickAction[];
  /** True when the view model has at least one signal from real data. */
  hasAnyData: boolean;
};

// ============================================================================
// Inputs — the raw fetched shapes the normalizer accepts.
// ============================================================================

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
    timeline?: {
      status?: string;
      items?: Array<{
        id: string;
        kind?: string;
        eventType?: string;
        occurredAtUtc?: string;
        evidenceId?: string | null;
        caseId?: string | null;
        title?: string;
        label?: string;
      }>;
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
    report?: {
      available?: boolean;
      version?: number | null;
      generatedAtUtc?: string | null;
    };
    package?: {
      available?: boolean;
      version?: number | null;
      generatedAtUtc?: string | null;
    };
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
// Enterprise blocklist (defense in depth)
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

const ENTERPRISE_DOMAINS = new Set([
  "reviewer_ops",
  "governance",
  "intelligence",
  "security",
  "incidents",
  "queue_health",
]);

// ============================================================================
// Plain-language translations
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

/** Map raw timeline event kinds to plain-language Home labels. */
function translateActivityKind(
  raw: string,
): { kind: ActivityEvent["kind"]; label: string } | null {
  const k = raw.toLowerCase();
  if (k.includes("report") && (k.includes("generated") || k.includes("ready"))) {
    return { kind: "report_generated", label: "Report generated" };
  }
  if (k.includes("package") && (k.includes("ready") || k.includes("generated"))) {
    return { kind: "package_ready", label: "Verification package ready" };
  }
  if (k.includes("verification") && k.includes("publish")) {
    return { kind: "verification_published", label: "Public verification link available" };
  }
  if (k.includes("timestamp")) {
    return { kind: "evidence_timestamped", label: "Evidence timestamped" };
  }
  if (k.includes("evidence") && (k.includes("upload") || k.includes("created") || k.includes("finalized"))) {
    return { kind: "evidence_uploaded", label: "Evidence uploaded" };
  }
  if (k.includes("case") && (k.includes("update") || k.includes("created"))) {
    return { kind: "case_updated", label: "Case updated" };
  }
  return null;
}

/** Round to one decimal, then drop trailing ".0" → "12.4" or "12". */
function roundToOneDp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

// ============================================================================
// Builders
// ============================================================================

type SnapshotInputs = {
  cc: HomeCommandCenterInput | null;
  reportsInput: HomeReportsInput | null;
  storage: StorageUsage | null;
};

function evidenceTotalFromPipeline(
  cc: HomeCommandCenterInput | null,
): number {
  const ev = cc?.sections?.pipelineDetail?.data?.evidence;
  if (!ev) return 0;
  return (ev.uploaded ?? 0) + (ev.signed ?? 0) + (ev.reported ?? 0);
}

function evidenceTotalAnyScope(
  cc: HomeCommandCenterInput | null,
  reportsInput: HomeReportsInput | null,
): number {
  const fromPipeline = evidenceTotalFromPipeline(cc);
  if (fromPipeline > 0) return fromPipeline;
  // Fallback: distinct evidenceIds derived from the reports endpoint.
  // This handles the bug where pipelineDetail returns 0 for evidence
  // even though the user has reports — that means the underlying
  // evidence rows exist but the pipelineDetail aggregator missed them.
  const ids = new Set<string>();
  for (const r of reportsInput?.items ?? []) {
    if (r.evidenceId) ids.add(r.evidenceId);
  }
  if (ids.size > 0) return ids.size;
  return cc?.sections?.recentEvidence?.items?.length ?? 0;
}

function buildSnapshot(inputs: SnapshotInputs): SnapshotTile[] {
  const evidence = evidenceTotalAnyScope(inputs.cc, inputs.reportsInput);
  const cases = inputs.cc?.sections?.caseOperations?.data?.activeCasesCount ?? 0;
  const reports = inputs.reportsInput?.items?.length ?? 0;
  const verifyPublished =
    inputs.cc?.sections?.pipelineDetail?.data?.publicVerify?.published ?? 0;

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
      value: String(evidence),
      hint: null,
      href: "/evidence",
    },
    {
      key: "cases",
      label: "Cases",
      value: String(cases),
      hint: null,
      href: "/cases",
    },
    {
      key: "reports",
      label: "Reports",
      value: String(reports),
      hint: null,
      href: "/reports",
    },
    {
      key: "verification_links",
      label: "Verification links",
      value: String(verifyPublished),
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

function buildRecentEvidence(args: {
  cc: HomeCommandCenterInput | null;
  reportsInput: HomeReportsInput | null;
}): RecentEvidenceRow[] {
  const items = args.cc?.sections?.recentEvidence?.items ?? [];
  if (items.length > 0) {
    return items.slice(0, 5).map((it) => ({
      id: it.id,
      title: it.title || it.id,
      status: it.status,
      createdAt: it.createdAt,
      href: `/evidence/${encodeURIComponent(it.id)}`,
    }));
  }
  // Phase IA-home-polish fallback: cc.recentEvidence is empty but the
  // reports endpoint proves evidence exists in this workspace. Build a
  // synthetic recent-evidence list from the reports rows so the
  // dashboard never shows "no evidence" while reports are listed.
  const reportRows = args.reportsInput?.items ?? [];
  if (reportRows.length === 0) return [];
  return reportRows.slice(0, 5).map((r) => ({
    id: r.evidenceId,
    title: r.title || r.evidenceId,
    status: r.status ?? "SIGNED",
    createdAt: r.createdAt ?? r.report?.generatedAtUtc ?? new Date(0).toISOString(),
    href: `/evidence/${encodeURIComponent(r.evidenceId)}`,
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
    .map((r) => {
      const evidenceId = r.evidenceId;
      const open = `/evidence/${encodeURIComponent(evidenceId)}`;
      const reportPdf = r.report?.available
        ? `/v1/evidence/${encodeURIComponent(evidenceId)}/report/latest`
        : null;
      const packageZip = r.package?.available
        ? `/v1/evidence/${encodeURIComponent(evidenceId)}/verification-package`
        : null;
      // Public verification link is only useful when published. We
      // don't have a published flag per-row from /v1/reports, so the
      // UI hides this when packageReady is false.
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
        verifyHref: verify,
        href: open,
        actions: {
          open,
          reportPdf,
          packageZip,
          verify,
        },
      };
    });
}

function buildPipeline(
  cc: HomeCommandCenterInput | null,
): { stages: PipelineStageTile[]; empty: boolean } {
  const d = cc?.sections?.pipelineDetail?.data ?? null;
  const ev = d?.evidence ?? {};
  const rep = d?.reports ?? {};
  const pkg = d?.packages ?? {};
  const ver = d?.publicVerify ?? {};

  const uploadedTotal =
    (ev.uploaded ?? 0) + (ev.signed ?? 0) + (ev.reported ?? 0);

  const stages: PipelineStageTile[] = [
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

  const totalValue = stages.reduce((sum, s) => sum + s.value, 0);
  return { stages, empty: totalValue === 0 };
}

function buildStorage(
  billing: HomeBillingInput | null,
): StorageUsage | null {
  const s = billing?.workspaces?.personal?.storage;
  if (!s) return null;
  // Belt-and-suspenders: if the backend somehow returns a long-decimal
  // usedLabel like "6.528212832286954 GB", normalize the numeric prefix.
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

function pickNextAction(args: {
  plan: HomePlan;
  cc: HomeCommandCenterInput | null;
  evidenceCount: number;
  caseCount: number;
  reportCount: number;
}): NextAction {
  const { plan, cc } = args;

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
      done: false,
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

function buildActivity(args: {
  cc: HomeCommandCenterInput | null;
  reportsInput: HomeReportsInput | null;
}): ActivityEvent[] {
  const out: ActivityEvent[] = [];

  // 1. command-center.timeline — already a real event stream.
  const items = args.cc?.sections?.timeline?.items ?? [];
  for (const it of items) {
    const raw = it.kind ?? it.eventType ?? "";
    const translated = translateActivityKind(raw);
    if (!translated) continue;
    const occurredAt = it.occurredAtUtc;
    if (!occurredAt) continue;
    const href = it.evidenceId
      ? `/evidence/${encodeURIComponent(it.evidenceId)}`
      : it.caseId
        ? `/cases/${encodeURIComponent(it.caseId)}`
        : "/inbox";
    out.push({
      id: `tl:${it.id}`,
      kind: translated.kind,
      label: translated.label,
      occurredAt,
      href,
    });
  }

  // 2. Reports list fallback / supplement — every available report is a
  //    "report generated" event; every available package is a "package
  //    ready" event. Useful when the timeline section is missing or empty.
  const reportRows = args.reportsInput?.items ?? [];
  for (const r of reportRows) {
    if (r.report?.available && r.report.generatedAtUtc) {
      out.push({
        id: `rpt:${r.evidenceId}`,
        kind: "report_generated",
        label: "Report generated",
        occurredAt: r.report.generatedAtUtc,
        href: `/evidence/${encodeURIComponent(r.evidenceId)}`,
      });
    }
    if (r.package?.available && r.package.generatedAtUtc) {
      out.push({
        id: `pkg:${r.evidenceId}`,
        kind: "package_ready",
        label: "Verification package ready",
        occurredAt: r.package.generatedAtUtc,
        href: `/evidence/${encodeURIComponent(r.evidenceId)}`,
      });
    }
  }

  // Deduplicate by id, prefer earlier insertions (timeline wins over
  // synthetic report rows when both are present).
  const seen = new Set<string>();
  const deduped: ActivityEvent[] = [];
  for (const e of out) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    deduped.push(e);
  }
  // Sort newest first, cap at 10.
  deduped.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  return deduped.slice(0, 10);
}

function buildHealth(args: {
  cc: HomeCommandCenterInput | null;
  pipelineEmpty: boolean;
  integrityAlertCount: number;
  evidenceCount: number;
  reportCount: number;
}): EvidenceHealth {
  const d = args.cc?.sections?.pipelineDetail?.data ?? null;
  const needsReport =
    (d?.reports?.missingFromSigned ?? 0) + (d?.reports?.failed ?? 0);
  const verificationMissing = d?.packages?.missingFromReported ?? 0;
  // Timestamp issues: stuckUploading is the closest signal we have on
  // the self-serve allowlist (no reviewer-ops / TSA-internal queues).
  const timestampIssues = d?.evidence?.stuckUploading ?? 0;
  // OTS anchoring is not surfaced as a separate count on the self-serve
  // allowlist. Without a real signal we report 0 — never invent one.
  const anchorPending = 0;

  const completeApprox = Math.max(0, args.reportCount - verificationMissing);
  const allClear =
    !args.pipelineEmpty &&
    needsReport === 0 &&
    timestampIssues === 0 &&
    verificationMissing === 0 &&
    args.integrityAlertCount === 0;

  return {
    complete: completeApprox,
    needsReport,
    timestampIssues,
    anchorPending,
    verificationMissing,
    integrityAlerts: args.integrityAlertCount,
    allClear: allClear && args.evidenceCount > 0,
  };
}

function buildQuickActions(args: { plan: HomePlan }): QuickAction[] {
  const pro = isProOrTeam(args.plan);
  return [
    { key: "upload", label: "Upload evidence", href: "/capture", visible: true },
    { key: "create_case", label: "Create case", href: "/cases", visible: true },
    { key: "open_reports", label: "View reports", href: "/reports", visible: true },
    {
      key: "create_intake_link",
      label: "Create intake link",
      href: "/intake-links",
      visible: pro,
    },
    {
      key: "invite_teammate",
      label: "Invite teammate",
      href: "/teams",
      visible: pro,
    },
  ];
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
  const cc = inputs.commandCenter;
  const storage = buildStorage(inputs.billing);
  const recentEvidence = buildRecentEvidence({
    cc,
    reportsInput: inputs.reports,
  });
  const recentCases = buildRecentCases(cc);
  const recentReports = buildRecentReports(inputs.reports);
  const pipelineBuilt = buildPipeline(cc);

  const evidenceCount = evidenceTotalAnyScope(cc, inputs.reports);
  const caseCount = cc?.sections?.caseOperations?.data?.activeCasesCount ?? 0;
  const reportCount = inputs.reports?.items?.length ?? 0;

  const snapshot = buildSnapshot({
    cc,
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

  const activity = buildActivity({
    cc,
    reportsInput: inputs.reports,
  });

  const health = buildHealth({
    cc,
    pipelineEmpty: pipelineBuilt.empty,
    integrityAlertCount: integrityAlerts.length,
    evidenceCount,
    reportCount,
  });

  const quickActions = buildQuickActions({ plan: inputs.plan });

  const hasAnyData =
    snapshot.some((t) => t.value !== "0" && t.value !== "—") ||
    recentEvidence.length > 0 ||
    recentCases.length > 0 ||
    recentReports.length > 0 ||
    integrityAlerts.length > 0 ||
    activity.length > 0 ||
    (storage?.usedLabel != null);

  return {
    plan: inputs.plan,
    snapshot,
    nextAction,
    recentEvidence,
    recentCases,
    recentReports,
    pipeline: pipelineBuilt.stages,
    pipelineEmpty: pipelineBuilt.empty,
    storage,
    teamActivity,
    integrityAlerts,
    checklist,
    activity,
    health,
    quickActions,
    hasAnyData,
  };
}
