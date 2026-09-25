/**
 * HOME SECTIONS (T-14 HomeSections.tsx) — the four web Home cards native did
 * not have, ported rule-for-rule from `home-view-model.ts`:
 *
 *   buildActiveMatters      ← buildActiveMatters   (command-center caseOperations.topCases)
 *   buildVerificationHealth ← buildVerificationHealth (trust-summary publicVerify)
 *   buildRecentReports      ← buildRecentReports   (GET /v1/reports items)
 *   buildTeamWork           ← buildTeamWork        (platform context + trust-summary intake)
 *
 * Every figure is a server count. Nothing here fetches; the Home screen owns
 * the reads.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------------------
// Active matters
// ---------------------------------------------------------------------------

export type MatterVerdict = "action_required" | "needs_work" | "healthy";

export interface ActiveMatterRow {
  caseId: string;
  caseName: string;
  evidenceCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
  reportsReadyCount: number;
  packagesReadyCount: number;
  verifyLiveCount: number;
  verdict: MatterVerdict;
  /** "On track", or the reasons joined with " · ". */
  statusLabel: string;
}

export interface ActiveMatters {
  /** False when the caseOperations section was unavailable — not the same as "no matters". */
  available: boolean;
  rows: ActiveMatterRow[];
  activeCasesCount: number | null;
}

export const MATTER_VERDICT_LABEL: Record<MatterVerdict, string> = {
  action_required: "Action required",
  needs_work: "Needs work",
  healthy: "Healthy",
};

export function buildActiveMatters(commandCenter: unknown, reportCaseIds: ReadonlySet<string> = new Set()): ActiveMatters {
  const section = obj(obj(obj(commandCenter).sections).caseOperations);
  const data = section.data && typeof section.data === "object" ? obj(section.data) : null;
  if (!data) return { available: false, rows: [], activeCasesCount: null };
  const out: ActiveMatterRow[] = rows(data.topCases)
    .map(obj)
    .filter((c) => str(c.caseId))
    .map((c) => {
      const caseId = str(c.caseId) as string;
      const evidenceCount = num(c.evidenceCount);
      const unreviewed = num(c.unreviewedCount);
      const overdue = num(c.overdueReviewCount);
      const escalations = num(c.openEscalationsCount);
      // Older payloads without the aggregates fall back to /v1/reports caseIds, as on the web.
      const reportsReadyCount = typeof c.reportsReadyCount === "number" ? c.reportsReadyCount : reportCaseIds.has(caseId) ? 1 : 0;
      const packagesReadyCount = num(c.packagesReadyCount);
      const verifyLiveCount = num(c.verifyLiveCount);
      const hasReport = reportsReadyCount > 0;
      const chain =
        evidenceCount === 0
          ? "none"
          : !hasReport
            ? "needs_report"
            : packagesReadyCount === 0
              ? "missing_package"
              : verifyLiveCount === 0
                ? "needs_publication"
                : "ready";
      const chainIncomplete = evidenceCount > 0 && chain !== "ready";
      const needsWork = unreviewed > 0 || overdue > 0 || escalations > 0 || chainIncomplete;
      const reasons: string[] = [];
      if (unreviewed > 0) reasons.push(`${unreviewed} unreviewed`);
      if (overdue > 0) reasons.push(`${overdue} overdue`);
      if (escalations > 0) reasons.push(`${escalations} blocked`);
      if (chain === "needs_report") reasons.push("no report yet");
      else if (chain === "missing_package") reasons.push("package missing");
      else if (chain === "needs_publication") reasons.push("verification not published");
      const verdict: MatterVerdict = escalations > 0 || overdue > 0 ? "action_required" : needsWork ? "needs_work" : "healthy";
      return {
        caseId,
        caseName: str(c.caseName) ?? "Untitled matter",
        evidenceCount,
        hasActiveLegalHold: c.hasActiveLegalHold === true,
        lastActivityAtUtc: str(c.lastActivityAtUtc),
        reportsReadyCount,
        packagesReadyCount,
        verifyLiveCount,
        verdict,
        statusLabel: reasons.length > 0 ? reasons.join(" · ") : "On track",
      };
    });
  const rank: Record<MatterVerdict, number> = { action_required: 2, needs_work: 1, healthy: 0 };
  out.sort((a, b) => rank[b.verdict] - rank[a.verdict]);
  return {
    available: true,
    rows: out.slice(0, 6),
    activeCasesCount: typeof data.activeCasesCount === "number" ? data.activeCasesCount : null,
  };
}

/** The web chain chip: "E 4 · R 2 · P 1 · V 0". */
export function matterChainLabel(r: ActiveMatterRow): string | null {
  if (r.evidenceCount <= 0) return null;
  return `E ${r.evidenceCount} · R ${r.reportsReadyCount} · P ${r.packagesReadyCount} · V ${r.verifyLiveCount}`;
}

// ---------------------------------------------------------------------------
// Public verification links
// ---------------------------------------------------------------------------

export interface VerificationHealth {
  live: number;
  unpublished: number;
  suspended: number;
  empty: boolean;
  /** command-center timeline `verification_published` events, newest first (max 3). */
  recentPublications: Array<{ label: string; href: string; occurredAt: string }>;
  /** Recent reports whose package is ready — the public verify page works (max 5). */
  verifiable: Array<{ evidenceId: string; title: string }>;
}

