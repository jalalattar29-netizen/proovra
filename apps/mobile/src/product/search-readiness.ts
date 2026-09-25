/**
 * SEARCH READINESS + OWNER REBUILD (T-15) — the native port of the web's
 * readiness disclosure (search/page.tsx reloadHealth / rebuildIndex,
 * components/SearchStates.tsx SearchReadinessNotice).
 *
 * GET  /v1/search/diagnostics?teamId[&q]  → { readiness: SearchReadinessProjection, … }
 * POST /v1/search/reconcile { teamId }    → { status?, alreadyRunning? }
 *
 * The STATE is the server's (`@proovra/shared` search-readiness); the client
 * never classifies from counts. Native showed "No results — Nothing matched"
 * while the index was still being built or had stalled, which reads as "your
 * records are gone". The rebuild control appears only when the server
 * projects `canRecover` for THIS actor.
 */
import type { SearchReadinessProjection, SearchReadinessState } from "@proovra/shared";

export function buildSearchDiagnosticsPath(teamId: string, q?: string): string {
  const p = new URLSearchParams({ teamId });
  const t = (q ?? "").trim();
  if (t) p.set("q", t.slice(0, 200));
  return `/v1/search/diagnostics?${p.toString()}`;
}
export const SEARCH_RECONCILE_PATH = "/v1/search/reconcile";

const STATES: readonly SearchReadinessState[] = [
  "EMPTY_WORKSPACE",
  "INITIALIZING",
  "PARTIAL",
  "READY",
  "STALLED",
  "FAILED",
  "RESTRICTED",
  "UNAVAILABLE",
  "DEGRADED",
];

/** The readiness block, or null — an older API build says nothing, and so does the client. */
function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function parseSearchReadiness(payload: unknown): SearchReadinessProjection | null {
  const d = o(payload);
  const r = o(d["readiness"]);
  if (!(STATES as readonly unknown[]).includes(r.state)) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    ...(r as unknown as SearchReadinessProjection),
    eligibleCount: n(r.eligibleCount),
    indexedCount: n(r.indexedCount),
    outstandingCount: n(r.outstandingCount),
    failureReason: typeof r.failureReason === "string" ? r.failureReason : null,
    shouldPoll: r.shouldPoll === true,
    resultsAreComplete: r.resultsAreComplete === true,
    canRecover: r.canRecover === true,
  };
}

export interface ReadinessNotice {
  tone: "info" | "warn" | "danger";
  heading: string | null;
  body: string;
  /** The recovery control's label when the actor may recover; the hint otherwise. */
  recoverLabel: string | null;
  recoverHint: string | null;
}

export const SEARCH_RECOVERY_UNAVAILABLE_HINT = "Indexing retries automatically. Contact support if records stay missing.";

/** SearchReadinessNotice, verbatim; null for READY / EMPTY_WORKSPACE / RESTRICTED. */
export function searchReadinessNotice(r: SearchReadinessProjection): ReadinessNotice | null {
  const recover = (label: string) => ({
    recoverLabel: r.canRecover ? label : null,
    recoverHint: r.canRecover ? null : SEARCH_RECOVERY_UNAVAILABLE_HINT,
  });
  switch (r.state) {
    case "INITIALIZING":
      return { tone: "info", heading: null, body: "Preparing workspace search…", recoverLabel: null, recoverHint: null };
    case "PARTIAL":
      return {
        tone: "info",
        heading: null,
        body: `Indexing in progress — ${r.indexedCount} of ${r.eligibleCount} records searchable. Recent records may not appear yet.`,
        recoverLabel: null,
        recoverHint: null,
      };
    case "STALLED":
      return {
        tone: "warn",
        heading: "Indexing is not progressing",
        body: `${r.indexedCount} of ${r.eligibleCount} records are searchable. What is below is real and complete for what has been indexed. Indexing retries on its own; the remaining records appear once it catches up.`,
        ...recover("Rebuild index"),
      };
    case "FAILED":
      return {
        tone: "danger",
        heading: "The last indexing run did not finish",
        body: `${r.failureReason ? `Reason: ${r.failureReason}. ` : ""}${r.indexedCount} of ${r.eligibleCount} records are searchable. The rest will not appear until indexing runs again.`,
        ...recover("Retry indexing"),
      };
    case "DEGRADED":
      return {
        tone: "warn",
        heading: "Search is working",
        body: "One secondary capability is unavailable right now. Everything below is complete for the search you ran.",
        recoverLabel: null,
        recoverHint: null,
      };
    case "UNAVAILABLE":
      return {
        tone: "danger",
        heading: "Search is temporarily unavailable",
        body: "The search service could not be reached, so nothing can be said about this workspace's index right now. Try again shortly.",
        recoverLabel: null,
        recoverHint: null,
      };
    default:
      return null;
  }
}

/** What the SERVER said happened (search/page.tsx rebuildIndex). */
export function reconcileNotice(payload: unknown): string {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (d["alreadyRunning"] === true) return "Indexing is already running for this workspace.";
  if (d["status"] === "COMPLETED") return "Indexing finished.";
  return "Indexing started.";
}

export const SEARCH_REBUILD_FAILED = "Could not start the index rebuild.";
