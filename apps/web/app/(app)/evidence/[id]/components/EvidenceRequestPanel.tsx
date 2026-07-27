"use client";

/**
 * Phase 7 — Linked evidence requests panel.
 *
 * Renders the list of EvidenceRequests linked to the current evidence. Lets
 * authenticated workspace users create a new request (with optional intake
 * link generation) and shows responses + deliverable status as compact
 * cards. Renders nothing when there are no linked requests AND the
 * "Request additional evidence" affordance is opt-in.
 *
 * Privacy:
 *   - Calls only authenticated endpoints. Workspace-internal fields are
 *     OK to render here (reviewer notes, recipient email, etc.); they
 *     are scoped by membership server-side.
 *   - The raw intake-link token is captured in a one-shot reveal modal
 *     after creating + sending a request to an external recipient. The
 *     URL is held in component state ONLY while the dialog is open.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
// PHASE 7 §10 — canonical context-safety primitives.
import {
  WorkspaceContextBanner,
  useWorkspaceContextSafety,
} from "../../../../../lib/platform-context";
import { formatUserDateTime } from "../../../../../lib/date";

type RequestRow = {
  id: string;
  status: string;
  priority: string;
  requestType: string;
  title: string;
  instructions: string;
  dueAtUtc: string | null;
  recipientMode: string;
  recipientLabel: string | null;
  recipientEmail: string | null;
  intakeLinkId: string | null;
  reviewerNote: string | null;
  sentAtUtc: string | null;
  firstOpenedAtUtc: string | null;
  closedAtUtc: string | null;
  cancelledAtUtc: string | null;
  createdAt: string;
  deliverables: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    status: string;
    workflowStepId: string | null;
  }>;
  responses: Array<{
    id: string;
    status: string;
    responseEvidenceId: string | null;
    submittedAtUtc: string;
    submittedByExternalLabel: string | null;
    reviewerNote: string | null;
  }>;
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  SENT: "Sent",
  VIEWED: "Viewed",
  IN_PROGRESS: "In progress",
  RESPONSE_RECEIVED: "Response received",
  UNDER_REVIEW: "Under internal review",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  NEEDS_MORE_INFO: "Needs additional context",
  CANCELLED: "Cancelled",
  CLOSED: "Closed",
};

const RESPONSE_STATUS_LABEL: Record<string, string> = {
  RECEIVED: "Received",
  UNDER_REVIEW: "Under internal review",
  ACCEPTED: "Accepted for internal review",
  NEEDS_MORE_INFO: "Needs additional context",
  REJECTED: "Rejected as insufficient",
};

const DELIVERABLE_LABEL: Record<string, string> = {
  PENDING: "Pending",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  WAIVED: "Waived",
  REJECTED: "Rejected as insufficient",
};

const RECIPIENT_MODE_LABEL: Record<string, string> = {
  INTERNAL_USER: "Internal user",
  EXTERNAL_CONTRIBUTOR: "External contributor",
  ANONYMOUS_SOURCE: "Anonymous source",
  PSEUDONYMOUS_SOURCE: "Pseudonymous source",
};

export default function EvidenceRequestPanel({
  evidenceId,
  teamId,
}: {
  evidenceId: string;
  teamId: string | null;
}) {
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [reveal, setReveal] = useState<{ url: string } | null>(null);
  const [noteDialog, setNoteDialog] = useState<{
    action: "cancel" | "close" | "needs-more-info" | "review";
    requestId: string;
    responseId?: string;
    status?: string;
    label: string;
  } | null>(null);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(
      `/v1/evidence-requests?teamId=${encodeURIComponent(teamId)}&evidenceId=${encodeURIComponent(evidenceId)}`,
      { method: "GET" },
    )
      .then((res: { requests: RequestRow[] }) => {
        if (cancelled) return;
        setRequests(res.requests ?? []);
        setFeatureDisabled(false);
      })
      .catch((err: { message?: string; code?: string; statusCode?: number }) => {
        if (cancelled) return;
        if (err?.statusCode === 503 || err?.code === "FEATURE_DISABLED") {
          setFeatureDisabled(true);
          setRequests([]);
          return;
        }
        setError(toSafeUserError(err, { message: "Unable to load evidence requests." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, evidenceId]);

  async function reload() {
    if (!teamId) return;
    const res: { requests: RequestRow[] } = await apiFetch(
      `/v1/evidence-requests?teamId=${encodeURIComponent(teamId)}&evidenceId=${encodeURIComponent(evidenceId)}`,
      { method: "GET" },
    );
    setRequests(res.requests ?? []);
  }

  async function sendRequest(req: RequestRow) {
    try {
      const res: { rawToken: string | null; intakeUrl: string | null } =
        await apiFetch(`/v1/evidence-requests/${req.id}/send`, {
          method: "POST",
        });
      if (res.intakeUrl) setReveal({ url: res.intakeUrl });
      await reload();
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not send request." }).message);
    }
  }

  async function reviewResponse(
    requestId: string,
    responseId: string,
    status: string,
    reviewerNote?: string | null,
  ) {
    try {
      await apiFetch(
        `/v1/evidence-requests/${requestId}/responses/${responseId}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status, reviewerNote: reviewerNote ?? null }),
        },
      );
      await reload();
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not update response." }).message);
    }
  }

  async function executeNoteAction(note: string) {
    if (!noteDialog) return;
    try {
      if (noteDialog.action === "cancel") {
        await apiFetch(`/v1/evidence-requests/${noteDialog.requestId}/cancel`, {
          method: "POST",
        });
      } else if (noteDialog.action === "close") {
        await apiFetch(`/v1/evidence-requests/${noteDialog.requestId}/close`, {
          method: "POST",
        });
      } else if (noteDialog.action === "needs-more-info") {
        await apiFetch(
          `/v1/evidence-requests/${noteDialog.requestId}/needs-more-info`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reviewerNote: note }),
          },
        );
      } else if (
        noteDialog.action === "review" &&
        noteDialog.responseId &&
        noteDialog.status
      ) {
        await reviewResponse(
          noteDialog.requestId,
          noteDialog.responseId,
          noteDialog.status,
          note,
        );
      }
      setNoteDialog(null);
      await reload();
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not complete action." }).message);
    }
  }

  if (!teamId) return null;

  // Phase 7.5 — when the feature is disabled at the server, hide the
  // panel entirely so the evidence page stays clean. Authenticated users
  // are not blocked from anything else on the page.
  if (featureDisabled) return null;

  return (
    <section style={panelStyle} aria-label="Evidence requests">
      <header style={headerStyle}>
        <div>
          <p style={mutedStyle}>Evidence requests</p>
          <h3 style={titleStyle}>Linked requests</h3>
        </div>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => setShowCreate(true)}
        >
          New request
        </button>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {requests !== null && requests.length === 0 ? (
        <p style={mutedTextStyle}>
          No linked requests yet. Use “New request” to ask a contributor or
          reviewer for additional evidence or context.
        </p>
      ) : null}

      {requests?.map((req) => (
        <article key={req.id} style={requestCardStyle}>
          <div style={requestHeaderStyle}>
            <div>
              <strong>{req.title}</strong>
              <div style={mutedTextStyle}>
                {req.requestType} · {RECIPIENT_MODE_LABEL[req.recipientMode] ?? req.recipientMode}
                {req.recipientLabel ? ` · ${req.recipientLabel}` : ""}
              </div>
            </div>
            <span style={statusBadgeStyle(req.status)}>
              {STATUS_LABEL[req.status] ?? req.status}
            </span>
          </div>

          {req.instructions ? (
            <p style={paragraphStyle}>{req.instructions}</p>
          ) : null}

          {req.deliverables.length > 0 ? (
            <ul style={deliverableListStyle}>
              {req.deliverables.map((d) => (
                <li key={d.id} style={deliverableItemStyle}>
                  <span style={{ fontWeight: 600 }}>{d.title}</span>
                  {d.required ? (
                    <span style={requiredBadgeStyle}>Required</span>
                  ) : null}
                  <span style={deliverableStatusBadge(d.status)}>
                    {DELIVERABLE_LABEL[d.status] ?? d.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {req.responses.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <p style={mutedStyle}>Responses</p>
              {req.responses.map((r) => (
                <div key={r.id} style={responseRowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <strong>
                        {r.submittedByExternalLabel ?? "External contributor"}
                      </strong>{" "}
                      <span style={mutedStyle}>
                        · {formatUserDateTime(r.submittedAtUtc)}
                      </span>
                    </div>
                    <div style={mutedStyle}>
                      Status: {RESPONSE_STATUS_LABEL[r.status] ?? r.status}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={smallButtonStyle}
                      onClick={() => reviewResponse(req.id, r.id, "ACCEPTED")}
                    >
                      {RESPONSE_STATUS_LABEL.ACCEPTED}
                    </button>
                    {(["NEEDS_MORE_INFO", "REJECTED"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        style={smallButtonStyle}
                        onClick={() =>
                          setNoteDialog({
                            action: "review",
                            requestId: req.id,
                            responseId: r.id,
                            status: s,
                            label: RESPONSE_STATUS_LABEL[s],
                          })
                        }
                      >
                        {RESPONSE_STATUS_LABEL[s]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div style={requestActionsStyle}>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => setTimelineFor(req.id)}
            >
              Activity
            </button>
            {req.status === "DRAFT" || req.status === "OPEN" ? (
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => sendRequest(req)}
              >
                Send
              </button>
            ) : null}
            {req.status !== "CANCELLED" &&
            req.status !== "CLOSED" &&
            req.status !== "DRAFT" ? (
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() =>
                  setNoteDialog({
                    action: "needs-more-info",
                    requestId: req.id,
                    label: "Mark as needs additional context",
                  })
                }
              >
                Needs more info
              </button>
            ) : null}
            {req.status !== "CANCELLED" && req.status !== "CLOSED" ? (
              <>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() =>
                    setNoteDialog({
                      action: "close",
                      requestId: req.id,
                      label: "Close request",
                    })
                  }
                >
                  Close
                </button>
                <button
                  type="button"
                  style={dangerButtonStyle}
                  onClick={() =>
                    setNoteDialog({
                      action: "cancel",
                      requestId: req.id,
                      label: "Cancel request",
                    })
                  }
                >
                  Cancel
                </button>
              </>
            ) : null}
          </div>
        </article>
      ))}

      {showCreate ? (
        <CreateRequestDialog
          teamId={teamId}
          evidenceId={evidenceId}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await reload();
          }}
        />
      ) : null}

      {noteDialog ? (
        <NoteDialog
          label={noteDialog.label}
          onCancel={() => setNoteDialog(null)}
          onConfirm={executeNoteAction}
        />
      ) : null}

      {timelineFor ? (
        <ActivityTimelineDrawer
          requestId={timelineFor}
          onClose={() => setTimelineFor(null)}
        />
      ) : null}

      {reveal ? (
        <div style={modalBackdropStyle} role="dialog" aria-modal>
          <div style={modalStyle}>
            <h3 style={titleStyle}>Intake link created</h3>
            <p style={paragraphStyle}>
              Send this link to the intended recipient. It will not be shown
              again.
            </p>
            <input
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12 }}
              readOnly
              value={reveal.url}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => {
                  navigator.clipboard?.writeText(reveal.url).catch(() => {});
                }}
              >
                Copy
              </button>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => setReveal(null)}
              >
                Close (forget link)
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Create dialog
// -----------------------------------------------------------------------------

function CreateRequestDialog({
  teamId,
  evidenceId,
  onClose,
  onCreated,
}: {
  teamId: string;
  evidenceId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [requestType, setRequestType] = useState("ADDITIONAL_EVIDENCE");
  const [priority, setPriority] = useState("NORMAL");
  const [recipientMode, setRecipientMode] = useState("EXTERNAL_CONTRIBUTOR");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [dueInHours, setDueInHours] = useState<number | "">(72);
  const [deliverables, setDeliverables] = useState<
    Array<{
      title: string;
      description: string;
      required: boolean;
      acceptedKinds: string[];
    }>
  >([
    {
      title: "Primary evidence",
      description: "",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PHASE 7 §10.1/§10.3 — the request form holds unsaved workspace-scoped
  // work; register it dirty + guard the create against a mid-flight switch.
  const { runGuarded } = useWorkspaceContextSafety({
    isDirty:
      title.trim().length > 0 ||
      instructions.trim().length > 0 ||
      recipientEmail.trim().length > 0,
    dirtyLabel: "Unsaved evidence request",
  });

  function updateDeliverable(idx: number, patch: Partial<(typeof deliverables)[number]>) {
    setDeliverables((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)),
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const dueAtUtc =
        dueInHours === ""
          ? null
          : new Date(Date.now() + Number(dueInHours) * 3600 * 1000).toISOString();
      await runGuarded(
        () =>
          apiFetch("/v1/evidence-requests", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              teamId,
              evidenceId,
              requestType,
              title: title || "Additional evidence needed",
              instructions,
              priority,
              dueAtUtc,
              recipientMode,
              recipientLabel: recipientLabel || null,
              recipientEmail: recipientEmail || null,
              createIntakeLink: true,
              deliverables: deliverables.map((d, idx) => ({
                title: d.title,
                description: d.description,
                required: d.required,
                acceptedKinds: d.acceptedKinds,
                minCount: 1,
                locationRequirement: "optional",
                captureAfterRequest: false,
                sortOrder: idx,
              })),
            }),
          }),
        () => onCreated(),
      );
    } catch (err) {
      const e = err as { message?: string };
      setError(toSafeUserError(e, { message: "Could not create request." }).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle}>
        <h3 style={titleStyle}>New evidence request</h3>
        {/* PHASE 7 §10.5 — this request + its intake link land in the
            owning workspace/org; show it before submission. */}
        <WorkspaceContextBanner action="Evidence request will be created in" />
        {error ? <div style={errorBoxStyle}>{error}</div> : null}

        <label style={labelStyle}>Title</label>
        <input
          style={inputStyle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label style={labelStyle}>Instructions</label>
        <textarea
          style={{ ...inputStyle, minHeight: 80 }}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />

        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Type</label>
            <select
              style={inputStyle}
              value={requestType}
              onChange={(e) => setRequestType(e.target.value)}
            >
              <option value="ADDITIONAL_EVIDENCE">Additional evidence</option>
              <option value="CLARIFICATION">Clarification</option>
              <option value="REPLACEMENT_FILE">Replacement file</option>
              <option value="WITNESS_STATEMENT">Witness statement</option>
              <option value="DOCUMENT">Document</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Priority</label>
            <select
              style={inputStyle}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            >
              <option value="LOW">Low</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </div>
        </div>

        <label style={labelStyle}>Recipient</label>
        <select
          style={inputStyle}
          value={recipientMode}
          onChange={(e) => setRecipientMode(e.target.value)}
        >
          <option value="INTERNAL_USER">Internal team member</option>
          <option value="EXTERNAL_CONTRIBUTOR">External contributor</option>
          <option value="ANONYMOUS_SOURCE">Anonymous source</option>
          <option value="PSEUDONYMOUS_SOURCE">Pseudonymous source</option>
        </select>

        <label style={labelStyle}>Recipient label (optional)</label>
        <input
          style={inputStyle}
          value={recipientLabel}
          onChange={(e) => setRecipientLabel(e.target.value.slice(0, 180))}
          placeholder="e.g. John Smith — claim 4842"
        />

        {recipientMode === "EXTERNAL_CONTRIBUTOR" ? (
          <>
            <label style={labelStyle}>Recipient email (optional)</label>
            <input
              style={inputStyle}
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value.slice(0, 320))}
            />
          </>
        ) : null}

        <label style={labelStyle}>Due in (hours)</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          max={24 * 365}
          value={dueInHours}
          onChange={(e) =>
            setDueInHours(e.target.value === "" ? "" : Number(e.target.value))
          }
        />

        <label style={labelStyle}>Deliverables</label>
        {deliverables.map((d, idx) => (
          <div
            key={idx}
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              padding: 12,
              marginBottom: 8,
            }}
          >
            <input
              style={inputStyle}
              value={d.title}
              placeholder="Title (e.g. Damage close-up)"
              onChange={(e) => updateDeliverable(idx, { title: e.target.value })}
            />
            <input
              style={inputStyle}
              value={d.description}
              placeholder="Description (optional)"
              onChange={(e) =>
                updateDeliverable(idx, { description: e.target.value })
              }
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "#334155",
              }}
            >
              <input
                type="checkbox"
                checked={d.required}
                onChange={(e) =>
                  updateDeliverable(idx, { required: e.target.checked })
                }
              />
              Required
            </label>
          </div>
        ))}
        <button
          type="button"
          style={secondaryButtonStyle}
          onClick={() =>
            setDeliverables((prev) => [
              ...prev,
              {
                title: "",
                description: "",
                required: false,
                acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
              },
            ])
          }
        >
          Add deliverable
        </button>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={submit}
            disabled={busy || !title.trim()}
          >
            {busy ? "Creating…" : "Create request"}
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  marginTop: 24,
  marginBottom: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: 12,
};
const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  margin: 0,
  color: "#0f172a",
};
const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#64748b",
  margin: 0,
};
const mutedTextStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
};
const paragraphStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#0f172a",
  margin: "8px 0",
};
const requestCardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 16,
  marginTop: 12,
};
const requestHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
};
const requestActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 12,
};
const deliverableListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "8px 0",
};
const deliverableItemStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: "4px 0",
};
const responseRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: 8,
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  marginTop: 6,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 500,
  color: "#7f1d1d",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 8,
  cursor: "pointer",
};
const smallButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 999,
  cursor: "pointer",
  color: "#0f172a",
};
const requiredBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: "#fef2f2",
  color: "#991b1b",
  borderRadius: 999,
};
const errorBoxStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: 8,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 6,
  fontSize: 13,
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
};
const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 24,
  maxWidth: 560,
  width: "100%",
  maxHeight: "90vh",
  overflow: "auto",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  marginBottom: 12,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
  color: "#334155",
};

