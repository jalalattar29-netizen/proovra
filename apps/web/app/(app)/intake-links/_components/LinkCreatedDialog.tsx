"use client";

/**
 * Intake links — the one-shot secure-link reveal.
 *
 * This is the ONLY moment the raw token exists in the browser. It is held in
 * component state, never persisted, and discarded when the dialog closes — so
 * this is also the only place `POST /:id/send` can be driven, because that
 * endpoint needs the raw token the list projection deliberately never returns.
 *
 * The dialog states, truthfully, what the create call actually did: sent,
 * failed (with the link still created), or nothing sent because the operator
 * chose to share it themselves.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { channelLabel } from "../../../../lib/intake-links/vocabulary";
import type { CreatedIntakeLink } from "../_lib/types";
import { friendlyDeliveryReason } from "../_lib/wizardState";
import { IconClose, IconSpinner } from "./icons";

/** What `POST /v1/workflow/intake-links/:id/send` accepts. */
type SendChannel = "EMAIL" | "SMS";

export function LinkCreatedDialog({
  created,
  intakeUrl,
  onClose,
}: {
  created: CreatedIntakeLink;
  intakeUrl: string;
  onClose: () => void;
}) {
  /*
   * THE CHANNELS A NEW LINK MAY BE SENT ON.
   *
   * Email, SMS, copy link — the same three the create wizard offers and the
   * same three `POST /:id/send` accepts (`z.enum(["SMS", "EMAIL"])`). This
   * dialog still offered "Send by WhatsApp", which had become a button that
   * could only fail: the server stopped accepting the channel when WhatsApp
   * was retired from External Intake, and the wizard stopped offering it, but
   * the one surface that appears immediately AFTER creating a link kept it.
   *
   * Historical rows still RENDER as WhatsApp wherever they are read — the
   * enum, the labels and the delivery history are deliberately untouched, and
   * MFA and general communications keep their WhatsApp support. What is gone
   * is the ability to start a new one from here.
   */
  const [copied, setCopied] = React.useState(false);
  const [sendBusy, setSendBusy] = React.useState<SendChannel | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sentChannel, setSentChannel] = React.useState<SendChannel | null>(
    null,
  );
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const titleId = React.useId();
  const sendingRef = React.useRef(false);

  const { delivery, link, rawToken } = created;
  /*
   * Presence, not the value. The dialog needs to know a channel exists; it has
   * never needed to read the recipient's address or number to decide that, and
   * the projection deliberately gives it only the booleans.
   *
   * Email is offered here for the first time. The send endpoint has always
   * accepted it and a link created with an email recipient had no way to be
   * sent from this dialog at all — the operator had to close it, losing the
   * one-shot token, and start again.
   */
  const canSendSms = link.hasRecipientPhone === true;
  const canSendEmail = link.hasRecipientEmail === true;
  const canSend = canSendSms || canSendEmail;

  React.useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  async function send(channel: SendChannel) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSendError(null);
    setSendBusy(channel);
    try {
      await apiFetch(
        `/v1/workflow/intake-links/${encodeURIComponent(link.id)}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel, rawToken, intakeUrl }),
        },
      );
      setSentChannel(channel);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const map: Record<string, string> = {
        link_missing_phone:
          "Add a recipient phone number to the link before sending.",
        link_missing_email:
          "Add a recipient email address to the link before sending.",
        link_revoked: "This link has been disabled.",
        link_expired: "This link has already expired.",
        provider_unconfigured:
          "Messaging isn't configured on this deployment. Copy the link instead.",
      };
      setSendError(
        map[e?.code ?? ""] ??
          toSafeUserError(e, { message: "Couldn't send the link." }).message,
      );
    } finally {
      sendingRef.current = false;
      setSendBusy(null);
    }
  }

  return (
    <div className="app-dialog-overlay" data-intake-link-created-overlay>
      <div
        ref={dialogRef}
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="intake-link-created"
      >
        <header className="app-dialog__head">
          <div>
            <h2 className="app-dialog__title" id={titleId}>
              Secure link created
            </h2>
            <p className="app-dialog__subtitle">
              This link is shown once. Copy or send it now — after you close
              this dialog the only way to share it is to create a new link.
            </p>
          </div>
          <button
            type="button"
            className="app-ghost-action"
            onClick={onClose}
            aria-label="Close secure link dialog"
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="app-dialog__body">
          {delivery.status === "sent" ? (
            <p
              className="app-alert app-alert--ok"
              role="status"
              data-intake-link-delivery-result="sent"
            >
              <AppStatusBadge tone="green">Sent</AppStatusBadge> Handed to the
              provider via {channelLabel(delivery.method)}. Track it under
              Delivery history on the link.
            </p>
          ) : null}
          {delivery.status === "failed" ? (
            <p
              className="app-alert app-alert--danger"
              role="alert"
              data-intake-link-delivery-result="failed"
            >
              Delivery failed on {channelLabel(delivery.method)}
              {delivery.reason
                ? ` — ${friendlyDeliveryReason(delivery.reason)}`
                : ""}
              . The link itself was created: copy it below, or retry from
              Delivery history.
            </p>
          ) : null}
          {delivery.status === "skipped" ? (
            <p
              className="app-alert"
              role="status"
              data-intake-link-delivery-result="skipped"
            >
              Nothing was sent — you chose to share this link yourself.
            </p>
          ) : null}

          <div className="ilk-field">
            <label className="app-field-label" htmlFor="ilk-created-url">
              Secure link
            </label>
            <div className="ilk-secret">
              <input
                id="ilk-created-url"
                className="app-form-input ilk-secret__value"
                readOnly
                value={intakeUrl}
                onFocus={(e) => e.currentTarget.select()}
                data-intake-link-url
              />
              <button
                type="button"
                className="app-secondary-action"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(intakeUrl);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
                data-intake-link-copy
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <p className="app-field-help">
              Anyone with this link can upload until it expires. Ask the
              recipient not to forward it.
            </p>
          </div>

          {sendError ? (
            <p
              className="app-alert app-alert--danger"
              role="alert"
              data-intake-link-send-error
            >
              {sendError}
            </p>
          ) : null}
          {sentChannel ? (
            <p
              className="app-alert app-alert--ok"
              role="status"
              data-intake-link-send-success
            >
              Queued for {channelLabel(sentChannel)} delivery. Track it under
              Delivery history.
            </p>
          ) : null}

          {/*
            One action per channel the link HAS a recipient for. A link with
            only an address offers only Email; one with only a number offers
            only SMS; one with both offers both. Copy link is above and is
            always available, because it is the only way to share a link the
            operator means to hand over themselves.
          */}
          {canSend ? (
            <div className="ilk-card__foot">
              {canSendEmail ? (
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => void send("EMAIL")}
                  disabled={sendBusy !== null}
                  aria-busy={sendBusy === "EMAIL" || undefined}
                  data-intake-link-send="EMAIL"
                >
                  {sendBusy === "EMAIL" ? <IconSpinner size={14} /> : null}
                  <span>
                    {sendBusy === "EMAIL" ? "Sending…" : "Send by email"}
                  </span>
                </button>
              ) : null}
              {canSendSms ? (
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => void send("SMS")}
                  disabled={sendBusy !== null}
                  aria-busy={sendBusy === "SMS" || undefined}
                  data-intake-link-send="SMS"
                >
                  {sendBusy === "SMS" ? <IconSpinner size={14} /> : null}
                  <span>{sendBusy === "SMS" ? "Sending…" : "Send by SMS"}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="app-dialog__footer">
          <button
            type="button"
            className="app-primary-action"
            onClick={onClose}
            data-intake-link-created-done
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

export default LinkCreatedDialog;
