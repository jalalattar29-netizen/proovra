"use client";

/**
 * Phase 25 — Escalation Console.
 *
 * Operator surface for the escalation lifecycle:
 *   - Filter by status / severity / reason
 *   - Acknowledge / reassign / resolve / suppress
 *   - Link back to the workflow workspace
 *   - Optional link to the Phase 21 operational incident
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useActiveWorkspaceId } from "../../../../lib/useActiveWorkspaceId";
import { WorkspaceGateState } from "../WorkspaceGateState";
import {
  NoEscalationsEmptyState,
  RuntimeStatusBanner,
} from "../../../../components/operational";
import {
  cardStyle,
  emptyStateStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  selectStyle,
  severityBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

type EscalationStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "REASSIGNED"
  | "RESOLVED"
  | "SUPPRESSED";

type EscalationProjection = {
  id: string;
  teamId: string;
  workflowId: string;
  evidenceId: string | null;
  reason: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: EscalationStatus;
  safeSummary: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAtUtc: string | null;
  resolvedAtUtc: string | null;
  resolutionNote: string | null;
  suppressedAtUtc: string | null;
  suppressionReason: string | null;
  assignedToUserId: string | null;
  incidentId: string | null;
};

const STATUS_FILTERS: (EscalationStatus | "ALL")[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "REASSIGNED",
  "RESOLVED",
  "SUPPRESSED",
  "ALL",
];

const SEVERITY_FILTERS = ["", "INFO", "WARNING", "HIGH", "CRITICAL"];

export default function EscalationsConsolePage() {
  // Hotfix — canonical workspace resolution.
  const workspaceState = useActiveWorkspaceId();
  const teamId =
    workspaceState.status === "ready" ? workspaceState.workspaceId : null;
  const [rows, setRows] = useState<EscalationProjection[] | null>(null);
  const [status, setStatus] = useState<EscalationStatus | "ALL">("OPEN");
  const [severity, setSeverity] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!teamId) return;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    qs.set("status", status);
    if (severity) qs.set("severity", severity);
    qs.set("limit", "100");
    apiFetch(`/v1/reviewer-ops/escalations?${qs.toString()}`, {
      method: "GET",
    })
      .then((r: { escalations: EscalationProjection[] }) => {
        setRows(r.escalations ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load escalations."),
      );
  }, [teamId, status, severity]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (
      label: string,
      id: string,
      path: string,
      body: Record<string, unknown>,
    ) => {
      if (!teamId) return;
      setBusy(`${id}:${label}`);
      try {
        await apiFetch(
          `/v1/reviewer-ops/escalations/${encodeURIComponent(id)}/${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, ...body }),
          },
        );
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? `Action "${label}" failed.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  if (workspaceState.status !== "ready") {
    return (
      <WorkspaceGateState state={workspaceState} surface="Escalations" />
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Escalation Console</h1>
          <p style={subtitleStyle}>
            Operator escalation lifecycle. Open / acknowledged / reassigned
            escalations affect workspace SLA pressure; resolved /
            suppressed escalations remain in history.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as EscalationStatus | "ALL")
            }
            style={selectStyle}
            aria-label="Status filter"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            style={selectStyle}
            aria-label="Severity filter"
          >
            {SEVERITY_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s || "All severities"}
              </option>
            ))}
          </select>
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={load}
            disabled={busy !== null}
          >
            Refresh
          </button>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {teamId ? <RuntimeStatusBanner teamId={teamId} /> : null}

      <section style={{ ...cardStyle, marginTop: 16, padding: 0 }}>
        {rows === null ? (
          <div style={emptyStateStyle}>Loading…</div>
        ) : rows.length === 0 ? (
          // Phase 28-G — actionable enterprise empty state.
          // Replaces the previous static "No escalations match these
          // filters." line so the operator sees WHY the page is empty
          // (no overdue reviews, reconcile not yet run, etc.) and
          // what they can do next (check SLA policy, run seed, etc.).
          <div style={{ padding: 20 }}>
            <NoEscalationsEmptyState />
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Summary</th>
                <th style={thStyle}>Workflow</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td style={tdStyle}>
                    <span style={severityBadgeStyle(e.severity)}>
                      {e.severity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ ...mutedStyle, fontSize: 12 }}>
                      {e.reason}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={statusChipStyle(e.status)}>{e.status}</span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ maxWidth: 360, fontSize: 12 }}>
                      {e.safeSummary}
                    </div>
                    {e.incidentId ? (
                      <a
                        href={`/ops`}
                        style={{ ...mutedStyle, color: TOKENS.link }}
                      >
                        incident {e.incidentId.slice(0, 8)}…
                      </a>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    <a
                      href={`/reviewer-ops/${encodeURIComponent(e.workflowId)}`}
                      style={{
                        color: TOKENS.link,
                        textDecoration: "none",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        fontSize: 12,
                      }}
                    >
                      {e.workflowId.slice(0, 8)}…
                    </a>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>{formatDateTime(e.createdAt)}</span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {e.status === "OPEN" ? (
                        <button
                          type="button"
                          style={smallButton}
                          disabled={busy !== null}
                          onClick={() =>
                            act("ack", e.id, "acknowledge", {})
                          }
                        >
                          Acknowledge
                        </button>
                      ) : null}
                      {!["RESOLVED", "SUPPRESSED"].includes(e.status) ? (
                        <>
                          <button
                            type="button"
                            style={smallButton}
                            disabled={busy !== null}
                            onClick={async () => {
                              const u = window.prompt("New assignee user id");
                              if (!u) return;
                              act("reassign", e.id, "reassign", {
                                newAssigneeUserId: u,
                              });
                            }}
                          >
                            Reassign
                          </button>
                          <button
                            type="button"
                            style={smallButton}
                            disabled={busy !== null}
                            onClick={async () => {
                              const n = window.prompt(
                                "Resolution note (required)",
                              );
                              if (!n) return;
                              act("resolve", e.id, "resolve", {
                                resolutionNote: n,
                              });
                            }}
                          >
                            Resolve
                          </button>
                          <button
                            type="button"
                            style={smallButton}
                            disabled={busy !== null}
                            onClick={async () => {
                              const n = window.prompt(
                                "Suppression reason (required)",
                              );
                              if (!n) return;
                              act("suppress", e.id, "suppress", {
                                suppressionReason: n,
                              });
                            }}
                          >
                            Suppress
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function statusChipStyle(status: EscalationStatus): React.CSSProperties {
  const palette: Record<
    EscalationStatus,
    { bg: string; fg: string; border: string }
  > = {
    OPEN: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    ACKNOWLEDGED: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    REASSIGNED: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
    RESOLVED: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    SUPPRESSED: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  };
  const p = palette[status];
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
}

const smallButton: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 11,
  fontWeight: 500,
  background: TOKENS.surface,
  color: TOKENS.ink,
  border: `1px solid ${TOKENS.borderStrong}`,
  borderRadius: 4,
  cursor: "pointer",
};
