/**
 * INTAKE-LINK DELIVERY HISTORY (T-15) — the native port of
 * `apps/web/app/(app)/intake-links/_components/DeliveryHistoryDrawer.tsx`.
 *
 * GET /v1/communications/messages?teamId&relatedIntakeLinkId&limit=50 lists
 * every Email/SMS attempt for one link; POST /v1/communications/messages/:id/retry
 * re-drives an attempt the provider already has. There is deliberately no
 * "resend" that composes a new message: the secure token is unrecoverable after
 * creation, so such a control could not do what it says.
 *
 * The state model and wording are the web's (lib/intake-links/state-model.ts
 * getDeliveryState, vocabulary.ts DELIVERY_STATE_VOCABULARY), verbatim.
 */
import type { ProovraStatusTone } from "@proovra/ui";

export function buildIntakeDeliveriesPath(teamId: string, linkId: string): string {
  return `/v1/communications/messages?teamId=${encodeURIComponent(teamId)}&relatedIntakeLinkId=${encodeURIComponent(linkId)}&limit=50`;
}
export function buildDeliveryRetryPath(messageId: string): string {
  return `/v1/communications/messages/${encodeURIComponent(messageId)}/retry`;
}

export interface DeliveryMessage {
  id: string;
  channel: string;
  status: string;
  recipientPreview: string | null;
  attemptCount: number;
  createdAt: string | null;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
  nextAttemptAtUtc: string | null;
  errorCode: string | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseDeliveryMessages(payload: unknown): DeliveryMessage[] {
  const list = o(payload)["messages"];
  const out: DeliveryMessage[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = o(raw);
    const id = s(m["id"]);
    if (!id) continue;
    out.push({
      id,
      channel: s(m["channel"]) ?? "",
      status: (s(m["status"]) ?? "").toUpperCase(),
      recipientPreview: s(m["recipientPreview"]),
      attemptCount: typeof m["attemptCount"] === "number" ? (m["attemptCount"] as number) : 0,
      createdAt: s(m["createdAt"]),
      sentAtUtc: s(m["sentAtUtc"]),
      deliveredAtUtc: s(m["deliveredAtUtc"]),
      failedAtUtc: s(m["failedAtUtc"]),
      nextAttemptAtUtc: s(m["nextAttemptAtUtc"]),
      errorCode: s(m["errorCode"]),
    });
  }
  return out;
}

export type DeliveryState = "NOT_SENT" | "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "RETRY_SCHEDULED";

/** state-model.ts getDeliveryState, verbatim. */
export function deliveryStateOf(status: string): DeliveryState {
  switch (status.toUpperCase()) {
    case "DELIVERED":
      return "DELIVERED";
    case "FAILED":
    case "UNDELIVERED":
    case "CANCELLED":
      return "FAILED";
    case "RETRY_SCHEDULED":
      return "RETRY_SCHEDULED";
    case "SENT":
      return "SENT";
    case "QUEUED":
      return "QUEUED";
    default:
      return "NOT_SENT";
  }
}

/** DELIVERY_STATE_VOCABULARY, verbatim (web tone → native badge tone). */
export const DELIVERY_VOCABULARY: Record<DeliveryState, { label: string; tone: ProovraStatusTone; explanation: string }> = {
  NOT_SENT: { label: "Not sent", tone: "risk", explanation: "No message was sent — the link is shared manually." },
  QUEUED: {
    label: "With provider",
    tone: "verified",
    explanation: "Queued with the provider — the provider accepted the message and has not handed it off yet.",
  },
  SENT: { label: "Sent to provider", tone: "verified", explanation: "The provider accepted the send; delivery is not confirmed." },
  DELIVERED: { label: "Delivered", tone: "verified", explanation: "The provider confirmed delivery to the recipient." },
  FAILED: { label: "Failed", tone: "risk", explanation: "The provider rejected or could not deliver the message." },
  RETRY_SCHEDULED: { label: "Retry scheduled", tone: "pending", explanation: "Delivery failed and another attempt is scheduled." },
};

/** The raw statuses the web offers "Retry now" for. */
export function canRetryDelivery(status: string): boolean {
  const st = status.toUpperCase();
  return st === "RETRY_SCHEDULED" || st === "FAILED" || st === "UNDELIVERED";
}

/** vocabulary.ts providerErrorCodeLabel, verbatim. */
export function providerErrorCodeLabel(code: string): string {
  switch (code) {
    case "63016":
      return "WhatsApp template required or not approved.";
    case "63015":
      return "WhatsApp recipient is not opted in / sandbox not joined.";
    case "63018":
      return "WhatsApp recipient blocked the sender.";
    case "63003":
      return "WhatsApp number is not a valid recipient.";
    case "30007":
      return "Carrier filtered the message as spam.";
    case "30008":
      return "Carrier reported the message as undeliverable.";
    default:
      return `code ${code}`;
  }
}

/** vocabulary.ts CHANNEL_LABEL (WhatsApp is read-only history — sending it was retired). */
export function deliveryChannelLabel(channel: string): string {
  const c = channel.toUpperCase();
  return c === "EMAIL" ? "Email" : c === "SMS" ? "SMS" : c === "WHATSAPP" ? "WhatsApp" : "Copy link";
}

/** The web's timestamp line, or its fallback sentence. */
export function deliveryTimeline(m: DeliveryMessage, rel: (iso: string) => string): string {
  return (
    [
      m.sentAtUtc ? `Sent ${rel(m.sentAtUtc)}` : "",
      m.deliveredAtUtc ? `Delivered ${rel(m.deliveredAtUtc)}` : "",
      m.failedAtUtc ? `Failed ${rel(m.failedAtUtc)}` : "",
      m.nextAttemptAtUtc ? `Next retry ${rel(m.nextAttemptAtUtc)}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "No provider timestamps recorded."
  );
}

export const DELIVERY_HISTORY_COPY = {
  title: "Delivery history",
  loadFailed: "Couldn't load delivery history.",
  loading: "Loading delivery history…",
  emptyTitle: "Nothing sent yet",
  emptyBody: "Email, SMS and WhatsApp attempts for this link will appear here as soon as one is made.",
  retry: "Retry now",
  retrying: "Retrying…",
  retryFailed: "Retry failed.",
} as const;
