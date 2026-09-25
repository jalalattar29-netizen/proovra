/**
 * OPERATIONS (T-11 / RC-12) — the native port of `/operations`.
 *
 * THE DEFECT
 * ----------
 * `/operations` is a CORE-tier web surface (91 handlers, 15 endpoints) and
 * native had NO screen for it: the attention queue for everything that went
 * wrong in a workspace — failed uploads, stalled reports, webhook delivery,
 * integrity signals — was unreachable from a phone or tablet. The rail now
 * offers it (`workspace.operations` in `src/product/navigation.ts`).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * PURE: paths, parsers, the access gate, row eligibility, the bulk-outcome
 * arithmetic, and every string the page shows, verbatim with its web source.
 * The screen is `app/(stack)/operations/index.tsx`. (Named ops-console, not
 * operations: `src/product/operations.ts` holds the quotas + batch-analysis
 * projections, which share the URL prefix but not the console.) Spec with line references:
 * `docs/audit/pwa-native-2026-09-24-v2/T-11-OPERATIONS-SPEC.md`.
 *
 * WHERE NATIVE DELIBERATELY DIFFERS FROM THE WEB (web defects found while porting)
 *   - Bulk success is `COMPLETED` (the server's value); the web counts
 *     `SUCCEEDED`, which the server never sends, so every web sweep reports
 *     0 updated. Spec §1.
 *   - A failed grouped read is SHOWN as a failure; the web renders it as an
 *     empty list over real conditions. Spec §8.
 *   - A refused remediation shows the server's own `remediation.message`; the
 *     web replaces it with generic copy. Spec §9.
 */
import type { ProovraStatusTone } from "@proovra/ui";

import { describeDuration } from "../lib/relative-time";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/* ------------------------------------------------------------ vocabulary */

export const SEVERITIES = ["CRITICAL", "HIGH", "WARNING", "INFO"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"] as const;
export type IncidentStatus = (typeof STATUSES)[number];

/** L/vocabulary.ts:156-181 */
export const SEVERITY_VOCABULARY: Readonly<Record<Severity, { label: string; rank: number; explanation: string; tone: ProovraStatusTone }>> = {
  CRITICAL: { label: "Critical", rank: 4, explanation: "Records or delivery are affected now.", tone: "risk" },
  HIGH: { label: "High", rank: 3, explanation: "Needs an operator before it becomes critical.", tone: "pending" },
  WARNING: { label: "Warning", rank: 2, explanation: "Worth attention; nothing is blocked yet.", tone: "governance" },
  INFO: { label: "Info", rank: 1, explanation: "Recorded for context, no action expected.", tone: "info" },
};

/** L/vocabulary.ts:203-228 */
export const STATUS_VOCABULARY: Readonly<Record<IncidentStatus, { label: string; explanation: string; tone: ProovraStatusTone }>> = {
  OPEN: { label: "Open", explanation: "Nobody has taken this on yet.", tone: "info" },
  ACKNOWLEDGED: {
    label: "Acknowledged",
    explanation: "An operator has seen this and taken it on. It does not mean the underlying problem is fixed.",
    tone: "governance",
  },
  RESOLVED: {
    label: "Resolved",
    explanation: "Closed. If the same condition happens again it reopens with its history intact.",
    tone: "verified",
  },
  SUPPRESSED: {
    label: "Suppressed",
    explanation:
      "This workspace decided to stop being told about it. Repeat occurrences are still recorded, and it resolves on its own when the source recovers.",
    tone: "neutral",
  },
};

export function severityOf(v: unknown): Severity {
  return (SEVERITIES as readonly string[]).includes(v as string) ? (v as Severity) : "INFO";
}
export function statusOf(v: unknown): IncidentStatus {
  return (STATUSES as readonly string[]).includes(v as string) ? (v as IncidentStatus) : "OPEN";
}

/** L/vocabulary.ts:241-257 */
export const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  UPLOAD: "Capture and upload",
  REPORT: "Report generation",
  PACKAGE: "Verification packages",
  WEBHOOK: "Webhook delivery",
  COMMUNICATIONS: "Communications",
  IDENTITY_SECURITY: "Identity and access",
  GOVERNANCE: "Governance",
  STORAGE: "Storage",
  AI: "AI processing",
  INTEGRATION: "Integrations",
  DATABASE: "Database",
  WORKER: "Background processing",
  RECONCILIATION: "Reconciliation",
  EVIDENCE_INTEGRITY: "Evidence integrity",
};

/** Unknown categories are humanised (L/vocabulary.ts:267-272). */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABEL[category];
  if (known) return known;
  const words = category.replace(/_/g, " ").toLowerCase().trim();
  return words.length === 0 ? category : words.charAt(0).toUpperCase() + words.slice(1);
}

/** L/vocabulary.ts:464-471 */
export const SORT_LABEL = {
  recent: "Most recent activity",
  severity: "Most severe first",
  oldest: "Oldest first",
  occurrences: "Most source observations",
} as const;
export type SortKey = keyof typeof SORT_LABEL;

/** L/vocabulary.ts:481-501 */
export function slaLabel(posture: string | null | undefined): string {
  switch (posture) {
    case "BREACHED":
      return "Overdue";
    case "AT_RISK":
      return "Due soon";
    case "ON_TRACK":
      return "On time";
    case "ACKNOWLEDGED":
      return "Owned";
    case "RESOLVED":
      return "Resolved";
    case "UNTRACKED_LEGACY":
      return "No SLA recorded";
    default:
      return "No SLA applies";
  }
}

export function slaTone(posture: string | null | undefined): ProovraStatusTone {
  switch (posture) {
    case "BREACHED":
      return "risk";
    case "AT_RISK":
      return "pending";
    case "RESOLVED":
      return "verified";
    case "ACKNOWLEDGED":
      return "governance";
    case "ON_TRACK":
      return "info";
    default:
      return "neutral";
  }
}

export interface IncidentSla {
  readonly posture: string;
  readonly obligation: string;
  readonly dueAtUtc: string | null;
  readonly targetHours: number | null;
  readonly acknowledgementBreached: boolean;
  readonly resolutionBreached: boolean;
}

