"use client";

/**
 * Phase 23 — Workflow instance detail page.
 *
 * Workspace-internal operator view of a single Phase 22 workflow
 * instance:
 *   - status badge + lifecycle metadata
 *   - step checklist (with reviewer-only private notes when permitted
 *     by the backend projection)
 *   - mapped evidence summary
 *   - export-policy summary (operator-readable blockers)
 *   - safe activity timeline
 *   - reviewer actions: submit / assign / approve / request changes /
 *     waive / cancel
 *
 * Wording invariant: operational only. We say "review approved",
 * "workflow approved", "step satisfied", "step waived". See the
 * Phase 22/23 forbidden-overclaim catalog in docs/runbooks/README.md
 * — this file MUST avoid every entry in that list.
 *
 * Hard invariants:
 *   - Frontend state is advisory. The backend engine is the source of
 *     truth; every action POSTs and re-loads on success.
 *   - Step-up errors (`STEP_UP_REQUIRED`) surface as a clear prompt;
 *     the OTP value NEVER lives in component state beyond the form
 *     submit and is never sent to any logger.
 *   - Governance errors (`WORKFLOW_GOVERNANCE_BLOCKED`,
 *     `WORKFLOW_LEGAL_HOLD_ACTIVE`) render with the operational
 *     reason; details (legal-hold reason text) are NEVER fetched or
 *     displayed here.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

type InstanceStatus =
  | "DRAFT"
  | "ACTIVE"
  | "SUBMITTED"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "REPORT_READY"
  | "PACKAGE_READY"
  | "SHARED_EXTERNALLY"
  | "ARCHIVED"
  | "RETAINED"
  | "LEGAL_HOLD"
  | "CANCELLED"
  | "CHANGES_REQUESTED";

type StepStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "SATISFIED"
  | "NEEDS_ATTENTION"
  | "WAIVED"
  | "FAILED";

type Instance = {
  id: string;
  teamId: string;
  status: InstanceStatus;
  intakeMode: string;
  actorRole: string;
  templateSlug: string | null;
  templateVersion: number | null;
  title: string | null;
  assignedReviewerUserId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAtUtc: string | null;
  approvedAtUtc: string | null;
  closedAtUtc: string | null;
};

type Step = {
  id: string;
  stepKey: string;
  title: string;
  required: boolean;
  orderIndex: number;
  status: StepStatus;
  mappedEvidenceId: string | null;
  completedAtUtc: string | null;
  waiverReason: string | null;
  // Present only when the backend returns the reviewer projection.
  privateReviewerNote?: string | null;
};

type MappedEvidence = {
  evidenceId: string;
  stepInstanceId: string | null;
  mappedAtUtc: string;
};

type TimelineEvent = {
  id: string;
  occurredAtUtc: string;
  kind: string;
  actorType: "system" | "user" | "service_account" | "contributor";
  actorUserId: string | null;
  summary: string;
};

type ExportSummary = {
  instanceId: string;
  status: InstanceStatus;
  canExportToReport: boolean;
  canExportToVerificationPackage: boolean;
  canShareToPublicVerify: boolean;
  canDownloadOriginal: boolean;
  blockers: string[];
};

// Phase 38.13 — wrap in canonical PageRouteGate inheriting from parent
// `workspace.workflows` route.
export default function WorkflowInstancePage() {
  return (
    <PageRouteGate routeId="workspace.workflows">
      <WorkflowInstancePageInner />
    </PageRouteGate>
  );
}

function WorkflowInstancePageInner() {
  const teamId = useTeamId();
  const params = useParams<{ id: string }>();
  const instanceId = params?.id ?? "";
  const [instance, setInstance] = useState<Instance | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [mapped, setMapped] = useState<MappedEvidence[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [exportSummary, setExportSummary] = useState<ExportSummary | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  
  async function refresh() {
    if (!teamId || !instanceId) return;
    const qs = `?teamId=${encodeURIComponent(teamId)}`;
    try {
      const [detail, tl, summary] = (await Promise.all([
        apiFetch(`/v1/workflows/instances/${instanceId}${qs}`, { method: "GET" }),
        apiFetch(
          `/v1/workflows/instances/${instanceId}/timeline${qs}`,
          { method: "GET" },
        ).catch(() => ({ events: [] })),
        apiFetch(
          `/v1/workflows/instances/${instanceId}/export-policy${qs}`,
          { method: "GET" },
        ).catch(() => null),
      ])) as [
        {
          instance: Instance;
          steps: Step[];
          mappedEvidence: MappedEvidence[];
        },
        { events: TimelineEvent[] },
        { summary: ExportSummary } | null,
      ];
      setInstance(detail.instance);
      setSteps(detail.steps);
      setMapped(detail.mappedEvidence);
      setTimeline(tl.events ?? []);
      setExportSummary(summary?.summary ?? null);
      setError(null);
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Could not load workflow.");
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, instanceId]);

  /**
   * Perform a sensitive action against the workflow engine. Handles
   * STEP_UP_REQUIRED, WORKFLOW_GOVERNANCE_BLOCKED, and the other
   * Phase 22 codes. Re-fetches on success.
   */
  async function performAction(
    path: string,
    body: Record<string, unknown>,
    confirmMessage?: string,
  ) {
    if (!teamId) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusy(true);
    try {
      const res: { error?: { code?: string; reason?: string } } = await apiFetch(
        `/v1/workflows/instances/${instanceId}${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, ...body }),
        },
      );
      if (res.error) {
        handleEngineError(res.error.code ?? "", res.error.reason ?? null);
        return;
      }
      await refresh();
    } catch (err) {
      const e = err as { status?: number; body?: { error?: { code?: string; reason?: string } } };
      if (e.body?.error?.code) {
        handleEngineError(e.body.error.code, e.body.error.reason ?? null);
      } else {
        alert((err as { message?: string })?.message ?? "Action failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  function handleEngineError(code: string, _reason: string | null): void {
    if (code === "STEP_UP_REQUIRED") {
      alert(
        "Step-up verification is required for this action. Open the security center to start a step-up challenge, then retry from here.",
      );
      return;
    }
    if (code === "WORKFLOW_GOVERNANCE_BLOCKED" || code === "WORKFLOW_LEGAL_HOLD_ACTIVE") {
      alert(
        "This action is blocked by workspace governance. Contact a workspace administrator.",
      );
      return;
    }
    if (code === "WORKFLOW_STEP_REQUIRED") {
      alert(
        "One or more required steps are not yet satisfied. Map evidence to each required step before submitting.",
      );
      return;
    }
    if (code === "WORKFLOW_INVALID_TRANSITION") {
      alert("Action not allowed from the current workflow state.");
      return;
    }
    if (code === "WORKFLOW_ACTOR_NOT_PERMITTED") {
      alert("You do not have permission to perform this action on this workflow.");
      return;
    }
    alert(`Action could not complete (${code}).`);
  }

  const counts = useMemo(() => {
    if (steps.length === 0) return null;
    let req = 0;
    let reqSatisfied = 0;
    let waived = 0;
    for (const s of steps) {
      if (s.required) {
        req += 1;
        if (s.status === "SATISFIED" || s.status === "WAIVED") reqSatisfied += 1;
      }
      if (s.status === "WAIVED") waived += 1;
    }
    return { req, reqSatisfied, waived, total: steps.length };
  }, [steps]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Workflow</h1>
        <p style={mutedStyle}>
          Operational workflow detail. Frontend reflects the backend
          engine state; every action is validated server-side and
          audited. Wording is operational only.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view workflows.</p>
      ) : !instance ? (
        <p style={mutedStyle}>Loading…</p>
      ) : (
        <>
          {/* Header card — status + identity */}
          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>
                  {instance.title ?? "Untitled workflow"}
                </div>
                <div style={mutedStyle}>
                  template {instance.templateSlug ?? "—"}{" "}
                  {instance.templateVersion ? `v${instance.templateVersion}` : ""}{" "}
                  · intake {instance.intakeMode} · actor {instance.actorRole}
                </div>
                <div style={mutedStyle}>
                  created{" "}
                  {new Date(instance.createdAt).toLocaleString()}
                  {instance.submittedAtUtc
                    ? ` · submitted ${new Date(instance.submittedAtUtc).toLocaleString()}`
                    : ""}
                  {instance.approvedAtUtc
                    ? ` · approved ${new Date(instance.approvedAtUtc).toLocaleString()}`
                    : ""}
                </div>
              </div>
              <span style={statusBadgeStyle(instance.status)}>
                {instance.status}
              </span>
            </div>
            {counts ? (
              <div style={mutedStyle}>
                {counts.reqSatisfied}/{counts.req} required steps satisfied
                {counts.waived ? ` · ${counts.waived} waived` : ""} ·{" "}
                {counts.total} total
              </div>
            ) : null}
          </section>

          {/* Export policy summary */}
          {exportSummary ? (
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Export policy</h2>
              <div style={healthGridStyle}>
                <Stat
                  label="Report"
                  value={exportSummary.canExportToReport ? "allowed" : "blocked"}
                />
                <Stat
                  label="Package"
                  value={
                    exportSummary.canExportToVerificationPackage
                      ? "allowed"
                      : "blocked"
                  }
                />
                <Stat
                  label="Public verify"
                  value={exportSummary.canShareToPublicVerify ? "allowed" : "blocked"}
                />
                <Stat
                  label="Original download"
                  value={
                    exportSummary.canDownloadOriginal ? "allowed" : "blocked"
                  }
                />
              </div>
              {exportSummary.blockers.length > 0 ? (
                <ul style={blockerListStyle}>
                  {exportSummary.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {/* Reviewer / operator actions */}
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Actions</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy || instance.status !== "ACTIVE"}
                onClick={() =>
                  void performAction(
                    "/submit",
                    {},
                    "Submit this workflow for review?",
                  )
                }
              >
                Submit
              </button>
              <button
                type="button"
                style={secondaryButtonStyle}
                disabled={
                  busy ||
                  (instance.status !== "SUBMITTED" &&
                    instance.status !== "NEEDS_REVIEW")
                }
                onClick={() => {
                  const reviewer = window.prompt(
                    "Reviewer user id (UUID, must be a workspace member)",
                  );
                  if (!reviewer || !reviewer.trim()) return;
                  void performAction("/assign-reviewer", {
                    reviewerUserId: reviewer.trim(),
                  });
                }}
              >
                Assign reviewer
              </button>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy || instance.status !== "NEEDS_REVIEW"}
                onClick={() =>
                  void performAction(
                    "/approve",
                    {},
                    "Approve this workflow? This is operator-recorded and audited.",
                  )
                }
              >
                Approve
              </button>
              <button
                type="button"
                style={secondaryButtonStyle}
                disabled={
                  busy ||
                  (instance.status !== "SUBMITTED" &&
                    instance.status !== "NEEDS_REVIEW")
                }
                onClick={() =>
                  void performAction(
                    "/request-changes",
                    {},
                    "Send this workflow back for changes?",
                  )
                }
              >
                Request changes
              </button>
              <button
                type="button"
                style={dangerButtonStyle}
                disabled={busy}
                onClick={() =>
                  void performAction(
                    "/cancel",
                    {},
                    "Cancel this workflow? Cancellation after submission requires step-up verification.",
                  )
                }
              >
                Cancel
              </button>
            </div>
          </section>

          {/* Step checklist */}
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Steps</h2>
            {steps.length === 0 ? (
              <p style={mutedStyle}>No steps recorded.</p>
            ) : (
              <ul style={listStyle}>
                {steps.map((s) => (
                  <li key={s.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {s.title}{" "}
                        {s.required ? (
                          <span style={chipStyle}>required</span>
                        ) : null}
                      </div>
                      <div style={mutedStyle}>
                        step key {s.stepKey}
                        {s.mappedEvidenceId
                          ? ` · mapped evidence ${s.mappedEvidenceId.slice(0, 8)}…`
                          : ""}
                        {s.completedAtUtc
                          ? ` · completed ${new Date(s.completedAtUtc).toLocaleString()}`
                          : ""}
                      </div>
                      {s.waiverReason ? (
                        <div style={mutedStyle}>
                          waiver: {s.waiverReason}
                        </div>
                      ) : null}
                      {/* The privateReviewerNote is present in the
                          payload ONLY when the backend returns the
                          reviewer projection. Render only when present
                          and mark it operator-visible-only. */}
                      {s.privateReviewerNote ? (
                        <div style={privateNoteStyle}>
                          <strong>Reviewer-only:</strong> {s.privateReviewerNote}
                        </div>
                      ) : null}
                    </div>
                    <span style={stepStatusBadgeStyle(s.status)}>{s.status}</span>
                    {s.status !== "SATISFIED" &&
                    s.status !== "WAIVED" &&
                    s.required ? (
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt(
                            "Reason for waiving this required step (operator-visible only)",
                          );
                          if (!reason || !reason.trim()) return;
                          void performAction(
                            `/steps/${encodeURIComponent(s.stepKey)}/waive`,
                            { reason: reason.trim() },
                          );
                        }}
                      >
                        Waive
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Mapped evidence */}
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Mapped evidence</h2>
            {mapped.length === 0 ? (
              <p style={mutedStyle}>No evidence is mapped to this workflow yet.</p>
            ) : (
              <ul style={listStyle}>
                {mapped.map((m) => (
                  <li key={`${m.evidenceId}:${m.stepInstanceId ?? "_"}`} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        evidence {m.evidenceId.slice(0, 8)}…
                      </div>
                      <div style={mutedStyle}>
                        mapped {new Date(m.mappedAtUtc).toLocaleString()}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Timeline */}
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Activity</h2>
            {timeline.length === 0 ? (
              <p style={mutedStyle}>No activity recorded.</p>
            ) : (
              <ul style={listStyle}>
                {timeline.map((e) => (
                  <li key={e.id} style={timelineRowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{e.summary}</div>
                      <div style={mutedStyle}>
                        actor {e.actorType}
                        {e.actorUserId ? ` (${e.actorUserId.slice(0, 8)}…)` : ""}
                        {" · "}
                        {new Date(e.occurredAtUtc).toLocaleString()}
                      </div>
                    </div>
                    <span style={timelineKindBadge}>{e.kind}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};
const healthGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
  marginBottom: 12,
};
const statStyle: React.CSSProperties = {
  padding: 10,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const timelineRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 4px",
  borderBottom: "1px solid #f1f5f9",
};
const chipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#fef3c7",
  color: "#92400e",
  border: "1px solid #fcd34d",
  marginLeft: 6,
};
const timelineKindBadge: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
};
const blockerListStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 16px",
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 8,
  color: "#92400e",
  fontSize: 12,
};
const privateNoteStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "6px 8px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  fontSize: 12,
  color: "#7f1d1d",
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
const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontWeight: 500,
  color: "#7f1d1d",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

function statusBadgeStyle(status: InstanceStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (status === "APPROVED" || status === "REPORT_READY" || status === "PACKAGE_READY" || status === "SHARED_EXTERNALLY") {
    return { ...base, background: "#f0fdf4", borderColor: "#86efac", color: "#166534" };
  }
  if (status === "NEEDS_REVIEW" || status === "CHANGES_REQUESTED" || status === "SUBMITTED") {
    return { ...base, background: "#fffbeb", borderColor: "#fcd34d", color: "#92400e" };
  }
  if (status === "LEGAL_HOLD" || status === "CANCELLED" || status === "ARCHIVED") {
    return { ...base, background: "#fef2f2", borderColor: "#fca5a5", color: "#7f1d1d" };
  }
  return { ...base, background: "#eff6ff", borderColor: "#93c5fd", color: "#1e40af" };
}

function stepStatusBadgeStyle(status: StepStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (status === "SATISFIED") {
    return { ...base, background: "#f0fdf4", borderColor: "#86efac", color: "#166534" };
  }
  if (status === "WAIVED") {
    return { ...base, background: "#f1f5f9", borderColor: "#cbd5e1", color: "#475569" };
  }
  if (status === "NEEDS_ATTENTION" || status === "IN_PROGRESS") {
    return { ...base, background: "#fffbeb", borderColor: "#fcd34d", color: "#92400e" };
  }
  if (status === "FAILED") {
    return { ...base, background: "#fef2f2", borderColor: "#fca5a5", color: "#7f1d1d" };
  }
  return { ...base, background: "#f8fafc", borderColor: "#e2e8f0", color: "#64748b" };
}
