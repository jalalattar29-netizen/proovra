/**
 * Phase 18 — Enterprise Communications & External Outreach canonical types.
 *
 * Provider-agnostic, framework-agnostic primitives for:
 *   - Channels (SMS / WhatsApp / Email / System)
 *   - Directions (Outbound / Inbound)
 *   - Purposes (OTP, EvidenceRequest, IntakeLink, ...)
 *   - Statuses (Queued → Sent → Delivered / Failed / Retry / Cancelled)
 *   - Providers (Twilio, Resend, Internal, Noop)
 *   - Verification attempt statuses (OTP audit row state machine)
 *   - E.164 phone normalisation + masking + HMAC hash helpers
 *   - Retry backoff ladder for outbound sends
 *   - Operational message bodies — short, privacy-safe wording catalog
 *
 * Hard invariants encoded here:
 *   - Phone numbers are NEVER stored raw on CommunicationMessage; the
 *     `recipientHash` is HMAC-SHA256 + the preview is masked.
 *   - OTP codes are NEVER persisted (Twilio Verify owns them).
 *   - Message bodies are SHORT and operational — no evidence titles,
 *     no reviewer notes, no legal-hold reasons, no tokens.
 *   - Marketing / newsletter content is not supported by design.
 *
 * Wording rule: every operational template must avoid promises of
 * authenticity, legal admissibility, or factual truth. The body says
 * "secure evidence request" / "secure link", never "verified",
 * "authentic", or "admissible".
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Channels
// -----------------------------------------------------------------------------

export const COMMUNICATION_CHANNELS = [
  "SMS",
  "WHATSAPP",
  "EMAIL",
  "SYSTEM",
] as const;
export const CommunicationChannelSchema = z.enum(COMMUNICATION_CHANNELS);
export type CommunicationChannel = z.infer<typeof CommunicationChannelSchema>;

const PHONE_CHANNELS: ReadonlyArray<CommunicationChannel> = ["SMS", "WHATSAPP"];

export function isPhoneChannel(channel: CommunicationChannel): boolean {
  return PHONE_CHANNELS.includes(channel);
}

// -----------------------------------------------------------------------------
// Direction
// -----------------------------------------------------------------------------

export const COMMUNICATION_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;
export const CommunicationDirectionSchema = z.enum(COMMUNICATION_DIRECTIONS);
export type CommunicationDirection = z.infer<
  typeof CommunicationDirectionSchema
>;

// -----------------------------------------------------------------------------
// Purpose
// -----------------------------------------------------------------------------

export const COMMUNICATION_PURPOSES = [
  "OTP",
  "EVIDENCE_REQUEST",
  "INTAKE_LINK",
  "REVIEW_ESCALATION",
  "REVIEW_REMINDER",
  "CONTRIBUTOR_CLARIFICATION",
  "COLLABORATION_MENTION",
  "GOVERNANCE_ALERT",
  "SECURITY_ALERT",
  "PREFERENCE_UPDATE",
] as const;
export const CommunicationPurposeSchema = z.enum(COMMUNICATION_PURPOSES);
export type CommunicationPurpose = z.infer<typeof CommunicationPurposeSchema>;

// Critical purposes bypass opt-out (where legally appropriate). OTP +
// SECURITY_ALERT are the only purposes that may reach an opted-out
// recipient — and only under a deliberate operator override. Everything
// else is fully blocked when the recipient has opted out.
const CRITICAL_PURPOSES: ReadonlyArray<CommunicationPurpose> = [
  "OTP",
  "SECURITY_ALERT",
];

export function isCriticalCommunicationPurpose(
  purpose: CommunicationPurpose,
): boolean {
  return CRITICAL_PURPOSES.includes(purpose);
}

// Retry-eligible purposes. OTP is NEVER retried by the platform —
// Twilio Verify owns the code lifecycle and we MUST NOT generate a new
// code on retry. Inbound STOP/START preference updates are not
// outbound. Marketing-style purposes don't exist by design.
const RETRY_ELIGIBLE_PURPOSES: ReadonlyArray<CommunicationPurpose> = [
  "EVIDENCE_REQUEST",
  "INTAKE_LINK",
  "REVIEW_ESCALATION",
  "REVIEW_REMINDER",
  "CONTRIBUTOR_CLARIFICATION",
  "COLLABORATION_MENTION",
  "GOVERNANCE_ALERT",
];

export function isRetryEligibleCommunicationPurpose(
  purpose: CommunicationPurpose,
): boolean {
  return RETRY_ELIGIBLE_PURPOSES.includes(purpose);
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export const COMMUNICATION_STATUSES = [
  "QUEUED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "UNDELIVERED",
  "RETRY_SCHEDULED",
  "CANCELLED",
  "RECEIVED",
] as const;
export const CommunicationStatusSchema = z.enum(COMMUNICATION_STATUSES);
export type CommunicationStatus = z.infer<typeof CommunicationStatusSchema>;

const TERMINAL_COMMUNICATION_STATUSES: ReadonlyArray<CommunicationStatus> = [
  "DELIVERED",
  "FAILED",
  "UNDELIVERED",
  "CANCELLED",
  "RECEIVED",
];

export function isTerminalCommunicationStatus(
  status: CommunicationStatus,
): boolean {
  return TERMINAL_COMMUNICATION_STATUSES.includes(status);
}

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

export const COMMUNICATION_PROVIDERS = [
  "TWILIO",
  "RESEND",
  "INTERNAL",
  "NOOP",
] as const;
export const CommunicationProviderSchema = z.enum(COMMUNICATION_PROVIDERS);
export type CommunicationProvider = z.infer<typeof CommunicationProviderSchema>;

// -----------------------------------------------------------------------------
// Verification attempt status
// -----------------------------------------------------------------------------

export const VERIFICATION_ATTEMPT_STATUSES = [
  "STARTED",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
] as const;
export const VerificationAttemptStatusSchema = z.enum(
  VERIFICATION_ATTEMPT_STATUSES,
);
export type VerificationAttemptStatus = z.infer<
  typeof VerificationAttemptStatusSchema
>;

// -----------------------------------------------------------------------------
// Retry backoff
// -----------------------------------------------------------------------------

export const COMMUNICATION_RETRY_MAX_ATTEMPTS = 5;

/**
 * Exponential backoff between outbound send attempts (in seconds).
 * Attempt 1 is the initial send; attempts 2..5 are retries. Returns the
 * recommended interval; the caller is responsible for scheduling.
 *
 * The ladder is intentionally similar to the notification retry ladder
 * (notifications.ts:131) so operators see a consistent retry pattern
 * across email and SMS deliveries.
 */
