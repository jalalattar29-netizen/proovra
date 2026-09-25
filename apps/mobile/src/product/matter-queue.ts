/**
 * MATTER QUEUE (T-15) — the native port of the web Cases index
 * (`apps/web/components/cases-experience/CasesIndex.tsx`).
 *
 *   GET /v1/cases/matter-queue?teamId=&search=&status=&riskLevel=
 *       → { generatedAt, workspace, items[], total }
 *
 * DEFECT THIS REPLACES: native Matters read `GET /v1/cases`, the legacy
 * non-paginated index capped at 200 that returns every case the user can
 * reach in ANY workspace (owned, shared, or in any member team). The list
 * mixed workspaces and the status filter/search ran over that mixed page.
 * The queue is bound to the ACTIVE workspace and filtered by the SERVER.
 */
export type CaseStatusFilter = "" | "OPEN" | "INVESTIGATING" | "ON_HOLD" | "RESOLVED" | "CLOSED" | "ARCHIVED";
export type RiskLevelFilter = "" | "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const STATUS_SEGMENTS: ReadonlyArray<{ value: CaseStatusFilter; label: string }> = [
  { value: "", label: "All cases" },
  { value: "OPEN", label: "Open" },
  { value: "INVESTIGATING", label: "Investigating" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
  { value: "ARCHIVED", label: "Archived" },
];
export const RISK_OPTIONS: ReadonlyArray<{ value: RiskLevelFilter; label: string }> = [
  { value: "", label: "Any risk" },
  { value: "NONE", label: "NONE" },
  { value: "LOW", label: "LOW" },
  { value: "MEDIUM", label: "MEDIUM" },
  { value: "HIGH", label: "HIGH" },
  { value: "CRITICAL", label: "CRITICAL" },
];