/**
 * web buildVerificationHealth. Null when the trust summary was not read —
 * never a card of zeros.
 */
export function buildVerificationHealth(
  trustSummary: unknown,
  extras: { commandCenter?: unknown; recentReports?: ReadonlyArray<RecentReportRow> } = {},
): VerificationHealth | null {
  if (!trustSummary || typeof trustSummary !== "object") return null;
  const s = obj(trustSummary);
  const total = num(s.totalEvidence);
  const live = num(obj(s.publicVerify).published);
  const suspended = num(obj(s.publicVerify).suspended);
  const empty = total === 0;
  const recentPublications = rows(obj(obj(obj(extras.commandCenter).sections).timeline).items)
    .map(obj)
    .filter((it) => it.kind === "verification_published" && str(it.occurredAt))
    .sort((a, b) => ((str(a.occurredAt) ?? "") < (str(b.occurredAt) ?? "") ? 1 : -1))
    .slice(0, 3)
    .map((it) => ({
      label: str(it.label) ?? "Verification published",
      href: str(it.href) ?? "/evidence",
      occurredAt: str(it.occurredAt) as string,
    }));
  const verifiable = (extras.recentReports ?? [])
    .filter((r) => r.packageReady)
    .slice(0, 5)
    .map((r) => ({ evidenceId: r.evidenceId, title: r.title }));
  return {
    live,
    suspended,
    empty,
    unpublished: empty ? 0 : Math.max(0, total - live - suspended),
    recentPublications,
    verifiable,
  };
}

// ---------------------------------------------------------------------------
// Report production — recent reports with their package state
// ---------------------------------------------------------------------------

export interface RecentReportRow {
  evidenceId: string;
  title: string;
  /** Report version, when the server sent one. */
  version: number | null;
  packageReady: boolean;
  generatedAtUtc: string | null;
  /** GET /v1/evidence/:id/report/latest — minted on TAP only (it records a download). */
  reportPdfApiPath: string;
  /** GET /v1/evidence/:id/verification-package, when a package exists. */
  packageZipApiPath: string | null;
}

/** web buildRecentReports — GET /v1/reports rows whose report is available (max 5). */
export function buildRecentReports(reports: unknown): RecentReportRow[] {
  return rows(obj(reports).items)
    .map(obj)
    .filter((r) => str(r.evidenceId) && obj(r.report).available === true)
    .slice(0, 5)
    .map((r) => {
      const evidenceId = str(r.evidenceId) as string;
      const enc = encodeURIComponent(evidenceId);
      const packageReady = obj(r.package).available === true;
      const version = obj(r.report).version;
      return {
        evidenceId,
        title: str(r.title) ?? evidenceId,
        version: typeof version === "number" && Number.isFinite(version) ? version : null,
        packageReady,
        generatedAtUtc: str(obj(r.report).generatedAtUtc),
        reportPdfApiPath: `/v1/evidence/${enc}/report/latest`,
        packageZipApiPath: packageReady ? `/v1/evidence/${enc}/verification-package` : null,
      };
    });
}

/** web middleTruncate — a raw id shown as a label keeps its head and tail. */
export function middleTruncate(id: string, head = 18, tail = 8): string {
  if (!id || id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Team work (organization workspaces only)
// ---------------------------------------------------------------------------

export interface TeamWork {
  submissionsAwaitingReview: number;
  reportsToday: number;
  members: number;
  pendingInvites: number;
}

export function buildTeamWork(args: {
  /** The raw /v1/platform/context envelope. */
  envelope: unknown;
  trustSummary: unknown;
  reports: unknown;
  nowMs: number;
}): TeamWork | null {
  const env = obj(args.envelope);
  // Only inside an ORGANIZATION workspace whose plan includes team collaboration (fail-closed).
  if (str(obj(env.activeSpace).type) !== "ORGANIZATION") return null;
  if (obj(env.planFeatures).teamCollaborationIncluded !== true) return null;
  const workspaceId = str(obj(env.activeSpace).id);
  const orgs = rows(env.organizations).map(obj);
  const active = orgs.filter((o) => o.membershipStatus === "ACTIVE");
  const scoped = workspaceId ? active.filter((o) => o.id === workspaceId) : active;
  const members = (scoped.length > 0 ? scoped : active).reduce((sum, o) => sum + num(o.memberCount), 0);
  const pendingInvites = orgs.filter((o) => o.membershipStatus === "PENDING").length;
  // "Today" is the UTC day, as the web counts it.
  const startOfToday = Math.floor(args.nowMs / 86_400_000) * 86_400_000;
  const reportsToday = rows(obj(args.reports).items)
    .map(obj)
    .filter((r) => {
      const at = str(obj(r.report).generatedAtUtc);
      const t = at ? Date.parse(at) : NaN;
      return Number.isFinite(t) && t >= startOfToday;
    }).length;
  return {
    submissionsAwaitingReview: num(obj(obj(args.trustSummary).intake).submissionsAwaitingReview),
    reportsToday,
    members,
    pendingInvites,
  };
}
