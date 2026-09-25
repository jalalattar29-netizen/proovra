/**
 * MESSAGING CONTACT (T-15) — the native port of
 * `apps/web/components/notifications/ContactChannelVerificationCard.tsx`.
 *
 * A DELIVERY DESTINATION for evidence-request and reminder messages — not MFA,
 * not sign-in recovery, not the step-up device on Security. Three operations:
 *
 *   POST /v1/communications/verify/start  { teamId, channel, phone, purpose:"OTP" }
 *        → 200 { status: "started", attempt } | 200 { status: "rate_limited" }
 *   POST /v1/communications/verify/check  { teamId, phone, code }
 *        → 200 { status: "approved", verificationId } | 400 { status: "denied" }
 *   POST /v1/communications/preferences   { teamId, target:{kind:"contact",phone}, …OptOut, … }
 *        → 200 { preference }  | 409 contact_not_verified (opting IN only)
 *
 * SERVER-AUTHORITATIVE: only `{ status: "approved" }` moves the journey to
 * verified; the code is forwarded verbatim and never inspected. A 400 on check
 * buckets wrong / expired / exhausted / replayed into ONE sentence. Opting OUT
 * never needs a code.
 */
export const MESSAGING_VERIFY_START_PATH = "/v1/communications/verify/start";
export const MESSAGING_VERIFY_CHECK_PATH = "/v1/communications/verify/check";
export const MESSAGING_PREFERENCES_PATH = "/v1/communications/preferences";

export type MessagingChannel = "SMS" | "WHATSAPP";
export const MESSAGING_CHANNELS: ReadonlyArray<{ value: MessagingChannel; label: string }> = [
  { value: "SMS", label: "Text message (SMS)" },
  { value: "WHATSAPP", label: "WhatsApp" },
];
export function messagingChannelLabel(c: MessagingChannel): string {
  return c === "SMS" ? "Text message (SMS)" : "WhatsApp";
}

export interface VerificationAttemptView {
  id: string;
  recipientPreview: string;
  checkAttemptCount: number;
  expiresAtUtc: string | null;
}

export type StartOutcome =
  | { kind: "started"; attempt: VerificationAttemptView }
  | { kind: "rate_limited" }
  | { kind: "unusable" };

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseVerifyStart(payload: unknown): StartOutcome {
  const d = o(payload);
  const status = d["status"];
  if (status === "rate_limited") return { kind: "rate_limited" };
  const a = o(d["attempt"]);
  const id = s(a["id"]);
  if (status !== "started" || !id) return { kind: "unusable" };
  return {
    kind: "started",
    attempt: {
      id,
      // The backend only ever returns the masked recipient.
      recipientPreview: s(a["recipientPreview"]) ?? "•••",
      checkAttemptCount: typeof a["checkAttemptCount"] === "number" ? (a["checkAttemptCount"] as number) : 0,
      expiresAtUtc: s(a["expiresAtUtc"]),
    },
  };
}

/** true ONLY when the server said "approved"; the client never decides. */
export function parseVerifyCheck(payload: unknown): { approved: boolean; verificationId: string | null } {
  const d = o(payload);
  return { approved: d["status"] === "approved", verificationId: s(d["verificationId"]) };
}

export interface SavedMessagingPreference {
  smsOptOut: boolean;
  whatsappOptOut: boolean;
  preferredChannel: string | null;
  updatedAt: string;
}

export function buildPreferenceBody(teamId: string, phone: string, channel: MessagingChannel, optIn: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { teamId, target: { kind: "contact", phone } };
  if (channel === "SMS") body.smsOptOut = !optIn;
  else body.whatsappOptOut = !optIn;
  if (optIn) body.preferredChannel = channel;
  else body.optOutReason = "operator_preference";
  return body;
}

