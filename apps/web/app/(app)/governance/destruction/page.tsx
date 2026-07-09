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

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalBreadcrumb } from "../../../../components/navigation/OperationalBreadcrumb";
import { DestructionImpactPreview } from "../../../../components/governance/DestructionImpactPreview";
import { DestructionCertificate } from "../../../../components/governance/DestructionCertificate";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { StatusBadge } from "../../../../components/ui/StatusBadge";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";

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
  // Phase F — operator-facing impact preview + destruction certificate
  // modals. Both surfaces are read-only and route through the new
  // governance endpoints.
  const [previewFor, setPreviewFor] = useState<Review | null>(null);
  const [certificateFor, setCertificateFor] = useState<Review | null>(null);
  const { confirm } = useConfirmAction();

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
        setError(toSafeUserError(err, { message: "Unable to load destruction queue." }).message);
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
      const confirmed = await confirm(
        nextStatus === "EXECUTED"
          ? {
              title: "Execute destruction?",
              description:
                "This is irreversible. A destruction certificate will be emitted and the evidence will move to DESTROYED. Step-up authentication is required on the next request.",
              confirmLabel: "Execute destruction",
              tone: "danger",
              requireConfirmText: "EXECUTE",
              testId: "destruction-execute",
            }
          : {
              title: "Approve destruction?",
              description:
                "Approval queues the evidence for destruction execution. Step-up authentication is required on the next request.",
              confirmLabel: "Approve",
              tone: "warning",
              testId: "destruction-approve",
            },
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
      alert(toSafeUserError(e, { message: `Could not transition review to ${nextStatus}.` }).message);
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
      alert(toSafeUserError(e, { message: "Could not load lifecycle timeline." }).message);
      setTimelineFor(null);
    }
  }

  const visible = useMemo(() => reviews ?? [], [reviews]);

  const columns: DataTableColumn<Review>[] = [
    {
      key: "review",
      header: "Review",
      render: (r) => (
        <div>
          <div style={monoStyle}>{r.id.slice(0, 8)}…</div>
          <div style={mutedStyle}>{formatUserDateTime(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: "evidence",
      header: "Evidence",
      render: (r) => (
        <div>
          <div style={monoStyle}>{r.evidenceId.slice(0, 8)}…</div>
          {r.retentionPolicyId ? (
            <div style={mutedStyle}>
              Policy {r.retentionPolicyId.slice(0, 8)}… v
              {r.retentionPolicyVersion ?? "?"}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      render: (r) => REASON_LABEL[r.reason],
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <div>
          <StatusBadge status={r.status} />
          {r.deferredUntilUtc ? (
            <div style={mutedStyle}>
              Until {formatUserDateTime(r.deferredUntilUtc)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "decision",
      header: "Decision",
      render: (r) => (
        <div>
          {r.decisionNote ? (
            <div style={{ fontSize: 13 }}>{r.decisionNote}</div>
          ) : (
            <span style={mutedStyle}>—</span>
          )}
          {r.decidedAtUtc ? (
            <div style={mutedStyle}>{formatUserDateTime(r.decidedAtUtc)}</div>
          ) : null}
          {r.certificateHash ? (
            <div style={{ marginTop: 4 }}>
              <Badge tone="risk" subtle>
                Certificate
              </Badge>
              <div style={monoSmallStyle}>
                {r.certificateHash.slice(0, 16)}…
              </div>
            </div>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Governance"
          title="Destruction queue"
          subtitle="Every proposed destruction lands here for reviewer approval. Holds and immutable retention block approval. Approval and execution require step-up authentication."
          contextStrip={
            <OperationalBreadcrumb
              routeId="governance.destruction"
              items={[
                { label: "Governance", href: "/governance" },
                { label: "Destruction queue" },
              ]}
            />
          }
        />
      }
    >
      <nav style={navStyle}>
        <Link href="/governance/lifecycle" style={navLinkStyle}>
          ← Governance operations
        </Link>
        <Link href="/governance/retention" style={navLinkStyle}>
          Retention policies →
        </Link>
      </nav>

      <PageSection
        title="Review queue"
        action={
          <FilterBar>
            <FilterBar.Select
              label="Status"
              showLabel
              value={filter}
              onChange={(v) =>
                setFilter(v as "ACTIVE" | "ALL" | ReviewStatus)
              }
              options={[
                { value: "ACTIVE", label: "Active (non-terminal)" },
                { value: "ALL", label: "All" },
                { value: "PENDING", label: "Pending" },
                { value: "UNDER_REVIEW", label: "Under review" },
                { value: "APPROVED", label: "Approved" },
                { value: "DEFERRED", label: "Deferred" },
                { value: "DENIED", label: "Denied" },
                { value: "RESTORED", label: "Restored" },
                { value: "EXECUTED", label: "Executed" },
                { value: "CANCELLED", label: "Cancelled" },
              ]}
            />
          </FilterBar>
        }
      >
        {error ? <div style={errorBoxStyle}>{error}</div> : null}

        {!teamId ? (
          <EmptyState
            framed
            title="No workspace selected"
            purpose="Switch to an organization workspace to view its destruction review queue."
          />
        ) : (
          <DataTable
            ariaLabel="Destruction review queue"
            columns={columns}
            rows={visible}
            getRowId={(r) => r.id}
            loading={!reviews}
            rowActions={(r) => (
              <div style={actionRowStyle}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => viewTimeline(r)}
                >
                  Timeline
                </Button>
                {/* Phase F — operational impact preview. Shows
                    consequences before destructive transitions. */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPreviewFor(r)}
                  data-action="preview-impact"
                >
                  Impact
                </Button>
                {/* Phase F — destruction certificate viewer.
                    Only available for EXECUTED reviews. */}
                {r.status === "EXECUTED" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setCertificateFor(r)}
                    data-action="view-certificate"
                  >
                    Certificate
                  </Button>
                ) : null}
                {ALLOWED_NEXT[r.status].map((next) => (
                  <Button
                    key={next}
                    variant={
                      next === "EXECUTED" || next === "APPROVED"
                        ? "destructive"
                        : "secondary"
                    }
                    size="sm"
                    onClick={() => transition(r, next)}
                    title={
                      next === "APPROVED" || next === "EXECUTED"
                        ? "Step-up authentication required"
                        : undefined
                    }
                  >
                    {STATUS_LABEL[next]}
                  </Button>
                ))}
              </div>
            )}
            emptyState={
              <EmptyState
                title="No destruction requests pending"
                purpose="No reviews match the current filter. Proposed destructions awaiting reviewer approval will appear here."
              />
            }
          />
        )}
      </PageSection>

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

      {/* Phase F — destruction impact preview modal. */}
      {previewFor ? (
        <div style={modalBackdropStyle} role="dialog" aria-modal>
          <div style={{ ...modalStyle, maxWidth: 820 }}>
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18 }}>Destruction impact</h2>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => setPreviewFor(null)}
              >
                Close
              </button>
            </header>
            <DestructionImpactPreview
              reviewId={previewFor.id}
              teamId={teamId ?? null}
            />
          </div>
        </div>
      ) : null}

      {/* Phase F — destruction certificate modal. */}
      {certificateFor ? (
        <div style={modalBackdropStyle} role="dialog" aria-modal>
          <div style={{ ...modalStyle, maxWidth: 820 }}>
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18 }}>
                Destruction certificate
              </h2>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => setCertificateFor(null)}
              >
                Close
              </button>
            </header>
            <DestructionCertificate
              reviewId={certificateFor.id}
              teamId={teamId ?? null}
            />
          </div>
        </div>
      ) : null}
    </PageShell>
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
                    {formatUserDateTime(e.createdAt)}
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

const mutedStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 8,
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