/** L/vocabulary.ts:531-563 */
export function slaExplanation(sla: IncidentSla): string {
  const duty = sla.obligation === "ACKNOWLEDGEMENT" ? "for someone to take this on" : "for this to be resolved";
  const promise =
    sla.targetHours == null ? "" : ` This workspace allowed ${sla.targetHours} ${sla.targetHours === 1 ? "hour" : "hours"} ${duty}.`;
  switch (sla.posture) {
    case "BREACHED":
      return `Past the time this workspace allowed ${duty}.${promise}`;
    case "AT_RISK":
      return `Approaching the time this workspace allowed ${duty}.${promise}`;
    case "ON_TRACK":
      return `Within the time this workspace allowed ${duty}.${promise}`;
    case "ACKNOWLEDGED":
      return `Someone has taken this on and no commitment has been missed.${promise}`;
    case "RESOLVED":
      return sla.resolutionBreached
        ? "This was resolved, but after the time this workspace allowed."
        : "This was resolved within the time this workspace allowed.";
    case "UNTRACKED_LEGACY":
      return "No historical SLA was recorded for this incident, so no commitment can be reported for it.";
    default:
      return "No time commitment applies to this condition.";
  }
}

/** L/vocabulary.ts:573-580 */
export function slaBreachRecord(sla: IncidentSla): string | null {
  if (sla.posture === "BREACHED") return null;
  const parts: string[] = [];
  if (sla.acknowledgementBreached) parts.push("was not taken on in time");
  if (sla.resolutionBreached) parts.push("was not resolved in time");
  return parts.length === 0 ? null : `Recorded: this condition ${parts.join(" and ")}.`;
}

/** L/vocabulary.ts:434-443 */
export function timelineEventLabel(event: string): string {
  const known: Record<string, string> = {
    opened: "Opened",
    reopened: "Reopened",
    occurrence: "Happened again",
    acknowledged: "Acknowledged",
    resolved: "Resolved",
    suppressed: "Suppressed",
    assigned: "Owner changed",
  };
  if (known[event]) return known[event]!;
  const w = event.replace(/[_.]/g, " ").trim();
  return w.length === 0 ? event : w.charAt(0).toUpperCase() + w.slice(1);
}

/* ------------------------------------------------------------ queue metrics */

export type QueueMetricKey =
  | "open"
  | "critical"
  | "high"
  | "warning"
  | "slaBreached"
  | "slaAtRisk"
  | "resolved"
  | "assignedToMe"
  | "unassigned";

/** L/vocabulary.ts:312-410, in the web's order. */
export const QUEUE_METRICS: ReadonlyArray<{
  key: QueueMetricKey;
  label: string;
  note: string;
  tone: ProovraStatusTone;
  collaborativeOnly: boolean;
}> = [
  { key: "open", label: "Unresolved", note: "Open or acknowledged.", tone: "neutral", collaborativeOnly: false },
  { key: "critical", label: "Critical", note: "Affecting records now.", tone: "risk", collaborativeOnly: false },
  { key: "high", label: "High", note: "Needs an operator soon.", tone: "pending", collaborativeOnly: false },
  { key: "warning", label: "Warning", note: "Worth attention; nothing is blocked yet.", tone: "governance", collaborativeOnly: false },
  { key: "slaBreached", label: "Overdue", note: "Past the time this workspace committed to.", tone: "risk", collaborativeOnly: false },
  { key: "slaAtRisk", label: "Due soon", note: "Approaching the committed time.", tone: "pending", collaborativeOnly: false },
  { key: "resolved", label: "Resolved", note: "Closed operational conditions.", tone: "verified", collaborativeOnly: false },
  { key: "assignedToMe", label: "Assigned to me", note: "You own these.", tone: "governance", collaborativeOnly: true },
  { key: "unassigned", label: "Unassigned", note: "Waiting for an owner.", tone: "pending", collaborativeOnly: true },
];

export const QUEUE_OVERLAP_NOTE = "A condition can be counted by more than one card. These are filters, not a breakdown.";

/* ------------------------------------------------------------ filters */

export interface OpsFilters {
  readonly sla: string;
  readonly status: string;
  readonly severity: string;
  readonly category: string;
  readonly owner: string;
  readonly q: string;
  readonly sort: SortKey;
}

export const DEFAULT_FILTERS: OpsFilters = { sla: "", status: "", severity: "", category: "", owner: "any", q: "", sort: "recent" };

/** `anyFilterActive` (L/filters.ts:88-98) — a non-default sort counts. */
export function anyFilterActive(f: OpsFilters): boolean {
  return (
    f.sla !== "" || f.status !== "" || f.severity !== "" || f.category !== "" || f.owner !== "any" || f.q.trim() !== "" || f.sort !== "recent"
  );
}

/** Card → filter (P:1405-1427): reset to defaults, then set ONE axis. */
export function filtersForMetric(key: QueueMetricKey): OpsFilters {
  switch (key) {
    case "critical":
      return { ...DEFAULT_FILTERS, severity: "CRITICAL" };
    case "high":
      return { ...DEFAULT_FILTERS, severity: "HIGH" };
    case "warning":
      return { ...DEFAULT_FILTERS, severity: "WARNING" };
    case "slaBreached":
      return { ...DEFAULT_FILTERS, sla: "BREACHED" };
    case "slaAtRisk":
      return { ...DEFAULT_FILTERS, sla: "AT_RISK" };
    case "resolved":
      return { ...DEFAULT_FILTERS, status: "RESOLVED" };
    case "assignedToMe":
      return { ...DEFAULT_FILTERS, owner: "me" };
    case "unassigned":
      return { ...DEFAULT_FILTERS, owner: "unassigned" };
    default:
      return DEFAULT_FILTERS;
  }
}