function statusBadgeStyle(status: string): React.CSSProperties {
  const palette: Record<string, [string, string, string]> = {
    DRAFT: ["#f1f5f9", "#cbd5e1", "#475569"],
    OPEN: ["#eff6ff", "#bfdbfe", "#1e40af"],
    SENT: ["#eff6ff", "#bfdbfe", "#1e40af"],
    VIEWED: ["#eff6ff", "#bfdbfe", "#1e40af"],
    IN_PROGRESS: ["#eff6ff", "#bfdbfe", "#1e40af"],
    RESPONSE_RECEIVED: ["#fef3c7", "#fde68a", "#92400e"],
    UNDER_REVIEW: ["#fef3c7", "#fde68a", "#92400e"],
    PARTIALLY_FULFILLED: ["#fef9c3", "#fde68a", "#854d0e"],
    FULFILLED: ["#dcfce7", "#bbf7d0", "#166534"],
    NEEDS_MORE_INFO: ["#fef3c7", "#fde68a", "#92400e"],
    CANCELLED: ["#fef2f2", "#fecaca", "#7f1d1d"],
    CLOSED: ["#f1f5f9", "#cbd5e1", "#475569"],
  };
  const [bg, border, color] = palette[status] ?? palette.DRAFT;
  return {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
  };
}