export function communicationRetryDelaySeconds(attempt: number): number {
  if (attempt <= 1) return 0;
  if (attempt > COMMUNICATION_RETRY_MAX_ATTEMPTS) {
    return 24 * 3600;
  }
  const ladder = [60, 300, 1800, 7200];
  return ladder[attempt - 2] ?? 3600;
}

/**
 * Classify a provider error string into transient (retriable) vs
 * permanent. Mirrors `classifyNotificationProviderError` semantics so
 * the retry processor can reuse one classification surface.
 */
export function classifyCommunicationProviderError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): "transient" | "permanent" {
  const code = (errorCode ?? "").toLowerCase();
  const msg = (errorMessage ?? "").toLowerCase();
  const transientMarkers = [
    "timeout",
    "etimedout",
    "econnreset",
    "econnrefused",
    "rate_limit",
    "rate limit",
    "too_many_requests",
    "too many requests",
    "service_unavailable",
    "service unavailable",
    "5xx",
    "503",
    "504",
    "502",
    "internal_server_error",
  ];
  for (const m of transientMarkers) {
    if (code.includes(m) || msg.includes(m)) return "transient";
  }
  return "permanent";
}

// -----------------------------------------------------------------------------
// E.164 phone normalisation + masking
//
// Pure helpers — used by every provider and the rate limiter to produce
// a deterministic recipient hash and a safe preview without ever
// retaining the raw phone in our logs or DB rows.
// -----------------------------------------------------------------------------

/**
 * Normalise an inbound phone to a strict E.164 form: a leading "+" and
 * 8..15 digits. Returns null on anything we can't safely send to. The
 * input may contain whitespace, dashes, parentheses, or a leading "00"
 * international prefix; everything else is rejected.
 *
 * NOTE: this is a structural normaliser, NOT a phone-validity oracle.
 * Operators are responsible for confirming the destination is real.
 */
export function normaliseToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/[\s\-().]/g, "").trim();
  if (stripped.length === 0) return null;
  let candidate = stripped;
  // "00" leading international prefix → "+"
  if (candidate.startsWith("00")) {
    candidate = "+" + candidate.slice(2);
  }
  // Bare digits without "+" — refuse. Operators must supply E.164.
  if (!candidate.startsWith("+")) return null;
  const digits = candidate.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return null;
  return "+" + digits;
}