/** The selected card, derived from the filters (P:1386-1403). */
export function selectedMetric(f: OpsFilters): QueueMetricKey | null {
  for (const m of QUEUE_METRICS) {
    const want = filtersForMetric(m.key);
    if (JSON.stringify({ ...want, q: "", sort: "recent" }) === JSON.stringify({ ...f, q: "", sort: "recent" }) && f.q === "" && f.sort === "recent") {
      return m.key;
    }
  }
  return null;
}

export const SLA_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Any commitment" },
  { value: "BREACHED", label: "Overdue" },
  { value: "AT_RISK", label: "Due soon" },
  { value: "ON_TRACK", label: "On time" },
  { value: "UNTRACKED_LEGACY", label: "No SLA recorded" },
  { value: "NOT_APPLICABLE", label: "No SLA applies" },
];

/* ------------------------------------------------------------ paths */

const enc = encodeURIComponent;
export function buildOpsSummaryPath(teamId: string): string {
  return `/v1/ops/summary?teamId=${enc(teamId)}`;
}
export const OPS_PAGE_LIMIT = 50;

function filterParams(teamId: string, f: OpsFilters): URLSearchParams {
  const p = new URLSearchParams();
  p.set("teamId", teamId);
  if (f.sla) p.set("sla", f.sla);
  if (f.status) p.set("status", f.status);
  if (f.severity) p.set("severity", f.severity);
  if (f.category) p.set("category", f.category);
  // `owner=any` is the server default; the web's grouped read sends it by
  // accident (truthiness). Native sends it for neither read.
  if (f.owner && f.owner !== "any") p.set("owner", f.owner);
  if (f.q.trim()) p.set("q", f.q.trim());
  return p;
}

export function buildOpsIncidentsPath(teamId: string, f: OpsFilters, cursor?: string | null): string {
  const p = filterParams(teamId, f);
  p.set("sort", f.sort);
  p.set("limit", String(OPS_PAGE_LIMIT));
  if (cursor) p.set("cursor", cursor);
  return `/v1/ops/incidents?${p.toString()}`;
}
export function buildOpsGroupsPath(teamId: string, f: OpsFilters): string {
  return `/v1/ops/incident-groups?${filterParams(teamId, f).toString()}`;
}
export function buildOpsGroupAffectedPath(teamId: string, groupKey: string, cursor?: string | null): string {
  const p = new URLSearchParams();
  p.set("teamId", teamId);
  if (cursor) p.set("cursor", cursor);
  return `/v1/ops/incident-groups/${enc(groupKey)}/affected?${p.toString()}`;
}
export function buildOpsIncidentPath(teamId: string, id: string): string {
  return `/v1/ops/incidents/${enc(id)}?teamId=${enc(teamId)}`;
}
export function buildOpsOperatorsPath(teamId: string): string {
  return `/v1/ops/assignable-operators?teamId=${enc(teamId)}`;
}
export function buildOpsSavedViewsPath(teamId: string): string {
  return `/v1/ops/saved-views?teamId=${enc(teamId)}`;
}
export const OPS_SAVED_VIEWS_PATH = "/v1/ops/saved-views";
export function buildOpsSavedViewPath(id: string): string {
  return `/v1/ops/saved-views/${enc(id)}`;
}
export const OPS_RECONCILE_PATH = "/v1/ops/workspace-reconcile";
export type LifecycleAction = "ack" | "resolve" | "suppress";
export function buildOpsLifecyclePath(id: string, action: LifecycleAction): string {
  return `/v1/ops/incidents/${enc(id)}/${action}`;
}
export function buildOpsAssignPath(id: string): string {
  return `/v1/ops/incidents/${enc(id)}/assign`;
}
export function buildOpsRemediatePath(id: string): string {
  return `/v1/ops/incidents/${enc(id)}/remediate`;
}
export const OPS_BULK_PATH = "/v1/ops/bulk-actions";

/* ------------------------------------------------------------ access gate */

export type RestrictedReason = "not_included" | "no_workspace" | "context_mismatch" | "account_not_active" | "no_envelope";

/**
 * The in-page gate (P:596-606) over `resolveRuntimeReadAccess`
 * (runtimeReadAccess.ts:89-186), in the same order.
 */
export function resolveOperationsAccess(envelope: unknown, teamId: string | null): RestrictedReason | null {
  if (envelope == null) return "no_envelope";
  const env = obj(envelope);
  if (!teamId) return "no_workspace";
  const ws = obj(env["workspace"]);
  if (ws["status"] !== "active") return "not_included"; // workspace_not_resolved → not_included
  const declared = [
    str(obj(obj(env["contextOptions"])["activeContext"])["workspaceId"]),
    str(obj(env["activeSpace"])["id"]),
    str(ws["id"]),
  ].filter((x): x is string => x !== null);
  if (new Set(declared).size > 1) return "context_mismatch";
  if (declared[0] && declared[0] !== teamId) return "context_mismatch";
  const accountStatus = obj(env["account"])["accountStatus"];
  if (accountStatus != null && accountStatus !== "active") return "account_not_active";
  const caps = obj(env["capabilities"]);
  if (caps["OPERATIONS_VIEW"] !== true) return "not_included";
  return null;
}

/** C/States.tsx:112-137 */
export const RESTRICTED_TITLE = "Operations isn't available for this workspace";
export const RESTRICTED_BODY: Readonly<Record<RestrictedReason, string>> = {
  not_included:
    "Operations is available to workspaces that produce operational conditions, or that more than one person shares. This workspace does neither right now, so there is no shared triage queue to show.",
  no_workspace: "No workspace is selected yet. Choose a workspace to see its operational conditions.",
  context_mismatch: "This workspace couldn't be confirmed. Reload the page, or switch workspace again.",
  account_not_active: "This account is suspended, so operational work can't be shown or acted on. Contact a workspace owner.",
  no_envelope: "Your access for this workspace hasn't been confirmed. Reload the page, or ask a workspace owner to check your role.",
};

export interface OpsCapabilities {
  readonly acknowledge: boolean;
  readonly resolve: boolean;
  readonly suppress: boolean;
  readonly assign: boolean;
  readonly manageSharedViews: boolean;
}

