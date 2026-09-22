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
    effectiveAtIso: str(req.effectiveAtUtc) ?? str(req.effectiveAt),
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

/** A request that is open and still inside its cooling-off period. */
export function hasOpenClosure(state: ClosureState): boolean {
  const s = (state.requestStatus ?? "").toUpperCase();
  return state.requestId !== null && (s === "PENDING" || s === "SCHEDULED" || s === "REQUESTED");
}

/** Closure may be requested only when the SERVER listed no blockers. */
export function canRequestClosure(state: ClosureState): boolean {
  return !hasOpenClosure(state) && state.blockers.length === 0;
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
