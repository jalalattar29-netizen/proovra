"use client";

/**
 * NEW-RG-19-1 (owner decision G) / closure phase 2 — the recipient contact of
 * an evidence request, masked, with an audited reveal for authorized users.
 *
 * The request projection always carries the contact MASKED
 * (`recipientEmailMasked` / `recipientPhoneMasked`) and says, from the one
 * canonical disclosure decision, whether this reader may reveal it
 * (`recipientContactRevealAuthorized`). The UI decides nothing of its own:
 *
 *   - a request sent through an intake link reveals on that link's own route
 *     (the intake-link card), so no button is offered here — and the API would
 *     answer 409 REVEAL_VIA_INTAKE_LINK if one were pressed;
 *   - a reader the projection does not authorize is offered no button;
 *   - "Reveal contact" posts POST /v1/evidence-requests/:id/recipient-contact
 *     through the step-up flow (a fresh challenge bound to THIS request); the
 *     API audits the disclosure before it answers;
 *   - the revealed values live only in this component's state, are hidden
 *     again after REVEAL_VISIBLE_MS or on "Hide", and are never written to the
 *     list, the URL or storage.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  StepUpModal,
  isStepUpCancelled,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";

/** How long a revealed contact stays on screen. */
export const REVEAL_VISIBLE_MS = 60_000;

export type RecipientContactRequest = {
  id: string;
  teamId: string;
  intakeLinkId: string | null;
  recipientEmailMasked?: string | null;
  recipientPhoneMasked?: string | null;
  hasRecipientEmail?: boolean;
  hasRecipientPhone?: boolean;
  recipientContactRevealAuthorized?: boolean;
};

/** The sentence for a refused reveal, from the API's own answer. */
export function contactRevealRefusal(err: unknown): string {
  const e = err as { code?: string; statusCode?: number } | null;
  if (e?.code === "REVEAL_VIA_INTAKE_LINK") {
    return "This request was sent through an intake link. Reveal the recipient's contact on that intake link.";
  }
  if (e?.statusCode === 403) {
    return "Your role does not include revealing recipient contact details in this workspace. Nothing was revealed.";
  }
  if (e?.statusCode === 404 || e?.code === "request_not_found") {
    return "This request is no longer available to you.";
  }
  return toSafeUserError(err, { message: "The contact could not be revealed." }).message;
}

export function EvidenceRequestRecipientContact({ request }: { request: RecipientContactRequest }) {
  const stepUp = useStepUpAction({ teamId: request.teamId });
  const [revealed, setRevealed] = useState<{ email: string | null; phone: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRevealed(null);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // A different request never inherits a revealed value.
  useEffect(() => {
    hide();
    setError(null);
  }, [request.id, hide]);

  const hasContact = Boolean(request.hasRecipientEmail || request.hasRecipientPhone);
  if (!hasContact) return null;

  const offerReveal = request.recipientContactRevealAuthorized === true && !request.intakeLinkId;

  const reveal = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await stepUp.runStepUpAction((headers) =>
        apiFetch(`/v1/evidence-requests/${encodeURIComponent(request.id)}/recipient-contact`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: "{}",
        }),
      )) as { recipientContact?: { recipientEmail: string | null; recipientPhone: string | null } };
      setRevealed({
        email: res?.recipientContact?.recipientEmail ?? null,
        phone: res?.recipientContact?.recipientPhone ?? null,
      });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setRevealed(null);
      }, REVEAL_VISIBLE_MS);
    } catch (err) {
      if (!isStepUpCancelled(err)) setError(contactRevealRefusal(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-evidence-request-recipient-contact
      style={{ marginTop: 16, padding: 12, border: "1px solid #e2e8f0", borderRadius: 8 }}
    >
      <strong style={{ fontSize: 14 }}>Recipient contact</strong>
      <dl style={{ margin: "6px 0", fontSize: 13, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" }}>
        {request.hasRecipientEmail ? (
          <>
            <dt>Email</dt>
            <dd style={{ margin: 0 }} data-recipient-email={revealed ? "revealed" : "masked"}>
              {revealed?.email ?? request.recipientEmailMasked ?? "Hidden"}
            </dd>
          </>
        ) : null}
        {request.hasRecipientPhone ? (
          <>
            <dt>Phone</dt>
            <dd style={{ margin: 0 }} data-recipient-phone={revealed ? "revealed" : "masked"}>
              {revealed?.phone ?? request.recipientPhoneMasked ?? "Hidden"}
            </dd>
          </>
        ) : null}
      </dl>
      {request.intakeLinkId ? (
        <p style={{ fontSize: 12, color: "#64748b", margin: 0 }} data-recipient-contact-via-link>
          This request was sent through an intake link; the full contact is revealed on that intake link.
        </p>
      ) : null}
      {offerReveal ? (
        revealed ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#64748b" }} role="status">
              Shown for one minute. The reveal is recorded in the workspace audit log.
            </span>
            <button type="button" className="app-secondary-action" onClick={hide} data-recipient-contact-hide>
              Hide
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="app-secondary-action"
            onClick={() => void reveal()}
            disabled={busy}
            data-recipient-contact-reveal
          >
            {busy ? "Revealing…" : "Reveal contact"}
          </button>
        )
      ) : null}
      {error ? (
        <p role="alert" style={{ fontSize: 12.5, color: "#991b1b", margin: "6px 0 0" }} data-recipient-contact-error>
          {error}
        </p>
      ) : null}
      <StepUpModal control={stepUp} />
    </section>
  );
}