export function opsCapabilities(envelope: unknown): OpsCapabilities {
  const caps = obj(obj(envelope)["capabilities"]);
  return {
    acknowledge: caps["OPERATIONS_ACKNOWLEDGE"] === true,
    resolve: caps["OPERATIONS_RESOLVE"] === true,
    suppress: caps["OPERATIONS_SUPPRESS"] === true,
    assign: caps["OPERATIONS_ASSIGN"] === true,
    manageSharedViews: caps["OPERATIONS_SAVED_VIEWS_MANAGE"] === true,
  };
}
export function canActOnAnything(c: OpsCapabilities): boolean {
  return c.acknowledge || c.resolve || c.suppress || c.assign;
}
export function viewerUserId(envelope: unknown): string | null {
  return str(obj(obj(envelope)["account"])["userId"]);
}

/* ------------------------------------------------------------ wire types */

export interface OpsMetric {
  readonly currentValue: number;
  readonly previousValue: number | null;
  readonly delta: number | null;
  readonly thresholdValue: number;
  readonly criticalThresholdValue: number | null;
  readonly unit: string;
  readonly observedAtUtc: string;
  readonly stale: boolean;
  readonly truncated: boolean;
}

export interface Incident {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly safeSummary: string;
  readonly severity: Severity;
  readonly status: IncidentStatus;
  readonly occurrenceCount: number;
  readonly firstSeenAtUtc: string;
  readonly lastSeenAtUtc: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly relatedEvidenceId: string | null;
  readonly relatedJobId: string | null;
  readonly relatedProvider: string | null;
  readonly assignedOperatorUserId: string | null;
  readonly resolutionAuthority: string | null;
  readonly manualResolution: boolean;
  readonly metricContract: string | null;
  readonly metric: OpsMetric | null;
  readonly sla: IncidentSla | null;
}

function parseMetric(v: unknown): OpsMetric | null {
  const m = obj(v);
  const current = num(m["currentValue"]);
  const threshold = num(m["thresholdValue"]);
  if (current == null || threshold == null) return null;
  return {
    currentValue: current,
    previousValue: num(m["previousValue"]),
    delta: num(m["delta"]),
    thresholdValue: threshold,
    criticalThresholdValue: num(m["criticalThresholdValue"]),
    unit: str(m["unit"]) ?? "",
    observedAtUtc: str(m["observedAtUtc"]) ?? "",
    stale: m["stale"] === true,
    truncated: m["truncated"] === true,
  };
}

function parseSla(v: unknown): IncidentSla | null {
  const s = obj(v);
  const posture = str(s["posture"]);
  if (!posture) return null;
  return {
    posture,
    obligation: str(s["obligation"]) ?? "NONE",
    dueAtUtc: str(s["dueAtUtc"]),
    targetHours: num(s["targetHours"]),
    acknowledgementBreached: s["acknowledgementBreached"] === true,
    resolutionBreached: s["resolutionBreached"] === true,
  };
}

export function parseIncident(v: unknown): Incident | null {
  const i = obj(v);
  const id = str(i["id"]);
  if (!id) return null;
  const lifecycle = obj(i["lifecycle"]);
  return {
    id,
    category: str(i["category"]) ?? "",
    title: str(i["title"]) ?? "Operational condition",
    safeSummary: str(i["safeSummary"]) ?? "",
    severity: severityOf(i["severity"]),
    status: statusOf(i["status"]),
    occurrenceCount: num(i["occurrenceCount"]) ?? 1,
    firstSeenAtUtc: str(i["firstSeenAtUtc"]) ?? "",
    lastSeenAtUtc: str(i["lastSeenAtUtc"]) ?? "",
    requestId: str(i["requestId"]),
    traceId: str(i["traceId"]),
    relatedEvidenceId: str(i["relatedEvidenceId"]),
    relatedJobId: str(i["relatedJobId"]),
    relatedProvider: str(i["relatedProvider"]),
    assignedOperatorUserId: str(i["assignedOperatorUserId"]),
    resolutionAuthority: str(lifecycle["resolutionAuthority"]),
    manualResolution: lifecycle["manualResolution"] === true,
    metricContract: str(lifecycle["metricContract"]),
    metric: i["metric"] ? parseMetric(i["metric"]) : null,
    sla: i["sla"] ? parseSla(i["sla"]) : null,
  };
}

export interface IncidentsPage {
  readonly incidents: Incident[];
  readonly complete: boolean;
  readonly attentionPostures: string[];
  readonly nextCursor: string | null;
}

export function parseIncidentsPage(v: unknown): IncidentsPage {
  const d = obj(v);
  return {
    incidents: arr(d["incidents"]).map(parseIncident).filter((x): x is Incident => x !== null),
    complete: obj(d["completeness"])["complete"] === true,
    attentionPostures: arr(obj(d["sla"])["attentionPostures"]).filter((x): x is string => typeof x === "string"),
    nextCursor: str(obj(d["pagination"])["nextCursor"]),
  };
}

export interface OpsSummary {
  readonly counts: Readonly<Record<QueueMetricKey, number | null>>;
  readonly complete: boolean;
  readonly mayAssertAllClear: boolean;
  readonly readiness: string | null;
  readonly safeFailureCategory: string | null;
  readonly failedSources: number;
  readonly truncatedSources: number;
  /** Retryable = no source failures, or every failure is retryable (P:1528-1530). */
  readonly retryable: boolean;
}

export function parseSummary(v: unknown): { summary: OpsSummary; operatorCount: number } {
  const d = obj(v);
  const s = obj(d["summary"]);
  const counts = {} as Record<QueueMetricKey, number | null>;
  for (const m of QUEUE_METRICS) counts[m.key] = num(s[m.key]);
  const rec = obj(s["reconciliation"]);
  const sources = obj(rec["sources"]);
  const failures = arr(sources["sourceFailures"]);
  return {
    summary: {
      counts,
      complete: s["complete"] === true,
      mayAssertAllClear: s["mayAssertAllClear"] === true,
      readiness: str(s["readiness"]),
      safeFailureCategory: str(rec["safeFailureCategory"]),
      failedSources: num(sources["failedSources"]) ?? arr(sources["failedSources"]).length,
      truncatedSources: num(sources["truncatedSources"]) ?? arr(sources["truncatedSources"]).length,
      retryable: failures.length === 0 || failures.every((f) => obj(f)["retryable"] === true),
    },
    operatorCount: num(obj(d["workspace"])["operatorCount"]) ?? 0,
  };
}

