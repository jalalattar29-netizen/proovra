/**
 * HOME DASHBOARD — pure projections for the native Home.
 *
 * Ports the canonical web Home view model
 * (`apps/web/components/home-experience/home-view-model.ts`, rendered by
 * `SelfServeHomeDashboard.tsx`). Every rule below names the web function it
 * is ported from so the two cannot drift silently.
 *
 * The canonical reads, and what each one answers:
 *   /v1/dashboard/command-center?teamId=  pipelineDetail, caseOperations, timeline
 *   /v1/dashboard/trust-summary?teamId=   TSA/OTS/signing/verify posture, intake count
 *   /v1/billing/overview                  workspaces.personal.storage
 *   /v1/reports?teamId=                   { items, nextCursor } — recent reports
 *   /v1/workflow/intake-links?teamId=     active intake links
 *   /v1/me/inbox                          intake review items (pipeline card)
 *   /v1/ops/summary?teamId=               { summary } — may Home say "All clear"?
 *   /v1/evidence?scope=active             the most recent captures
 *
 * HONESTY, which the web does not need to spell out and Native does: an
 * absent source is UNKNOWN, never zero. The web view model folds a failed read
 * into zeros; Native keeps the "—" / "Not available" it already had, and
 * otherwise uses the web's figures, labels, tones and hrefs verbatim.
 *
 * Pure: no React, no react-native, no fetch, no runtime imports (the unit
 * test transpiles this file on its own).
 */
import type { ProovraStatusTone } from "@proovra/ui";

/* ----------------------------------------------------------------- helpers */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
const n0 = (v: unknown): number => int(v) ?? 0;

/** Thousands separators, matching the web's KPI formatting. */
export function formatKpiNumber(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US");
}

