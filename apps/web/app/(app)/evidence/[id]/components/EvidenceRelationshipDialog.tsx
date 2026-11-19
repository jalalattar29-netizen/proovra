"use client";

/**
 * The "Record evidence relationship" dialog of the evidence detail page.
 *
 * Extracted from page.tsx (remediation integration, 2026-11-19) so the page
 * stays an orchestrator under its byte guard: the dialog owns its own draft
 * (target record, type, note) and its save, and tells the page only that it
 * closed or saved. Markup, copy, test ids and the request are unchanged.
 */

import { useState } from "react";

import { AppListbox } from "../../../../../components/app-primitives";
import { Modal as PortalModal } from "../../../../../components/cases-experience/matter-modals/Modal";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { captureException } from "../../../../../lib/sentry";

export function EvidenceRelationshipDialog({
  open,
  evidenceId,
  actionBusy,
  setActionBusy,
  addToast,
  onClose,
  onSaved,
}: {
  open: boolean;
  evidenceId: string;
  /** The page's one pending flag: every dialog on the route shares it. */
  actionBusy: boolean;
  setActionBusy: (busy: boolean) => void;
  addToast: (message: string, tone: "success" | "error") => void;
  onClose: () => void;
  /** Reload the record after a relationship was recorded. */
  onSaved: () => Promise<unknown> | unknown;
}) {
  const [relationshipTargetId, setRelationshipTargetId] = useState("");
  const relationshipTargetIsSelf =
    Boolean(evidenceId) &&
    relationshipTargetId.trim().toLowerCase() === String(evidenceId).toLowerCase();
  const [relationshipType, setRelationshipType] = useState("RELATED");
  const [relationshipNote, setRelationshipNote] = useState("");

  const saveRelationship = async () => {
    if (!evidenceId || !relationshipTargetId) return;
    setActionBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/relationships`, {
        method: "POST",
        body: JSON.stringify({
          targetEvidenceId: relationshipTargetId,
          relationshipType,
          note: relationshipNote || null,
        }),
      });
      addToast("Relationship recorded", "success");
      onClose();
      setRelationshipTargetId("");
      setRelationshipType("RELATED");
      setRelationshipNote("");
      await onSaved();
    } catch (saveError) {
      captureException(saveError, {
        feature: "web_evidence_relationship_create",
        evidenceId,
      });
      addToast(
        toSafeUserError(saveError, { message: "Failed to create relationship" }).message,
        "error",
      );
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <PortalModal
      open={open}
      testid="evidence-relationship"
      dismissDisabled={actionBusy}
      onClose={onClose}
      title="Record evidence relationship"
      footer={
        <>
          <button type="button" className="app-secondary-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="app-primary-action"
            onClick={() => void saveRelationship()}
            disabled={actionBusy || !relationshipTargetId.trim() || relationshipTargetIsSelf}
            aria-describedby={
              relationshipTargetIsSelf || !relationshipTargetId.trim()
                ? "evidence-relationship-target-reason"
                : undefined
            }
          >
            Save relationship
          </button>
        </>
      }
    >
      <div className="evidence-detail-modal-stack">
        <p className="evidence-detail-muted">
          Enter the linked evidence record ID. The target must be an accessible
          evidence record.
        </p>
        <input
          className="evidence-detail-input"
          value={relationshipTargetId}
          onChange={(event) => setRelationshipTargetId(event.target.value)}
          placeholder="Linked evidence ID"
          aria-label="Linked evidence record ID"
          aria-invalid={relationshipTargetIsSelf || undefined}
        />
        {/* PV-DEFECT-001 — the server refuses a self-link (400
            EVIDENCE_RELATIONSHIP_SELF_LINK); saying so before the request is
            the same rule, stated where the operator is typing. */}
        <p
          id="evidence-relationship-target-reason"
          className="evidence-detail-muted"
          role={relationshipTargetIsSelf ? "alert" : undefined}
          data-evidence-relationship-reason={
            relationshipTargetIsSelf ? "self" : !relationshipTargetId.trim() ? "empty" : undefined
          }
        >
          {relationshipTargetIsSelf
            ? "A record can't be linked to itself. Enter a different evidence record ID."
            : !relationshipTargetId.trim()
              ? "Enter the ID of the record to link before saving."
              : null}
        </p>
        <label className="evidence-detail-field">
          <span>Relationship type</span>
          <AppListbox
            value={relationshipType}
            ariaLabel="Relationship type"
            onChange={(next) => setRelationshipType(next)}
            options={[
              "RELATED",
              "SUPPORTS",
              "DUPLICATE_OF",
              "DERIVED_FROM",
              "SAME_INCIDENT",
              "CONTRADICTS",
              "REPLACES",
              "REFERENCES",
            ].map((value) => ({ value, label: value.replace(/_/g, " ") }))}
          />
        </label>
        <label className="evidence-detail-field">
          <span>Note</span>
          <textarea
            className="evidence-detail-textarea"
            value={relationshipNote}
            onChange={(event) => setRelationshipNote(event.target.value)}
          />
        </label>
      </div>
    </PortalModal>
  );
}