/** IncidentGroup — operations/_lib/types.ts:161-212 (field names verified 2026-09-24). */
export interface IncidentGroup {
  readonly groupKey: string;
  readonly sourceId: string;
  readonly title: string;
  readonly severity: Severity;
  readonly statusPosture: string;
  readonly category: string;
  readonly conditionCount: number;
  readonly affectedRecordCount: number | null;
  readonly affectedUnit: string | null;
  readonly observations: number;
  readonly assignedCount: number;
  readonly durationSeconds: number | null;
  readonly firstSeenAtUtc: string;
  readonly lastSeenAtUtc: string;
  readonly failureGroups: ReadonlyArray<{ label: string; count: number }>;
  readonly metric: {
    readonly currentValue: number;
    readonly unit: string;
    readonly thresholdValue: number;
    readonly criticalThresholdValue: number | null;
    readonly observedAtUtc: string;
    readonly stale: boolean;
    readonly contract: string;
  } | null;
}

export function parseGroups(v: unknown): { groups: IncidentGroup[]; totalGroups: number; totalConditions: number } {
  const d = obj(v);
  const groups = arr(d["groups"])
    .map((g): IncidentGroup | null => {
      const o = obj(g);
      const key = str(o["groupKey"]);
      if (!key) return null;
      const m = o["metric"] ? obj(o["metric"]) : null;
      const current = m ? num(m["currentValue"]) : null;
      const threshold = m ? num(m["thresholdValue"]) : null;
      return {
        groupKey: key,
        sourceId: str(o["sourceId"]) ?? "",
        title: str(o["title"]) ?? "Operational condition",
        severity: severityOf(o["severity"]),
        statusPosture: str(o["statusPosture"]) ?? "OPEN",
        category: str(o["category"]) ?? "",
        conditionCount: num(o["conditionCount"]) ?? 0,
        affectedRecordCount: num(o["affectedRecordCount"]),
        affectedUnit: str(o["affectedUnit"]),
        observations: num(o["observations"]) ?? 0,
        assignedCount: num(o["assignedCount"]) ?? 0,
        durationSeconds: num(o["durationSeconds"]),
        firstSeenAtUtc: str(o["firstSeenAtUtc"]) ?? "",
        lastSeenAtUtc: str(o["lastSeenAtUtc"]) ?? "",
        failureGroups: arr(o["failureGroups"])
          .map((f) => ({ label: str(obj(f)["label"]) ?? "", count: num(obj(f)["count"]) ?? 0 }))
          .filter((f) => f.label.length > 0),
        metric:
          m && current != null && threshold != null
            ? {
                currentValue: current,
                unit: str(m["unit"]) ?? "",
                thresholdValue: threshold,
                criticalThresholdValue: num(m["criticalThresholdValue"]),
                observedAtUtc: str(m["observedAtUtc"]) ?? "",
                stale: m["stale"] === true,
                contract: str(m["contract"]) ?? "",
              }
            : null,
      };
    })
    .filter((x): x is IncidentGroup => x !== null);
  const totals = obj(d["totals"]);
  return {
    groups,
    totalGroups: num(totals["groups"]) ?? groups.length,
    totalConditions: num(totals["conditions"]) ?? groups.reduce((n, g) => n + g.conditionCount, 0),
  };
}

/** AffectedRecord — operations/_lib/types.ts:221-231. */
export interface AffectedRecord {
  readonly conditionId: string;
  readonly evidenceId: string | null;
  readonly title: string;
  readonly severity: Severity;
  readonly status: string;
  readonly firstSeenAtUtc: string;
  readonly lastSeenAtUtc: string;
  readonly occurrenceCount: number;
  readonly assignedOperatorUserId: string | null;
}

export function parseAffected(v: unknown): { records: AffectedRecord[]; nextCursor: string | null } {
  const d = obj(v);
  return {
    records: arr(d["records"])
      .map((r): AffectedRecord | null => {
        const o = obj(r);
        const id = str(o["conditionId"]);
        if (!id) return null;
        return {
          conditionId: id,
          evidenceId: str(o["evidenceId"]),
          title: str(o["title"]) ?? "Record",
          severity: severityOf(o["severity"]),
          status: str(o["status"]) ?? "",
          firstSeenAtUtc: str(o["firstSeenAtUtc"]) ?? "",
          lastSeenAtUtc: str(o["lastSeenAtUtc"]) ?? "",
          occurrenceCount: num(o["occurrenceCount"]) ?? 1,
          assignedOperatorUserId: str(o["assignedOperatorUserId"]),
        };
      })
      .filter((x): x is AffectedRecord => x !== null),
    nextCursor: str(obj(d["pagination"])["nextCursor"]),
  };
}

export interface TimelineEntry {
  readonly event: string;
  readonly safeMessage: string | null;
  readonly atUtc: string;
}
export interface RemediationAction {
  readonly actionId: string;
  readonly label: string;
  readonly description: string;
  readonly confirm: boolean;
  readonly async: boolean;
}
export interface ProjectedRemediation {
  readonly actions: RemediationAction[];
  readonly deepLink: { href: string; label: string } | null;
  readonly guidance: string | null;
  readonly unsafeReason: string | null;
}
export interface IncidentDetail {
  readonly incident: Incident;
  readonly timeline: TimelineEntry[];
  readonly timelineComplete: boolean;
  readonly remediation: ProjectedRemediation | null;
}

