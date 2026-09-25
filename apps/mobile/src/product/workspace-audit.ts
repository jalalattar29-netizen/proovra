/**
 * WORKSPACE AUDIT HISTORY (T-12 / RC-13) — the native port of
 * `apps/web/components/workspace-admin/WorkspaceAuditTab.tsx`.
 *
 * GET /v1/audit/tenant is the ONE tenant-audit query/export authority: it
 * authorizes (`audit.read`, or `audit.export` for export=true) on the proven
 * workspace BEFORE querying, and filters on the workspace column in the
 * database. So this client:
 *   - sends every filter to the server and never filters rows in memory;
 *   - exports through the SAME endpoint with export=true — no second policy;
 *   - renders any 403/404 as one generic denial (no scope/existence leak).
 */

export type AuditOutcomeFilter = "" | "success" | "denied" | "error";

export const AUDIT_OUTCOME_OPTIONS: ReadonlyArray<{ value: AuditOutcomeFilter; label: string }> = [
  { value: "", label: "Any outcome" },
  { value: "success", label: "Success" },
  { value: "denied", label: "Denied" },
  { value: "error", label: "Error" },
];

export const WORKSPACE_AUDIT_COPY = {
  title: "Audit history",
  description:
    "Every event is recorded against this workspace with a tamper-evident integrity chain. Filters run on the server.",
  unavailable: "Audit history is not available.",
  exportUnavailable: "Audit export is not available.",
  loading: "Loading audit history…",
  empty: "No audit events for the current filters.",
} as const;

/** The web shows the tab only in an ORGANIZATION workspace to TEAM_MANAGE holders. */
export function canViewWorkspaceAudit(input: {
  activeSpaceType: string | null;
  capabilities: Record<string, unknown> | null | undefined;
}): boolean {
  return input.activeSpaceType === "ORGANIZATION" && input.capabilities?.["TEAM_MANAGE"] === true;
}

export function buildTenantAuditPath(
  teamId: string,
  f: { action?: string; outcome?: AuditOutcomeFilter; cursorId?: string | null; exportAll?: boolean },
): string {
  const p = new URLSearchParams({ teamId });
  // The route caps `action` at 120; a longer value is a 400, not a filter.
  const action = (f.action ?? "").trim().slice(0, 120);
  if (action) p.set("action", action);
  if (f.outcome) p.set("outcome", f.outcome);
  if (f.cursorId) p.set("cursorId", f.cursorId);
  if (f.exportAll) p.set("export", "true");
  return `/v1/audit/tenant?${p.toString()}`;
}

export interface AuditRow {
  eventId: string;
  occurredAtUtc: string;
  action: string;
  outcome: string | null;
  resourceType: string | null;
  resourceId: string | null;
}

export interface AuditPage {
  items: AuditRow[];
  nextCursorId: string | null;
  /** The rows exactly as the server sent them — what an export shares. */
  raw: unknown[];
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseTenantAuditPage(payload: unknown): AuditPage {
  const d = o(payload);
  const raw = Array.isArray(d["items"]) ? (d["items"] as unknown[]) : [];
  const items: AuditRow[] = [];
  for (const r of raw) {
    const row = o(r);
    const eventId = s(row["eventId"]);
    if (!eventId) continue;
    items.push({
      eventId,
      occurredAtUtc: s(row["occurredAtUtc"]) ?? "",
      action: s(row["action"]) ?? "",
      outcome: s(row["outcome"]),
      resourceType: s(row["resourceType"]),
      resourceId: s(row["resourceId"]),
    });
  }
  return { items, nextCursorId: s(d["nextCursorId"]), raw };
}

/** The web's resource cell: `TYPE:id`, or an em dash when the event names none. */
export function auditResourceLabel(r: AuditRow): string {
  return r.resourceType ? `${r.resourceType}:${r.resourceId ?? ""}` : "—";
}

export function auditOutcomeTone(outcome: string | null): "verified" | "risk" | "pending" | "neutral" {
  if (outcome === "success") return "verified";
  if (outcome === "denied") return "pending";
  if (outcome === "error") return "risk";
  return "neutral";
}
