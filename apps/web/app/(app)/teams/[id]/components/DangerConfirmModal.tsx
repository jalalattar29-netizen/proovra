"use client";

/**
 * Phase 2.6B — Reusable destructive confirmation modal.
 *
 * Replaces remaining raw `window.confirm("...")` calls in
 * /teams/[id]/page.tsx with a structured dialog that:
 *
 *   - Shows the consequence in plain language, not just a yes/no.
 *   - Uses the existing Modal primitive so focus-trap + Escape +
 *     scroll-lock behavior matches every other dialog in the app.
 *   - Renders explicit Cancel + Confirm buttons; never relies on the
 *     browser's confirm() native chrome.
 *   - Surfaces loading state during the underlying mutation.
 *   - Optionally surfaces an inline error if onConfirm throws.
 *
 * Hard rules:
 *   - This component is INTENTIONALLY generic. It does not know what
 *     the destructive action is — the caller supplies the labels,
 *     consequence text, and `onConfirm` async handler. Each call site
 *     owns the wording so the consequences match the action.
 *   - The Confirm button is disabled while `pending` is true. Escape
 *     and outside-click are blocked while pending so a user can't
 *     dismiss the dialog mid-mutation.
 *   - This is NOT a Phase 2.2 MemberRemovalDialog replacement. Member
 *     removal has its own dialog that fetches a removal-impact
 *     envelope before showing the form. This modal is for SIMPLE
 *     destructive operations (revoke an invite, unlink a case) where
 *     there's no pre-flight read to perform.
 */

import { useCallback, useState } from "react";
import { Modal } from "../../../../../components/cases-experience/matter-modals/Modal";
import { Button } from "../../../../../components/ui";

export type DangerConfirmModalProps = {
  open: boolean;
  title: string;
  /**
   * Plain-language explanation of what happens when the user
   * confirms. Should describe the SAFEST honest consequence — e.g.
   * "Invited member will lose the email link" rather than just
   * "Are you sure?".
   */
  description: string;
  /**
   * Optional sub-text rendered below the description in a muted
   * tone. Used for "no rollback available" type warnings.
   */
  caveat?: string;
  /** Label for the destructive confirm button. */
  confirmLabel: string;
  /** Optional override for the cancel button label. */
  cancelLabel?: string;
  /**
   * Test id passed down to the Modal primitive. Defaults to
   * `team-danger-confirm` if not provided.
   */
  testid?: string;
  onCancel: () => void;
  /**
   * Returns a Promise; the modal stays open until the promise
   * settles. If the handler rejects, the error message is surfaced
   * inline and the modal remains open so the user can retry.
   */
  onConfirm: () => Promise<void>;
};

export function DangerConfirmModal({
  open,
  title,
  description,
  caveat,
  confirmLabel,
  cancelLabel = "Cancel",
  testid = "team-danger-confirm",
  onCancel,
  onConfirm,
}: DangerConfirmModalProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      const msg =
        (err as { message?: string })?.message ??
        "Could not complete the action. Try again.";
      setError(msg);
    } finally {
      setPending(false);
    }
  }, [onConfirm]);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!pending) onCancel();
      }}
      title={title}
      description={description}
      testid={testid}
      dismissDisabled={pending}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={pending}
            data-danger-confirm-cancel
          >
            {cancelLabel}
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={pending}
            data-danger-confirm-submit
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div data-danger-confirm-body>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            lineHeight: 1.5,
          }}
          data-danger-confirm-description
        >
          {description}
        </p>
        {caveat ? (
          <p
            style={{
              margin: "10px 0 0",
              fontSize: 12.5,
              lineHeight: 1.5,
              opacity: 0.75,
            }}
            data-danger-confirm-caveat
          >
            {caveat}
          </p>
        ) : null}
        {error ? (
          <p
            data-danger-confirm-error
            style={{
              margin: "12px 0 0",
              padding: "8px 10px",
              background: "rgba(220, 70, 70, 0.10)",
              border: "1px solid rgba(220, 70, 70, 0.30)",
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