export function parseIncidentDetail(v: unknown): IncidentDetail | null {
  const d = obj(v);
  const incident = parseIncident(d["incident"]);
  if (!incident) return null;
  const inc = obj(d["incident"]);
  const r = d["remediation"] ? obj(d["remediation"]) : null;
  const deep = r ? obj(r["deepLink"]) : {};
  return {
    incident,
    timeline: arr(inc["timeline"]).map((t) => {
      const o = obj(t);
      // IncidentTimelineEntry — types.ts:299-304.
      return { event: str(o["eventType"]) ?? "", safeMessage: str(o["safeMessage"]), atUtc: str(o["occurredAtUtc"]) ?? "" };
    }),
    timelineComplete: inc["timelineComplete"] !== false,
    remediation: r
      ? {
          actions: arr(r["actions"])
            .map((a) => {
              const o = obj(a);
              const actionId = str(o["actionId"]);
              const label = str(o["label"]);
              return actionId && label
                ? { actionId, label, description: str(o["description"]) ?? "", confirm: o["confirm"] === true, async: o["async"] === true }
                : null;
            })
            .filter((x): x is RemediationAction => x !== null),
          deepLink: str(deep["href"]) && str(deep["label"]) ? { href: str(deep["href"])!, label: str(deep["label"])! } : null,
          guidance: str(r["guidance"]),
          unsafeReason: str(r["unsafeReason"]),
        }
      : null,
  };
}

export interface Operator {
  readonly userId: string;
  readonly label: string;
  readonly role: string | null;
}
export function parseOperators(v: unknown): { operators: Operator[]; selfUserId: string | null } {
  const d = obj(v);
  return {
    operators: arr(d["operators"])
      .map((o): Operator | null => {
        const x = obj(o);
        const userId = str(x["userId"]);
        if (!userId) return null;
        // P: display name, else email, else first 8 chars of the id.
        return { userId, label: str(x["displayName"]) ?? str(x["email"]) ?? userId.slice(0, 8), role: str(x["role"]) };
      })
      .filter((x): x is Operator => x !== null),
    selfUserId: str(d["selfUserId"]),
  };
}

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly visibility: "PRIVATE" | "TEAM";
  readonly updatedAt: string;
  readonly ownedByViewer: boolean;
  readonly filter: OpsFilters;
}
export function parseOpsSavedViews(v: unknown, viewer: string | null): SavedView[] {
  return arr(obj(v)["views"])
    .map((raw): SavedView | null => {
      const o = obj(raw);
      const id = str(o["id"]);
      const name = str(o["name"]);
      if (!id || !name) return null;
      const f = obj(o["filter"]);
      const sort = str(f["sort"]);
      return {
        id,
        name,
        visibility: o["visibility"] === "TEAM" ? "TEAM" : "PRIVATE",
        updatedAt: str(o["updatedAt"]) ?? "",
        ownedByViewer: o["ownedByViewer"] === true || (viewer !== null && str(o["ownerUserId"]) === viewer),
        filter: {
          sla: str(f["sla"]) ?? "",
          status: str(f["status"]) ?? "",
          severity: str(f["severity"]) ?? "",
          category: str(f["category"]) ?? "",
          owner: str(f["owner"]) ?? "any",
          q: str(f["q"]) ?? "",
          sort: sort && sort in SORT_LABEL ? (sort as SortKey) : "recent",
        },
      };
    })
    .filter((x): x is SavedView => x !== null);
}

/**
 * Saved-view filter body. Unlike the web (spec §6) the SLA axis is persisted:
 * the server schema accepts it, and a view that silently drops a filter
 * reopens showing a different queue than the one that was saved.
 */
export function savedViewFilterBody(teamId: string, f: OpsFilters) {
  return {
    teamId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.category ? { category: f.category } : {}),
    ...(f.owner !== "any" ? { owner: f.owner } : {}),
    ...(f.sla ? { sla: f.sla } : {}),
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    sort: f.sort,
  };
}

/* ------------------------------------------------------------ row model */

export const METRIC_DISPLAY_CAP = 2000;
export function formatMetricValue(value: number): string {
  return value > METRIC_DISPLAY_CAP ? `${METRIC_DISPLAY_CAP.toLocaleString("en-US")}+` : value.toLocaleString("en-US");
}

export function affectedFor(i: Incident): { label: string | null; href: string | null } {
  if (i.relatedEvidenceId) return { label: "Evidence record", href: `/evidence/${encodeURIComponent(i.relatedEvidenceId)}` };
  if (i.relatedJobId) return { label: "Background job", href: null };
  if (i.relatedProvider) return { label: i.relatedProvider, href: null };
  return { label: null, href: null };
}

export function resolutionNoteFor(i: Incident): string | null {
  if (i.resolutionAuthority === "SOURCE_TRUTH") {
    return "This condition closes itself when its source recovers. It cannot be marked resolved by hand.";
  }
  if (i.resolutionAuthority === "NO_DIRECT_RESOLUTION") {
    return "This condition is owned by a surface outside this workspace. It cannot be marked resolved here.";
  }
  return null;
}

/** Per-row eligibility (L/rowModel.ts). */
export function rowEligibility(i: Incident, c: OpsCapabilities) {
  const live = i.status === "OPEN" || i.status === "ACKNOWLEDGED";
  return {
    canAcknowledge: c.acknowledge && i.status === "OPEN",
    canResolve: i.manualResolution && c.resolve && live,
    canSuppress: c.suppress && live,
    canAssign: c.assign && live,
  };
}

export function ownerLabel(i: Incident, viewer: string | null, operators: ReadonlyArray<Operator>): string {
  if (!i.assignedOperatorUserId) return "Unassigned";
  if (viewer && i.assignedOperatorUserId === viewer) return "You";
  return operators.find((o) => o.userId === i.assignedOperatorUserId)?.label ?? i.assignedOperatorUserId.slice(0, 8);
}

/* ------------------------------------------------------------ bulk */

export type BulkActionType = "BULK_ACKNOWLEDGE_INCIDENTS" | "BULK_SUPPRESS_INCIDENTS" | "BULK_ASSIGN_INCIDENTS";

export function bulkBody(teamId: string, actionType: BulkActionType, targetIds: readonly string[], assigneeUserId?: string) {
  return { teamId, actionType, targetIds: [...targetIds].slice(0, 200), ...(assigneeUserId ? { assigneeUserId } : {}) };
}

