/**
 * SEARCH ACTIVITY (T-15) — the native port of
 * `apps/web/components/search/SearchAuditLogPanel.tsx`.
 *
 *   GET /v1/search/audit?teamId=&limit=50[&failClosedOnly=true][&beforeUtc=]
 *       → { rows[], nextBeforeUtc }
 *
 * A different data domain from GET /v1/search (search-OPERATOR gate). The
 * client decides nothing about who may read it: a 403/404 is rendered as the
 * server's refusal. Raw query text never exists on the wire — only a short
 * non-reversible fingerprint + length, shown as-is. Rows claiming another
 * workspace are dropped (defence in depth).
 */
export const SEARCH_AUDIT_PAGE = 50;

export function buildSearchAuditPath(teamId: string, opts: { failClosedOnly: boolean; beforeUtc?: string | null }): string {
  const parts = [`teamId=${encodeURIComponent(teamId)}`, `limit=${SEARCH_AUDIT_PAGE}`];
  if (opts.failClosedOnly) parts.push("failClosedOnly=true");
  if (opts.beforeUtc) parts.push(`beforeUtc=${encodeURIComponent(opts.beforeUtc)}`);
  return `/v1/search/audit?${parts.join("&")}`;
}

export interface SearchAuditRow {
  id: string;
  actorShort: string;
  surface: string;
  queryHash: string | null;
  queryLength: number;
  resultCount: number;
  withheld: number;
  failClosed: boolean;
  occurredAtUtc: string;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function parseSearchAudit(payload: unknown, teamId: string): { rows: SearchAuditRow[]; nextBeforeUtc: string | null } {
  const d = o(payload);
  const rows: SearchAuditRow[] = [];
  for (const raw of Array.isArray(d["rows"]) ? (d["rows"] as unknown[]) : []) {
    const r = o(raw);
    const id = typeof r["id"] === "string" ? (r["id"] as string) : "";
    if (!id || r["teamId"] !== teamId) continue;
    const actor = typeof r["actorUserId"] === "string" ? (r["actorUserId"] as string) : "";
    rows.push({
      id,
      actorShort: `${actor.slice(0, 8)}…`,
      surface: typeof r["surface"] === "string" ? (r["surface"] as string) : "",
      queryHash: typeof r["queryHash"] === "string" && (r["queryHash"] as string).length > 0 ? (r["queryHash"] as string) : null,
      queryLength: n(r["queryLength"]),
      resultCount: n(r["resultCount"]),
      withheld: n(r["filteredGovernanceCount"]) + n(r["filteredVisibilityCount"]),
      failClosed: r["failClosed"] === true,
      occurredAtUtc: typeof r["occurredAtUtc"] === "string" ? (r["occurredAtUtc"] as string) : "",
    });
  }
  return { rows, nextBeforeUtc: typeof d["nextBeforeUtc"] === "string" ? (d["nextBeforeUtc"] as string) : null };
}

export const SEARCH_AUDIT_COPY = {
  title: "Search activity",
  intro:
    "Who ran a search in this workspace, what the platform returned, and how many results governance or visibility rules withheld. Search wording itself is never stored — only a short non-reversible fingerprint.",
  withheldOnly: "Withheld results only",
  loading: "Loading search activity…",
  denied403: "You do not have permission to read this workspace's search activity. An owner, admin, or reviewer can open it.",
  denied404: "Search activity is not available for this workspace.",
  failed: "We couldn't load search activity.",
  retry: "Try again",
  emptyWithheld: "No searches in this workspace had results withheld.",
  empty: "No searches have been run in this workspace yet.",
  noWording: "No search wording",
  withheldBadge: "Results withheld",
  completed: "Completed",
  loadMore: "Load more",
} as const;
