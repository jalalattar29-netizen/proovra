"use client";

/**
 * Intake links wizard — message preview.
 *
 * A REVIEW surface, not a textarea. It imports the SAME renderers the API
 * uses, so what the operator reads is what the recipient receives, with one
 * deliberate difference: the secure link is a visible `[secure-link]`
 * placeholder because the real token does not exist until the create call
 * returns. Nothing here sends anything, and the body is not editable — the
 * create contract has no field for an operator-authored body.
 */

import * as React from "react";

import {
  renderIntakeEmailMessage,
  renderIntakeSmsMessage,
  renderIntakeWhatsappMessage,
  resolveIntakeSenderDisplay,
  type IntakeSenderDisplayMode,
} from "@proovra/shared";

import { formatUserDateTime } from "../../../../../lib/date";
import { channelCarriesOptOut } from "../../../../../lib/intake-links/catalog";
import { channelLabel } from "../../../../../lib/intake-links/vocabulary";
import type { SenderTransportInfo } from "../../_lib/types";

export const PLACEHOLDER_INTAKE_URL =
  "https://app.proovra.com/intake/[secure-link]";

export type PreviewChannel = "EMAIL" | "SMS" | "WHATSAPP";

export function resolvePreviewSender(input: {
  senderMode: IntakeSenderDisplayMode;
  senderName: string;
  workspaceName: string;
}): string {
  // An invalid custom name must not crash the preview; the step gate already
  // stops the actual send, and falling back keeps the panel readable while the
  // operator is still typing.
  try {
    return resolveIntakeSenderDisplay({
      mode: input.senderMode,
      workspaceName: input.workspaceName,
      customName: input.senderName || "Your business",
    }).display;
  } catch {
    return resolveIntakeSenderDisplay({ mode: "PROOVRA" }).display;
  }
}

export function transportSummary(
  channel: PreviewChannel,
  transport: SenderTransportInfo | null,
): string {
  if (!transport) return "Checking provider…";
  const t =
    channel === "EMAIL"
      ? transport.email
      : channel === "SMS"
        ? transport.sms
        : transport.whatsapp;
  if (!t?.configured) return "Not configured on this deployment";
  if (channel === "EMAIL") {
    return `${t.fromName ?? "PROOVRA"} <${t.fromAddressPreview ?? "no-reply@proovra.com"}>`;
  }
  if (channel === "SMS") {
    return t.fromNumberPreview
      ? `PROOVRA via ${t.fromNumberPreview}`
      : "PROOVRA";
  }
  return t.fromNumberPreview
    ? `PROOVRA WhatsApp via ${t.fromNumberPreview}`
    : "PROOVRA WhatsApp";
}

export function MessagePreview({
  channel,
  senderMode,
  senderName,
  workspaceName,
  requestTypeSlug,
  recipientLabel,
  recipientTarget,
  expiresAt,
  transport,
}: {
  channel: PreviewChannel;
  senderMode: IntakeSenderDisplayMode;
  senderName: string;
  workspaceName: string;
  requestTypeSlug: string;
  recipientLabel: string;
  /** The masked address or number the message would go to. */
  recipientTarget: string;
  expiresAt: Date;
  transport: SenderTransportInfo | null;
}) {
  const senderDisplay = resolvePreviewSender({
    senderMode,
    senderName,
    workspaceName,
  });

  const renderInput = {
    senderDisplay,
    requestTypeSlug,
    recipientLabel: recipientLabel || null,
    intakeUrl: PLACEHOLDER_INTAKE_URL,
    expiresAtUtc: expiresAt.toISOString(),
    channel,
    locale: "en" as const,
  };

  let subject: string | null = null;
  let body = "";
  if (channel === "EMAIL") {
    const rendered = renderIntakeEmailMessage(renderInput);
    subject = rendered.subject;
    body = rendered.text;
  } else if (channel === "SMS") {
    body = renderIntakeSmsMessage(renderInput);
  } else {
    body = renderIntakeWhatsappMessage(renderInput);
  }

  return (
    <section
      className="ilk-preview"
      data-intake-link-preview-studio="true"
      data-intake-link-preview-channel={channel}
      aria-label="Message preview"
    >
      <h3 className="ilk-preview__title">Message preview</h3>
      <dl className="ilk-preview__meta">
        <div>
          <dt>Appears from</dt>
          <dd data-intake-link-preview-sender-display="true">{senderDisplay}</dd>
        </div>
        <div>
          <dt>Sent via</dt>
          <dd
            data-intake-link-preview-transport="true"
            data-intake-link-preview-transport-configured={
              transport
                ? transport[
                    channel === "EMAIL"
                      ? "email"
                      : channel === "SMS"
                        ? "sms"
                        : "whatsapp"
                  ]?.configured
                  ? "true"
                  : "false"
                : "unknown"
            }
          >
            <span className="ilk-ltr">{transportSummary(channel, transport)}</span>
          </dd>
        </div>
        <div>
          <dt>Goes to</dt>
          <dd>
            <span className="ilk-ltr">{recipientTarget || "—"}</span>
          </dd>
        </div>
        <div>
          <dt>Channel</dt>
          <dd>{channelLabel(channel)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            <span className="ilk-ltr">{formatUserDateTime(expiresAt)}</span>
          </dd>
        </div>
      </dl>

      {subject ? (
        <dl className="ilk-preview__meta">
          <div>
            <dt>Subject</dt>
            <dd data-intake-link-preview-subject="true">{subject}</dd>
          </div>
        </dl>
      ) : null}

      <pre className="ilk-preview__body" data-intake-link-preview-body="true">
        {body}
      </pre>

      <p className="ilk-preview__note" data-intake-link-preview-only>
        Preview only. Nothing is sent until you create the link, and the secure
        link shown as <span className="ilk-ltr">[secure-link]</span> is
        generated at that moment.
      </p>
      <p className="ilk-preview__note">
        No account is required to upload. Ask the recipient not to forward the
        link.
        {channelCarriesOptOut(channel)
          ? " Carrier rules add the STOP opt-out line to SMS."
          : ""}
      </p>
    </section>
  );
}

export default MessagePreview;
