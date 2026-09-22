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

// ---------------------------------------------------------------------------
// The VIEWER's own capabilities on this case
// ---------------------------------------------------------------------------
//
// `GET /v1/cases/:id/matter-workspace` carries `viewer`, which is the SERVER's
// answer to what this caller may do here — and it also carries a
// `disabledReasons` string per denied action.
//
// The native screen offered every action unconditionally and let the refusal
// arrive as an error. That is the wrong order: a control that is offered and
// then refused teaches a user that the app is unreliable, when in fact the
// server was right. Nothing here DERIVES a permission; it reads the one the
// server already computed, exactly as the web does.

const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export interface CaseViewer {
  canManage: boolean;
  canMutate: boolean;
  canAssign: boolean;
  canChangeStatus: boolean;
  canLinkEvidence: boolean;
  canUnlinkEvidence: boolean;
  canUnlinkLegacyEvidence: boolean;
  canComment: boolean;
  canResolveComment: boolean;
  canManageAccess: boolean;
  /** Why an action is denied, in the server's own words. */
  disabledReasons: Record<string, string>;
}

/**
 * Absent means NOT allowed.
 *
 * An envelope that could not be read, or a build that stops sending `viewer`,
 * must close the controls rather than open them — a client that defaulted to
 * "yes" would offer a destructive action to someone the server would refuse.
 */
export function parseCaseViewer(envelope: unknown): CaseViewer {
  const v = obj(obj(envelope).viewer);
  const flag = (k: string) => v[k] === true;
  const reasons: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v.disabledReasons))) {
    if (typeof val === "string" && val.length > 0) reasons[k] = val;
  }
  return {
    canManage: flag("canManage"),
    canMutate: flag("canMutate"),
    canAssign: flag("canAssign"),
    canChangeStatus: flag("canChangeStatus"),
    canLinkEvidence: flag("canLinkEvidence"),
    canUnlinkEvidence: flag("canUnlinkEvidence"),
    canUnlinkLegacyEvidence: flag("canUnlinkLegacyEvidence"),
    canComment: flag("canComment"),
    canResolveComment: flag("canResolveComment"),
    canManageAccess: flag("canManageAccess"),
    disabledReasons: reasons,
  };
}

/** The server's reason for a denial, or null when it gave none. */
export function caseDenialReason(viewer: CaseViewer, action: string): string | null {
  return viewer.disabledReasons[action] ?? null;
}

// ---------------------------------------------------------------------------
// Notes: resolving and deleting
// ---------------------------------------------------------------------------

export function buildCaseCommentsPath(caseId: string): string {
  return `/v1/cases/${encodeURIComponent(caseId)}/comments`;
}
export function buildCaseCommentPath(caseId: string, commentId: string): string {
  return `${buildCaseCommentsPath(caseId)}/${encodeURIComponent(commentId)}`;
}
export function buildCaseCommentResolvePath(caseId: string, commentId: string): string {
  return `${buildCaseCommentPath(caseId, commentId)}/resolve`;
}

/** The route bounds the note at 4000 characters; so does the composer. */
export const CASE_NOTE_MAX = 4000;

export function validateCaseNote(body: string): string | null {
  const b = body.trim();
  if (b.length === 0) return "Write something first.";
  if (b.length > CASE_NOTE_MAX) {
    return `A note cannot be longer than ${CASE_NOTE_MAX} characters.`;
  }
  return null;
}

export function buildResolveCommentBody(resolved: boolean) {
  return { resolved };
}

/**
 * What the notes section MUST say about itself.
 *
 * The web carries this sentence on the panel, and it is not decoration: a
 * private note sitting beside integrity state reads as part of the record
 * unless something says it is not.
 */
export const CASE_NOTES_BOUNDARY =
  "Notes are private workspace notes. They do not change the recorded evidence integrity state.";

// ---------------------------------------------------------------------------
// Reports and packages
// ---------------------------------------------------------------------------

export interface CaseDeliverables {
  total: number;
  reportsReady: number;
  packagesReady: number;
  /** Records still missing a report or a package. */
  pending: number;
  /** Records whose verification signals a failure or needs review. */
  failed: number;
}

export function summariseCaseDeliverables(envelope: unknown): CaseDeliverables {
  const items = rows(obj(obj(obj(envelope).sections).evidence).items);
  let reportsReady = 0;
  let packagesReady = 0;
  let pending = 0;
  let failed = 0;

  for (const raw of items) {
    const i = obj(raw);
    const report = i.reportReady === true;
    const pack = i.packageReady === true;
    if (report) reportsReady += 1;
    if (pack) packagesReady += 1;
    if (!report || !pack) pending += 1;
    // REVIEW_REQUIRED is counted with FAILED, as the web counts it: both mean
    // the record cannot be treated as cleanly verified.
    const verification = str(i.verificationStatus);
    if (verification === "FAILED" || verification === "REVIEW_REQUIRED") failed += 1;
  }

  return { total: items.length, reportsReady, packagesReady, pending, failed };
}

// ---------------------------------------------------------------------------
// Settings: renaming and deleting the case
// ---------------------------------------------------------------------------

export function buildCasePath(caseId: string): string {
  return `/v1/cases/${encodeURIComponent(caseId)}`;
}

export function buildCaseRenameBody(name: string) {
  return { name: name.trim() };
}

export function validateCaseName(name: string, current: string): string | null {
  const n = name.trim();
  if (n.length === 0) return "A case needs a name.";
  // Not an error, but not a request worth sending either.
  if (n === current.trim()) return "That is already the name.";
  return null;
}

/**
 * What deleting a case actually does.
 *
 * The route's own comment: "DELETE /v1/cases/:id unlinks evidence via
 * updateMany". The evidence is NOT deleted, and saying so is the difference
 * between a user deleting a case and a user believing they have destroyed
 * their own records.
 */
export const DELETE_CASE_CONSEQUENCE =
  "Deleting this case will not delete preserved evidence records. Evidence remains " +
  "available in the Evidence Library unless separately archived or restricted.";
