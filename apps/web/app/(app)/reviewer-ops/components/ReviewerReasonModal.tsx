"use client";

/**
 * Phase 2.4 — Structured reviewer reason modal.
 *
 * Replaces the bare `window.prompt(...)` calls in `/reviewer-ops/[reviewId]`
 * (Phase 2.4 read-only audit P0) for the three reviewer actions that
 * require an operator-typed reason:
 *
 *   - request-info  → note (required)
 *   - reject        → rejection note (required)
 *   - pause         → pause reason (required)
 *
 * Hard rules:
 *   - Backend is authoritative. The modal only collects + validates
 *     the reason string client-side before the POST; the route still
 *     enforces transition + permission + length limits.
 *   - Reason is required and bounded to 400 chars (matches the
 *     `case-lifecycle.service.ts` 400-char convention used elsewhere).
 *   - Escape closes ONLY when no submission is in flight.
 *   - Submit is disabled until at least one non-whitespace character
 *     has been typed.
 *   - No PII redaction in this layer — the operator types the text;
 *     audit redaction happens server-side in the existing reviewer-
 *     ops route handlers.
 *   - This component is the SOLE replacement for the
 *     `window.prompt` flow; the parent passes a kind + onSubmit
 *     callback per click.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useId, useRef, useState } from "react";

export type ReviewerReasonKind =
  | "REQUEST_INFO"
  | "REJECT"
  | "PAUSE"
  | "ESCALATION_REASSIGN"
  | "ESCALATION_RESOLVE"
  | "ESCALATION_SUPPRESS";

type ReviewerReasonModalConfig = {
  kind: ReviewerReasonKind;
  title: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  submitLabel: string;
  /**
   * Free-form text input by default. For ESCALATION_REASSIGN we accept
   * a UUID (the new assignee). The modal toggles validation accordingly.
   */
  validateAs?: "text" | "uuid";
};