/**
 * The bulk outcome. SUCCESS IS `COMPLETED` — the value the server writes
 * (bulk-actions.service.ts:119). Items still PENDING/FAILED stay selected so the
 * person can retry them; SKIPPED items (nothing to do) are not failures.
 */
export function summarizeBulk(v: unknown, requested: readonly string[]) {
  const items = arr(obj(v)["items"]).map((x) => ({ targetId: str(obj(x)["targetId"]), status: str(obj(x)["status"]) }));
  const succeeded = items.filter((i) => i.status === "COMPLETED").length;
  const skipped = items.filter((i) => i.status === "SKIPPED").length;
  const stillSelected = items.filter((i) => i.status !== "COMPLETED" && i.status !== "SKIPPED" && i.targetId).map((i) => i.targetId!);
  // An id the server never reported on is unknown, not done.
  for (const id of requested) if (!items.some((i) => i.targetId === id)) stillSelected.push(id);
  const n = requested.length;
  const failed = stillSelected.length;
  let message = `${succeeded} of ${n} updated.`;
  if (skipped > 0) message += ` ${skipped} needed no change.`;
  if (failed > 0) message += ` ${failed} could not be changed and ${failed === 1 ? "remains" : "remain"} selected.`;
  return { succeeded, skipped, failed, stillSelected, message };
}

/* ------------------------------------------------------------ refusals + notices */

/** P:1094-1133 — lifecycle refusals, verbatim. */
export const REFUSAL_NOTICE: Readonly<Record<string, { title: string; body: string }>> = {
  CONDITION_STILL_ACTIVE: {
    title: "Condition is still active",
    body: "This condition is still being reported by its source. Complete the required remediation, or suppress it with a recorded reason if notifications should stop.",
  },
  CONDITION_ACTIVITY_UNKNOWN: {
    title: "Condition status could not be verified",
    body: "PROOVRA could not confirm that the underlying condition has recovered. No status was changed. Check again after the source becomes available.",
  },
  CONDITION_NOT_DIRECTLY_RESOLVABLE: {
    title: "This condition cannot be resolved here",
    body: "This condition is owned by the surface that reported it and closes when that surface recovers. You can still acknowledge it, assign it, or suppress it with a recorded reason.",
  },
};

/** The refusal code on a failed lifecycle call, from `{error:{code}}`. */
export function refusalCode(err: unknown): string | null {
  const e = obj(err);
  const code = str(e["code"]);
  return code && REFUSAL_NOTICE[code] ? code : null;
}

/** A remediation outcome from a success OR a refused (403/409/503) body — spec §9. */
export function remediationMessage(bodyOrErr: unknown): string | null {
  const direct = obj(obj(bodyOrErr)["remediation"]);
  const viaErr = obj(obj(obj(bodyOrErr)["body"])["remediation"]);
  return str(direct["message"]) ?? str(viaErr["message"]);
}

export type ReconciliationNotice =
  | { kind: "failed"; message: string; canRetry: boolean }
  | { kind: "stalled" }
  | { kind: "partial"; heading: string; retryable: boolean }
  | { kind: "running" }
  | null;

const FAILED_EXPLANATION: Readonly<Record<string, string>> = {
  database_unavailable: "The workspace's data couldn't be reached.",
  timeout: "The check took too long and was stopped.",
  schema_mismatch:
    "This version of the app and its data store don't currently match, so the check can't run at all. Checking again won't change that — it needs whoever manages this deployment.",
  permission_denied:
    "The check wasn't allowed to read what it needs. Checking again won't change that — it needs whoever manages this deployment.",
};

/** At most one reconciliation notice (P:1555-1659). STALE has none. */
export function reconciliationNotice(s: OpsSummary | null): ReconciliationNotice {
  if (!s) return null;
  switch (s.readiness) {
    case "FAILED": {
      const cat = s.safeFailureCategory ?? "";
      const explanation = FAILED_EXPLANATION[cat] ?? "The check couldn't be completed.";
      return {
        kind: "failed",
        message: `The last check for operational conditions failed. ${explanation} Anything below is from an earlier check and may be out of date.`,
        canRetry: cat !== "schema_mismatch" && cat !== "permission_denied",
      };
    }
    case "STALLED":
      return { kind: "stalled" };
    case "PARTIAL":
      return {
        kind: "partial",
        heading:
          s.failedSources > 0 && s.truncatedSources > 0
            ? "Some checks failed and others returned more than they could read."
            : s.truncatedSources > 0
              ? "Some checks returned more than they could read in one pass."
              : "Some checks could not be completed.",
        retryable: s.retryable,
      };
    case "RUNNING":
      return { kind: "running" };
    default:
      return null;
  }
}

