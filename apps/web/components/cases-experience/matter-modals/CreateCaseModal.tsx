"use client";

/**
 * Phase 2.1 — Create Case modal.
 *
 * Wires `POST /v1/cases` (which already existed in the backend) to a
 * canonical UI affordance on the Cases page. Closes the read-only audit's
 * P0 finding: "Cases page has no Create Case CTA".
 *
 * Behaviour:
 *   - Validates `name` (1..120 chars, matching backend `CreateCaseBody`).
 *   - Passes `teamId` from the platform context (Cases is team-scoped;
 *     the modal does not show in personal-space mode).
 *   - On success: invokes `onCreated(caseId)` so the parent can
 *     navigate or reload the queue.
 *   - On 403: surfaces a `PERMISSION_REQUIRED` AccessGate inline.
 *   - On 409 LEGAL_REACCEPT_REQUIRED: surfaces a REQUEST_ACCESS gate.
 *   - On 402 / plan errors: surfaces a PLAN_UPGRADE gate.
 *   - On other errors: bounded error message with requestId.
 *
 * Backend authority is preserved: the POST is gated server-side
 * (auth + legal + team membership). UI only renders the affordance;
 * it never simulates permission.
 */

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useState } from "react";

import { apiFetch } from "../../../lib/api";
import { AccessGate, classifyAccessError } from "../../access/AccessGate";
import { Modal } from "./Modal";

type CreateCaseResponse = {
  id: string;
  name: string;
  teamId: string | null;
};

export function CreateCaseModal({
  open,
  teamId,
  onClose,
  onCreated,
}: {
  open: boolean;
  teamId: string;
  onClose: () => void;
  onCreated: (newCase: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorState, setErrorState] = useState<null | {
    kind: "gate" | "message";
    gate?: ReturnType<typeof classifyAccessError>;
    message?: string;
    requestId?: string;
  }>(null);

  const reset = () => {
    setName("");
    setSubmitting(false);
    setErrorState(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setErrorState({ kind: "message", message: "Case name is required." });
      return;
    }
    if (trimmed.length > 120) {
      setErrorState({
        kind: "message",
        message: "Case name must be 120 characters or fewer.",
      });
      return;
    }
    setSubmitting(true);
    setErrorState(null);
    try {
      const created = (await apiFetch("/v1/cases", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, teamId }),
      })) as CreateCaseResponse;
      reset();
      onCreated({ id: created.id, name: created.name });
    } catch (err) {
      const e = err as {
        statusCode?: number;
        message?: string;
        body?: { requestId?: string };
      };
      const gate = classifyAccessError(err);
      if (gate) {
        setErrorState({ kind: "gate", gate });
      } else {
        setErrorState({
          kind: "message",
          message: toSafeUserError(e, { message: "Could not create case" }).message,
          requestId: e.body?.requestId,
        });
      }
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create case"
      description="Create a new investigation matter in this workspace."
      testid="create-case-modal"
      footer={
        <>
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            data-create-case-cancel
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 600,
              background: "rgba(255,255,255,0.78)",
              border: "1px solid rgba(79,70,229,0.18)",
              color: "#4F46E5",
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-case-form"
            disabled={submitting || name.trim().length === 0}
            data-create-case-submit
            className="cases-create-submit"
            style={{
              // §7 — distinct disabled (soft lavender, no dimming shadow)
              // vs enabled (#5B4FE9) states; hover handled by the class.
              padding: "0 16px",
              height: 40,
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 650,
              background:
                submitting || name.trim().length === 0 ? "#C9C5F4" : "#5B4FE9",
              border: "1px solid transparent",
              color:
                submitting || name.trim().length === 0
                  ? "rgba(255,255,255,0.9)"
                  : "#ffffff",
              cursor:
                submitting || name.trim().length === 0 ? "default" : "pointer",
              boxShadow: "none",
            }}
          >
            {submitting ? "Creating…" : "Create case"}
          </button>
        </>
      }
    >
      <form id="create-case-form" onSubmit={handleSubmit}>
        <label
          htmlFor="create-case-name"
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            color: "#172033",
            marginBottom: 6,
          }}
        >
          Case name
        </label>
        <input
          id="create-case-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Insurance claim #4823"
          maxLength={120}
          required
          disabled={submitting}
          data-create-case-name
          className="cases-form-input"
          style={{
            // §7 — 46px field height; the shared class owns the border,
            // background, radius, placeholder and the lavender focus ring
            // (no green/teal focus, matching the Case details field).
            height: 46,
            padding: "0 12px",
            fontSize: 14,
          }}
        />
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 12,
            color: "#64748B",
          }}
        >
          You can rename the case from its workspace at any time. Evidence,
          assignments, and comments are added after creation.
        </p>

        {errorState?.kind === "gate" && errorState.gate ? (
          <div style={{ marginTop: 14 }}>
            <AccessGate
              kind={errorState.gate}
              surface="Create case"
              variant="inline"
            />
          </div>
        ) : null}

        {errorState?.kind === "message" && errorState.message ? (
          <div
            data-create-case-error
            role="alert"
            style={{
              marginTop: 14,
              padding: "10px 12px",
              background: "rgba(185, 56, 62, 0.08)",
              border: "1px solid rgba(185, 56, 62, 0.30)",
              borderRadius: 8,
              color: "#B9383E",
              fontSize: 13,
            }}
          >
            {errorState.message}
            {errorState.requestId ? (
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                Request ID: {errorState.requestId}
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
