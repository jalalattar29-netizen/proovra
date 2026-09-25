/**
 * NOTIFICATIONS VIEW MODEL — the native port of the canonical inbox page
 * (`apps/web/app/(app)/inbox/page.tsx`) over `GET /v1/me/inbox`
 * (`services/api/src/routes/me-inbox.routes.ts`).
 *
 * The web page is SERVER-FILTERED: the primary view (All / Unread / a
 * severity), the category filter, the archive status, the workspace and the
 * sort are all query parameters, applied to the FULL population and paged by
 * an opaque cursor. Native used to fetch one page of 50 and filter / sort the
 * rows it happened to hold, so page 2 was never reachable and a filter on
 * page 1 said nothing about the rest of the inbox.
 *
 * Every key read below is one the route sends (me-inbox.routes.ts
 * `reply.code(200).send({...})` in the GET /v1/me/inbox handler, and the two
 * archived-lifecycle replies above it). Pure: no React, no fetch.
 */
import type { InboxItem } from "./inbox";

export type InboxTone = "info" | "warning" | "high" | "critical";

/** The six alternatives the metric cards select between — ONE value, never a set. */
export type PrimaryView = "all" | "unread" | InboxTone;

export const PRIMARY_VIEW_LABELS: Record<PrimaryView, string> = {
  all: "All",
  unread: "Unread",
  critical: "Critical",
  high: "High",
  warning: "Warning",
  info: "Info",
};

/** The all-caps badge a row wears (web TONE_LABELS). */
export const TONE_LABELS: Record<InboxTone, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  warning: "WARNING",
  info: "INFO",
};

/** Row tone → native status tone. */
export const TONE_STATUS: Record<InboxTone, "risk" | "pending" | "governance" | "info"> = {
  critical: "risk",
  high: "pending",
  warning: "governance",
  info: "info",
};

/** The metric cards, in the web's order, with its explanations. */
export const NOTIFICATION_METRICS: ReadonlyArray<{
  key: PrimaryView;
  label: string;
  explanation: string;
  tone: "neutral" | "info" | "risk" | "pending" | "governance";
}> = [
  { key: "all", label: "All", explanation: "Everything currently addressed to you.", tone: "neutral" },
  { key: "unread", label: "Unread", explanation: "Not opened yet.", tone: "info" },
  { key: "critical", label: "Critical", explanation: "Needs attention now.", tone: "risk" },
  { key: "high", label: "High", explanation: "Important, not urgent.", tone: "pending" },
  { key: "warning", label: "Warning", explanation: "Worth a look.", tone: "governance" },
  { key: "info", label: "Info", explanation: "For your awareness.", tone: "info" },
];

/** Archiving marks read, so Archived + Unread cannot exist (web inbox/page.tsx:1332). */
export const ARCHIVED_ALWAYS_READ = "Archived notifications are always marked read.";

export const CATEGORY_LABELS: Record<string, string> = {
  onboarding: "Onboarding",
  org_invite: "Invite",
  org_admin: "Org governance",
  governance: "Workspace governance",
  review_decision: "Review decision",
  discussion_mention: "Mention",
  discussion_assigned: "Assigned thread",
  review_escalation: "Escalation",
  access_review_pending: "Access review",
  mfa_recovery_pending: "MFA approval",
  communication_failure: "Delivery failure",
  security_event_high: "Security alert",
  report_failure: "Report failure",
  verification_package_failure: "Package failure",
  ots_failure: "OTS failure",
  intake_submission_pending_review: "Intake review",
  intake_required_items_missing: "Intake incomplete",
  intake_link_expiring: "Link expiring",
  collaboration: "Collaboration",
  tsa_failure: "Timestamp failure",
  case_assignment: "Case assignment",
};

/** The category filter keys the route's `filter` enum accepts (INBOX_FILTER_KEYS). */
export type InboxCategoryFilter =
  | "all"
  | "assigned_to_me"
  | "mentions"
  | "invitations"
  | "review"
  | "collaboration"
  | "governance"
  | "security"
  | "integrity"
  | "reports"
  | "packages"
  | "intake"
  | "failures"
  | "due_soon"
  | "overdue"
  | "admin";

