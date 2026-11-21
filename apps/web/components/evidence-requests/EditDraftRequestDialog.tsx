"use client";

/**
 * EP-0343 / PRO-CENZ-01 (closure phase 2) — edit a DRAFT evidence request.
 *
 * PATCH /v1/evidence-requests/:id existed (DRAFT only, `evidence_request.create`
 * — the same authority as Send — record/case reach, assignee-in-workspace) and
 * no surface offered it: a draft could be created and sent, never corrected.
 *
 * The dialog reads the request fresh (GET /v1/evidence-requests/:id), edits
 * the fields a draft owns, and saves through the PATCH. What the API decides
 * stays with the API:
 *   - only a DRAFT is editable: a request that left DRAFT answers 409
 *     `request_not_editable`, said here as such;
 *   - a refused role answers 403, a request out of reach 404 — both said;
 *   - the recipient's contact stays masked: the dialog never shows it, and a
 *     new address is sent only when one is typed (blank = unchanged);
 *   - deliverables are replaced as a whole by the API, so they are sent only
 *     when changed, and every field the dialog does not edit (accepted kinds,
 *     counts, location rule, workflow step) is carried over unchanged.
 */

import { useEffect, useId, useState } from "react";

import { AppListbox } from "../app-primitives";
import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

type Deliverable = {
  id?: string;
  title: string;
  description: string;
  required: boolean;
  acceptedKinds: string[];
  minCount?: number;
  maxCount?: number | null;
  locationRequirement?: string;
  captureAfterRequest?: boolean;
  workflowStepId?: string | null;
};

export type DraftRequestView = {
  id: string;
  status: string;
  title: string;
  instructions: string;
  requestType: string;
  priority: string;
  dueAtUtc: string | null;
  recipientMode: string;
  recipientLabel: string | null;
  recipientEmailMasked?: string | null;
  hasRecipientEmail?: boolean;
  deliverables: Deliverable[];
};

const REQUEST_TYPES: Array<[string, string]> = [
  ["ADDITIONAL_EVIDENCE", "Additional evidence"],
  ["CLARIFICATION", "Clarification"],
  ["REPLACEMENT_FILE", "Replacement file"],
  ["WITNESS_STATEMENT", "Witness statement"],
  ["DOCUMENT", "Document"],
  ["OTHER", "Other"],
];
const PRIORITIES: Array<[string, string]> = [
  ["LOW", "Low"],
  ["NORMAL", "Normal"],
  ["HIGH", "High"],
  ["URGENT", "Urgent"],
];
const ALL_KINDS = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** ISO → the value of a `datetime-local` input, in UTC (the page states UTC). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The sentence for a refused save, from the API's own code. */
export function draftEditRefusal(err: unknown): string {
  const e = err as { code?: string; statusCode?: number } | null;
  const code = e?.code ?? "";
  if (code === "request_not_editable") {
    return "This request has already left Draft, so it can no longer be edited. Reload to see its current state.";
  }
  if (code === "request_not_found" || e?.statusCode === 404) {
    return "This request is no longer available to you.";
  }
  if (e?.statusCode === 403) {
    return "Your role does not include editing evidence requests in this workspace.";
  }
  return toSafeUserError(err, { message: "The draft could not be saved." }).message;
}

function deliverablesKey(list: Deliverable[]): string {
  return JSON.stringify(list.map((d) => [d.title.trim(), d.description, d.required]));
}

