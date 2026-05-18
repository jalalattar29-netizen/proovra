"use client";

/**
 * Phase 25 — Review Workspace (single review).
 *
 * Full-page reviewer workspace surface. Loads `/workspace/:workflowId`,
 * shows lifecycle / SLA / escalation panels and the same reviewer action
 * surface as the queue inspector but in a wider layout (left =
 * lifecycle + SLA + escalation; right = actions + evidence pointer).
 *
 * Wording: operator-safe only. Never composes legal / forensic
 * overclaim phrases.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import {
  cardStyle,
  emptyStateStyle,
  errorBoxStyle,
  formatDateTime,
  formatRelative,
  ghostButtonStyle,
  headerRowStyle,
  lifecycleBadgeStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  severityBadgeStyle,
  slaBadgeStyle,
  subtitleStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

type LifecycleState =
  | "DRAFT"
  | "SUBMITTED"
  | "QUEUED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_INFORMATION"
  | "ESCALATED"
  | "APPROVED"
  | "REJECTED"
  | "ARCHIVED";

type SlaState =
  | "HEALTHY"
  | "DUE_SOON"
  | "BREACHED"
  | "ESCALATED"
  | "BLOCKED"
  | "PAUSED"
  | "COMPLETED";

type WorkspaceResponse = {
  projection: {
    workflowId: string;
    evidenceId: string;
    lifecycleState: LifecycleState;
    assignedToUserId: string | null;
    assignedAtUtc: string | null;
    priority: string;
    slaRollupState: SlaState;
    slaDimensions: Array<{
      dimension: string;
      dueAtUtc: string | null;
      state: SlaState;
    }>;
  };
  openEscalation: null | {
    id: string;
    reason: string;
    severity: string;
    status: string;
    safeSummary: string;
    createdAt: string;
    assignedToUserId: string | null;
  };
  allowedLifecycleTransitions: LifecycleState[];
};

export default function ReviewWorkspacePage() {
  const params = useParams<{ reviewId: string }>();
  const workflowId = params?.reviewId ?? "";
  const [teamId, setTeamId] = useState<string | null>(null);
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((r: { user?: { currentWorkspaceId?: string | null } }) => {
        if (!cancelled) setTeamId(r?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setTeamId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(() => {
    if (!teamId || !workflowId) return;
    apiFetch(
      `/v1/reviewer-ops/workspace/${encodeURIComponent(
        workflowId,
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: WorkspaceResponse) => {
        setData(r);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load workspace."),
      );
  }, [teamId, workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  const post = useCallback(
    async (label: string, path: string, body: Record<string, unknown>) => {
      if (!teamId) return;
      setBusy(label);
      try {
        await apiFetch(
          `/v1/reviewer-ops/reviews/${encodeURIComponent(
            workflowId,
          )}/${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, ...body }),
          },
        );
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ??
            `Action "${label}" failed.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, workflowId, load],
  );

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <p style={mutedStyle}>Switch to a workspace to use Reviewer Ops.</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main style={pageStyle}>
        {error ? <div style={errorBoxStyle}>{error}</div> : null}
        <div style={emptyStateStyle}>Loading workspace…</div>
      </main>
    );
  }

  const p = data.projection;

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={lifecycleBadgeStyle(p.lifecycleState)}>
              {p.lifecycleState.toLowerCase().replace("_", " ")}
            </span>
            <span style={slaBadgeStyle(p.slaRollupState)}>
              {p.slaRollupState.toLowerCase().replace("_", " ")}
            </span>
          </div>
          <h1 style={{ ...titleStyle, marginTop: 8 }}>Review workspace</h1>
          <p style={subtitleStyle}>
            Workflow {p.workflowId.slice(0, 12)}… · Evidence{" "}
            <a
              href={`/evidence/${p.evidenceId}`}
              style={{ color: TOKENS.link, textDecoration: "none" }}
            >
              {p.evidenceId}
            </a>
          </p>
        </div>
        <div>
          <a
            href="/reviewer-ops"
            style={{ ...ghostButtonStyle, textDecoration: "none" }}
          >
            Back to queue
          </a>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <div style={twoColStyle}>
        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>SLA dimensions</h3>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr>
                <th style={thLight}>Dimension</th>
                <th style={thLight}>State</th>
                <th style={thLight}>Due</th>
              </tr>
            </thead>
            <tbody>
              {p.slaDimensions.map((d) => (
                <tr key={d.dimension}>
                  <td style={tdLight}>
                    {d.dimension.toLowerCase().replace("_", " ")}
                  </td>
                  <td style={tdLight}>
                    <span style={slaBadgeStyle(d.state)}>
                      {d.state.toLowerCase().replace("_", " ")}
                    </span>
                  </td>
                  <td style={tdLight}>
                    <span style={mutedStyle}>
                      {formatRelative(d.dueAtUtc)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={sectionTitleStyle}>Assignment</h3>
          <div style={{ fontSize: 13 }}>
            <KV
              k="Assigned to"
              v={
                p.assignedToUserId
                  ? p.assignedToUserId.slice(0, 12) + "…"
                  : "Unassigned"
              }
            />
            <KV k="Assigned at" v={formatDateTime(p.assignedAtUtc)} />
            <KV k="Priority" v={p.priority} />
          </div>

          {data.openEscalation ? (
            <>
              <h3 style={sectionTitleStyle}>Open escalation</h3>
              <div
                style={{
                  border: "1px solid #fecaca",
                  background: "#fef2f2",
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 13,
                  color: "#7f1d1d",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span style={severityBadgeStyle(data.openEscalation.severity)}>
                    {data.openEscalation.severity}
                  </span>
                  <span style={mutedStyle}>
                    {data.openEscalation.reason}
                  </span>
                  <span style={{ marginLeft: "auto", ...mutedStyle }}>
                    {formatDateTime(data.openEscalation.createdAt)}
                  </span>
                </div>
                <div>{data.openEscalation.safeSummary}</div>
              </div>
            </>
          ) : null}
        </section>

        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>Allowed lifecycle transitions</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.allowedLifecycleTransitions.map((s) => (
              <span key={s} style={lifecycleBadgeStyle(s)}>
                {s.toLowerCase().replace("_", " ")}
              </span>
            ))}
            {data.allowedLifecycleTransitions.length === 0 ? (
              <span style={mutedStyle}>Terminal state</span>
            ) : null}
          </div>

          <h3 style={sectionTitleStyle}>Reviewer actions</h3>
          <div style={actionGridStyle}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== null || p.lifecycleState !== "ASSIGNED"}
              onClick={() => post("start", "start", {})}
            >
              Start review
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={
                busy !== null ||
                !["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"].includes(
                  p.lifecycleState,
                )
              }
              onClick={async () => {
                const n = window.prompt("Note (required)");
                if (!n) return;
                post("request-info", "request-info", { note: n });
              }}
            >
              Request info
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={
                busy !== null ||
                !["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"].includes(
                  p.lifecycleState,
                )
              }
              onClick={() => post("approve", "approve", {})}
            >
              Approve
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={
                busy !== null ||
                !["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"].includes(
                  p.lifecycleState,
                )
              }
              onClick={async () => {
                const n = window.prompt("Rejection note (required)");
                if (!n) return;
                post("reject", "reject", { note: n });
              }}
            >
              Reject
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={busy !== null}
              onClick={async () => {
                const r = window.prompt("Pause reason (required)");
                if (!r) return;
                post("pause", "pause", { pausedReason: r });
              }}
            >
              Pause
            </button>
            <a
              href="/reviewer-ops/escalations"
              style={{
                ...ghostButtonStyle,
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              Escalation log
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "2px 0",
      }}
    >
      <span style={mutedStyle}>{k}</span>
      <span>{v}</span>
    </div>
  );
}

const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
  marginTop: 16,
  alignItems: "flex-start",
};

const thLight: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  color: TOKENS.inkMuted,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  padding: "6px 0",
  borderBottom: `1px solid ${TOKENS.border}`,
};

const tdLight: React.CSSProperties = {
  padding: "6px 0",
  borderBottom: `1px solid ${TOKENS.divider}`,
  fontSize: 12,
};

const actionGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 6,
  marginTop: 8,
};