export const INBOX_FILTER_LABELS: Record<InboxCategoryFilter, string> = {
  all: "All",
  assigned_to_me: "Assigned to me",
  mentions: "Mentions",
  invitations: "Invitations",
  review: "Reviews",
  collaboration: "Collaboration",
  governance: "Governance",
  security: "Security",
  integrity: "Integrity",
  reports: "Reports",
  packages: "Verification packages",
  intake: "Intake",
  failures: "Failures",
  due_soon: "Due soon",
  overdue: "Overdue",
  admin: "Admin",
};

/** The web's grouped advanced panel (operationsFilterPolicy.ts ADVANCED_OPERATIONS_FILTER_GROUPS). */
export const INBOX_FILTER_GROUPS: ReadonlyArray<{
  id: "type" | "integrity" | "time";
  label: string;
  keys: ReadonlyArray<InboxCategoryFilter>;
}> = [
  {
    id: "type",
    label: "Type",
    keys: ["mentions", "assigned_to_me", "collaboration", "invitations", "review", "intake", "reports", "packages", "governance", "security", "admin"],
  },
  { id: "integrity", label: "Evidence & integrity", keys: ["integrity", "failures"] },
  { id: "time", label: "Time & urgency", keys: ["due_soon", "overdue"] },
];

export const INBOX_SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "unread_first", label: "Unread first" },
  { value: "severity", label: "Highest severity" },
] as const;
export type InboxSort = (typeof INBOX_SORT_OPTIONS)[number]["value"];
export const DEFAULT_INBOX_SORT: InboxSort = "newest";

export const TRUNCATION_LABELS: Record<string, string> = {
  governance: "Workspace governance",
  discussion_mention: "Mentions",
  discussion_assigned: "Assigned threads",
  review_escalation: "Escalations",
  access_review_pending: "Access reviews",
  mfa_recovery_pending: "MFA approvals",
  communication_failure: "Delivery failures",
  security_event_high: "Security alerts",
  report_failure: "Report failures",
  verification_package_failure: "Package failures",
  ots_failure: "OTS failures",
  intake_submission_pending_review: "Intake awaiting review",
  intake_required_items_missing: "Intake incomplete",
  intake_link_expiring: "Intake link expiring",
  collaboration: "Collaboration",
  tsa_failure: "Timestamp failures",
  case_assignment: "Case assignments",
};

/* ---------------------------------------------------------------- request */

export interface InboxQuery {
  primaryView: PrimaryView;
  category: InboxCategoryFilter;
  archived: boolean;
  workspaceId: string;
  sort: InboxSort;
  cursor?: string | null;
}

/**
 * ONE parameter per axis (web buildUrl). The primary view resolves to exactly
 * one of `readState` / `tone`, so Unread then High asks for High, never the
 * intersection. `sort` is always sent: the route's own default is `priority`,
 * which is not what the control says.
 */
export function buildInboxQueryPath(q: InboxQuery): string {
  const params = new URLSearchParams();
  if (q.primaryView === "unread") params.set("readState", "unread");
  else if (q.primaryView !== "all") params.set("tone", q.primaryView);
  if (q.category !== "all") params.set("filter", q.category);
  if (q.archived) params.set("lifecycle", "archived");
  if (q.workspaceId !== "all") params.set("workspaceId", q.workspaceId);
  params.set("sort", q.sort);
  if (q.cursor) params.set("cursor", q.cursor);
  return `/v1/me/inbox?${params.toString()}`;
}

/* ---------------------------------------------------------------- envelope */

export interface InboxViewItem extends InboxItem {
  body: string | null;
  dueAt: string | null;
  /** Absent reads as true — the route sets it on every item it emits. */
  canMarkRead: boolean;
}

type ToneCounts = Record<InboxTone, number>;
interface CountBlock {
  total: number | null;
  unread: number | null;
  byTone: Partial<ToneCounts>;
}

