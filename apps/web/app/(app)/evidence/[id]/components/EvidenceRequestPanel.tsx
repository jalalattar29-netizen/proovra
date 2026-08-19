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

import { AppListbox } from "../../../../../components/app-primitives";
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
    <section className="evd-panel" aria-label="Evidence requests">
      <header className="evd-header">
        <div>
          <p className="evd-muted">Evidence requests</p>
          <h3 className="evd-title">Linked requests</h3>
        </div>
        <button
          type="button"
          className="app-primary-action"
          onClick={() => setShowCreate(true)}
        >
          New request
        </button>
      </header>

      {error ? <div className="evd-error">{error}</div> : null}

      {requests !== null && requests.length === 0 ? (
        <p className="evd-muted">
          No linked requests yet. Use “New request” to ask a contributor or
          reviewer for additional evidence or context.
        </p>
      ) : null}

      {requests?.map((req) => (
        <article key={req.id} className="evd-card">
          <div className="evd-card-header">
            <div>
              <strong>{req.title}</strong>
              <div className="evd-muted">
                {req.requestType} · {RECIPIENT_MODE_LABEL[req.recipientMode] ?? req.recipientMode}
                {req.recipientLabel ? ` · ${req.recipientLabel}` : ""}
              </div>
            </div>
            <span className="app-status-badge" data-tone={requestStatusTone(req.status)}>
              {STATUS_LABEL[req.status] ?? req.status}
            </span>
          </div>

          {req.instructions ? (
            <p className="evd-paragraph">{req.instructions}</p>
          ) : null}

          {req.deliverables.length > 0 ? (
            <ul className="evd-list">
              {req.deliverables.map((d) => (
                <li key={d.id} className="evd-list-item">
                  <span className="evd-strong">{d.title}</span>
                  {d.required ? (
                    <span className="evd-badge evd-badge--accent">Required</span>
                  ) : null}
                  <span className="app-status-badge" data-tone={deliverableStatusTone(d.status)}>
                    {DELIVERABLE_LABEL[d.status] ?? d.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {req.responses.length > 0 ? (
            <div className="evd-block--tight">
              <p className="evd-muted">Responses</p>
              {req.responses.map((r) => (
                <div key={r.id} className="evd-card">
                  <div className="evd-grow">
                    <div>
                      <strong>
                        {r.submittedByExternalLabel ?? "External contributor"}
                      </strong>{" "}
                      <span className="evd-muted">
                        · {formatUserDateTime(r.submittedAtUtc)}
                      </span>
                    </div>
                    <div className="evd-muted">
                      Status: {RESPONSE_STATUS_LABEL[r.status] ?? r.status}
                    </div>
                  </div>
                  <div className="evd-actions">
                    <button
                      type="button"
                      className="app-ghost-action"
                      onClick={() => reviewResponse(req.id, r.id, "ACCEPTED")}
                    >
                      {RESPONSE_STATUS_LABEL.ACCEPTED}
                    </button>
                    {(["NEEDS_MORE_INFO", "REJECTED"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="app-ghost-action"
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

          <div className="evd-actions">
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setTimelineFor(req.id)}
            >
              Activity
            </button>
            {req.status === "DRAFT" || req.status === "OPEN" ? (
              <button
                type="button"
                className="app-secondary-action"
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
                className="app-secondary-action"
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
                  className="app-secondary-action"
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
                  className="app-secondary-action evidence-detail-destructive-action"
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
        <div className="evd-dialog-backdrop" role="dialog" aria-modal="true">
          <div className="evd-dialog">
            <h3 className="evd-title">Intake link created</h3>
            <p className="evd-paragraph">
              Send this link to the intended recipient. It will not be shown
              again.
            </p>
            <input
              className="app-form-input evd-input evd-mono"
              readOnly
              value={reveal.url}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <div className="evd-actions evd-actions--end evd-actions--top">
              <button
                type="button"
                className="app-primary-action"
                onClick={() => {
                  navigator.clipboard?.writeText(reveal.url).catch(() => {});
                }}
              >
                Copy
              </button>
              <button
                type="button"
                className="app-secondary-action"
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
    <div className="evd-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="evd-dialog">
        <h3 className="evd-title">New evidence request</h3>
        {/* PHASE 7 §10.5 — this request + its intake link land in the
            owning workspace/org; show it before submission. */}
        <WorkspaceContextBanner action="Evidence request will be created in" />
        {error ? <div className="evd-error">{error}</div> : null}

        <label className="evd-label">Title</label>
        <input
          className="app-form-input evd-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label className="evd-label">Instructions</label>
        <textarea
          className="app-form-input evd-input evd-textarea"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />

        <div className="evd-row">
          <div className="evd-grow">
            <label className="evd-label">Type</label>
            <AppListbox
              value={requestType}
              ariaLabel="Request type"
              onChange={(next) => setRequestType(next)}
              options={[
                { value: "ADDITIONAL_EVIDENCE", label: "Additional evidence" },
                { value: "CLARIFICATION", label: "Clarification" },
                { value: "REPLACEMENT_FILE", label: "Replacement file" },
                { value: "WITNESS_STATEMENT", label: "Witness statement" },
                { value: "DOCUMENT", label: "Document" },
                { value: "OTHER", label: "Other" },
              ]}
            />
          </div>
          <div className="evd-grow">
            <label className="evd-label">Priority</label>
            <AppListbox
              value={priority}
              ariaLabel="Priority"
              onChange={(next) => setPriority(next)}
              options={[
                { value: "LOW", label: "Low" },
                { value: "NORMAL", label: "Normal" },
                { value: "HIGH", label: "High" },
                { value: "URGENT", label: "Urgent" },
              ]}
            />
          </div>
        </div>

        <label className="evd-label">Recipient</label>
        <AppListbox
          value={recipientMode}
          ariaLabel="Recipient"
          onChange={(next) => setRecipientMode(next)}
          options={[
            { value: "INTERNAL_USER", label: "Internal team member" },
            { value: "EXTERNAL_CONTRIBUTOR", label: "External contributor" },
            { value: "ANONYMOUS_SOURCE", label: "Anonymous source" },
            { value: "PSEUDONYMOUS_SOURCE", label: "Pseudonymous source" },
          ]}
        />

        <label className="evd-label">Recipient label (optional)</label>
        <input
          className="app-form-input evd-input"
          value={recipientLabel}
          onChange={(e) => setRecipientLabel(e.target.value.slice(0, 180))}
          placeholder="e.g. John Smith — claim 4842"
        />

        {recipientMode === "EXTERNAL_CONTRIBUTOR" ? (
          <>
            <label className="evd-label">Recipient email (optional)</label>
            <input
              className="app-form-input evd-input"
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value.slice(0, 320))}
            />
          </>
        ) : null}

        <label className="evd-label">Due in (hours)</label>
        <input
          className="app-form-input evd-input"
          type="number"
          min={1}
          max={24 * 365}
          value={dueInHours}
          onChange={(e) =>
            setDueInHours(e.target.value === "" ? "" : Number(e.target.value))
          }
        />

        <label className="evd-label">Deliverables</label>
        {deliverables.map((d, idx) => (
          <div
            key={idx}
            className="evd-card"
          >
            <input
              className="app-form-input evd-input"
              value={d.title}
              placeholder="Title (e.g. Damage close-up)"
              onChange={(e) => updateDeliverable(idx, { title: e.target.value })}
            />
            <input
              className="app-form-input evd-input"
              value={d.description}
              placeholder="Description (optional)"
              onChange={(e) =>
                updateDeliverable(idx, { description: e.target.value })
              }
            />
            <label
              className="evd-checkbox"
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
          className="app-secondary-action"
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

        <div className="evd-actions evd-actions--end evd-actions--top">
          <button
            type="button"
            className="app-secondary-action"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="app-primary-action"
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






/**
 * Request / deliverable status -> canonical badge tone. Both helpers used to
 * build a private three-colour palette per status; app-status-badge already
 * owns that vocabulary. The status groupings below are unchanged.
 */
function requestStatusTone(
  status: string,
): "green" | "blue" | "amber" | "red" | "slate" {
  switch (status) {
    case "FULFILLED":
      return "green";
    case "OPEN":
    case "SENT":
    case "VIEWED":
    case "IN_PROGRESS":
      return "blue";
    case "RESPONSE_RECEIVED":
    case "UNDER_REVIEW":
    case "PARTIALLY_FULFILLED":
    case "NEEDS_MORE_INFO":
      return "amber";
    case "CANCELLED":
      return "red";
    case "DRAFT":
    case "CLOSED":
    default:
      return "slate";
  }
}

function deliverableStatusTone(
  status: string,
): "green" | "amber" | "red" | "slate" {
  switch (status) {
    case "FULFILLED":
      return "green";
    case "PARTIALLY_FULFILLED":
      return "amber";
    case "REJECTED":
      return "red";
    case "PENDING":
    case "WAIVED":
    default:
      return "slate";
  }
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
    <div className="evd-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="evd-dialog">
        <h3 className="evd-title">{label}</h3>
        <p className="evd-paragraph">
          Please add a short reviewer note explaining the decision. The note
          is internal — it is not shared with the contributor or any public
          surface.
        </p>
        <textarea
          className="app-form-input evd-input evd-textarea evd-textarea--tall"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 4000))}
          autoFocus
        />
        <div className="evd-actions evd-actions--end evd-actions--top">
          <button type="button" className="app-secondary-action" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="app-primary-action"
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
    <div className="evd-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="evd-dialog">
        <h3 className="evd-title">Request activity</h3>
        {error ? (
          <div className="evd-error">{error}</div>
        ) : events === null ? (
          <p className="evd-muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="evd-muted">No activity yet.</p>
        ) : (
          <ul className="evd-list">
            {events.map((e) => (
              <li
                key={e.id}
                className="evd-activity-row"
              >
                <div className="evd-strong">
                  {ACTIVITY_LABEL[e.eventType] ?? e.eventType}
                </div>
                <div className="evd-muted">
                  {formatUserDateTime(e.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="evd-actions evd-actions--end evd-actions--top">
          <button type="button" className="app-secondary-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
