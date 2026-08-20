"use client";

/**
 * PHASE 12B (Evidence Operations) — Search activity log panel.
 *
 * Product consumer for the canonical Discovery audit authority
 * `GET /v1/search/audit` (services/api/src/routes/search.routes.ts).
 * That route is the ONLY public authority over the
 * `search_audit_logs` data domain — it is deliberately NOT folded into
 * the unified `GET /v1/search` (which searches the workspace CONTENT
 * projection, a different data domain with a different authorization
 * gate: search-actor vs. search-OPERATOR).
 *
 * Hard rules honoured here:
 *   * Workspace context is SERVER-projected (`teamId` prop is sourced
 *     from the platform-context envelope by the page, never inferred
 *     client-side) and every response is dropped when the tenant
 *     generation changed mid-flight.
 *   * ZERO client-side policy authority — the panel does not decide
 *     who may read the log. It asks, and renders the server's bounded
 *     denial when the backend answers 403 / 404.
 *   * Raw query text never exists on the wire; the backend returns a
 *     truncated hash prefix + length. The panel renders exactly that
 *     and never attempts to reverse it.
 *   * Errors go through toSafeUserError — never a raw error.message.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../lib/platform-context";
import { AppStatusBadge } from "../app-primitives/AppStatusBadge";

/** INTERNAL. The panel is the only consumer; nothing outside reads a row. */
type SearchAuditRow = {
  id: string;
  teamId: string;
  actorUserId: string;
  surface: string;
  queryHash: string | null;
  queryLength: number;
  documentTypes: ReadonlyArray<string> | null;
  filters: Record<string, unknown> | null;
  resultCount: number;
  filteredGovernanceCount: number;
  filteredVisibilityCount: number;
  failClosed: boolean;
  requestId: string | null;
  occurredAtUtc: string;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "ready" };

const PAGE_LIMIT = 50;

