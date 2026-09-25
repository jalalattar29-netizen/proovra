/**
 * CLOSURE — one understanding of "this tenant is being shut down".
 *
 * An organization and a workspace are closed by the SAME contract, field for
 * field:
 *
 *   GET  /v1/{orgs,teams}/:id/closure
 *        → { request, blockers[], confirmationPhrase, coolingOffDays }
 *   POST /v1/{orgs,teams}/:id/closure
 *        { confirmation, reason?, stepUp? }
 *   POST /v1/{orgs,teams}/:id/closure/:requestId/cancel
 *
 * Both are ORG_OWNER / workspace OWNER only, both validate the typed phrase
 * server-side, and both schedule rather than delete.
 *
 * It is written once. Two copies of a projection that decides whether a
 * destructive action is OFFERED is exactly the code that drifts, and the copy
 * that drifts is the one that offers closure on a tenant the server would have
 * refused.
 *
 * ===========================================================================
 * THE CLIENT NEVER STATES THE SAFETY
 * ===========================================================================
 * The phrase, the cooling-off period and the blocker sentences are all the
 * server's. A client that believed in its own phrase and the route rejected it
 * would make closure impossible with no explanation the user could act on; a
 * client that restated the blockers would be explaining a refusal it did not
 * make.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export interface ClosureBlocker {
  code: string;
  message: string;
  count: number | null;
}

export interface ClosureState {
  requestId: string | null;
  requestStatus: string | null;
  requestedAtIso: string | null;
  effectiveAtIso: string | null;
  blockers: ClosureBlocker[];
  /** The exact phrase the ROUTE checks. Never restated by the client. */
  confirmationPhrase: string | null;
  coolingOffDays: number | null;
}

export function parseClosureState(payload: unknown): ClosureState {
  const d = obj(payload);
  const req = obj(d.request);
  return {
    requestId: str(req.id),
    requestStatus: str(req.status),
    requestedAtIso: str(req.requestedAtUtc) ?? str(req.requestedAt),
    // The server's date is the END OF COOLING-OFF (org + workspace closure selects);
    // `effectiveAtUtc` was never sent, so the scheduled date never showed.
    effectiveAtIso: str(req.coolingOffEndsAtUtc),
    blockers: rows(d.blockers)
      .map((raw) => {
        const b = obj(raw);
        const code = str(b.code);
        if (!code) return null;
        return {
          code,
          // The server wrote these sentences.
          message: str(b.message) ?? code,
          count: num(b.count),
        };
      })
      .filter((b): b is ClosureBlocker => b !== null),
    confirmationPhrase: str(d.confirmationPhrase),
    coolingOffDays: num(d.coolingOffDays),
  };
}

/** The server's sets (org-closure.service.ts / workspace-closure.service.ts). PENDING was never a status. */
const CANCELLABLE_CLOSURE = ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED"];
const ACTIVE_CLOSURE = ["REQUESTED", "COOLING_OFF", "SCHEDULED", "PROCESSING"];

/**
 * A request the owner can still cancel. A request is created as COOLING_OFF,
 * which this used to omit — so a just-requested closure read as not open: no
 * Cancel, and the request form came back only to meet a 409.
 */
export function hasOpenClosure(state: ClosureState): boolean {
  const s = (state.requestStatus ?? "").toUpperCase();
  return state.requestId !== null && CANCELLABLE_CLOSURE.includes(s);
}

/** Closure may be requested only when none is active or open and the SERVER listed no blockers. */
export function canRequestClosure(state: ClosureState): boolean {
  const s = (state.requestStatus ?? "").toUpperCase();
  const active = state.requestId !== null && ACTIVE_CLOSURE.includes(s);
  return !hasOpenClosure(state) && !active && state.blockers.length === 0;
}

/**
 * Whether what was typed matches the phrase the route will check.
 *
 * Compared against the SERVER's phrase, never a copy. Exact, including case
 * and surrounding space: a typed confirmation a client quietly normalised is
 * not a confirmation.
 */
export function closurePhraseMatches(state: ClosureState, typed: string): boolean {
  return state.confirmationPhrase !== null && typed === state.confirmationPhrase;
}

export function buildClosureBody(confirmation: string, reason?: string | null) {
  const r = (reason ?? "").trim();
  return {
    // Sent exactly as typed. The client compares it only to decide whether to
    // enable the button; the route is what actually checks it.
    confirmation,
    ...(r.length > 0 ? { reason: r } : {}),
  };
}

/** True when the failure means the closure state on screen is now stale. */
export function closureFailureNeedsReload(err: unknown): boolean {
  const e = obj(err);
  const code = str(obj(obj(e.body).error).code) ?? str(e.code);
  return code === "closure_blocked" || code === "closure_request_active";
}

// ---------------------------------------------------------------------------
// Workspace closure card parity (web teams/[id]/components/WorkspaceClosureCard)
// ---------------------------------------------------------------------------

/** How many OTHER members lose access (GET /v1/teams/:id/closure, teams.routes.ts:3470). Null when not sent. */
export function parseMembersLosingAccess(payload: unknown): number | null {
  return num(obj(payload).membersLosingAccess);
}

/**
 * The blockers stored ON a BLOCKED request (`request.blockersJson`, a JSON
 * string). The web lists them under the status line; a malformed value lists
 * nothing rather than throwing.
 */
export function parseRequestBlockers(payload: unknown): ClosureBlocker[] {
  const raw = str(obj(obj(payload).request).blockersJson);
  if (!raw) return [];
  try {
    return rows(JSON.parse(raw))
      .map(obj)
      .filter((b) => str(b.code))
      .map((b) => ({ code: str(b.code) as string, message: str(b.message) ?? (str(b.code) as string), count: num(b.count) }));
  } catch {
    return [];
  }
}

/** The web's status labels (WorkspaceClosureCard STATUS_LABEL). */
const CLOSURE_STATUS_LABEL: Readonly<Record<string, string>> = {
  BLOCKED: "Blocked — action needed",
  COOLING_OFF: "Scheduled — cancellation window open",
  SCHEDULED: "Scheduled",
  PROCESSING: "Closing…",
  COMPLETED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};
export function closureStatusLabel(status: string): string {
  return CLOSURE_STATUS_LABEL[status.toUpperCase()] ?? status;
}

/** A request still in flight — the web's `open` (includes PROCESSING, which cannot be cancelled). */
export function isClosureInFlight(state: ClosureState): boolean {
  const s = (state.requestStatus ?? "").toUpperCase();
  return state.requestId !== null && ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED", "PROCESSING"].includes(s);
}

/** Reopen is offered only where it can work: the latest request COMPLETED. */
export function canReopenWorkspace(state: ClosureState): boolean {
  return !isClosureInFlight(state) && (state.requestStatus ?? "").toUpperCase() === "COMPLETED";
}

export function buildWorkspaceReopenPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/reopen`;
}

/** POST /v1/teams/:id/reopen refusals (teams.routes.ts:3709), as the web words them. */
export function reopenFailureCopy(err: unknown, fallback: string | null): string {
  const status = num(obj(err).statusCode) ?? 0;
  if (status === 403) return "You don't have permission to reopen this workspace. Only its owner can.";
  if (status === 404) return "This workspace no longer exists.";
  if (status === 409) {
    return "There is nothing to reopen: either a closure request is still open — cancel that instead — or this workspace was never closed.";
  }
  return fallback ?? "Could not reopen this workspace. Nothing was changed.";
}

export const WORKSPACE_REOPENED_NOTICE =
  "Workspace reopened. Your owner access is back; other members, API credentials and webhooks stay revoked until you restore them explicitly.";