export interface InboxEnvelope {
  items: InboxViewItem[];
  summaryTotal: number;
  summaryByTone: Partial<ToneCounts>;
  scopeSummary: (CountBlock & { byCategory: Record<string, number>; deadlines: { dueSoon: number; overdue: number } }) | null;
  metricSummary: CountBlock | null;
  nextCursor: string | null;
  totalEstimate: number | null;
  totalIsExact: boolean;
  /** Labels of the sources the server capped. Empty when nothing was capped. */
  cappedSources: string[];
  /** False only when the server said it may NOT assert everything was read. */
  mayAssertAllClear: boolean;
  incompleteSources: string[];
  /** `false` only on an archived read where the snapshot store is not provisioned. */
  historyAvailable: boolean | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function tones(v: unknown): Partial<ToneCounts> {
  const o = obj(v);
  const out: Partial<ToneCounts> = {};
  for (const t of ["critical", "high", "warning", "info"] as const) {
    const n = num(o[t]);
    if (n !== null) out[t] = n;
  }
  return out;
}

function countBlock(v: unknown): CountBlock | null {
  if (!v || typeof v !== "object") return null;
  const o = obj(v);
  return { total: num(o.total), unread: num(o.unread), byTone: tones(o.byTone) };
}

export function parseInboxEnvelope(raw: unknown): InboxEnvelope {
  const d = obj(raw);
  const summary = obj(d.summary);
  const scope = countBlock(d.scopeSummary);
  const scopeRaw = obj(d.scopeSummary);
  const pagination = obj(d.pagination);
  const completeness = d.completeness && typeof d.completeness === "object" ? obj(d.completeness) : null;
  const truncated = obj(d.truncated);
  const items = (Array.isArray(d.items) ? d.items : []).map((r): InboxViewItem => {
    const i = obj(r);
    return {
      itemKey: str(i.itemKey) ?? str(i.id) ?? "",
      title: str(i.title) ?? "",
      body: str(i.body),
      href: str(i.href),
      occurredAt: str(i.occurredAt) ?? "",
      category: str(i.category),
      tone: str(i.tone),
      isRead: i.isRead === true,
      dismissedAt: str(i.dismissedAt),
      resolvedAt: str(i.resolvedAt),
      sourceClearedAt: str(i.sourceClearedAt),
      snoozedUntil: str(i.snoozedUntil),
      dueAt: str(i.dueAt),
      canMarkRead: i.canMarkRead !== false,
      canDismiss: i.canDismiss !== false,
    };
  });
  const byCategory: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(scopeRaw.byCategory))) {
    const n = num(v);
    if (n !== null) byCategory[k] = n;
  }
  const deadlines = obj(scopeRaw.deadlines);
  return {
    items,
    summaryTotal: num(summary.total) ?? items.length,
    summaryByTone: tones(summary.byTone),
    scopeSummary: scope
      ? { ...scope, byCategory, deadlines: { dueSoon: num(deadlines.dueSoon) ?? 0, overdue: num(deadlines.overdue) ?? 0 } }
      : null,
    metricSummary: countBlock(d.metricSummary),
    nextCursor: str(pagination.nextCursor),
    totalEstimate: num(pagination.totalEstimate),
    totalIsExact: pagination.totalIsExact !== false,
    cappedSources:
      d.anyTruncated === true
        ? Object.entries(truncated)
            .filter(([, capped]) => capped === true)
            .map(([key]) => TRUNCATION_LABELS[key] ?? key)
        : [],
    mayAssertAllClear: completeness ? completeness.mayAssertAllClear !== false : true,
    incompleteSources: completeness && Array.isArray(completeness.incompleteSources)
      ? completeness.incompleteSources.filter((s): s is string => typeof s === "string")
      : [],
    historyAvailable: typeof d.historyAvailable === "boolean" ? d.historyAvailable : null,
  };
}

/**
 * One count per metric card — `metricSummary` first (the canonical basis,
 * narrowed by the advanced axes but not by the cards' own), then the older
 * blocks so a pre-deploy envelope still shows numbers (web metricCount).
 */
export function inboxMetricCount(key: PrimaryView, env: InboxEnvelope): number {
  const m = env.metricSummary;
  const s = env.scopeSummary;
  if (key === "unread") return m?.unread ?? s?.unread ?? 0;
  if (key === "all") return m?.total ?? s?.total ?? env.summaryTotal;
  return m?.byTone[key] ?? s?.byTone[key] ?? env.summaryByTone[key] ?? 0;
}