const CONFIG: Record<ReviewerReasonKind, ReviewerReasonModalConfig> = {
  REQUEST_INFO: {
    kind: "REQUEST_INFO",
    title: "Request more information",
    description:
      "Send the submitter a note explaining what additional information is needed. The submitter sees the workflow state change to NEEDS_INFORMATION.",
    fieldLabel: "Note to submitter",
    placeholder: "e.g. Please share the original capture device's chain-of-custody log.",
    submitLabel: "Send request",
  },
  REJECT: {
    kind: "REJECT",
    title: "Reject this review",
    description:
      "Record a rejection note. This is operator-visible and audited — it is NOT a public verdict.",
    fieldLabel: "Rejection note",
    placeholder: "e.g. Evidence integrity check failed — submitter to re-capture.",
    submitLabel: "Reject",
  },
  PAUSE: {
    kind: "PAUSE",
    title: "Pause this review",
    description:
      "Pause stops the SLA clock until the review resumes. The reason is audited and operator-visible.",
    fieldLabel: "Pause reason",
    placeholder: "e.g. Waiting on outside counsel before continuing.",
    submitLabel: "Pause review",
  },
  ESCALATION_REASSIGN: {
    kind: "ESCALATION_REASSIGN",
    title: "Reassign this escalation",
    description:
      "Move this escalation to a different operator. Enter the new assignee's user id (UUID).",
    fieldLabel: "New assignee user id",
    placeholder: "00000000-0000-4000-8000-000000000000",
    submitLabel: "Reassign",
    validateAs: "uuid",
  },
  ESCALATION_RESOLVE: {
    kind: "ESCALATION_RESOLVE",
    title: "Resolve this escalation",
    description:
      "Record how this escalation was resolved. Resolution notes are operator-visible and audited.",
    fieldLabel: "Resolution note",
    placeholder: "e.g. Submitter clarified intent; review can proceed.",
    submitLabel: "Resolve",
  },
  ESCALATION_SUPPRESS: {
    kind: "ESCALATION_SUPPRESS",
    title: "Suppress this escalation",
    description:
      "Suppression marks the escalation as not actionable. State the reason so future operators can audit the decision.",
    fieldLabel: "Suppression reason",
    placeholder: "e.g. Duplicate of escalation EXM-A12B3C.",
    submitLabel: "Suppress",
  },
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_REASON_LEN = 400;

export function ReviewerReasonModal({
  kind,
  open,
  onCancel,
  onSubmit,
}: {
  kind: ReviewerReasonKind | null;
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputId = useId();

  // Reset state every time the modal opens for a new kind.
  useEffect(() => {
    if (!open) return;
    setValue("");
    setError(null);
    setSubmitting(false);
    // Defer focus to next paint so the textarea exists in the DOM.
    const t = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, kind]);

  // Focus trap + escape handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, submitting, onCancel]);

  const config = kind ? CONFIG[kind] : null;

  const handleSubmit = useCallback(async () => {
    if (!config) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setError(`${config.fieldLabel} is required.`);
      return;
    }
    if (trimmed.length > MAX_REASON_LEN) {
      setError(
        `Keep ${config.fieldLabel.toLowerCase()} under ${MAX_REASON_LEN} characters.`,
      );
      return;
    }
    if (config.validateAs === "uuid" && !UUID_REGEX.test(trimmed)) {
      setError("Enter a valid user id (UUID format).");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      // The parent's onSubmit catches and surfaces server errors via
      // its own state — the modal stays open. We only surface a
      // fallback for synchronous throws (rare).
      setError(
        toSafeUserError(err, { message: "Could not submit." }).message,
      );
    } finally {
      setSubmitting(false);
    }
  }, [config, value, onSubmit]);

  if (!open || !config) return null;

  return (
    <div
      role="presentation"
      data-reviewer-reason-overlay={kind}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(8,18,22,0.72)",
        backdropFilter: "blur(6px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${inputId}-title`}
        aria-describedby={`${inputId}-desc`}
        data-reviewer-reason-modal={kind}
        style={{
          maxWidth: 540,
          width: "100%",
          background:
            "linear-gradient(180deg, rgba(20,30,34,0.98) 0%, rgba(12,20,24,0.98) 100%)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 16,
          color: "#dce1de",
          boxShadow: "0 20px 50px rgba(0,0,0,0.4)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <h2
            id={`${inputId}-title`}
            style={{ margin: 0, fontSize: 16, fontWeight: 700 }}
            data-reviewer-reason-title
          >
            {config.title}
          </h2>
          <p
            id={`${inputId}-desc`}
            style={{ margin: "6px 0 0", fontSize: 13, opacity: 0.85 }}
            data-reviewer-reason-desc
          >
            {config.description}
          </p>
        </header>
        <div style={{ padding: "14px 18px" }}>
          <label
            htmlFor={`${inputId}-input`}
            style={{
              display: "block",
              fontSize: 12,
              fontWeight: 600,
              opacity: 0.85,
              marginBottom: 6,
            }}
          >
            {config.fieldLabel}
          </label>
          <textarea
            id={`${inputId}-input`}
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, MAX_REASON_LEN + 1))}
            disabled={submitting}
            placeholder={config.placeholder}
            data-reviewer-reason-input
            rows={config.validateAs === "uuid" ? 1 : 4}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "inherit",
              fontFamily: config.validateAs === "uuid" ? "monospace" : "inherit",
              fontSize: 13,
              resize: "vertical",
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 11,
              opacity: 0.6,
              marginTop: 6,
            }}
          >
            <span data-reviewer-reason-counter>
              {value.length}/{MAX_REASON_LEN}
            </span>
            <span>Operator-audited. Not public.</span>
          </div>
          {error ? (
            <p
              data-reviewer-reason-error
              style={{
                margin: "8px 0 0",
                padding: "8px 10px",
                background: "rgba(220,70,70,0.10)",
                border: "1px solid rgba(220,70,70,0.30)",
                borderRadius: 8,
                fontSize: 12.5,
              }}
            >
              {error}
            </p>
          ) : null}
        </div>
        <footer
          style={{
            padding: "10px 18px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            data-reviewer-reason-cancel
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "transparent",
              color: "inherit",
              fontSize: 13,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !value.trim()}
            data-reviewer-reason-submit
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.20)",
              background:
                "linear-gradient(180deg, rgba(214,184,157,0.22) 0%, rgba(214,184,157,0.10) 100%)",
              color: "#f5e6d6",
              fontSize: 13,
              fontWeight: 600,
              cursor:
                submitting || !value.trim() ? "not-allowed" : "pointer",
              opacity: submitting || !value.trim() ? 0.6 : 1,
            }}
          >
            {submitting ? "Submitting…" : config.submitLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
