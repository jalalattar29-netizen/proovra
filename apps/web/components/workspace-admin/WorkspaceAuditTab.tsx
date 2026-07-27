"use client";

/**
 * PHASE 11 §6 — the REAL authorized workspace-admin audit surface.
 *
 * Consumes GET /v1/audit/tenant — the ONE canonical tenant-audit query/export
 * authority (authorize-before-query, DB-level workspace column filter,
 * deterministic UTC cursor pagination). This component renders the SERVER
 * projection verbatim:
 *
 *   - NO client-side tenant filtering (the rows arrive already scope-pinned);
 *   - filters (action/outcome/time) are sent to the server, never applied
 *     in memory;
 *   - Export uses the EXACT same endpoint + authorization with export=true —
 *     there is no second export policy;
 *   - a 403/404 renders one generic denial (no existence/scope leak).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

type AuditRow = {
  eventId: string;
  occurredAtUtc: string;
  action: string;
  outcome: string | null;
  actorUserId: string | null;
  workspaceId: unknown;
  resourceType: string | null;
  resourceId: string | null;
};

type AuditPage = { items: AuditRow[]; nextCursorId: string | null };

type OutcomeFilter = "" | "success" | "denied" | "error";

export function WorkspaceAuditTab({ teamId }: { teamId: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeFilter>("");
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query = useCallback(
    (cursor: string | null, forExport: boolean) => {
      const p = new URLSearchParams({ teamId });
      if (action.trim()) p.set("action", action.trim());
      if (outcome) p.set("outcome", outcome);
      if (cursor) p.set("cursorId", cursor);
      if (forExport) p.set("export", "true");
      return `/v1/audit/tenant?${p.toString()}`;
    },
    [teamId, action, outcome],
  );

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        // The server authorizes (audit.read on the PROVEN workspace) BEFORE it
        // queries; rows are DB-filtered on the authoritative workspace column.
        const page = (await apiFetch(query(cursor, false))) as AuditPage;
        setRows((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursorId);
      } catch (err) {
        // Generic denial — never distinguishes "no such workspace" from
        // "not yours" from "no capability" (anti-enumeration preserved).
        setRows([]);
        setNextCursor(null);
        setError(toSafeUserError(err, { message: "Audit history is not available." }).message);
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const exportAudit = useCallback(async () => {
    try {
      // SAME endpoint, SAME authorization, SAME query — export=true only.
      const page = (await apiFetch(query(null, true))) as AuditPage;
      const blob = new Blob([JSON.stringify(page.items, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workspace-audit-${teamId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(toSafeUserError(err, { message: "Audit export is not available." }).message);
    }
  }, [query, teamId]);

  const hasRows = rows.length > 0;
  const emptyLabel = useMemo(
    () => (loading ? "Loading audit history…" : "No audit events for the current filters."),
    [loading],
  );

  return (
    <section className="cc-section" data-tab-body="audit" data-workspace-audit>
      <header className="cc-section-header">
        <h2 className="cc-section-title">Audit history</h2>
        <p className="cc-section-sub">
          Every event is recorded against this workspace with a tamper-evident
          integrity chain. Filters run on the server.
        </p>
      </header>

      <div className="cc-toolbar" data-workspace-audit-filters>
        <input
          type="text"
          value={action}
          placeholder="Filter by action (exact)"
          aria-label="Filter by action"
          onChange={(e) => setAction(e.target.value)}
          className="cc-input"
        />
        <select
          value={outcome}
          aria-label="Filter by outcome"
          onChange={(e) => setOutcome(e.target.value as OutcomeFilter)}
          className="cc-input"
        >
          <option value="">Any outcome</option>
          <option value="success">Success</option>
          <option value="denied">Denied</option>
          <option value="error">Error</option>
        </select>
        <button
          type="button"
          onClick={() => void exportAudit()}
          data-workspace-audit-export
          className="cc-button"
        >
          Export
        </button>
      </div>

      {error ? (
        <p role="status" data-workspace-audit-denied className="cc-empty">
          {error}
        </p>
      ) : !hasRows ? (
        <p className="cc-empty" aria-live="polite">
          {emptyLabel}
        </p>
      ) : (
        <table className="cc-table" data-workspace-audit-rows>
          <thead>
            <tr>
              <th scope="col">When (UTC)</th>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col">Resource</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.eventId} data-audit-event-id={r.eventId}>
                <td>{r.occurredAtUtc}</td>
                <td>{r.action}</td>
                <td data-audit-outcome={r.outcome ?? ""}>{r.outcome ?? "—"}</td>
                <td>
                  {r.resourceType ? `${r.resourceType}:${r.resourceId ?? ""}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {nextCursor ? (
        <button
          type="button"
          onClick={() => void load(nextCursor)}
          disabled={loading}
          data-workspace-audit-more
          className="cc-button"
        >
          Load more
        </button>
      ) : null}
    </section>
  );
}