/**
 * Mask an E.164 phone to a short operator-safe preview. The first
 * country-code digit (or two) is preserved; the rest is replaced with
 * bullets except for the last 4 digits.
 *
 *   +14155551234  →  +1 ••• •••• 1234
 *   +447700900123 →  +44 ••• ••• 0123
 *   +(short)      →  +•••• ••XX
 */
export function maskPhonePreview(phone: string | null | undefined): string {
  if (!phone) return "";
  const e164 = normaliseToE164(phone) ?? phone.trim();
  if (!e164.startsWith("+")) return "+••••";
  const digits = e164.slice(1);
  if (digits.length <= 4) return "+•••• " + digits.slice(-Math.min(4, digits.length));
  const last4 = digits.slice(-4);
  // Country code = up to 3 leading digits; use 1 for NANP (+1...) else 2.
  const ccLen = digits.startsWith("1") ? 1 : digits.length >= 11 ? 2 : 1;
  const cc = digits.slice(0, ccLen);
  return `+${cc} ••• ••• ${last4}`;
}

// -----------------------------------------------------------------------------
// Operational message body catalog
//
// Short, fixed-shape bodies that the communication service uses to
// compose outbound SMS/WhatsApp. Each function takes ONLY the minimal
// safe-to-send fields and returns a body bounded to ~280 chars (safe
// for SMS segment behavior). Adding a new template REQUIRES a privacy
// review — no evidence title, no reviewer note, no token internals.
// -----------------------------------------------------------------------------

const MAX_BODY_CHARS = 280;

function clip(s: string): string {
  if (s.length <= MAX_BODY_CHARS) return s;
  return s.slice(0, MAX_BODY_CHARS - 1) + "…";
}

export function renderEvidenceRequestSmsBody(input: {
  workspaceName: string;
  intakeUrl: string;
}): string {
  // No evidence title, no reviewer message — just the operational
  // wording mandated by the Phase 18 brief.
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws} secure evidence request: ${input.intakeUrl}. This link is intended only for you and may expire.`,
  );
}

export function renderIntakeLinkSmsBody(input: {
  workspaceName: string;
  intakeUrl: string;
}): string {
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws} secure submission link: ${input.intakeUrl}. Open only on a trusted device. Do not share.`,
  );
}

export function renderReviewEscalationSmsBody(input: {
  workspaceName: string;
}): string {
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws}: a review has been escalated and needs your attention. Sign in to PROOVRA to continue.`,
  );
}

export function renderReviewReminderSmsBody(input: {
  workspaceName: string;
}): string {
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws}: a reviewer task is past its SLA window. Sign in to PROOVRA to continue.`,
  );
}

export function renderContributorClarificationSmsBody(input: {
  workspaceName: string;
  intakeUrl: string;
}): string {
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws}: more information is needed on your submission. Continue here: ${input.intakeUrl}`,
  );
}

export function renderCollaborationMentionSmsBody(input: {
  workspaceName: string;
}): string {
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws}: you were mentioned in a workspace discussion. Sign in to PROOVRA to read.`,
  );
}

export function renderGovernanceAlertSmsBody(input: {
  workspaceName: string;
}): string {
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws}: a governance alert requires operator attention. Sign in to PROOVRA.`,
  );
}

export function renderSecurityAlertSmsBody(input: {
  workspaceName: string;
}): string {
  const ws = input.workspaceName.slice(0, 60);
  return clip(
    `${ws}: a security signal requires operator attention. Sign in to PROOVRA.`,
  );
}

// Standardised compliance footer for STOP/HELP. SMS carriers in some
// regions require this; appending it once at message build time keeps
// the wording consistent. We do NOT add it to OTP messages (Verify
// handles those).
export function appendStopFooter(body: string): string {
  if (body.includes("Reply STOP")) return body;
  const footer = " Reply STOP to opt out.";
  if (body.length + footer.length > MAX_BODY_CHARS) {
    return body;
  }
  return body + footer;
}

// -----------------------------------------------------------------------------
// Inbound STOP / START parsing
// -----------------------------------------------------------------------------

const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
const START_KEYWORDS = ["START", "UNSTOP", "YES"];

export type InboundCommand = "STOP" | "START" | null;

export function parseInboundCommand(body: string | null | undefined): InboundCommand {
  if (!body) return null;
  const t = body.trim().toUpperCase();
  if (STOP_KEYWORDS.includes(t)) return "STOP";
  if (START_KEYWORDS.includes(t)) return "START";
  return null;
}