export const STATE_COPY = {
  loading: "Loading operational conditions…",
  clearTitle: "Workspace operations are clear",
  clearBody: "There are no unresolved operational conditions requiring action in this workspace.",
  noMatchTitle: "No operational conditions match these filters",
  noMatchBody: "This workspace may still have unresolved work. Widen the filters to see it.",
  preparingTitle: "Preparing workspace operations",
  preparingBody:
    "This workspace hasn't been checked for operational conditions yet. The first check is running now — this page will update when it finishes.",
  unavailableTitle: "Operational conditions are temporarily unavailable",
  unavailableFallback: "Operational conditions could not be loaded.",
  degradedSummary: "The queue summary could not be loaded.",
  degradedTail: "Anything shown below may be incomplete.",
  groupsFailed: "Grouped conditions could not be loaded. Switch to All conditions, or try again.",
  partialTail:
    "The conditions below are what could be found, not necessarily all of them. This workspace can't be reported as clear until a complete check succeeds.",
  partialNotRetryable:
    "Checking again won't change this — the app and its data store don't currently match, so the same checks will fail until that is corrected. Contact whoever manages this deployment.",
  stalledTitle: "The last check didn't finish.",
  stalledBody: "It started but stopped before completing, so anything below may be out of date. A new check can be started now.",
  reconciling: "Refreshing operational conditions…",
  checkRefusedTitle: "This check can't run right now",
  checkRefusedBody:
    "The app and its data store don't currently match, so a new check would fail the same way. Contact whoever manages this deployment.",
  checkNotStartedTitle: "A new check couldn't be started",
  checkNotStartedBody: "Nothing has changed. Try again shortly.",
  checkThrew: "A new check could not be started.",
  historyEmpty: "Nothing has happened to this condition since it opened.",
  historyTruncated: "Older history exists beyond what is shown here.",
  historyFailed: "This condition's history could not be loaded.",
  groupEmpty: "No individual records to show for this group.",
  groupLoading: "Loading affected records…",
  groupFailed: "Those records could not be loaded.",
  noOperators: "Nobody else in this workspace can take operational work yet.",
  actionFailed: "That action could not be applied.",
  assignFailed: "Could not change who owns this.",
  remediationFailed: "That action could not be started.",
  remediationQueued: "Accepted and queued.",
  remediationAsyncHint: " This runs in the background; this condition closes on its own once the record recovers.",
  bulkCancelled: "Nothing was changed — verification was cancelled.",
  bulkFailed: "That bulk action could not be applied.",
  loadMoreFailed: "Could not load more conditions.",
  viewSaveFailed: "That view could not be saved.",
  viewRenameFailed: "That view could not be renamed. It may have changed since you opened it.",
  viewDeleteFailed: "That view could not be removed.",
  techRefsIntro: "Identifiers to quote if you contact support about this condition.",
} as const;

export function subtitleFor(c: OpsCapabilities): string {
  return canActOnAnything(c)
    ? "Monitor, assign and resolve operational conditions in this workspace."
    : "Monitor operational conditions in this workspace. Acting on one needs an operator role.";
}

/** Reconcile poll delay (P): min(750·2^⌊n/3⌋, 4000) ms, at most 12 polls. */
export const RECONCILE_MAX_POLLS = 12;
export function reconcilePollDelay(n: number): number {
  return Math.min(750 * 2 ** Math.floor(n / 3), 4000);
}

/* ------------------------------------------------------------ parity pass (2026-09-25) */

/**
 * The per-surface failure sentence (P:168-181 `sourceErrorFor`). It only picks
 * WHICH sentence a safe error falls back to, so a 503 on the summary never tells
 * the operator their conditions are unavailable.
 */
export const SOURCE_FALLBACK = {
  summary: "The queue summary could not be loaded.",
  incidents: "Operational conditions could not be loaded.",
  detail: "This condition's history could not be loaded.",
} as const;

/**
 * GroupSurface `describeAffected` (C/GroupSurface.tsx). The unit is the
 * server's own (operations-grouping.service.ts:481-486): "records" for a
 * per-record source, else the source metric's unit — "conditions" (retry
 * storm), "workflows", "items". Native used to switch on "occurrences", a unit
 * the server never sends, so the retry-storm group read "N affected records"
 * about conditions — the exact defect the server's unit field exists to stop.
 */
export function describeGroupAffected(count: number, unit: string | null): string {
  const n = formatMetricValue(count);
  if (unit === "conditions") return `${n} repeatedly observed conditions`;
  if (unit === "workflows") return `${n} affected workflows`;
  if (unit === "items") return `${n} affected items`;
  return `${n} affected records`;
}

/** GroupSurface `describeAge`: null when there is no age, or it cannot be stated. */
export function describeGroupAge(g: Pick<IncidentGroup, "durationSeconds" | "sourceId">): string | null {
  if (g.durationSeconds == null) return null;
  const span = describeDuration(g.durationSeconds);
  if (span === "—") return null;
  return g.sourceId === "platform.telemetry_stale" ? `Last telemetry sample ${span} ago` : `Last observed ${span} ago`;
}

/** The ONE quantity a group row states: age, else affected count, else conditions. */
export function groupQuantity(g: IncidentGroup): string {
  const age = describeGroupAge(g);
  if (age != null) return age;
  if (g.affectedRecordCount != null) return describeGroupAffected(g.affectedRecordCount, g.affectedUnit);
  return g.conditionCount === 1 ? "1 condition" : `${formatMetricValue(g.conditionCount)} conditions`;
}

export type RowActionKey = "open" | "assign" | "acknowledge" | "resolve" | "suppress";

/**
 * The row menu (C/IncidentSurface.tsx `buildActions`), in the web's order:
 * Change owner, Acknowledge, Resolve, Stop notifying — with "Open details"
 * first, and NO menu at all when none of the four applies.
 */
export function rowActions(i: Incident, c: OpsCapabilities): ReadonlyArray<{ key: RowActionKey; label: string; danger?: boolean }> {
  const e = rowEligibility(i, c);
  const actions: { key: RowActionKey; label: string; danger?: boolean }[] = [];
  if (e.canAssign) actions.push({ key: "assign", label: "Change owner" });
  if (e.canAcknowledge) actions.push({ key: "acknowledge", label: "Acknowledge" });
  if (e.canResolve) actions.push({ key: "resolve", label: "Resolve" });
  if (e.canSuppress) actions.push({ key: "suppress", label: "Stop notifying about this", danger: true });
  if (actions.length === 0) return actions;
  return [{ key: "open", label: "Open details" }, ...actions];
}

/** "Load 50 more" (P:1860) — the page size is the one the read asks for. */
export const LOAD_MORE_LABEL = `Load ${OPS_PAGE_LIMIT} more`;
export const AFFECTED_MORE_LABEL = "View more affected records";

/**
 * WORKSPACE HEALTH is its own capability (routeRegistry.ts:1164-1172:
 * `requiredCapabilities: ["WORKSPACE_HEALTH_VIEW"]`, HIDDEN_IF_NO_CAPABILITY).
 * The server grants it from the same predicate as OPERATIONS_VIEW
 * (capability-registry.ts:368-374) but the two may diverge, so it is read by name.
 */
export function canViewWorkspaceHealth(envelope: unknown): boolean {
  return obj(obj(envelope)["capabilities"])["WORKSPACE_HEALTH_VIEW"] === true;
}
