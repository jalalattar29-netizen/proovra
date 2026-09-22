/**
 * CANONICAL NATIVE CASE-WORKSPACE PROJECTION (Master Program §6, Cases) — pure.
 *
 * The canonical case detail read is GET /v1/cases/:id/matter-workspace (the
 * retired /workspace route 410s to it). It's a member-accessible 11-section
 * envelope; the mobile case detail needs two sections: notes (case comments) and
 * assignments. These pure parsers read the documented shape defensively so a
 * degraded/absent section renders nothing rather than crashing — the RN screen is
 * a thin shell. Notes are added via POST /v1/cases/:id/comments { body }.
 */

export interface CaseNote {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
  resolved: boolean;
}

export interface CaseAssignment {
  id: string;
  assignedToUserId: string;
  role: string;
  status: string;
  note: string | null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** sections.notes.caseComments[] → active case notes (defensive). */
export function parseCaseNotes(envelope: unknown): CaseNote[] {
  const comments = arr(obj(obj(obj(envelope)["sections"])["notes"])["caseComments"]);
  const out: CaseNote[] = [];
  for (const raw of comments) {
    const c = obj(raw);
    if (typeof c["id"] !== "string" || typeof c["body"] !== "string") continue;
    out.push({
      id: c["id"] as string,
      authorUserId: typeof c["authorUserId"] === "string" ? (c["authorUserId"] as string) : "",
      body: c["body"] as string,
      createdAt: typeof c["createdAt"] === "string" ? (c["createdAt"] as string) : "",
      resolved: !!c["resolvedAtUtc"],
    });
  }
  return out;
}

/** Top-level assignments[] → active (not removed) assignments (defensive). */
export function parseCaseAssignments(envelope: unknown): CaseAssignment[] {
  const items = arr(obj(envelope)["assignments"]);
  const out: CaseAssignment[] = [];
  for (const raw of items) {
    const a = obj(raw);
    if (typeof a["id"] !== "string") continue;
    if (a["removedAtUtc"]) continue; // only active assignments
    out.push({
      id: a["id"] as string,
      assignedToUserId: typeof a["assignedToUserId"] === "string" ? (a["assignedToUserId"] as string) : "",
      role: typeof a["role"] === "string" ? (a["role"] as string) : "",
      status: typeof a["status"] === "string" ? (a["status"] as string) : "",
      note: typeof a["note"] === "string" ? (a["note"] as string) : null,
    });
  }
  return out;
}

/** Build a userId → display-name map from the case's access[] list. */
export function buildMemberNameMap(access: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of arr(access)) {
    const entry = obj(raw);
    const user = obj(entry["user"]);
    const id = typeof user["id"] === "string" ? (user["id"] as string) : null;
    if (!id) continue;
    const name = typeof user["displayName"] === "string" && user["displayName"]
      ? (user["displayName"] as string)
      : typeof user["email"] === "string"
        ? (user["email"] as string)
        : null;
    if (name) map[id] = name;
  }
  return map;
}

/** Resolve a userId to a display name, else a short truncated id. */
export function resolveMemberName(map: Record<string, string>, userId: string): string {
  if (map[userId]) return map[userId];
  return userId ? `${userId.slice(0, 8)}…` : "Someone";
}

/* ------------------------------------------------------------- Cases summary */

/**
 * WORKSPACE-LEVEL CASE METRICS, from `GET /v1/cases/summary?teamId=`.
 *
 * The four counters the web's Cases index shows above its list. They are the
 * reason a case list is more than a list: "how many matters have evidence"
 * and "how many are waiting on review" are the questions somebody opens this
 * surface to answer.
 *
 * SECTION STATUS IS NOT DECORATION. The envelope reports each section's own
 * status, and `unavailable` with `data: null` is a different answer from four
 * zeroes. A workspace whose summary could not be computed must not be told it
 * has no cases with evidence.
 */
export const CASES_SUMMARY_PATH = "/v1/cases/summary";

export function buildCasesSummaryPath(teamId: string): string {
  return `${CASES_SUMMARY_PATH}?teamId=${encodeURIComponent(teamId)}`;
}

export interface CasesSummary {
  totalCases: number;
  casesWithEvidence: number;
  casesWithActiveHolds: number;
  casesWithPendingReview: number;
}

export type CasesSummaryState =
  | { phase: "ok"; summary: CasesSummary }
  | { phase: "unavailable" };

function o2(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function n2(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseCasesSummary(envelope: unknown): CasesSummaryState {
  const section = o2(o2(o2(envelope)["sections"])["summary"]);
  const data = section["data"];

  // "unavailable" and "no cases" are different answers and must not render
  // the same way.
  if (String(section["status"] ?? "") === "unavailable" || data === null || data === undefined) {
    return { phase: "unavailable" };
  }

  const d = o2(data);
  return {
    phase: "ok",
    summary: {
      totalCases: n2(d["totalCases"]) ?? 0,
      casesWithEvidence: n2(d["casesWithEvidence"]) ?? 0,
      casesWithActiveHolds: n2(d["casesWithActiveHolds"]) ?? 0,
      casesWithPendingReview: n2(d["casesWithPendingReview"]) ?? 0,
    },
  };
}

/** The KPI rows, in the web's order, with their meaning spelled out. */
export function casesSummaryKpis(
  summary: CasesSummary,
): ReadonlyArray<{ key: string; label: string; value: string }> {
  return [
    { key: "total", label: "Matters", value: String(summary.totalCases) },
    { key: "evidence", label: "With evidence", value: String(summary.casesWithEvidence) },
    { key: "review", label: "Awaiting review", value: String(summary.casesWithPendingReview) },
    { key: "holds", label: "Under legal hold", value: String(summary.casesWithActiveHolds) },
  ];
}

/**
 * Whether this workspace has more than one occupant.
 *
 * A SINGLE_OCCUPANT workspace has no one to assign a matter to, so an
 * assignment control there would be an affordance with no possible target.
 */
export function isSharedWorkspace(envelope: unknown): boolean {
  return String(o2(o2(envelope)["workspace"])["scope"] ?? "") === "SHARED";
}