export function EditDraftRequestDialog({
  requestId,
  onClose,
  onSaved,
}: {
  requestId: string;
  onClose: () => void;
  onSaved: (request: DraftRequestView) => void | Promise<void>;
}) {
  const titleId = useId();
  const [loaded, setLoaded] = useState<DraftRequestView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [requestType, setRequestType] = useState("ADDITIONAL_EVIDENCE");
  const [priority, setPriority] = useState("NORMAL");
  const [due, setDue] = useState("");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/evidence-requests/${encodeURIComponent(requestId)}`, { method: "GET" })
      .then((res: { request: DraftRequestView }) => {
        if (cancelled) return;
        const r = res.request;
        setLoaded(r);
        setTitle(r.title ?? "");
        setInstructions(r.instructions ?? "");
        setRequestType(r.requestType);
        setPriority(r.priority);
        setDue(toLocalInput(r.dueAtUtc));
        setRecipientLabel(r.recipientLabel ?? "");
        setDeliverables((r.deliverables ?? []).map((d) => ({ ...d })));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(draftEditRefusal(err));
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  const notDraft = loaded !== null && loaded.status !== "DRAFT";

  async function save() {
    if (!loaded || busy || notDraft) return;
    const blank = deliverables.findIndex((d) => !d.title.trim());
    if (blank >= 0) {
      setError(`Deliverable ${blank + 1} needs a title.`);
      return;
    }
    if (newEmail.trim() && !EMAIL_RE.test(newEmail.trim())) {
      setError("Enter a valid recipient email, or leave it empty to keep the current one.");
      return;
    }
    const patch: Record<string, unknown> = {
      title: title.trim(),
      instructions,
      requestType,
      priority,
      dueAtUtc: fromLocalInput(due),
      recipientLabel: recipientLabel.trim() || null,
    };
    if (newEmail.trim() && loaded.recipientMode === "EXTERNAL_CONTRIBUTOR") {
      patch.recipientEmail = newEmail.trim();
    }
    if (deliverablesKey(deliverables) !== deliverablesKey(loaded.deliverables ?? [])) {
      patch.deliverables = deliverables.map((d, idx) => ({
        title: d.title.trim(),
        description: d.description ?? "",
        required: d.required,
        acceptedKinds: d.acceptedKinds && d.acceptedKinds.length > 0 ? d.acceptedKinds : ALL_KINDS,
        ...(d.minCount !== undefined ? { minCount: d.minCount } : {}),
        ...(d.maxCount !== undefined ? { maxCount: d.maxCount } : {}),
        ...(d.locationRequirement ? { locationRequirement: d.locationRequirement } : {}),
        ...(d.captureAfterRequest !== undefined ? { captureAfterRequest: d.captureAfterRequest } : {}),
        ...(d.workflowStepId !== undefined ? { workflowStepId: d.workflowStepId } : {}),
        sortOrder: idx,
      }));
    }
    setBusy(true);
    setError(null);
    try {
      const res = (await apiFetch(`/v1/evidence-requests/${encodeURIComponent(requestId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })) as { request: DraftRequestView };
      await onSaved(res.request);
    } catch (err) {
      setError(draftEditRefusal(err));
    } finally {
      setBusy(false);
    }
  }

  const update = (idx: number, change: Partial<Deliverable>) =>
    setDeliverables((prev) => prev.map((d, i) => (i === idx ? { ...d, ...change } : d)));

  return (
    <div className="evd-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId} data-edit-draft-request={requestId}>
      <div className="evd-dialog">
        <h3 className="evd-title" id={titleId}>Edit draft request</h3>
        <p className="evd-muted">
          A draft can be changed until it is sent. Every change is recorded on the request&rsquo;s activity timeline.
        </p>
        {loadError ? (
          <div className="evd-error" role="alert">{loadError}</div>
        ) : !loaded ? (
          <p className="evd-muted">Loading the draft…</p>
        ) : notDraft ? (
          <div className="evd-error" role="alert" data-edit-draft-not-draft>
            This request has already left Draft, so it can no longer be edited.
          </div>
        ) : (
          <>
            {error ? <div className="evd-error" role="alert">{error}</div> : null}
            <label className="evd-label" htmlFor={`${titleId}-title`}>Title</label>
            <input
              id={`${titleId}-title`}
              className="app-form-input evd-input"
              value={title}
              maxLength={180}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label className="evd-label" htmlFor={`${titleId}-instructions`}>Instructions</label>
            <textarea
              id={`${titleId}-instructions`}
              className="app-form-input evd-input evd-textarea"
              value={instructions}
              maxLength={4000}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <div className="evd-row">
              <div className="evd-grow">
                <span className="evd-label">Type</span>
                <AppListbox
                  value={requestType}
                  ariaLabel="Request type"
                  onChange={(next) => setRequestType(next)}
                  options={REQUEST_TYPES.map(([value, label]) => ({ value, label }))}
                />
              </div>
              <div className="evd-grow">
                <span className="evd-label">Priority</span>
                <AppListbox
                  value={priority}
                  ariaLabel="Priority"
                  onChange={(next) => setPriority(next)}
                  options={PRIORITIES.map(([value, label]) => ({ value, label }))}
                />
              </div>
            </div>
            <label className="evd-label" htmlFor={`${titleId}-due`}>Due (UTC, optional)</label>
            <input
              id={`${titleId}-due`}
              className="app-form-input evd-input"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <label className="evd-label" htmlFor={`${titleId}-label`}>Recipient label (optional)</label>
            <input
              id={`${titleId}-label`}
              className="app-form-input evd-input"
              value={recipientLabel}
              maxLength={180}
              onChange={(e) => setRecipientLabel(e.target.value)}
            />
            {loaded.recipientMode === "EXTERNAL_CONTRIBUTOR" ? (
              <>
                <label className="evd-label" htmlFor={`${titleId}-email`}>
                  New recipient email (optional)
                </label>
                <input
                  id={`${titleId}-email`}
                  className="app-form-input evd-input"
                  type="email"
                  value={newEmail}
                  maxLength={320}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
                <p className="evd-muted">
                  {loaded.hasRecipientEmail
                    ? `Current: ${loaded.recipientEmailMasked ?? "set"}. Leave empty to keep it.`
                    : "No recipient email is set. Leave empty to keep it that way."}
                </p>
              </>
            ) : null}
            <span className="evd-label">Deliverables</span>
            {deliverables.map((d, idx) => (
              <div key={d.id ?? `new-${idx}`} className="evd-card" data-edit-draft-deliverable={idx}>
                <input
                  className="app-form-input evd-input"
                  aria-label={`Deliverable ${idx + 1} title`}
                  value={d.title}
                  onChange={(e) => update(idx, { title: e.target.value })}
                />
                <input
                  className="app-form-input evd-input"
                  aria-label={`Deliverable ${idx + 1} description`}
                  value={d.description}
                  placeholder="Description (optional)"
                  onChange={(e) => update(idx, { description: e.target.value })}
                />
                <label className="evd-checkbox">
                  <input
                    type="checkbox"
                    checked={d.required}
                    onChange={(e) => update(idx, { required: e.target.checked })}
                  />
                  Required
                </label>
                <button
                  type="button"
                  className="app-ghost-action"
                  onClick={() => setDeliverables((prev) => prev.filter((_, i) => i !== idx))}
                >
                  Remove deliverable
                </button>
              </div>
            ))}
            <button
              type="button"
              className="app-secondary-action"
              disabled={deliverables.length >= 32}
              onClick={() =>
                setDeliverables((prev) => [...prev, { title: "", description: "", required: false, acceptedKinds: ALL_KINDS }])
              }
            >
              Add deliverable
            </button>
          </>
        )}
        <div className="evd-actions evd-actions--end evd-actions--top">
          <button type="button" className="app-secondary-action" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {loaded && !notDraft && !loadError ? (
            <button
              type="button"
              className="app-primary-action"
              onClick={() => void save()}
              disabled={busy || !title.trim()}
            >
              {busy ? "Saving…" : "Save draft"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
