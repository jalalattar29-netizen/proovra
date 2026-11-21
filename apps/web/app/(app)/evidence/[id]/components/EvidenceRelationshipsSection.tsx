"use client";

import { evidenceRecordStatusLabel } from "@proovra/shared";
import { Unlink } from "lucide-react";
import { useState } from "react";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

/** The relationship types the API accepts (EvidenceRelationshipType). */
export const RELATIONSHIP_TYPES = [
  "RELATED",
  "SUPPORTS",
  "DUPLICATE_OF",
  "DERIVED_FROM",
  "SAME_INCIDENT",
  "CONTRADICTS",
  "REPLACES",
  "REFERENCES",
] as const;

/** EP-0389 — the sentence for a refused relationship edit, from the API's answer. */
export function relationshipEditRefusal(err: unknown): string {
  const e = err as { statusCode?: number; code?: string } | null;
  if (e?.statusCode === 404) {
    return "This relationship is no longer available to you from this record. Nothing was changed.";
  }
  if (e?.statusCode === 403) {
    return "Your role does not include editing relationships on this record. Nothing was changed.";
  }
  if (e?.statusCode === 409) {
    return toSafeUserError(err, {
      message: "This record cannot be changed in its current state (for example, it is in trash). Nothing was changed.",
    }).message;
  }
  return toSafeUserError(err, { message: "The relationship could not be updated." }).message;
}

type RelationshipItem = {
  id: string;
  relationshipType: string;
  note: string | null;
  direction: "outbound" | "inbound";
  linkedEvidence: {
    id: string;
    title: string;
    status: string;
  };
};

type LinkedCase = {
  caseId: string;
  caseName: string | null;
  role: string;
  linkedAtUtc: string;
};