/** Rows show a short id as `#f2b14622`, so people type the `#`; the server matches the bare prefix. */
export function normalizeCaseSearch(raw: string): string {
  return raw.trim().replace(/^#/, "").trim();
}

export function buildMatterQueuePath(teamId: string, f: { search: string; status: CaseStatusFilter; riskLevel: RiskLevelFilter }): string {
  // Built by hand: React Native's URLSearchParams has historically lacked `set`.
  const parts = [`teamId=${encodeURIComponent(teamId)}`];
  if (f.search) parts.push(`search=${encodeURIComponent(f.search.slice(0, 80))}`);
  if (f.status) parts.push(`status=${f.status}`);
  if (f.riskLevel) parts.push(`riskLevel=${f.riskLevel}`);
  return `/v1/cases/matter-queue?${parts.join("&")}`;
}

export interface MatterQueueRow {
  id: string;
  name: string;
  shortRef: string;
  status: string;
  priority: string | null;
  ownerLabel: string;
  linkedEvidenceCount: number;
  evidenceGapCount: number;
  openIncidentCount: number;
  overdueWorkflowCount: number;
  governanceBlockerCount: number;
  activeLegalHoldCount: number;
  riskLevel: string | null;
  riskScore: number | null;
  /** The snapshot reason codes (advanced rows only render them). */
  riskReasonCodes: string[];
  latestActivityAtUtc: string | null;
}
export interface MatterQueue {
  items: MatterQueueRow[];
  total: number;
  /** When the server built the queue — the web header reads "Refreshed <relative>". */
  generatedAt: string | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** OwnerCell: the person's name, else email, else a short id; "Unassigned" without an owner. */
export function ownerLabel(ownerUserId: string | null, owner: unknown): string {
  if (!ownerUserId) return "Unassigned";
  const p = o(owner);
  return s(p["displayName"]) ?? s(p["email"]) ?? `Owner · ${ownerUserId.slice(0, 8)}`;
}

export function parseMatterQueue(payload: unknown): MatterQueue {
  const d = o(payload);
  const items: MatterQueueRow[] = [];
  for (const raw of Array.isArray(d["items"]) ? (d["items"] as unknown[]) : []) {
    const r = o(raw);
    const id = s(r["id"]);
    if (!id) continue;
    const ownerUserId = s(r["ownerUserId"]);
    items.push({
      id,
      name: s(r["name"]) ?? "Untitled case",
      shortRef: s(r["referenceNumber"]) ?? `#${id.slice(0, 8)}`,
      status: s(r["status"]) ?? "",
      priority: s(r["priority"]),
      ownerLabel: ownerLabel(ownerUserId, r["owner"]),
      linkedEvidenceCount: n(r["linkedEvidenceCount"]),
      evidenceGapCount: n(r["evidenceGapCount"]),
      openIncidentCount: n(r["openIncidentCount"]),
      overdueWorkflowCount: n(r["overdueWorkflowCount"]),
      governanceBlockerCount: n(r["governanceBlockerCount"]),
      activeLegalHoldCount: n(r["activeLegalHoldCount"]),
      riskLevel: s(r["riskLevel"]),
      riskScore: typeof r["riskScore"] === "number" ? (r["riskScore"] as number) : null,
      riskReasonCodes: Array.isArray(r["riskReasonCodes"])
        ? (r["riskReasonCodes"] as unknown[]).filter((c): c is string => typeof c === "string" && c.length > 0)
        : [],
      latestActivityAtUtc: s(r["latestActivityAtUtc"]),
    });
  }
  const total = typeof d["total"] === "number" ? (d["total"] as number) : items.length;
  return { items, total, generatedAt: s(d["generatedAt"]) };
}

/** The web's useEnterpriseSurfaceAccess — server-projected, fail-closed. */
export function canSeeAdvancedCaseOps(envelope: unknown): boolean {
  const e = o(envelope);
  return o(e["platform"])["isPlatformAdmin"] === true || o(e["flags"])["isEnterpriseWorkspace"] === true;
}

export function riskTone(level: string): "risk" | "pending" | "neutral" {
  return level === "CRITICAL" || level === "HIGH" ? "risk" : level === "MEDIUM" ? "pending" : "neutral";
}

/** The web RiskBadge text: "Risk: HIGH · 72". */
export function riskBadgeLabel(level: string, score: number | null): string {
  return `Risk: ${level}${score !== null ? ` · ${score}` : ""}`;
}

/** CasesIndex.tsx reasonCodeLabel — the snapshot reason codes in words; an unknown code is shown as sent. */
export function reasonCodeLabel(code: string): string {
  const labels: Record<string, string> = {
    EVIDENCE_GAP: "Evidence gap",
    INCIDENT_OPEN: "Open incident",
    WORKFLOW_OVERDUE: "Workflow overdue",
    WORKFLOW_ACTIVE: "Active workflow",
    INTEGRITY_FAILED: "Integrity failed",
    INTEGRITY_REVIEW_REQUIRED: "Integrity review",
    GOVERNANCE_BLOCKER: "Governance blocker",
    LEGAL_HOLD_ACTIVE: "Legal preservation",
    REVIEWER_OVERLOAD: "Reviewer overload",
    AUDIT_GAP: "Audit gap",
    PACKAGE_MISSING: "Package missing",
    REPORT_MISSING: "Report missing",
    CUSTODY_CONCERN: "Custody concern",
  };
  return labels[code] ?? code;
}

/** Advanced-mode counters, only the non-zero ones, in the web's words. */
export function rowCounters(r: MatterQueueRow): string[] {
  const out: string[] = [];
  if (r.evidenceGapCount > 0) out.push(`${r.evidenceGapCount} gap`);
  if (r.openIncidentCount > 0) out.push(`${r.openIncidentCount} incident`);
  if (r.overdueWorkflowCount > 0) out.push(`${r.overdueWorkflowCount} overdue`);
  if (r.governanceBlockerCount > 0) out.push(`${r.governanceBlockerCount} gov block`);
  return out;
}

export function queueCountTitle(shown: number, total: number): string {
  return shown === total ? `Cases · ${shown}` : `Cases · ${shown} of ${total}`;
}

export const MATTER_QUEUE_COPY = {
  searchPlaceholder: "Search cases, owners, IDs, or references…",
  searchLabel: "Search cases, owners, IDs, or references",
  noneTitle: "No cases yet",
  noneBody: "Create a case to group related evidence for an incident, claim, project, or review.",
  noMatchTitle: "No cases match these filters",
  noMatchBody: "Try clearing filters or searching for a different case name.",
  clearFilters: "Clear filters",
  signInTitle: "Sign in required",
  signInBody: "Sign in to view the matter queue.",
  deniedTitle: "Permission required",
  deniedBody: "You do not have permission to view the matter queue for this workspace. Ask a workspace administrator.",
  unavailableTitle: "Matter queue temporarily unavailable",
  unavailableFallback: "Unable to load matter queue.",
  noWorkspace: "No active workspace is available for this account. Create or switch into a workspace to view your cases.",
  subtitle: "Group related evidence into simple workspaces for incidents, claims, projects, or reviews.",
} as const;

/** CasesIndex.tsx:397 — the header count. */
export function caseTotalLabel(total: number): string {
  return `${total} ${total === 1 ? "case" : "cases"}`;
}

/* --------------------------------------------------------------- create */

/** CreateCaseModal.tsx — POST /v1/cases { name, teamId } (CreateCaseBody: name 1..120). */
export const CREATE_CASE_COPY = {
  title: "Create case",
  description: "Create a new investigation matter in this workspace.",
  contextPrefix: "New case will be created in",
  placeholder: "e.g. Insurance claim #4823",
  helper: "You can rename the case from its workspace at any time. Evidence, assignments, and comments are added after creation.",
} as const;

export function validateNewCaseName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Case name is required.";
  if (n.length > 120) return "Case name must be 120 characters or fewer.";
  return null;
}

/** The route replies with the created row itself (cases.routes.ts:430 `send(created)`). */
export function createdCaseId(payload: unknown): string | null {
  return s(o(payload)["id"]);
}

/* ---------------------------------------------------------- row actions */

/** CasesIndex.tsx RowActions — the confirmations, in the web words. */
export function archiveCaseConfirm(name: string) {
  return {
    title: `Archive "${name}"?`,
    consequence: "Archiving hides this case from the default list. Linked evidence, reports and packages are preserved and unchanged.",
    confirmLabel: "Archive case",
  };
}
export function deleteCaseConfirm(name: string) {
  return {
    title: `Delete "${name}"?`,
    consequence:
      "This deletes the case workspace only. Preserved evidence records remain in the Evidence Library; they are unlinked from this case, not destroyed.",
    confirmLabel: "Delete case",
  };
}

/**
 * HONEST readiness, derived only from evidence/gap facts (CasesIndex.tsx): an
 * empty case is "Not started" (never claimed healthy), a case with a
 * report/package gap "Needs attention", otherwise "Ready".
 */
export function caseReadiness(r: MatterQueueRow): { label: string; tone: "neutral" | "pending" | "verified" } {
  if (r.linkedEvidenceCount === 0) return { label: "Not started", tone: "neutral" };
  if (r.evidenceGapCount > 0) return { label: "Needs attention", tone: "pending" };
  return { label: "Ready", tone: "verified" };
}
export function evidenceCountLabel(count: number): string {
  return count === 0 ? "No records" : `${count} ${count === 1 ? "record" : "records"}`;
}
