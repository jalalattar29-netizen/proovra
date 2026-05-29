"use client";

/**
 * Phase C3 — Evidence Request inspector.
 *
 * Authenticated reviewer surface for a single Phase 7 EvidenceRequest.
 * Surfaces:
 *   * request header (title / status / priority / due date)
 *   * deliverable checklist with per-deliverable fulfillment progress
 *   * response timeline (which evidence was submitted via the intake
 *     session, when, current review state)
 *   * bounded reviewer actions: mark needs-more-info, waive a
 *     deliverable, review an individual response
 *
 * Hard rules:
 *   * Every mutation routes through the existing audited Phase 7
 *     backend endpoints. The inspector never bypasses the audit
 *     surface.
 *   * Workspace-scoped — the backend's `requireMember` gate is the
 *     authoritative isolation check. The frontend never tries to
 *     infer workspace from URL params.
 *   * Vocabulary: operational language only. No "chat", no
 *     overclaim, no "approved as authentic" wording.
 *   * The inspector renders an explicit empty/degraded state for
 *     every meaningful UI condition (loading, error, not found,
 *     no deliverables, no responses yet).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalBreadcrumb } from "../../../../components/navigation/OperationalBreadcrumb";

type AuthRequestView = {
  id: string;
  teamId: string;
  evidenceId: string | null;
  caseId: string | null;
  workflowTemplateSlug: string | null;
  workflowStepId: string | null;
  requestType: string;
  status: string;
  priority: string;
  title: string;
  instructions: string;
  dueAtUtc: string | null;
  recipientMode: string;
  recipientLabel: string | null;
  requestedByUserId: string;
  assignedReviewerUserId: string | null;
  intakeLinkId: string | null;
  reviewerNote: string | null;
  sentAtUtc: string | null;
  firstOpenedAtUtc: string | null;
  closedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
  deliverables: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    acceptedKinds: string[];
    minCount: number;
    maxCount: number | null;
    locationRequirement: string;
    captureAfterRequest: boolean;
    workflowStepId: string | null;
    sortOrder: number;
    status: string;
    waivedReason: string | null;
    fulfilledCount: number;
  }>;
  responses: Array<{
    id: string;
    intakeSessionId: string | null;
    responseEvidenceId: string | null;
    submittedByUserId: string | null;
    submittedByExternalLabel: string | null;
    status: string;
    submittedAtUtc: string;
    reviewedAtUtc: string | null;
    reviewedByUserId: string | null;
    reviewerNote: string | null;
  }>;
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return iso;
  }
}

// Phase C3 — gate the inspector on the existing intake-links capability.
// Evidence requests are part of the intake operations surface; anyone
// authorized to manage intake links is authorized to inspect requests
// they own. Server-side, `requireMember` on the request's teamId is the
// authoritative isolation gate.
export default function EvidenceRequestInspectorPage() {
  return (
    <PageRouteGate routeId="workspace.intake_links">
      <Inner />
    </PageRouteGate>
  );
}

function Inner() {
  const params = useParams<{ id?: string | string[] }>();
  const router = useRouter();
  const raw = params?.id;
  const requestId = Array.isArray(raw) ? raw[0] : raw;

  const [data, setData] = useState<AuthRequestView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [reviewerNote, setReviewerNote] = useState("");

  const load = useCallback(async () => {
    if (!requestId) return;
    setLoading(true);
    setError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const json = (await apiFetch(
        `/v1/evidence-requests/${encodeURIComponent(requestId)}`,
      )) as { request: AuthRequestView };
      setData(json.request);
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      setError(e.message ?? "Could not load this evidence request.");
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const markNeedsMoreInfo = useCallback(async () => {
    if (!requestId) return;
    setActionBusy("needs-more-info");
    try {
      await apiFetch(
        `/v1/evidence-requests/${encodeURIComponent(requestId)}/needs-more-info`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewerNote: reviewerNote.trim() || undefined,
          }),
        },
      );
      setReviewerNote("");
      await load();
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Could not mark request as needing more info.");
    } finally {
      setActionBusy(null);
    }
  }, [load, requestId, reviewerNote]);

  const waiveDeliverable = useCallback(
    async (deliverableId: string) => {
      if (!requestId) return;
      const reason = window.prompt(
        "Reason for waiving this deliverable (visible only to workspace members):",
      );
      if (!reason || !reason.trim()) return;
      setActionBusy(`waive:${deliverableId}`);
      try {
        await apiFetch(
          `/v1/evidence-requests/${encodeURIComponent(
            requestId,
          )}/deliverables/${encodeURIComponent(deliverableId)}/waive`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: reason.trim() }),
          },
        );
        await load();
      } catch (err) {
        const e = err as { message?: string };
        setError(e.message ?? "Could not waive deliverable.");
      } finally {
        setActionBusy(null);
      }
    },
    [load, requestId],
  );

  const reviewResponse = useCallback(
    async (responseId: string, decision: string) => {
      if (!requestId) return;
      const note =
        decision === "ACCEPTED"
          ? null
          : window.prompt(
              "Reviewer note (internal — visible only to workspace members):",
            );
      setActionBusy(`review:${responseId}:${decision}`);
      try {
        await apiFetch(
          `/v1/evidence-requests/${encodeURIComponent(
            requestId,
          )}/responses/${encodeURIComponent(responseId)}/review`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              decision,
              reviewerNote: note?.trim() || undefined,
            }),
          },
        );
        await load();
      } catch (err) {
        const e = err as { message?: string };
        setError(e.message ?? "Could not record review decision.");
      } finally {
        setActionBusy(null);
      }
    },
    [load, requestId],
  );

  if (loading) {
    return (
      <main style={mainStyle} data-evidence-request-loading>
        <p>Loading evidence request…</p>
      </main>
    );
  }
  if (error || !data) {
    return (
      <main style={mainStyle} data-evidence-request-error role="alert">
        <h1 style={titleStyle}>Evidence request unavailable</h1>
        <p>{error ?? "Not found."}</p>
        {data?.caseId ? (
          <Link href={`/cases/${encodeURIComponent(data.caseId)}`}>
            Return to matter
          </Link>
        ) : null}
      </main>
    );
  }

  // -----------------------------------------------------------------
  // Deterministic completion summary mirrored on the frontend (same
  // logic as the backend `completion` summary) — for the readiness
  // chip and counts. The authenticated projection does NOT include
  // the summary directly, so we recompute from the deliverables
  // array. Keep the predicate identical to the backend.
  // -----------------------------------------------------------------
  const isSatisfied = (s: string) => s === "FULFILLED" || s === "WAIVED";
  const required = data.deliverables.filter((d) => d.required);
  const optional = data.deliverables.filter((d) => !d.required);
  const requiredFulfilled = required.filter((d) => isSatisfied(d.status)).length;
  const optionalFulfilled = optional.filter((d) => isSatisfied(d.status)).length;
  const allSatisfied = data.deliverables.filter((d) =>
    isSatisfied(d.status),
  ).length;
  const completionPercent =
    data.deliverables.length === 0
      ? 0
      : Math.round((allSatisfied / data.deliverables.length) * 100);
  const reviewReady = required.length === 0 || requiredFulfilled === required.length;

  return (
    <main style={mainStyle} data-evidence-request={data.id}>
      {/* Phase B — operational breadcrumb keeps the workspace + Phase B
          group context visible while operators move between
          intake/matter surfaces. */}
      <OperationalBreadcrumb
        routeId="workspace.evidence_requests"
        items={[
          ...(data.caseId
            ? [
                {
                  label: "Matter",
                  href: `/cases/${encodeURIComponent(data.caseId)}`,
                },
              ]
            : []),
          { label: data.title },
        ]}
      />
      <header style={{ marginBottom: 16 }}>
        <p style={mutedStyle}>
          Evidence Request · {data.requestType.toLowerCase().replace(/_/g, " ")}
        </p>
        <h1 style={titleStyle}>{data.title}</h1>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 6,
            fontSize: 13,
          }}
        >
          <Chip label={`Status: ${data.status}`} tone="info" />
          <Chip label={`Priority: ${data.priority}`} tone="info" />
          {data.dueAtUtc ? (
            <Chip label={`Due ${formatDateTime(data.dueAtUtc)}`} tone="warning" />
          ) : null}
          {reviewReady ? (
            <Chip label="Review-ready" tone="success" />
          ) : (
            <Chip label="Required items remaining" tone="warning" />
          )}
          {data.status === "NEEDS_MORE_INFO" ? (
            <Chip label="Needs more info" tone="danger" />
          ) : null}
        </div>
      </header>

      {data.instructions ? (
        <p style={paragraphStyle}>{data.instructions}</p>
      ) : null}

      {/* Reviewer action — mark as needs-more-info */}
      {data.status !== "CLOSED" &&
      data.status !== "CANCELLED" &&
      data.status !== "FULFILLED" ? (
        <section
          data-evidence-request-rerequest
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
            marginTop: 16,
          }}
        >
          <strong style={{ fontSize: 14 }}>Request more information</strong>
          <p style={{ ...mutedStyle, margin: "4px 0 8px" }}>
            Flag this request as needing more information from the contributor.
            The contributor's intake page will show a re-request banner pointing
            at the unfulfilled deliverables. Workspace-internal note below is
            attached to the audit event.
          </p>
          <textarea
            value={reviewerNote}
            onChange={(e) => setReviewerNote(e.target.value)}
            placeholder="Reviewer note (workspace-internal, optional)"
            rows={2}
            maxLength={4000}
            style={textareaStyle}
            data-evidence-request-reviewer-note
          />
          <button
            type="button"
            onClick={markNeedsMoreInfo}
            disabled={actionBusy !== null}
            style={primaryButtonStyle}
            data-action="mark-needs-more-info"
          >
            {actionBusy === "needs-more-info"
              ? "Recording…"
              : "Mark as needs more info"}
          </button>
        </section>
      ) : null}

      {/* Completion */}
      <section
        data-evidence-request-completion
        style={{
          marginTop: 16,
          padding: 12,
          border: "1px solid #e2e8f0",
          borderRadius: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <strong>Completion</strong>
          <span>{completionPercent}%</span>
        </div>
        <div
          aria-hidden="true"
          style={{
            width: "100%",
            height: 8,
            background: "#f1f5f9",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${completionPercent}%`,
              height: "100%",
              background: reviewReady ? "#16a34a" : "#2563eb",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 8,
            fontSize: 13,
            color: "#475569",
          }}
        >
          <span>
            Required: {requiredFulfilled} / {required.length}
          </span>
          <span>
            Optional: {optionalFulfilled} / {optional.length}
          </span>
        </div>
      </section>

      {/* Deliverables */}
      <section style={{ marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>Deliverables</h2>
        {data.deliverables.length === 0 ? (
          <p style={mutedStyle} data-evidence-request-empty="no-deliverables">
            This request has no deliverable checklist. It accepts free-form
            uploads only.
          </p>
        ) : (
          <ol
            data-evidence-request-deliverables
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {data.deliverables.map((d) => (
              <li
                key={d.id}
                data-evidence-request-deliverable={d.id}
                data-deliverable-status={d.status}
                style={{
                  padding: "10px 12px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  marginBottom: 8,
                  background:
                    d.status === "FULFILLED"
                      ? "#ecfdf5"
                      : d.status === "WAIVED"
                        ? "#f8fafc"
                        : d.status === "REJECTED"
                          ? "#fef2f2"
                          : "#fff",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    flexWrap: "wrap",
                  }}
                >
                  <strong>{d.title}</strong>
                  <Chip
                    label={d.required ? "Required" : "Optional"}
                    tone={d.required ? "danger" : "neutral"}
                  />
                  <Chip label={d.status} tone="info" />
                </div>
                {d.description ? (
                  <p style={paragraphStyle}>{d.description}</p>
                ) : null}
                <div
                  style={{ fontSize: 12, color: "#475569", marginTop: 4 }}
                >
                  {d.fulfilledCount} of {d.minCount} received
                  {typeof d.maxCount === "number" && d.maxCount > 0
                    ? ` (up to ${d.maxCount})`
                    : ""}
                  {d.acceptedKinds.length > 0
                    ? ` · Accepts ${d.acceptedKinds.join(", ")}`
                    : ""}
                  {d.waivedReason
                    ? ` · Waived: ${d.waivedReason}`
                    : ""}
                </div>
                {d.status !== "WAIVED" &&
                d.status !== "FULFILLED" &&
                data.status !== "CLOSED" ? (
                  <button
                    type="button"
                    onClick={() => waiveDeliverable(d.id)}
                    disabled={actionBusy !== null}
                    style={secondaryButtonStyle}
                    data-action={`waive:${d.id}`}
                  >
                    {actionBusy === `waive:${d.id}` ? "Waiving…" : "Waive"}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Responses */}
      <section style={{ marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>Responses received</h2>
        {data.responses.length === 0 ? (
          <p style={mutedStyle} data-evidence-request-empty="no-responses">
            No responses received yet. Responses appear here once the
            contributor submits via the intake link.
          </p>
        ) : (
          <ol
            data-evidence-request-responses
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {data.responses.map((r) => (
              <li
                key={r.id}
                data-evidence-request-response={r.id}
                data-response-status={r.status}
                style={{
                  padding: "10px 12px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "baseline",
                  }}
                >
                  <strong style={{ fontSize: 13 }}>
                    {r.submittedByUserId ??
                      r.submittedByExternalLabel ??
                      "External contributor"}
                  </strong>
                  <Chip label={r.status} tone="info" />
                  <span style={mutedStyle}>
                    {formatDateTime(r.submittedAtUtc)}
                  </span>
                </div>
                {r.responseEvidenceId ? (
                  <Link
                    href={`/evidence/${encodeURIComponent(r.responseEvidenceId)}`}
                    style={{ fontSize: 13 }}
                  >
                    Open evidence
                  </Link>
                ) : null}
                {r.reviewerNote ? (
                  <p
                    style={{
                      ...mutedStyle,
                      marginTop: 4,
                      borderLeft: "2px solid #cbd5e1",
                      paddingLeft: 8,
                    }}
                  >
                    Reviewer note: {r.reviewerNote}
                  </p>
                ) : null}
                {r.status === "RECEIVED" || r.status === "UNDER_REVIEW" ? (
                  <div
                    style={{ display: "flex", gap: 6, marginTop: 8 }}
                    data-response-actions
                  >
                    <button
                      type="button"
                      onClick={() => reviewResponse(r.id, "ACCEPTED")}
                      disabled={actionBusy !== null}
                      style={primaryButtonStyle}
                      data-action={`accept:${r.id}`}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => reviewResponse(r.id, "NEEDS_MORE_INFO")}
                      disabled={actionBusy !== null}
                      style={secondaryButtonStyle}
                      data-action={`needs-more:${r.id}`}
                    >
                      Needs more info
                    </button>
                    <button
                      type="button"
                      onClick={() => reviewResponse(r.id, "REJECTED")}
                      disabled={actionBusy !== null}
                      style={secondaryButtonStyle}
                      data-action={`reject:${r.id}`}
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer style={{ marginTop: 24 }}>
        {data.caseId ? (
          <Link
            href={`/cases/${encodeURIComponent(data.caseId)}`}
            data-action="back-to-matter"
          >
            ← Back to matter
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => router.back()}
            style={secondaryButtonStyle}
          >
            Back
          </button>
        )}
      </footer>
    </main>
  );
}

function Chip({
  label,
  tone,
}: {
  label: string;
  tone: "info" | "success" | "warning" | "danger" | "neutral";
}) {
  const tones: Record<
    typeof tone,
    { bg: string; fg: string; border: string }
  > = {
    info: { bg: "#eff6ff", fg: "#1e3a8a", border: "#bfdbfe" },
    success: { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" },
    warning: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
    danger: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    neutral: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        fontSize: 12,
        padding: "2px 8px",
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

const mainStyle: React.CSSProperties = {
  padding: "1.5rem",
  maxWidth: 920,
  margin: "0 auto",
};

const titleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  margin: 0,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  margin: "16px 0 8px",
};

const paragraphStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#334155",
  margin: "8px 0",
  whiteSpace: "pre-wrap",
};

const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 6,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  resize: "vertical",
  padding: "8px 10px",
  fontFamily: "inherit",
  fontSize: 13,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  marginBottom: 8,
};