export function EvidenceRelationshipsSection({
  caseName,
  cases,
  onRemoveLinkedCase,
  relatedEvidenceCount,
  multipart,
  itemCount,
  note,
  items,
  actionBusy,
  canManageRelationships = true,
  onAssignCase,
  onRemoveCase,
  onOpenRelationshipEditor,
  onOpenLinkedEvidence,
  // Phase 2.1 — surfaces `DELETE /v1/evidence/:id/relationships/:relId`
  // which already existed in the backend but had no UI affordance.
  // Optional so parents that don't yet wire it continue to render
  // without the Remove button.
  onRemoveRelationship,
  evidenceId,
  onRelationshipEdited,
}: {
  /**
   * EP-0389 — with both of these, each relationship offers Edit (type and
   * note) through PATCH /v1/evidence/:id/relationships/:relationshipId, on the
   * same `canManageRelationships` answer as Remove. The API decides the rest
   * (update_metadata on this record, the link's open end, an open record).
   */
  evidenceId?: string;
  onRelationshipEdited?: () => void | Promise<void>;
  caseName: string | null;
  /**
   * UC-CASE-005 — every linked case the viewer may open (server-filtered).
   * When present it is the authority for the case list and per-case unlink;
   * absent (older API) the single `caseName` alias renders as before.
   */
  cases?: LinkedCase[];
  onRemoveLinkedCase?: (caseId: string) => void;
  relatedEvidenceCount: number | null;
  multipart: boolean;
  itemCount: number;
  note: string | null;
  items: RelationshipItem[];
  actionBusy: boolean;
  /**
   * Phase EVIDENCE-RELATIONSHIPS-GATE — when false (Personal /
   * non-investigation workspaces), the Manage button + per-row
   * Remove buttons are hidden. Items still render as read-only
   * when present. Defaults to `true` for back-compat with any
   * caller that hasn't yet passed it.
   */
  canManageRelationships?: boolean;
  onAssignCase: () => void;
  onRemoveCase: (() => void) | null;
  onOpenRelationshipEditor: () => void;
  onOpenLinkedEvidence: (id: string) => void;
  onRemoveRelationship?: (relationshipId: string) => void | Promise<void>;
}) {
  const { confirm } = useConfirmAction();
  const [editing, setEditing] = useState<{ id: string; type: string; note: string } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const canEdit = Boolean(evidenceId && onRelationshipEdited && canManageRelationships);

  const saveEdit = async () => {
    if (!editing || !evidenceId || editBusy) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/relationships/${encodeURIComponent(editing.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ relationshipType: editing.type, note: editing.note.trim() || null }),
        },
      );
      setEditing(null);
      await onRelationshipEdited?.();
    } catch (err) {
      setEditError(relationshipEditRefusal(err));
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <section
      id="relationships"
      className="evidence-detail-review-section"
      data-evidence-section="case-relationships"
    >
      {/* Case actions stay permission-gated exactly as before: Remove case is
          rendered only when the parent supplies a handler (i.e. a case is
          attached), Manage relationships only where the workspace can manage
          them, and both disable while a mutation is in flight. */}
      <div className="evidence-detail-review-head">
        <h2 className="evidence-detail-review-head__title">Case &amp; relationships</h2>
        <div className="evidence-detail-review-head__actions">
          {/* PRO-E2-09 (WS-ENT) — a case link is a write: offered on the same
              answer as the other relationship writes. */}
          {canManageRelationships ? (
          <button
            type="button"
            className="app-ghost-action"
            onClick={onAssignCase}
            data-evidence-action="assign-case"
          >
            {(cases ? cases.length > 0 : Boolean(caseName)) ? "Reassign case" : "Assign case"}
          </button>
          ) : null}
          {onRemoveCase && !cases ? (
            <button
              type="button"
              className="app-ghost-action evidence-detail-destructive-action"
              onClick={onRemoveCase}
              disabled={actionBusy}
              data-evidence-action="remove-case"
            >
              Remove case
            </button>
          ) : null}
          {canManageRelationships ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={onOpenRelationshipEditor}
              disabled={actionBusy}
              data-evidence-action="manage-relationships"
            >
              Manage relationships
            </button>
          ) : null}
        </div>
      </div>

      {/* Tracks come from the container, so a long case name wraps inside its
          own card and can never widen the grid or push a neighbour. */}
      <div className="evidence-detail-facts-grid" data-evidence-facts-grid>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">
            {cases && cases.length > 1 ? `Linked cases (${cases.length})` : "Case assignment"}
          </span>
          {cases ? (
            cases.length === 0 ? (
              <span className="evidence-detail-fact__value">None (optional)</span>
            ) : (
              <ul className="evidence-detail-case-list" data-evidence-linked-cases>
                {cases.map((c) => (
                  <li key={c.caseId} data-evidence-linked-case={c.caseId}>
                    <span className="evidence-detail-fact__value evidence-detail-fact__value--clamp">
                      {c.caseName || "Untitled case"}
                    </span>
                    {onRemoveLinkedCase ? (
                      <button
                        type="button"
                        className="app-ghost-action evidence-detail-destructive-action"
                        onClick={() => onRemoveLinkedCase(c.caseId)}
                        disabled={actionBusy}
                        data-evidence-action="remove-case"
                        aria-label={`Remove from case ${c.caseName || "Untitled case"}`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <span className="evidence-detail-fact__value evidence-detail-fact__value--clamp">
              {caseName || "None (optional)"}
            </span>
          )}
        </div>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">Related evidence</span>
          <span className="evidence-detail-fact__value">
            {/* The server counts the records in the linked case; with no case
                there is nothing to count — said, not "Not available". */}
            {relatedEvidenceCount != null
              ? `${relatedEvidenceCount} item${relatedEvidenceCount === 1 ? "" : "s"} in this case`
              : "No case linked"}
          </span>
        </div>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">Structure</span>
          <span className="evidence-detail-fact__value">
            {multipart ? "Multipart package" : "Single record"}
          </span>
        </div>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">Item count</span>
          <span className="evidence-detail-fact__value">{String(itemCount)}</span>
        </div>
      </div>

      {/* The server note only ever restates "no relationships yet", which
          the empty state below already says once. */}
      {note && items.length > 0 ? <p className="evidence-detail-review-note">{note}</p> : null}

      <div className="evidence-detail-linked">
        <div className="evidence-detail-review-head evidence-detail-review-head--sub">
          <h3 className="evidence-detail-review-head__title">
            Linked evidence relationships
          </h3>
          {items.length > 0 ? (
            <span className="evidence-detail-review-head__count">{items.length} recorded</span>
          ) : null}
        </div>
        {items.length === 0 ? (
          // Canonical dashed empty state. It reports the absence; it never
          // invents a relationship that the response does not carry.
          <div className="evidence-detail-empty" data-evidence-linked-empty>
            <Unlink size={26} strokeWidth={1.75} aria-hidden="true" />
            <p>No linked evidence relationships recorded.</p>
          </div>
        ) : (
          <div className="evidence-detail-linked-list">
            {items.map((item) => (
              <article key={item.id} className="evidence-detail-linked-card">
                <div className="evidence-detail-linked-card__head">
                  <h4 className="evidence-detail-linked-card__title">
                    {item.linkedEvidence.title}
                  </h4>
                  <span className="app-chip">
                    {item.relationshipType.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="evidence-detail-linked-card__meta">
                  {item.direction === "outbound"
                    ? "Links from this record"
                    : "Links to this record"}{" "}
                  •{" "}
                  {/* F-13 — THE record-status label, never the raw enum. */}
                  {evidenceRecordStatusLabel(item.linkedEvidence.status)}
                </p>
                {item.note ? (
                  <p className="evidence-detail-linked-card__meta">{item.note}</p>
                ) : null}
                {editing?.id === item.id ? (
                  <div className="evidence-detail-linked-card__edit" data-evidence-relationship-edit-form={item.id}>
                    <label className="evidence-detail-field">
                      <span>Relationship type</span>
                      <select
                        className="app-form-input"
                        aria-label="Relationship type"
                        value={editing.type}
                        onChange={(e) => setEditing({ ...editing, type: e.target.value })}
                      >
                        {RELATIONSHIP_TYPES.map((value) => (
                          <option key={value} value={value}>
                            {value.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="evidence-detail-field">
                      <span>Note</span>
                      <textarea
                        className="evidence-detail-textarea"
                        aria-label="Relationship note"
                        maxLength={1000}
                        value={editing.note}
                        onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                      />
                    </label>
                    {editError ? (
                      <p role="alert" className="evidence-detail-muted" data-evidence-relationship-edit-error>
                        {editError}
                      </p>
                    ) : null}
                    <div className="evidence-detail-linked-card__actions">
                      <button
                        type="button"
                        className="app-secondary-action app-secondary-action--filled"
                        onClick={() => void saveEdit()}
                        disabled={editBusy}
                      >
                        {editBusy ? "Saving…" : "Save relationship"}
                      </button>
                      <button
                        type="button"
                        className="app-ghost-action"
                        onClick={() => {
                          setEditing(null);
                          setEditError(null);
                        }}
                        disabled={editBusy}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="evidence-detail-linked-card__actions">
                  <button
                    type="button"
                    className="app-secondary-action"
                    onClick={() => onOpenLinkedEvidence(item.linkedEvidence.id)}
                    aria-label={`Open linked evidence: ${item.linkedEvidence.title}`}
                  >
                    Open linked evidence
                  </button>
                  {canEdit && editing?.id !== item.id ? (
                    <button
                      type="button"
                      className="app-ghost-action"
                      disabled={actionBusy || editBusy}
                      data-evidence-relationship-edit={item.id}
                      onClick={() => {
                        setEditError(null);
                        setEditing({ id: item.id, type: item.relationshipType, note: item.note ?? "" });
                      }}
                    >
                      Edit relationship
                    </button>
                  ) : null}
                  {onRemoveRelationship && canManageRelationships ? (
                    <button
                      type="button"
                      className="app-ghost-action evidence-detail-destructive-action"
                      disabled={actionBusy}
                      data-evidence-relationship-remove={item.id}
                      onClick={() => {
                        // D-3 closure — destructive relationship removal
                        // routed through ConfirmActionModal. The DELETE
                        // endpoint is audited server-side
                        // (RELATIONSHIP_DELETED reviewer-audit event).
                        void (async () => {
                          const ok = await confirm({
                            title: "Remove this relationship?",
                            description: `Remove the "${item.relationshipType.replace(/_/g, " ").toLowerCase()}" relationship with "${item.linkedEvidence.title}"? The linked evidence record itself is not affected.`,
                            confirmLabel: "Remove relationship",
                            tone: "warning",
                            testId: "evidence-relationship-remove",
                          });
                          if (ok) await onRemoveRelationship(item.id);
                        })();
                      }}
                    >
                      Remove relationship
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