function deliverableStatusBadge(status: string): React.CSSProperties {
  const palette: Record<string, [string, string]> = {
    PENDING: ["#f1f5f9", "#475569"],
    PARTIALLY_FULFILLED: ["#fef9c3", "#854d0e"],
    FULFILLED: ["#dcfce7", "#166534"],
    WAIVED: ["#e2e8f0", "#475569"],
    REJECTED: ["#fef2f2", "#7f1d1d"],
  };
  const [bg, color] = palette[status] ?? palette.PENDING;
  return {
    padding: "2px 8px",
    fontSize: 11,
    background: bg,
    color,
    borderRadius: 999,
  };
}

// -----------------------------------------------------------------------------
// NoteDialog — required reviewer note for sensitive actions. The backend
// enforces note presence; this UI surfaces the rule before the API call.
// -----------------------------------------------------------------------------

function NoteDialog({
  label,
  onCancel,
  onConfirm,
}: {
  label: string;
  onCancel: () => void;
  onConfirm: (note: string) => void | Promise<void>;
}) {
  const [note, setNote] = useState("");
  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle}>
        <h3 style={titleStyle}>{label}</h3>
        <p style={paragraphStyle}>
          Please add a short reviewer note explaining the decision. The note
          is internal — it is not shared with the contributor or any public
          surface.
        </p>
        <textarea
          style={{ ...inputStyle, minHeight: 100 }}
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 4000))}
          autoFocus
        />
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 12,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={note.trim().length === 0}
            onClick={() => onConfirm(note.trim())}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ActivityTimelineDrawer — authenticated-only activity log for a request.