/** A percentage, or the honest em dash when the denominator is zero. */
export function formatPercent(part: number | null, whole: number | null): string {
  if (part === null || whole === null || whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** The web's four-tone vocabulary → the native badge tone. */
export type HomeTone = "ok" | "warn" | "danger" | "neutral";
export function homeToneBadge(tone: HomeTone): ProovraStatusTone {
  return tone === "ok" ? "verified" : tone === "warn" ? "pending" : tone === "danger" ? "risk" : "neutral";
}

/* --------------------------------------------------------------- the inputs */

export interface HomeSources {
  commandCenter?: unknown;
  trustSummary?: unknown;
  billingOverview?: unknown;
  reports?: unknown;
  intakeLinks?: unknown;
  /** GET /v1/communications/messages?purpose=INTAKE_LINK — latest delivery per link (Intake status card). */
  intakeMessages?: unknown;
  inbox?: unknown;
  /** The wider evidence page ({ items: [{ createdAt }], nextCursor }) — KPI 7-day delta. */
  recentEvidence?: unknown;
  /** GET /v1/ops/summary → `summary` (ops.routes.ts:936). Absent = not read. */
  opsSummary?: unknown;
}

/* ------------------------------------------------------------ trust summary */

/** GET /v1/dashboard/trust-summary (trust-summary.service.ts TrustSummary). */
export interface TrustState {
  totalEvidence: number;
  tsaStamped: number;
  tsaPending: number;
  tsaFailed: number;
  tsaNone: number;
  otsAnchored: number;
  otsPending: number;
  otsFailed: number;
  otsNone: number;
  signed: number;
  endToEndReady: number;
  signedWithoutReport: number;
  reportedWithoutPackage: number;
  verifyPublished: number;
  verifySuspended: number;
  needingAttention: number;
  submissionsAwaitingReview: number;
  empty: boolean;
}

/** web buildTrustState. Null when the summary was not read — never a card of zeros. */
export function parseTrustState(summary: unknown): TrustState | null {
  if (!summary || typeof summary !== "object") return null;
  const s = obj(summary);
  const tsa = obj(s.tsa);
  const ots = obj(s.ots);
  const totalEvidence = n0(s.totalEvidence);
  return {
    totalEvidence,
    tsaStamped: n0(tsa.stamped),
    tsaPending: n0(tsa.pending),
    tsaFailed: n0(tsa.failed),
    tsaNone: n0(tsa.none),
    otsAnchored: n0(ots.anchored),
    otsPending: n0(ots.pending),
    otsFailed: n0(ots.failed),
    otsNone: n0(ots.none),
    signed: n0(s.signed),
    endToEndReady: n0(s.endToEndReady),
    signedWithoutReport: n0(s.signedWithoutReport),
    reportedWithoutPackage: n0(s.reportedWithoutPackage),
    verifyPublished: n0(obj(s.publicVerify).published),
    verifySuspended: n0(obj(s.publicVerify).suspended),
    needingAttention: n0(s.needingAttention),
    submissionsAwaitingReview: n0(obj(s.intake).submissionsAwaitingReview),
    empty: totalEvidence === 0,
  };
}

export interface TrustRow {
  key: string;
  label: string;
  segments: Array<{ text: string; tone: HomeTone }>;
  tone: HomeTone;
}

/** web HomeSections trustRows — each count wears its own meaning. */
export function buildTrustRows(t: TrustState): TrustRow[] {
  const out: TrustRow[] = [
    {
      key: "tsa",
      label: "Time-stamp proof (TSA)",
      segments: [
        { text: `${t.tsaStamped} stamped`, tone: "ok" },
        ...(t.tsaPending ? [{ text: `${t.tsaPending} pending`, tone: "warn" as const }] : []),
        ...(t.tsaFailed ? [{ text: `${t.tsaFailed} failed`, tone: "danger" as const }] : []),
        ...(t.tsaNone ? [{ text: `${t.tsaNone} not stamped`, tone: "danger" as const }] : []),
      ],
      tone: t.tsaFailed > 0 ? "danger" : t.tsaPending > 0 ? "warn" : t.empty ? "neutral" : "ok",
    },
    {
      key: "ots",
      label: "OpenTimestamps (OTS)",
      segments: [
        { text: `${t.otsAnchored} anchored`, tone: "ok" },
        ...(t.otsPending ? [{ text: `${t.otsPending} pending`, tone: "warn" as const }] : []),
        ...(t.otsFailed ? [{ text: `${t.otsFailed} failed`, tone: "danger" as const }] : []),
        ...(t.otsNone ? [{ text: `${t.otsNone} not anchored yet`, tone: "danger" as const }] : []),
      ],
      tone: t.otsFailed > 0 ? "danger" : t.otsPending > 0 ? "warn" : t.empty ? "neutral" : "ok",
    },
    { key: "signed", label: "Signed records", segments: [{ text: `${t.signed} of ${t.totalEvidence}`, tone: "neutral" }], tone: "neutral" },
    { key: "verify", label: "Public verification links live", segments: [{ text: `${t.verifyPublished}`, tone: "neutral" }], tone: "neutral" },
  ];
  if (t.verifySuspended > 0) {
    out.push({ key: "verify-suspended", label: "Public verification links paused", segments: [{ text: `${t.verifySuspended}`, tone: "danger" }], tone: "danger" });
  }
  if (t.needingAttention > 0) {
    out.push({ key: "attention", label: "Records needing attention", segments: [{ text: `${t.needingAttention}`, tone: "danger" }], tone: "danger" });
  }
  return out;
}

/* ------------------------------------------------------- command center */

/** command-center.service.ts PipelineDetail (sections.pipelineDetail.data). */
export interface PipelineData {
  evidenceUploaded: number;
  evidenceSigned: number;
  evidenceReported: number;
  reportsReady: number;
  reportsQueued: number;
  reportsFailed: number;
  packagesReady: number;
  packagesQueued: number;
  packagesFailed: number;
  packagesBlocked: number;
  verifyUnpublished: number;
}

export function parsePipeline(commandCenter: unknown): PipelineData | null {
  const section = obj(obj(obj(commandCenter).sections).pipelineDetail);
  if (!section.data || typeof section.data !== "object") return null;
  const d = obj(section.data);
  const ev = obj(d.evidence);
  const r = obj(d.reports);
  const p = obj(d.packages);
  return {
    evidenceUploaded: n0(ev.uploaded),
    evidenceSigned: n0(ev.signed),
    evidenceReported: n0(ev.reported),
    reportsReady: n0(r.ready),
    // `missingFromSigned` is a literal alias of `queued`: read one, never both.
    reportsQueued: int(r.queued) ?? n0(r.missingFromSigned),
    reportsFailed: n0(r.failed),
    packagesReady: n0(p.ready),
    packagesQueued: int(p.queued) ?? n0(p.missingFromReported),
    packagesFailed: n0(p.failed),
    packagesBlocked: n0(p.blocked),
    verifyUnpublished: n0(obj(d.publicVerify).unpublished),
  };
}

/** web CaseHealthSummary — the Active matters header counters. */
export interface CaseHealthSummary {
  gapsCount: number;
  blockersCount: number;
  unlinkedCount: number;
  unreviewedCount: number;
}

export function buildCaseHealthSummary(commandCenter: unknown): CaseHealthSummary | null {
  const section = obj(obj(obj(commandCenter).sections).caseOperations);
  if (!section.data || typeof section.data !== "object") return null;
  const d = obj(section.data);
  return {
    gapsCount: n0(d.casesWithEvidenceGapsCount),
    blockersCount: rows(d.topCases).filter((c) => n0(obj(c).openEscalationsCount) > 0).length,
    unlinkedCount: n0(d.unlinkedEvidenceCount),
    unreviewedCount: n0(d.unreviewedEvidenceCount),
  };
}

function activeCasesCount(commandCenter: unknown): number | null {
  const section = obj(obj(obj(commandCenter).sections).caseOperations);
  if (!section.data || typeof section.data !== "object") return null;
  return int(obj(section.data).activeCasesCount);
}

/* ------------------------------------------------------------- storage */

export interface HomeStorage {
  usedLabel: string;
  limitLabel: string;
  /** 0–1, or null when the plan states no percentage. */
  fraction: number | null;
  nearLimit: boolean;
  limitReached: boolean;
  tone: ProovraStatusTone;
}

/**
 * web buildStorage — `workspaces.personal.storage` (billing-overview.service.ts:269-294).
 *
 * This read `billingOverview.storage`, a key the server has never sent, so
 * Storage never rendered and the health row always said "—". Bytes are
 * BigInt strings on the wire; the server's `usagePercent` and its
 * `nearLimit` / `limitReached` flags are the authority.
 */
export function buildHomeStorage(s: HomeSources): HomeStorage | null {
  const o = obj(obj(obj(obj(s.billingOverview).workspaces).personal).storage);
  const used = str(o.usedLabel);
  if (!used) return null;
  const pct = typeof o.usagePercent === "number" && Number.isFinite(o.usagePercent) ? o.usagePercent : null;
  const nearLimit = o.nearLimit === true;
  const limitReached = o.limitReached === true;
  return {
    usedLabel: used,
    limitLabel: str(o.limitLabel) ?? "—",
    fraction: pct === null ? null : pct / 100,
    nearLimit,
    limitReached,
    tone: limitReached ? "risk" : nearLimit ? "pending" : "neutral",
  };
}

/* ------------------------------------------------------- report production */

/** The subset of a GET /v1/reports row the counts need (home-sections RecentReportRow). */
export interface ReportCountRow {
  reportReady?: boolean;
  packageReady: boolean;
}

export interface DeliverableIssue {
  key: string;
  label: string;
  count: number;
  tone: "danger" | "warn" | "action";
  actionLabel: string;
  href: string;
}

export interface ReportProduction {
  reportsReady: number;
  packagesReady: number;
  reportsPending: number;
  packagesPending: number;
  reportsFailed: number;
  packagesFailed: number;
  needsAction: DeliverableIssue[];
  /** False when neither the pipeline nor the reports list was read. */
  known: boolean;
}

/** web buildReportProduction. */
export function buildReportProduction(pipeline: PipelineData | null, recent: ReadonlyArray<ReportCountRow> | null): ReportProduction {
  const p = pipeline;
  const list = recent ?? [];
  const reportsReady = p ? p.reportsReady : list.filter((r) => r.reportReady !== false).length;
  const packagesReady = p ? p.packagesReady : list.filter((r) => r.packageReady).length;
  const reportsPending = p?.reportsQueued ?? 0;
  const packagesPending = p?.packagesQueued ?? 0;
  const reportsFailed = p?.reportsFailed ?? 0;
  const packagesFailed = (p?.packagesFailed ?? 0) + (p?.packagesBlocked ?? 0);
  const unpublished = p?.verifyUnpublished ?? 0;
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
    known: p !== null || recent !== null,
  };
}

/* --------------------------------------------------------------- hrefs */

export const HOME_INTEGRITY_REVIEW_HREF = "/evidence?verificationStatus=REVIEW_REQUIRED,FAILED";
export const HOME_TSA_FAILURES_HREF = "/evidence?tsaStatus=FAILED,REJECTED,ERROR";
export const HOME_OTS_PENDING_HREF = "/evidence?otsStatus=PENDING,UPGRADING,QUEUED";
export const HOME_ANCHORING_FAILURES_HREF = "/evidence?otsStatus=FAILED,ERRORED,ERROR";
export const HOME_PUBLISH_VERIFICATION_HREF = "/evidence?publicVerifyState=NOT_PUBLISHED,UNPUBLISHED";

/* ------------------------------------------------------------- priorities */

export type PrioritySeverity = "critical" | "warning" | "info";

export interface WorkspacePriority {
  key: string;
  severity: PrioritySeverity;
  count: number;
  label: string;
  whyItMatters: string;
  recommendedAction: string;
  actionLabel: string;
  href: string;
}

/** web PRIORITY_SEVERITY — the pill each severity wears. */
export const PRIORITY_SEVERITY: Record<PrioritySeverity, { label: string; tone: ProovraStatusTone }> = {
  critical: { label: "Critical", tone: "risk" },
  warning: { label: "Needs attention", tone: "pending" },
  info: { label: "Info", tone: "info" },
};

/**
 * web buildWorkspacePriorities — SHARED workspace facts, never one person's
 * notification feed (the web's Phase 4C correction: archiving a notification
 * must not lower a workspace's issue count). This used to be built from
 * `/v1/me/inbox`, which is exactly the source the web retired.
 */
export function buildWorkspacePriorities(args: {
  trust: TrustState | null;
  pipeline: PipelineData | null;
  reportCount: number;
  mattersNeedingWork: number;
  reportsReady: number;
  storage: HomeStorage | null;
  intakeIncluded: boolean;
  /** Active intake links, or null when the links read failed. */
  activeLinks: number | null;
}): WorkspacePriority[] {
  const t = args.trust;
  const p = args.pipeline;
  const out: WorkspacePriority[] = [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  if (args.storage?.limitReached) {
    out.push({
      key: "storage_pressure",
      severity: "critical",
      count: 1,
      label: "Storage limit reached",
      whyItMatters: "New captures are blocked until space is freed or the plan is topped up.",
      recommendedAction: "Manage storage or upgrade before capturing more evidence.",
      actionLabel: "Manage storage",
      href: "/billing",
    });
  }
  if (t && t.tsaFailed > 0) {
    out.push({
      key: "tsa_failures",
      severity: "critical",
      count: t.tsaFailed,
      label: `${t.tsaFailed} TSA timestamp${plural(t.tsaFailed, "", "s")} failed`,
      whyItMatters: "Failed timestamping weakens time-based evidence confidence for these records.",
      recommendedAction: "Open the affected records and review their timestamp state.",
      actionLabel: "Open affected records",
      href: HOME_TSA_FAILURES_HREF,
    });
  }
  if (t && t.otsFailed > 0) {
    out.push({
      key: "anchoring_terminal",
      severity: "critical",
      count: t.otsFailed,
      label: `${t.otsFailed} anchoring failure${plural(t.otsFailed, "", "s")} are terminal`,
      whyItMatters: "Blockchain anchoring cannot be retried for these records — they will stay unanchored.",
      recommendedAction: "Open each failure to decide how to document the gap.",
      actionLabel: "Open affected records",
      href: HOME_ANCHORING_FAILURES_HREF,
    });
  }
  if (t && t.needingAttention > 0) {
    out.push({
      key: "resolve_integrity",
      severity: "warning",
      count: t.needingAttention,
      label: `${t.needingAttention} record${plural(t.needingAttention, "", "s")} need integrity review`,
      whyItMatters: "These records may not be ready for trusted reports or external verification.",
      recommendedAction: "Review each flagged record's integrity verdict.",
      actionLabel: "Review integrity",
      href: HOME_INTEGRITY_REVIEW_HREF,
    });
  }
  const submissions = t?.submissionsAwaitingReview ?? 0;
  if (submissions > 0) {
    out.push({
      key: "review_submissions",
      severity: "warning",
      count: submissions,
      label: `${submissions} submission${plural(submissions, "", "s")} waiting for review`,
      whyItMatters: "External evidence is not part of the trusted record until you review it.",
      recommendedAction: "Review and accept or return each submission.",
      actionLabel: "Review submissions",
      href: "/evidence-requests?status=RESPONSE_RECEIVED,UNDER_REVIEW",
    });
  }
  const packagesMissing = p?.packagesQueued ?? 0;
  if (packagesMissing > 0) {
    out.push({
      key: "complete_packages",
      severity: "warning",
      count: packagesMissing,
      label: `${packagesMissing} package${plural(packagesMissing, " is", "s are")} missing`,
      whyItMatters: "Verification packages are needed for portable external review of reported evidence.",
      recommendedAction: "Complete the missing packages from the reports surface.",
      actionLabel: "Complete packages",
      href: "/reports",
    });
  }
  if (args.mattersNeedingWork > 0) {
    const m = args.mattersNeedingWork;
    out.push({
      key: "matters_need_reports",
      severity: "warning",
      count: m,
      label: `${m} matter${plural(m, "", "s")} need${plural(m, "s", "")} evidence work`,
      whyItMatters: "These matters have gaps or missing deliverables in their evidence chain.",
      recommendedAction: "Open each matter and complete its report, package, or review work.",
      actionLabel: "Open matters",
      href: "/cases",
    });
  }
  if (args.storage?.nearLimit && !args.storage.limitReached) {
    out.push({
      key: "storage_pressure",
      severity: "warning",
      count: 1,
      label: "Storage is close to its limit",
      whyItMatters: "Uploads may be blocked if the workspace reaches its storage limit.",
      recommendedAction: "Free space or extend storage before it runs out.",
      actionLabel: "Manage storage",
      href: "/billing",
    });
  }
  if (t && t.otsPending > 0) {
    out.push({
      key: "ots_pending",
      severity: "warning",
      count: t.otsPending,
      label: `${t.otsPending} OTS proof${plural(t.otsPending, " is", "s are")} still pending`,
      whyItMatters: "Bitcoin anchoring can take time, but long-pending proofs should be checked.",
      recommendedAction: "Review the anchoring status of the pending records.",
      actionLabel: "Review anchoring",
      href: HOME_OTS_PENDING_HREF,
    });
  }
  const unpublished = p?.verifyUnpublished ?? 0;
  if (unpublished > 0 && args.reportCount > 0) {
    out.push({
      key: "publish_verification",
      severity: "info",
      count: unpublished,
      label: `${unpublished} record${plural(unpublished, " is", "s are")} ready but not publicly verifiable`,
      whyItMatters: "External recipients cannot independently verify these records yet.",
      recommendedAction: "Publish their verification pages so links can be shared.",
      actionLabel: "Publish verification",
      href: HOME_PUBLISH_VERIFICATION_HREF,
    });
  }
  if (args.reportsReady > 0) {
    out.push({
      key: "reports_ready",
      severity: "info",
      count: args.reportsReady,
      label: `${args.reportsReady} report${plural(args.reportsReady, " is", "s are")} ready to share`,
      whyItMatters: "These records already have report output available for download or review.",
      recommendedAction: "Open report production to download or share them.",
      actionLabel: "Open reports",
      href: "/reports",
    });
  }
  // An unread links list is not "no links": the nudge needs a real zero.
  if (args.intakeIncluded && args.activeLinks === 0) {
    out.push({
      key: "create_intake_link",
      severity: "info",
      count: 1,
      label: "Create an intake link to request evidence",
      whyItMatters: "Evidence from clients, witnesses, or sources arrives tracked and reviewable.",
      recommendedAction: "Create a secure intake link and send it to your contributor.",
      actionLabel: "Create link",
      href: "/intake-link-create",
    });
  }
  const rank: Record<PrioritySeverity, number> = { critical: 2, warning: 1, info: 0 };
  out.sort((a, b) => rank[b.severity] - rank[a.severity] || b.count - a.count);
  return out.slice(0, 5);
}

/* ------------------------------------------------ operations all-clear */

export interface OperationsVerdict {
  /** "loading" while /v1/ops/summary is in flight; never rendered as a refusal. */
  loadState: "loading" | "ready" | "failed";
  mayAssertAllClear: boolean;
  /** Only when all-clear is refused: the web's title/detail for the reason. */
  refusal: { title: string; detail: string } | null;
}

/**
 * web WorkspacePrioritiesCard — MAY THIS CARD SAY "ALL CLEAR"?
 *
 * Only when the workspace's Operations summary was read completely and the
 * server says so (`mayAssertAllClear`). The refusal names the server's
 * `clearRefusalReason`, because nine reasons do not share one sentence.
 */
export function buildOperationsVerdict(opsSummary: unknown, loading: boolean): OperationsVerdict {
  if (loading) return { loadState: "loading", mayAssertAllClear: false, refusal: null };
  if (!opsSummary || typeof opsSummary !== "object") {
    return {
      loadState: "failed",
      mayAssertAllClear: false,
      refusal: {
        title: "Operations status unavailable",
        detail: "This workspace's shared operational status could not be loaded, so we can't tell you it's clear.",
      },
    };
  }
  const s = obj(opsSummary);
  if (s.mayAssertAllClear === true) return { loadState: "ready", mayAssertAllClear: true, refusal: null };
  return { loadState: "ready", mayAssertAllClear: false, refusal: refusalCopy(str(s.clearRefusalReason)) };
}

function refusalCopy(reason: string | null): { title: string; detail: string } {
  switch (reason) {
    case "UNRESOLVED_CONDITIONS":
      return {
        title: "Open operational conditions",
        detail: "Operations is tracking conditions that aren't listed here. Open Operations to see them.",
      };
    case "NEVER_RUN":
      return {
        title: "Operations not scanned yet",
        detail: "This workspace hasn't been scanned yet, so we can't tell you it's clear.",
      };
    case "RUNNING":
      return { title: "Operations scan in progress", detail: "A scan is running now. This will settle once it finishes." };
    case "STALE":
      return { title: "Operations status out of date", detail: "The last complete scan is too old to describe the workspace now." };
    case "FAILED":
    case "STALLED":
      return { title: "Operations scan did not complete", detail: "The last scan did not finish, so we can't tell you it's clear." };
    default:
      return {
        title: "Operations status incomplete",
        detail: "Not every source could be read, so this may not be the full picture.",
      };
  }
}

/* -------------------------------------------------------------- onboarding */

/**
 * web `evidenceCount` — pipeline stages, else the trust total, else the
 * recent list. Null when none of the three was read.
 */
export function homeEvidenceCount(pipeline: PipelineData | null, trust: TrustState | null, recentCount: number | null): number | null {
  if (pipeline) {
    const n = pipeline.evidenceUploaded + pipeline.evidenceSigned + pipeline.evidenceReported;
    if (n > 0) return n;
  }
  if (trust && trust.totalEvidence > 0) return trust.totalEvidence;
  if (recentCount !== null && recentCount > 0) return recentCount;
  return pipeline || trust || recentCount !== null ? 0 : null;
}

/**
 * web showGettingStarted — onboarding is for TRULY NEW workspaces only.
 * Any real work retires it; an unknown count never shows it.
 */
export function shouldShowGettingStarted(args: {
  evidenceCount: number | null;
  reportCount: number | null;
  caseCount: number | null;
  verifyPublished: number | null;
}): boolean {
  return args.evidenceCount === 0 && (args.reportCount ?? 0) === 0 && (args.caseCount ?? 0) === 0 && (args.verifyPublished ?? 0) === 0;
}

/** web HomeHeader — time-of-day greeting. */
export function homeGreeting(hour: number, firstName: string | null): string {
  const g = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return firstName ? `${g}, ${firstName}` : g;
}

/** web HomeHeader primary CTA: capture-first onboarding vs. the plain list. */
export function homeHeaderCta(captureFirst: boolean): { label: string; href: string } {
  return captureFirst ? { label: "Capture evidence", href: "/capture" } : { label: "All evidence", href: "/evidence" };
}

/* ------------------------------------------------------- executive summary */

export interface HomeSummary {
  overallStatus: "onboarding" | "critical" | "action_required" | "needs_attention" | "healthy" | "unavailable";
  /** The badge. */
  state: string;
  title: string;
  sentence: string;
  tone: ProovraStatusTone;
  /** "Also: …" — up to two further priorities. */
  secondarySignals: string[];
  actionLabel: string | null;
  actionHref: string | null;
}

/**
 * web buildExecutiveSummary — one state, one sentence, one action.
 *
 * Native keeps one rule the web does not have: when neither the command
 * center nor the trust summary was read, the band says so rather than
 * composing a calm workspace out of absent numbers.
 */
export function buildHomeSummary(args: {
  sources: HomeSources;
  trust: TrustState | null;
  priorities: WorkspacePriority[];
  production: ReportProduction;
  storage: HomeStorage | null;
  showGettingStarted: boolean;
}): HomeSummary {
  if (!args.sources.commandCenter && !args.sources.trustSummary) {
    return {
      overallStatus: "unavailable",
      state: "Unavailable",
      title: "Workspace summary unavailable",
      sentence: "Your workspace summary could not be loaded. Pull to refresh to try again.",
      tone: "neutral",
      secondarySignals: [],
      actionLabel: null,
      actionHref: null,
    };
  }
  if (args.showGettingStarted) {
    return {
      overallStatus: "onboarding",
      state: "Getting started",
      title: "Start your first evidence workflow",
      sentence:
        "Capture evidence, create a case, generate a report, and share verification — this summary becomes live workspace health as you work.",
      tone: "info",
      secondarySignals: [],
      actionLabel: "Capture evidence",
      actionHref: "/capture",
    };
  }
  const t = args.trust;
  const failedOutput = args.production.reportsFailed + args.production.packagesFailed;
  const unsigned = t ? Math.max(0, t.totalEvidence - t.signed) : 0;
  const overallStatus: HomeSummary["overallStatus"] =
    (t && (t.tsaFailed > 0 || t.otsFailed > 0)) || args.storage?.limitReached
      ? "critical"
      : (t && (t.needingAttention > 0 || t.verifySuspended > 0)) || failedOutput > 0
        ? "action_required"
        : args.priorities.some((p) => p.severity !== "info") || unsigned > 0 || (t?.otsPending ?? 0) > 0
          ? "needs_attention"
          : "healthy";
  const LABEL: Record<string, string> = {
    critical: "Critical",
    action_required: "Action required",
    needs_attention: "Needs attention",
    healthy: "Healthy",
  };
  const TONE: Record<string, ProovraStatusTone> = {
    critical: "risk",
    action_required: "risk",
    needs_attention: "pending",
    healthy: "verified",
  };
  if (overallStatus === "healthy") {
    return {
      overallStatus,
      state: LABEL.healthy,
      title: "Workspace is healthy",
      sentence: "Evidence, reports, packages, and verification are operating normally.",
      tone: TONE.healthy,
      secondarySignals: args.priorities.slice(0, 2).map((p) => p.label),
      actionLabel: null,
      actionHref: null,
    };
  }
  const top = args.priorities[0] ?? null;
  return {
    overallStatus,
    state: LABEL[overallStatus],
    title: top?.label ?? "Workspace needs review",
    sentence: top
      ? `${top.label} — ${top.whyItMatters}`
      : overallStatus === "needs_attention" && unsigned > 0
        ? `${unsigned} record${unsigned === 1 ? "" : "s"} are not signed yet — signing completes their integrity chain.`
        : "Operational signals need review.",
    tone: TONE[overallStatus],
    secondarySignals: args.priorities.slice(1, 3).map((p) => p.label),
    actionLabel: top?.actionLabel ?? null,
    actionHref: top?.href ?? null,
  };
}

/* ------------------------------------------------------------------- KPIs */

export type HomeKpiKey = "evidence" | "matters" | "trust" | "deliverables" | "intake";

export interface HomeKpi {
  key: HomeKpiKey;
  label: string;
  /** Pre-formatted display value ("334", "92%", "12 / 3"). */
  value: string;
  /** One line: what the number means, never a restatement of the label. */
  subtitle: string;
  tone: ProovraStatusTone;
  /** Where tapping the card goes. */
  href: string;
}

export interface HomeKpiOptions {
  /** SERVER-projected `planFeatures.intakeIncluded` (fail-closed). */
  intakeIncluded?: boolean;
  /** Intake link stats from the pipeline projection, or null when unread. */
  intakeStats?: { activeLinks: number; failedDeliveries: number } | null;
  nowMs?: number;
}

/**
 * web buildKpis — the five canonical KPIs, with the web's labels, formulas,
 * tones and hrefs. An absent source yields "—" / "Not available", never 0.
 *
 * The previous port read `commandCenter.evidence.total`, `cases.active`,
 * `reports.readyCount` and `reports.packagesReady` — keys neither route sends
 * (`/v1/reports` answers `{ items, nextCursor }`) — so four of the five tiles
 * were built from fallbacks or nothing.
 */
export function buildHomeKpis(s: HomeSources, opts: HomeKpiOptions = {}): HomeKpi[] {
  const trust = parseTrustState(s.trustSummary);
  const pipeline = parsePipeline(s.commandCenter);
  const caseCount = activeCasesCount(s.commandCenter);
  const caseHealth = buildCaseHealthSummary(s.commandCenter);
  const nowMs = opts.nowMs ?? Date.now();

  // 7-day delta from the evidence sample (web: the newest 100 records).
  const dayMs = 86_400_000;
  const startOfToday = Math.floor(nowMs / dayMs) * dayMs;
  const sample = obj(s.recentEvidence);
  const sampleRows = rows(sample.items);
  const listHasMore = typeof sample.nextCursor === "string" && sample.nextCursor.length > 0;
  let last7 = 0;
  for (const it of sampleRows) {
    const t = Date.parse(str(obj(it).createdAt) ?? "");
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((startOfToday + dayMs - 1 - t) / dayMs);
    if (idx >= 0 && idx < 7) last7 += 1;
  }

  const total = trust ? trust.totalEvidence : null;
  const evidenceKpi: HomeKpi = {
    key: "evidence",
    label: "Total evidence",
    value: formatKpiNumber(total),
    subtitle:
      total === null
        ? "Not available"
        : total === 0
          ? "No records yet — capture your first"
          : last7 > 0
            ? `+${last7}${listHasMore && last7 >= sampleRows.length ? "+" : ""} in the last 7 days`
            : "No new records this week",
    tone: total !== null && total > 0 ? "verified" : "neutral",
    href: "/evidence",
  };

  const mattersAttention = caseHealth ? caseHealth.gapsCount + caseHealth.blockersCount : 0;
  const mattersKpi: HomeKpi = {
    key: "matters",
    label: "Active matters",
    value: formatKpiNumber(caseCount),
    subtitle:
      caseCount === null
        ? "Not available"
        : caseCount === 0
          ? "No open matters"
          : mattersAttention > 0
            ? `${mattersAttention} need${mattersAttention === 1 ? "s" : ""} attention`
            : "All matters on track",
    tone: mattersAttention > 0 ? "pending" : caseCount !== null && caseCount > 0 ? "verified" : "neutral",
    href: "/cases",
  };

  let trustKpi: HomeKpi;
  if (!trust) {
    trustKpi = { key: "trust", label: "End-to-end ready", value: "—", subtitle: "Not available", tone: "neutral", href: "/evidence" };
  } else {
    const stuck = trust.signedWithoutReport + trust.reportedWithoutPackage;
    const ready = trust.endToEndReady;
    trustKpi = {
      key: "trust",
      label: "End-to-end ready",
      value: trust.totalEvidence >= 10 ? `${Math.round((ready / Math.max(1, trust.totalEvidence)) * 100)}%` : formatKpiNumber(ready),
      subtitle:
        trust.totalEvidence === 0
          ? "End-to-end readiness appears with your first record"
          : stuck > 0
            ? `${formatKpiNumber(ready)} of ${formatKpiNumber(trust.totalEvidence)} have report + package · ${formatKpiNumber(stuck)} need attention`
            : `${formatKpiNumber(ready)} of ${formatKpiNumber(trust.totalEvidence)} have report + package · ${formatKpiNumber(trust.verifyPublished)} verify pages live`,
      tone: trust.needingAttention > 0 ? "risk" : stuck > 0 ? "pending" : ready > 0 ? "verified" : "neutral",
      href: "/evidence",
    };
  }

  const reportRows = s.reports ? rows(obj(s.reports).items).map(obj) : null;
  const rp = buildReportProduction(
    pipeline,
    reportRows
      ? reportRows
          .filter((r) => obj(r.report).available === true)
          .map((r) => ({ reportReady: true, packageReady: obj(r.package).available === true }))
      : null,
  );
  const failed = rp.reportsFailed + rp.packagesFailed;
  const pending = rp.reportsPending + rp.packagesPending;
  const deliverablesKpi: HomeKpi = rp.known
    ? {
        key: "deliverables",
        label: "Reports & packages",
        value: `${formatKpiNumber(rp.reportsReady)} / ${formatKpiNumber(rp.packagesReady)}`,
        subtitle:
          failed > 0
            ? `${failed} failed · ${pending} pending`
            : pending > 0
              ? `${pending} pending`
              : rp.reportsReady + rp.packagesReady > 0
                ? "ready reports / packages"
                : "No deliverables yet",
        tone: failed > 0 ? "risk" : pending > 0 ? "pending" : rp.reportsReady + rp.packagesReady > 0 ? "verified" : "neutral",
        href: "/reports",
      }
    : { key: "deliverables", label: "Reports & packages", value: "—", subtitle: "Not available", tone: "neutral", href: "/reports" };

  const pro = opts.intakeIncluded === true;
  const stats = opts.intakeStats ?? null;
  const submissions = trust ? trust.submissionsAwaitingReview : null;
  let intakeKpi: HomeKpi;
  if (!pro) {
    intakeKpi = { key: "intake", label: "Intake & submissions", value: "—", subtitle: "Included with PRO", tone: "neutral", href: "/billing" };
  } else if (!stats && submissions === null) {
    intakeKpi = { key: "intake", label: "Intake & submissions", value: "—", subtitle: "Not available", tone: "neutral", href: "/intake-links" };
  } else {
    const links = stats?.activeLinks ?? null;
    const failedDeliveries = stats?.failedDeliveries ?? 0;
    const subs = submissions ?? 0;
    intakeKpi = {
      key: "intake",
      label: "Intake & submissions",
      value: `${formatKpiNumber(links)} / ${formatKpiNumber(submissions)}`,
      subtitle:
        failedDeliveries > 0
          ? `${failedDeliveries} failed deliver${failedDeliveries === 1 ? "y" : "ies"}`
          : subs > 0
            ? `${subs} awaiting review`
            : (links ?? 0) > 0
              ? "links active / pending review"
              : "No active intake links",
      tone: failedDeliveries > 0 ? "risk" : subs > 0 ? "pending" : (links ?? 0) > 0 ? "verified" : "neutral",
      href: "/intake-links",
    };
  }

  return [evidenceKpi, mattersKpi, trustKpi, deliverablesKpi, intakeKpi];
}