/** Whether the inbox has anything at all — the web's "all caught up" test. */
export function inboxPopulationTotal(env: InboxEnvelope): number {
  return env.scopeSummary?.total ?? env.summaryTotal;
}

/* ------------------------------------------------------------ eligibility */

/**
 * Which advanced filters this reader can ever receive — the web's
 * `deriveOperationsUiContext` + `filterAllowed`, over the SAME server
 * projection (`/v1/platform/context` `operationalEligibility` + `planFeatures`).
 * A missing projection withholds rather than offers.
 */
export interface InboxFilterContext {
  canViewAdminAttention: boolean;
  canReceiveGovernance: boolean;
  canUseReports: boolean;
  canUseVerificationPackages: boolean;
  canUseIntake: boolean;
  canParticipateInReviews: boolean;
  canReceiveAssignments: boolean;
  canCollaborate: boolean;
  hasPendingInvitation: boolean;
  hasEligibleDeadlineSource: boolean;
}

export function deriveInboxFilterContext(platformEnvelope: unknown): InboxFilterContext {
  const env = obj(platformEnvelope);
  const pf = obj(env.planFeatures);
  const elig = env.operationalEligibility && typeof env.operationalEligibility === "object" ? obj(env.operationalEligibility) : null;
  const t = (v: unknown) => v === true;
  const assignments = obj(elig?.assignments);
  return {
    canViewAdminAttention: t(obj(elig?.security).hasAdminSurface),
    canReceiveGovernance: t(obj(elig?.governance).canViewOperational),
    canUseReports: t(pf.reportsIncluded),
    canUseVerificationPackages: t(pf.verificationPackageIncluded),
    canUseIntake: t(pf.intakeIncluded),
    canParticipateInReviews: t(obj(elig?.reviews).canParticipate),
    canReceiveAssignments:
      t(assignments.hasCaseAssignmentCapability) ||
      t(assignments.hasReviewAssignmentCapability) ||
      t(assignments.hasCollaborationAssignmentCapability),
    canCollaborate: t(obj(elig?.collaboration).hasActiveMembership),
    hasPendingInvitation: t(obj(elig?.collaboration).hasPendingInvitation),
    hasEligibleDeadlineSource: t(obj(elig?.deadlines).hasEligibleSource),
  };
}

function eligible(key: InboxCategoryFilter, ctx: InboxFilterContext): boolean {
  switch (key) {
    case "admin": return ctx.canViewAdminAttention;
    case "governance": return ctx.canReceiveGovernance;
    case "reports": return ctx.canUseReports;
    case "packages": return ctx.canUseVerificationPackages;
    case "intake": return ctx.canUseIntake;
    case "review": return ctx.canParticipateInReviews;
    case "assigned_to_me": return ctx.canReceiveAssignments;
    case "mentions":
    case "collaboration": return ctx.canCollaborate;
    case "invitations": return ctx.hasPendingInvitation;
    case "due_soon":
    case "overdue": return ctx.hasEligibleDeadlineSource;
    default: return true;
  }
}

/** The actual-item override: a real, server-authorized item reveals its filter. */
const FILTER_MEMBERS: Partial<Record<InboxCategoryFilter, readonly string[]>> = {
  reports: ["report_failure"],
  packages: ["verification_package_failure"],
  intake: ["intake_submission_pending_review", "intake_required_items_missing", "intake_link_expiring"],
  review: ["review_decision", "review_escalation", "intake_submission_pending_review"],
  assigned_to_me: ["discussion_assigned", "review_escalation", "case_assignment"],
  mentions: ["discussion_mention"],
  collaboration: ["collaboration", "discussion_mention", "discussion_assigned"],
  invitations: ["org_invite"],
  governance: ["governance", "access_review_pending"],
  admin: [
    "org_admin",
    "mfa_recovery_pending",
    "communication_failure",
    "report_failure",
    "verification_package_failure",
    "intake_submission_pending_review",
    "intake_link_expiring",
  ],
};