export function SearchAuditLogPanel({ teamId }: { teamId: string | null }) {
  const [rows, setRows] = useState<SearchAuditRow[]>([]);
  const [nextBeforeUtc, setNextBeforeUtc] = useState<string | null>(null);
  const [failClosedOnly, setFailClosedOnly] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const { stamp, isStale } = useTenantGuard();

  const load = useCallback(
    async (opts: { beforeUtc?: string | null; append: boolean }) => {
      if (!teamId) {
        setState({ kind: "idle" });
        return;
      }
      const captured = stamp();
      setState({ kind: "loading" });
      const qs = new URLSearchParams();
      qs.set("teamId", teamId);
      qs.set("limit", String(PAGE_LIMIT));
      if (failClosedOnly) qs.set("failClosedOnly", "true");
      if (opts.beforeUtc) qs.set("beforeUtc", opts.beforeUtc);
      try {
        const res = await apiFetch(`/v1/search/audit?${qs.toString()}`, {
          method: "GET",
        });
        // §10.3 stale-context rejection — a workspace switch between
        // request and response makes this another tenant's audit log.
        if (isStale(captured)) return;
        const incoming = (res?.rows ?? []) as SearchAuditRow[];
        // Defence in depth: the server scopes by teamId, but never
        // render a row that claims a different workspace.
        const scoped = incoming.filter((r) => r.teamId === teamId);
        setRows((prev) => (opts.append ? [...prev, ...scoped] : scoped));
        setNextBeforeUtc((res?.nextBeforeUtc ?? null) as string | null);
        setState({ kind: "ready" });
      } catch (err) {
        if (isStale(captured)) return;
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 403 || status === 404) {
          setRows([]);
          setNextBeforeUtc(null);
          setState({
            kind: "denied",
            reason:
              status === 403
                ? "You do not have permission to read this workspace's search activity. An owner, admin, or reviewer can open it."
                : "Search activity is not available for this workspace.",
          });
          return;
        }
        setState({
          kind: "error",
          message: toSafeUserError(err, {
            message: "We couldn't load search activity.",
          }).message,
        });
      }
    },
    [teamId, failClosedOnly, stamp, isStale],
  );

  useEffect(() => {
    void load({ append: false });
  }, [load]);

  return (
    <section
      className="app-panel"
      data-search-audit-panel
      aria-labelledby="search-audit-title"
    >
      <header className="app-panel__head">
        <div>
          <h2 className="app-panel__title" id="search-audit-title">
            Search activity
          </h2>
          <p className="app-field-help">
            Who ran a search in this workspace, what the platform returned,
            and how many results governance or visibility rules withheld.
            Search wording itself is never stored — only a short
            non-reversible fingerprint.
          </p>
        </div>
        <label className="app-field-label" data-search-audit-failclosed-filter>
          <input
            type="checkbox"
            className="app-checkbox"
            data-search-audit-failclosed-toggle
            checked={failClosedOnly}
            onChange={(e) => setFailClosedOnly(e.target.checked)}
          />{" "}
          Withheld results only
        </label>
      </header>

      <div className="app-panel__body">
        {state.kind === "loading" && rows.length === 0 ? (
          <p data-search-audit-loading className="app-hint">
            Loading search activity…
          </p>
        ) : null}

        {/* A refusal, not a failure: the server decided, and this panel has no
            retry to offer because the same request answers the same way. */}
        {state.kind === "denied" ? (
          <p data-search-audit-denied className="app-hint">
            {state.reason}
          </p>
        ) : null}

        {state.kind === "error" ? (
          <div
            data-search-audit-error
            className="app-alert app-alert--danger"
            role="alert"
          >
            <span>{state.message}</span>
            <button
              type="button"
              data-search-audit-retry
              className="app-secondary-action"
              onClick={() => void load({ append: false })}
            >
              Try again
            </button>
          </div>
        ) : null}

        {state.kind === "ready" && rows.length === 0 ? (
          <p data-search-audit-empty className="app-hint">
            {failClosedOnly
              ? "No searches in this workspace had results withheld."
              : "No searches have been run in this workspace yet."}
          </p>
        ) : null}

        {rows.length > 0 ? (
          // The table scrolls inside its own surface; the page never scrolls
          // sideways because this panel is wide.
          <div className="app-table-surface app-table-surface--scroll">
            <table data-search-audit-table className="app-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Person</th>
                  <th scope="col">Surface</th>
                  <th scope="col">Search fingerprint</th>
                  <th scope="col">Returned</th>
                  <th scope="col">Withheld</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-search-audit-row={r.id}>
                    <td>{safeDateTime(r.occurredAtUtc)}</td>
                    <td>
                      <code>{r.actorUserId.slice(0, 8)}…</code>
                    </td>
                    <td>
                      <code>{r.surface}</code>
                    </td>
                    <td>
                      {r.queryHash ? (
                        <code data-search-audit-query-hash>
                          {r.queryHash} · {r.queryLength} chars
                        </code>
                      ) : (
                        <span className="app-table__muted">No search wording</span>
                      )}
                    </td>
                    <td>{r.resultCount}</td>
                    <td>
                      {r.filteredGovernanceCount + r.filteredVisibilityCount}
                    </td>
                    <td>
                      {r.failClosed ? (
                        <AppStatusBadge
                          tone="amber"
                          dot
                          data-search-audit-failclosed
                        >
                          Results withheld
                        </AppStatusBadge>
                      ) : (
                        <AppStatusBadge tone="green" dot>
                          Completed
                        </AppStatusBadge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {nextBeforeUtc ? (
          <button
            type="button"
            data-search-audit-load-more
            className="app-secondary-action"
            disabled={state.kind === "loading"}
            aria-busy={state.kind === "loading"}
            onClick={() =>
              void load({ beforeUtc: nextBeforeUtc, append: true })
            }
          >
            {state.kind === "loading" ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function safeDateTime(iso: string): string {
  try {
    return formatUserDateTime(iso) ?? iso;
  } catch {
    return iso;
  }
}

// REDESIGN/SEARCH — the panel's 15 `React.CSSProperties` objects were deleted
// here. It renders on the canonical `app-panel` / `app-table` /
// `app-status-badge` / `app-secondary-action` primitives now, so the search
// console's activity view is the same surface language as the rest of it.