// -----------------------------------------------------------------------------

type ActivityEvent = {
  id: string;
  eventType: string;
  actorUserId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

const ACTIVITY_LABEL: Record<string, string> = {
  EVIDENCE_REQUEST_CREATED: "Request created",
  EVIDENCE_REQUEST_EDITED: "Request edited",
  EVIDENCE_REQUEST_OPEN: "Opened",
  EVIDENCE_REQUEST_SENT: "Sent to recipient",
  EVIDENCE_REQUEST_VIEWED: "Recipient viewed",
  EVIDENCE_REQUEST_IN_PROGRESS: "In progress",
  EVIDENCE_REQUEST_RESPONSE_RECEIVED: "Response received",
  EVIDENCE_REQUEST_UNDER_REVIEW: "Under internal review",
  EVIDENCE_REQUEST_PARTIALLY_FULFILLED: "Partially fulfilled",
  EVIDENCE_REQUEST_FULFILLED: "Fulfilled",
  EVIDENCE_REQUEST_NEEDS_MORE_INFO: "Marked needs additional context",
  EVIDENCE_REQUEST_CANCELLED: "Cancelled",
  EVIDENCE_REQUEST_CLOSED: "Closed",
  EVIDENCE_REQUEST_LINK_CREATED: "Intake link issued",
  EVIDENCE_REQUEST_ASSIGNED: "Reviewer assigned",
  EVIDENCE_REQUEST_UNASSIGNED: "Reviewer unassigned",
  EVIDENCE_REQUEST_DELIVERABLE_WAIVED: "Deliverable waived",
  EVIDENCE_REQUEST_RESPONSE_ACCEPTED: "Response accepted for internal review",
  EVIDENCE_REQUEST_RESPONSE_REJECTED: "Response rejected as insufficient",
  EVIDENCE_REQUEST_RESPONSE_UNDER_REVIEW: "Response under review",
};

function ActivityTimelineDrawer({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/evidence-requests/${requestId}/events`, { method: "GET" })
      .then((res: { events: ActivityEvent[] }) => {
        if (cancelled) return;
        setEvents(res.events ?? []);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Unable to load activity timeline." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle}>
        <h3 style={titleStyle}>Request activity</h3>
        {error ? (
          <div style={errorBoxStyle}>{error}</div>
        ) : events === null ? (
          <p style={mutedTextStyle}>Loading…</p>
        ) : events.length === 0 ? (
          <p style={mutedTextStyle}>No activity yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {events.map((e) => (
              <li
                key={e.id}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid #e2e8f0",
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {ACTIVITY_LABEL[e.eventType] ?? e.eventType}
                </div>
                <div style={mutedTextStyle}>
                  {formatUserDateTime(e.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