function hasActualItem(key: InboxCategoryFilter, env: InboxEnvelope | null): boolean {
  const scope = env?.scopeSummary;
  if (!scope) return false;
  if (key === "due_soon") return scope.deadlines.dueSoon > 0;
  if (key === "overdue") return scope.deadlines.overdue > 0;
  return (FILTER_MEMBERS[key] ?? []).some((c) => (scope.byCategory[c] ?? 0) > 0);
}

export function visibleInboxFilterGroups(
  ctx: InboxFilterContext,
  env: InboxEnvelope | null,
): Array<{ id: string; label: string; keys: InboxCategoryFilter[] }> {
  return INBOX_FILTER_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    keys: g.keys.filter((k) => eligible(k, ctx) || hasActualItem(k, env)),
  })).filter((g) => g.keys.length > 0);
}

/** The web's workspace narrowing: All, the Personal Space, and every ACTIVE workspace. */
export function inboxWorkspaceOptions(platformEnvelope: unknown): Array<{ value: string; label: string }> {
  const env = obj(platformEnvelope);
  const personalId = str(obj(env.personalSpace).id);
  const orgs = Array.isArray(env.organizations) ? env.organizations.map(obj) : [];
  return [
    { value: "all", label: "All workspaces" },
    ...(personalId ? [{ value: personalId, label: "Personal Space" }] : []),
    ...orgs
      .filter((o) => o.membershipStatus === "ACTIVE" && str(o.id))
      .map((o) => ({ value: str(o.id) as string, label: str(o.displayName) ?? str(o.name) ?? "Organization" })),
  ];
}

/** The number on the Filters control: the ADVANCED axes only, never the primary view. */
export function activeInboxFilterCount(q: { category: InboxCategoryFilter; archived: boolean; workspaceId: string }): number {
  return (q.category !== "all" ? 1 : 0) + (q.archived ? 1 : 0) + (q.workspaceId !== "all" ? 1 : 0);
}

/* ------------------------------------------------------------------ words */

/** What the count is counting, in the page's vocabulary (web resultNoun). */
export function inboxResultNoun(q: { archived: boolean; primaryView: PrimaryView; category: InboxCategoryFilter }, shown: number): string {
  const plural = shown === 1 ? "notification" : "notifications";
  const lifecycle = q.archived ? "archived " : "";
  if (q.primaryView === "unread") return `${lifecycle}unread ${plural}`;
  if (q.primaryView !== "all") return `${lifecycle}${PRIMARY_VIEW_LABELS[q.primaryView].toLowerCase()} ${plural}`;
  if (q.category !== "all") return `${lifecycle}${INBOX_FILTER_LABELS[q.category].toLowerCase()} ${plural}`;
  return `${lifecycle}${plural}`;
}

/** "Showing X of Y …" only while Y is exact; otherwise "(more may exist)". */
export function inboxShowingText(shown: number, env: InboxEnvelope, noun: string): string {
  return env.totalIsExact && env.totalEstimate !== null
    ? `Showing ${shown} of ${env.totalEstimate} ${noun}`
    : `Showing ${shown} ${noun} (more may exist)`;
}

/** The row's meta line pieces after the timestamp (web ops-item__meta). */
export function inboxItemMeta(item: InboxViewItem, formatDate: (iso: string) => string, nowMs: number = Date.now()): string[] {
  const out: string[] = [];
  if (item.dueAt) {
    const due = Date.parse(item.dueAt);
    out.push(`${Number.isFinite(due) && due < nowMs ? "Overdue · " : "Due "}${formatDate(item.dueAt)}`);
  }
  if (item.resolvedAt) out.push(`No longer active ${formatDate(item.sourceClearedAt ?? item.resolvedAt)}`);
  if (item.dismissedAt) out.push(`Archived ${formatDate(item.dismissedAt)}`);
  if (item.snoozedUntil) {
    const until = Date.parse(item.snoozedUntil);
    if (Number.isFinite(until) && until > nowMs) out.push(`Reminder set for ${formatDate(item.snoozedUntil)}`);
  }
  return out;
}

export function isInboxTone(v: string | null | undefined): v is InboxTone {
  return v === "critical" || v === "high" || v === "warning" || v === "info";
}
