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

export type SearchAuditRow = {
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
    <section data-search-audit-panel style={panelStyle}>
      <header style={headerStyle}>
        <div>
          <strong style={{ fontSize: 14 }}>Search activity</strong>
          <p style={subtitleStyle}>
            Who ran a search in this workspace, what the platform returned,
            and how many results governance or visibility rules withheld.
            Search wording itself is never stored — only a short
            non-reversible fingerprint.
          </p>
        </div>
        <label style={toggleLabelStyle}>
          <input
            type="checkbox"
            data-search-audit-failclosed-toggle
            checked={failClosedOnly}
            onChange={(e) => setFailClosedOnly(e.target.checked)}
          />
          Withheld results only
        </label>
      </header>

      {state.kind === "loading" && rows.length === 0 ? (
        <p data-search-audit-loading style={mutedStyle}>
          Loading search activity…
        </p>
      ) : null}

      {state.kind === "denied" ? (
        <p data-search-audit-denied style={deniedStyle}>
          {state.reason}
        </p>
      ) : null}

      {state.kind === "error" ? (
        <div data-search-audit-error style={errorStyle}>
          <span>{state.message}</span>
          <button
            type="button"
            data-search-audit-retry
            onClick={() => void load({ append: false })}
            style={retryButtonStyle}
          >
            Try again
          </button>
        </div>
      ) : null}

      {state.kind === "ready" && rows.length === 0 ? (
        <p data-search-audit-empty style={mutedStyle}>
          {failClosedOnly
            ? "No searches in this workspace had results withheld."
            : "No searches have been run in this workspace yet."}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table data-search-audit-table style={tableStyle}>
            <thead>
              <tr style={{ textAlign: "left", color: "#475569" }}>
                <th style={thStyle}>When</th>
                <th style={thStyle}>Person</th>
                <th style={thStyle}>Surface</th>
                <th style={thStyle}>Search fingerprint</th>
                <th style={thStyle}>Returned</th>
                <th style={thStyle}>Withheld</th>
                <th style={thStyle}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-search-audit-row={r.id}>
                  <td style={tdStyle}>{safeDateTime(r.occurredAtUtc)}</td>
                  <td style={tdStyle}>
                    <code>{r.actorUserId.slice(0, 8)}…</code>
                  </td>
                  <td style={tdStyle}>
                    <code>{r.surface}</code>
                  </td>
                  <td style={tdStyle}>
                    {r.queryHash ? (
                      <code data-search-audit-query-hash>
                        {r.queryHash} · {r.queryLength} chars
                      </code>
                    ) : (
                      <span style={mutedStyle}>No search wording</span>
                    )}
                  </td>
                  <td style={tdStyle}>{r.resultCount}</td>
                  <td style={tdStyle}>
                    {r.filteredGovernanceCount + r.filteredVisibilityCount}
                  </td>
                  <td style={tdStyle}>
                    {r.failClosed ? (
                      <span data-search-audit-failclosed style={failChipStyle}>
                        Results withheld
                      </span>
                    ) : (
                      <span style={okChipStyle}>Completed</span>
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
          disabled={state.kind === "loading"}
          onClick={() =>
            void load({ beforeUtc: nextBeforeUtc, append: true })
          }
          style={loadMoreStyle}
        >
          {state.kind === "loading" ? "Loading…" : "Load more"}
        </button>
      ) : null}
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

const panelStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 14,
  marginTop: 12,
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
  justifyContent: "space-between",
  marginBottom: 10,
};
const subtitleStyle: React.CSSProperties = {
  margin: "4px 0 0",
  color: "#475569",
  fontSize: 12,
  maxWidth: 620,
};
const toggleLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "#475569",
  whiteSpace: "nowrap",
};
const mutedStyle: React.CSSProperties = { color: "#475569", fontSize: 12 };
const deniedStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 12,
  background: "rgba(15, 23, 42, 0.04)",
  border: "1px dashed rgba(15, 23, 42, 0.18)",
  borderRadius: 8,
  padding: 10,
};
const errorStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  color: "#7f1d1d",
  background: "rgba(239, 68, 68, 0.08)",
  borderRadius: 8,
  padding: 10,
  fontSize: 12,
};
const retryButtonStyle: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #7f1d1d",
  background: "#fff",
  color: "#7f1d1d",
  borderRadius: 6,
  fontSize: 11,
  cursor: "pointer",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 11,
};
const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #e2e8f0",
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #f1f5f9",
  whiteSpace: "nowrap",
};
const failChipStyle: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 999,
  background: "rgba(239, 68, 68, 0.1)",
  color: "#7f1d1d",
  fontSize: 10,
  fontWeight: 600,
};
const okChipStyle: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 999,
  background: "rgba(34, 197, 94, 0.12)",
  color: "#166534",
  fontSize: 10,
  fontWeight: 600,
};
const loadMoreStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};