export function parseSavedPreference(payload: unknown, optIn: boolean, nowIso: string): SavedMessagingPreference {
  const p = o(o(payload)["preference"]);
  return {
    smsOptOut: typeof p["smsOptOut"] === "boolean" ? (p["smsOptOut"] as boolean) : !optIn,
    whatsappOptOut: typeof p["whatsappOptOut"] === "boolean" ? (p["whatsappOptOut"] as boolean) : !optIn,
    preferredChannel: s(p["preferredChannel"]),
    updatedAt: s(p["updatedAt"]) ?? nowIso,
  };
}

/** The web enables "Send verification code" at 6 characters; the server decides validity. */
export function phoneReady(phone: string): boolean {
  return phone.trim().length >= 6;
}
export function codeReady(code: string): boolean {
  return code.trim().length >= 3;
}

function statusOf(err: unknown): number {
  const v = o(err)["statusCode"];
  return typeof v === "number" ? v : 0;
}

export const MESSAGING_COPY = {
  title: "Messaging contact",
  intro:
    "Verify a phone number that PROOVRA may use for evidence-request and reminder messages, by text message or WhatsApp. This is a delivery address for notifications — it is not used for signing in or for confirming sensitive actions.",
  intro2: "Confirmation is decided by the messaging provider and recorded on the server. Turning messaging OFF never requires a code.",
  noWorkspace: "Select a workspace to manage verified messaging contacts.",
  channel: "Channel",
  phone: "Mobile number",
  phonePlaceholder: "+44 7700 900000",
  phoneHelp: "Include the country code. The number is stored only as a one-way hash — it is never shown back to you in full.",
  send: "Send verification code",
  sending: "Sending code…",
  rateLimitedTitle: "Too many verification attempts for this number.",
  rateLimitedBody:
    "The workspace has reached the hourly limit for this recipient. Wait before requesting another code — the limit protects the recipient from being messaged repeatedly.",
  startOver: "Start over",
  code: "Verification code",
  confirm: "Confirm code",
  checking: "Checking…",
  differentNumber: "Use a different number",
  allow: "Allow messages",
  deny: "Do not message",
  saving: "Saving…",
  another: "Add another number",
  startUnusable: "The verification request did not complete. Try again in a moment.",
  invalidPhone: "That does not look like a mobile number that can receive messages. Check the country code and try again.",
  startDisabled: "Message verification is not enabled for this environment yet. Ask your administrator to configure a messaging provider.",
  startFailed: "The verification code could not be sent.",
  denied: "That code was not accepted. Codes expire quickly and can only be used once — request a new one.",
  checkDisabled: "Message verification is not enabled for this environment yet.",
  checkFailed: "The code could not be checked.",
  confirmed: "This contact is confirmed. You can now set its preference.",
  savedIn: "Messaging preference saved for this contact.",
  savedOut: "This contact will no longer be messaged on that channel.",
  notVerified: "This contact has not completed verification, so messaging cannot be enabled for it yet.",
  forbidden: "You do not have permission to change communication preferences in this workspace.",
  saveFailed: "The preference could not be saved.",
} as const;

type Safe = (e: unknown, fallback: string) => string;

export function startFailure(err: unknown, safe: Safe): string {
  const st = statusOf(err);
  if (st === 400) return MESSAGING_COPY.invalidPhone;
  if (st === 503) return MESSAGING_COPY.startDisabled;
  return safe(err, MESSAGING_COPY.startFailed);
}
export function checkFailure(err: unknown, safe: Safe): string {
  const st = statusOf(err);
  if (st === 400) return MESSAGING_COPY.denied;
  if (st === 503) return MESSAGING_COPY.checkDisabled;
  return safe(err, MESSAGING_COPY.checkFailed);
}
export function preferenceFailure(err: unknown, safe: Safe): string {
  const st = statusOf(err);
  if (st === 409 || o(err)["code"] === "contact_not_verified") return MESSAGING_COPY.notVerified;
  if (st === 403) return MESSAGING_COPY.forbidden;
  return safe(err, MESSAGING_COPY.saveFailed);
}
