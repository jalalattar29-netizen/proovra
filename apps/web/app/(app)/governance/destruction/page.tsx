"use client";

/**
 * Phase 27 — Destruction Review Queue.
 *
 * Operator approval surface for the destruction workflow. Reviewers
 * see every non-terminal review row, can step through the state
 * machine, and inspect the lifecycle timeline of the linked evidence.
 *
 * Hard rules:
 *   - Destructive actions (APPROVE / EXECUTE) require step-up. The
 *     route layer enforces this — the UI surfaces a clear note so
 *     reviewers know an MFA prompt will appear.
 *   - Decision notes are required on APPROVE / DENY / RESTORE.
 *   - The certificate hash is shown read-only on EXECUTED rows.
 *   - Privileged legal text is NEVER displayed here. The fields shown
 *     are bounded-catalog and operator-readable only.
 *
 * Tone: enterprise / SOC. No emoji. The destructive button is red but
 * understated; the state-machine flow is explicit in the action set.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

type ReviewStatus =
  | "PENDING"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "DENIED"
  | "DEFERRED"
  | "RESTORED"
  | "EXECUTED"
  | "CANCELLED";

type Review = {
  id: string;
  teamId: string;
  evidenceId: string;
  retentionPolicyId: string | null;
  retentionPolicyVersion: number | null;
  status: ReviewStatus;
  reason: "retention_expired" | "manual_review" | "policy_supersede";
  decisionNote: string | null;
  deferredUntilUtc: string | null;
  initiatedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAtUtc: string | null;
  executedAtUtc: string | null;
  certificateHash: string | null;
  createdAt: string;
  updatedAt: string;
};

type LifecycleEvent = {
  id: string;
  teamId: string;
  evidenceId: string;
  fromState: string | null;
  toState: string;
  eventType: string;
  summary: string;
  metadata: unknown;
  actorUserId: string | null;
  requestId: string | null;
  createdAt: string;
};

const STATUS_LABEL: Record<ReviewStatus, string> = {
  PENDING: "Pending",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  DENIED: "Denied",
  DEFERRED: "Deferred",
  RESTORED: "Restored",
  EXECUTED: "Executed",
  CANCELLED: "Cancelled",
};

const REASON_LABEL: Record<Review["reason"], string> = {
  retention_expired: "Retention expired",
  manual_review: "Manual review",
  policy_supersede: "Policy supersede",
};

const ALLOWED_NEXT: Record<ReviewStatus, ReviewStatus[]> = {
  PENDING: ["UNDER_REVIEW", "DEFERRED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "DENIED", "DEFERRED", "CANCELLED"],
  APPROVED: ["EXECUTED", "CANCELLED"],
  DENIED: ["RESTORED", "CANCELLED"],
  DEFERRED: ["PENDING", "CANCELLED"],
  RESTORED: [],
  EXECUTED: [],
  CANCELLED: [],
};

// Phase 38.11 — wrap in canonical PageRouteGate.
export default function DestructionQueuePage() {
  return (
    <PageRouteGate routeId="governance.destruction">
      <DestructionQueuePageInner />
    </PageRouteGate>
  );
}

function DestructionQueuePageInner() {
  const teamId = useTeamId();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ACTIVE" | "ALL" | ReviewStatus>(
    "ACTIVE",
  );
  const [timelineFor, setTimelineFor] = useState<Review | null>(null);
  const [timeline, setTimeline] = useState<LifecycleEvent[] | null>(null);

  
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const q = filter === "ALL" ? "" : `&status=${filter}`;
    apiFetch(
      `/v1/governance/destruction-reviews?teamId=${encodeURIComponent(teamId)}${q}`,
      { method: "GET" },
    )
      .then((res: { reviews: Review[] }) => {
        if (cancelled) return;
        setReviews(res.reviews);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Unable to load destruction queue.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, filter]);

  async function refresh() {
    if (!teamId) return;
    const q = filter === "ALL" ? "" : `&status=${filter}`;
    const res: { reviews: Review[] } = await apiFetch(
      `/v1/governance/destruction-reviews?teamId=${encodeURIComponent(teamId)}${q}`,
      { method: "GET" },
    );
    setReviews(res.reviews);
  }

  async function transition(review: Review, nextStatus: ReviewStatus) {
    if (!teamId) return;
    let decisionNote: string | null = null;
    if (
      nextStatus === "APPROVED" ||
      nextStatus === "DENIED" ||
      nextStatus === "RESTORED"
    ) {
      const note = window.prompt(
        `Decision note for ${nextStatus} — required for audit trail.`,
      );
      if (!note || !note.trim()) return;
      decisionNote = note.trim();
    }
    let deferredUntilUtc: string | null = null;
    if (nextStatus === "DEFERRED") {
      const until = window.prompt(
        "Defer until (ISO timestamp) — leave blank to defer indefinitely.",
      );
      if (until && until.trim()) {
        const d = new Date(until.trim());
        if (!Number.isNaN(d.getTime())) {
          deferredUntilUtc = d.toISOString();
        }
      }
    }
    const isDestructive = nextStatus === "APPROVED" || nextStatus === "EXECUTED";
    if (isDestructive) {
      const confirmed = window.confirm(
        nextStatus === "EXECUTED"
          ? "EXECUTE destruction? This is irreversible. A destruction certificate will be emitted and the evidence will move to DESTROYED. You will be asked to step-up authenticate."
          : "Approve destruction? You will be asked to step-up authenticate.",
      );
      if (!confirmed) return;
    }
    try {
      await apiFetch(
        `/v1/governance/destruction-reviews/${review.id}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            nextStatus,
            decisionNote,
            deferredUntilUtc,
          }),
        },
      );
      await refresh();
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? `Could not transition review to ${nextStatus}.`);
    }
  }

  async function viewTimeline(review: Review) {
    if (!teamId) return;
    setTimelineFor(review);
    setTimeline(null);
    try {
      const res: { events: LifecycleEvent[] } = await apiFetch(
        `/v1/governance/lifecycle/evidence/${review.evidenceId}/events?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setTimeline(res.events);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not load lifecycle timeline.");
      setTimelineFor(null);
    }
  }

  const visible = useMemo(() => reviews ?? [], [reviews]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Destruction queue</h1>
        <p style={mutedStyle}>
          Every proposed destruction lands here for reviewer approval. Holds
          and immutable retention block approval. Approval and execution
          require step-up authentication.
        </p>
      </header>

      <nav style={navStyle}>
        <Link href="/governance/lifecycle" style={navLinkStyle}>
          ← Governance operations
        </Link>
        <Link href="/governance/retention" style={navLinkStyle}>
          Retention policies →
        </Link>
      </nav>

      <div style={toolbarStyle}>
        <label style={filterLabelStyle}>
          Status
          <select
            style={selectStyle}
            value={filter}
            onChange={(e) =>
              setFilter(e.target.value as "ACTIVE" | "ALL" | ReviewStatus)
            }
          >
            <option value="ACTIVE">Active (non-terminal)</option>
            <option value="ALL">All</option>
            <option value="PENDING">Pending</option>
            <option value="UNDER_REVIEW">Under review</option>
            <option value="APPROVED">Approved</option>
            <option value="DEFERRED">Deferred</option>
            <option value="DENIED">Denied</option>
            <option value="RESTORED">Restored</option>
            <option value="EXECUTED">Executed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </label>
      </div>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view the queue.</p>
      ) : !reviews ? (
        <p style={mutedStyle}>Loading destruction queue…</p>
      ) : visible.length === 0 ? (
        <p style={mutedStyle}>No reviews match the current filter.</p>
      ) : (
        <section style={cardStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Review</th>
                <th style={thStyle}>Evidence</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Decision</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle}>
                    <div style={monoStyle}>{r.id.slice(0, 8)}…</div>
                    <div style={mutedStyle}>
                      {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={monoStyle}>{r.evidenceId.slice(0, 8)}…</div>
                    {r.retentionPolicyId ? (
                      <div style={mutedStyle}>
                        Policy {r.retentionPolicyId.slice(0, 8)}… v
                        {r.retentionPolicyVersion ?? "?"}
                      </div>
                    ) : null}
                  </td>
                  <td style={tdStyle}>{REASON_LABEL[r.reason]}</td>
                  <td style={tdStyle}>
                    <span style={statusBadgeStyle(r.status)}>
                      {STATUS_LABEL[r.status]}
                    </span>
                    {r.deferredUntilUtc ? (
                      <div style={mutedStyle}>
                        Until {new Date(r.deferredUntilUtc).toLocaleString()}
                      </div>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    {r.decisionNote ? (
                      <div style={{ fontSize: 13 }}>{r.decisionNote}</div>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                    {r.decidedAtUtc ? (
                      <div style={mutedStyle}>
                        {new Date(r.decidedAtUtc).toLocaleString()}
                      </div>
                    ) : null}
                    {r.certificateHash ? (
                      <div style={{ marginTop: 4 }}>
                        <span style={certBadgeStyle}>Certificate</span>
                        <div style={monoSmallStyle}>
                          {r.certificateHash.slice(0, 16)}…
                        </div>
                      </div>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    <div style={actionRowStyle}>
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={() => viewTimeline(r)}
                      >
                        Timeline
                      </button>
                      {ALLOWED_NEXT[r.status].map((next) => (
                        <button
                          type="button"
                          key={next}
                          style={
                            next === "EXECUTED" || next === "APPROVED"
                              ? dangerButtonStyle
                              : secondaryButtonStyle
                          }
                          onClick={() => transition(r, next)}
                          title={
                            next === "APPROVED" || next === "EXECUTED"
                              ? "Step-up authentication required"
                              : undefined
                          }
                        >
                          {STATUS_LABEL[next]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {timelineFor ? (
        <TimelineModal
          evidenceId={timelineFor.evidenceId}
          events={timeline}
          onClose={() => {
            setTimelineFor(null);
            setTimeline(null);
          }}
        />
      ) : null}
    </main>
  );
}

function TimelineModal({
  evidenceId,
  events,
  onClose,
}: {
  evidenceId: string;
  events: LifecycleEvent[] | null;
  onClose: () => void;
}) {
  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={{ ...modalStyle, maxWidth: 720 }}>
        <h3 style={sectionTitleStyle}>
          Lifecycle timeline — {evidenceId.slice(0, 8)}…
        </h3>
        <p style={{ ...mutedStyle, marginBottom: 12 }}>
          Append-only history of every lifecycle event on this evidence
          record. The orchestrator is the only writer; entries cannot be
          edited or removed.
        </p>
        {!events ? (
          <p style={mutedStyle}>Loading timeline…</p>
        ) : events.length === 0 ? (
          <p style={mutedStyle}>No lifecycle events recorded.</p>
        ) : (
          <ul style={listStyle}>
            {events.map((e) => (
              <li key={e.id} style={timelineRowStyle}>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={eventTypeBadgeStyle}>{e.eventType}</span>
                  {e.fromState && e.fromState !== e.toState ? (
                    <span style={transitionTextStyle}>
                      {e.fromState} → {e.toState}
                    </span>
                  ) : (
                    <span style={transitionTextStyle}>{e.toState}</span>
                  )}
                  <span style={mutedStyle}>
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 13, marginTop: 4 }}>{e.summary}</div>
                {e.metadata ? (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ fontSize: 12, color: "#475569" }}>
                      Metadata
                    </summary>
                    <pre style={preStyle}>
                      {JSON.stringify(e.metadata, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  marginBottom: 4,
  letterSpacing: -0.4,
};
const mutedStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 8,
};
const cardStyle: React.CSSProperties = {
  marginTop: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
  overflow: "hidden",
};
const navStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 16,
  marginBottom: 8,
  fontSize: 13,
};
const navLinkStyle: React.CSSProperties = {
  color: "#4338ca",
  fontWeight: 600,
  textDecoration: "none",
};
const toolbarStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  marginTop: 16,
  marginBottom: 12,
};
const filterLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#475569",
};
const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  background: "#f8fafc",
  borderBottom: "1px solid #e2e8f0",
  fontWeight: 600,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#475569",
};
const tdStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
};
const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontWeight: 600,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
  overflow: "auto",
};
const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 24,
  width: "100%",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
  maxHeight: "90vh",
  overflow: "auto",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "12px 0 0",
};
const timelineRowStyle: React.CSSProperties = {
  padding: "12px 0",
  borderBottom: "1px solid #f1f5f9",
};
const monoStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
};
const monoSmallStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 11,
  color: "#64748b",
  marginTop: 2,
};
const preStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  background: "#f8fafc",
  padding: 10,
  borderRadius: 6,
  border: "1px solid #e2e8f0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  marginTop: 4,
};
const eventTypeBadgeStyle: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  fontWeight: 600,
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  color: "#1e40af",
  borderRadius: 999,
};
const transitionTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#334155",
  fontWeight: 600,
};
const certBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  color: "#991b1b",
  borderRadius: 999,
};

function statusBadgeStyle(status: ReviewStatus): React.CSSProperties {
  const palette: Record<ReviewStatus, [string, string, string]> = {
    PENDING: ["#fffbeb", "#fcd34d", "#92400e"],
    UNDER_REVIEW: ["#eff6ff", "#bfdbfe", "#1e40af"],
    APPROVED: ["#fff7ed", "#fed7aa", "#9a3412"],
    DENIED: ["#f1f5f9", "#cbd5e1", "#334155"],
    DEFERRED: ["#f5f3ff", "#ddd6fe", "#5b21b6"],
    RESTORED: ["#ecfdf5", "#bbf7d0", "#166534"],
    EXECUTED: ["#fef2f2", "#fca5a5", "#991b1b"],
    CANCELLED: ["#f8fafc", "#e2e8f0", "#475569"],
  };
  const [bg, border, color] = palette[status];
  return {
    padding: "3px 10px",
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    display: "inline-block",
  };
}
