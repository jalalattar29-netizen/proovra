/**
 * CONTACT-FACTOR ENROLMENT (T-15) — the native port of
 * `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx`.
 *
 * The step-up gate for sensitive operations sends its one-time code ONLY to an
 * ACTIVE, verified factor owned by the account (never to a number entered at
 * the time of the action). With no enrolment surface, a native user could not
 * satisfy it at all.
 *
 *   GET  /v1/identity-security/contact-factors            → { factors }  (masked)
 *   POST /v1/identity-security/contact-factors/enroll/start
 *        { teamId, channel, destination, label? } → { factor, verificationAttemptId, codeExpiresAtUtc }
 *   POST /v1/identity-security/contact-factors/enroll/verify
 *        { teamId, factorId, verificationAttemptId, code } → { factor }  (400 = wrong OR expired)
 *   POST /v1/identity-security/contact-factors/:id/revoke
 *
 * The full destination is typed once and dropped from state on success; only
 * `destinationMask` is ever rendered. A code is never logged or kept.
 */
export const CONTACT_FACTORS_PATH = "/v1/identity-security/contact-factors";
export const CONTACT_FACTOR_ENROLL_START_PATH = "/v1/identity-security/contact-factors/enroll/start";
export const CONTACT_FACTOR_ENROLL_VERIFY_PATH = "/v1/identity-security/contact-factors/enroll/verify";
export function buildContactFactorRevokePath(factorId: string): string {
  return `/v1/identity-security/contact-factors/${encodeURIComponent(factorId)}/revoke`;
}

export type ContactFactorKind = "SMS" | "WHATSAPP";
export const CONTACT_FACTOR_CHANNELS: ReadonlyArray<{ value: ContactFactorKind; label: string }> = [
  { value: "SMS", label: "Text message (SMS)" },
  { value: "WHATSAPP", label: "WhatsApp" },
];

export interface ContactFactor {
  factorId: string;
  kind: string;
  label: string;
  destinationMask: string;
  status: "ENROLLING" | "ACTIVE" | "REVOKED" | string;
  verifiedAtUtc: string | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function factorOf(raw: unknown): ContactFactor | null {
  const f = o(raw);
  const factorId = s(f.factorId);
  if (!factorId) return null;
  return {
    factorId,
    kind: s(f.kind) ?? "SMS",
    label: s(f.label) ?? "",
    destinationMask: s(f.destinationMask) ?? "•••",
    status: s(f.status) ?? "ENROLLING",
    verifiedAtUtc: s(f.verifiedAtUtc),
  };
}

export function parseContactFactors(payload: unknown): ContactFactor[] {
  const list = o(payload)["factors"];
  return (Array.isArray(list) ? list : []).map(factorOf).filter((f): f is ContactFactor => f !== null);
}

export interface EnrolmentAttempt {
  factorId: string;
  verificationAttemptId: string;
  destinationMask: string;
  codeExpiresAt: number | null;
}

/** null when the start answer is unusable (the web then says enrolment could not be started). */
export function parseEnrolmentStart(payload: unknown): EnrolmentAttempt | null {
  const d = o(payload);
  const factor = factorOf(d["factor"]);
  const attempt = s(d["verificationAttemptId"]);
  if (!factor || !attempt) return null;
  const exp = s(d["codeExpiresAtUtc"]);
  return {
    factorId: factor.factorId,
    verificationAttemptId: attempt,
    destinationMask: factor.destinationMask,
    codeExpiresAt: exp && !Number.isNaN(Date.parse(exp)) ? Date.parse(exp) : null,
  };
}

export function contactFactorStatusLabel(status: string): string {
  if (status === "ACTIVE") return "Active";
  if (status === "ENROLLING") return "Awaiting verification";
  return "Revoked";
}

/** Client validation spares a round-trip; the server re-validates and normalises to E.164. */
export function destinationError(value: string): string | null {
  const t = value.trim();
  if (t.length < 3 || t.length > 32) {
    return "Enter the full number in international format, including the country code — for example +44 7700 900123.";
  }
  if (!/^[+()\-.\s\d]+$/.test(t)) return "A phone number can only contain digits, spaces, and the characters + ( ) - .";
  return null;
}

export const CODE_MIN = 3;
export const CODE_MAX = 16;
export function codeError(value: string): string | null {
  const t = value.trim();
  return t.length < CODE_MIN || t.length > CODE_MAX ? `Enter the ${CODE_MIN}–${CODE_MAX} character code exactly as it was sent.` : null;
}

export const RESEND_COOLDOWN_MS = 60_000;

const NOTICE = {
  reauthentication_required:
    "Your session needs to be confirmed again before you can change security settings. Sign in again, then return to this page.",
  rate_limited: "Too many verification codes have been requested for this account recently. Wait a while before trying again.",
  already_enrolled: "That destination is already enrolled on this account. Revoke the existing factor first if you want to enrol it again.",
  provider_unavailable:
    "The messaging service did not accept the request, so no code was sent. Nothing was changed on your account — try again shortly.",
  incorrect_code: "That code was not correct. Check the digits and enter it again.",
  expired_code: "That code has expired. Request a new one and enter the code from the newest message.",
} as const;

/** noticeForError, verbatim; `fallback` is what the web says for anything else. */
export function contactFactorFailure(err: unknown, fallback: string, safeMessage: (e: unknown, f: string) => string): string {
  const e = o(err);
  const status = typeof e.statusCode === "number" ? (e.statusCode as number) : 0;
  const code = s(e.code) ?? "";
  if (status === 401 || code === "STEP_UP_REQUIRED") return NOTICE.reauthentication_required;
  if (status === 429 || code === "rate_limited") return NOTICE.rate_limited;
  if (status === 409 || code === "already_enrolled") return NOTICE.already_enrolled;
  if (status === 502 || code === "provider_error") return NOTICE.provider_unavailable;
  return safeMessage(err, fallback);
}

/** A 400 on verify is wrong OR expired; the attempt's own expiry decides which sentence. */
export function verifyDeniedMessage(codeExpiresAt: number | null, nowMs: number): string {
  return codeExpiresAt !== null && codeExpiresAt <= nowMs ? NOTICE.expired_code : NOTICE.incorrect_code;
}

export const CONTACT_FACTOR_COPY = {
  title: "Verified contact device",
  intro:
    "Sensitive operations — publishing or withdrawing evidence, approving a review or a destruction, changing a governance policy, granting department membership — ask you to confirm a one-time code first. The code is always sent to the device you enrol here, never to a number entered at the time of the action.",
  loadFailed: "Your enrolled devices could not be loaded, so this section cannot be changed right now. Reload the page to try again.",
  loading: "Loading your enrolled devices…",
  none: "You have no verified device yet. Enrol one below to unlock the operations listed above.",
  replace: "Replace this device",
  channelQuestion: "How should the code be sent?",
  phone: "Phone number",
  phoneHelp:
    "Include the country code. This is the only place the full number is entered — after verification the product shows a masked form of it and never displays it again.",
  labelField: "Label (optional)",
  labelPlaceholder: "Work handset",
  send: "Send verification code",
  sending: "Sending code…",
  noWorkspace: "Open a workspace before enrolling a device — the verification is recorded against the workspace you are working in.",
  codeField: "Verification code",
  codeExpired: "This code has expired. Request a new one below.",
  codeValid: "The code is valid for a short time. Request a new one if it does not arrive.",
  verify: "Verify and enrol",
  verifying: "Checking code…",
  resend: "Resend code",
  startOver: "Start over",
  enrolled: "Device enrolled.",
  replaced: "Device replaced.",
  revoked: "Device revoked. Any approval granted against it has stopped working, and sensitive operations stay blocked until you enrol another device.",
  startFailed: "The verification code could not be sent. Nothing was changed on your account — try again shortly.",
  startUnusable: "Enrolment could not be started. Nothing was changed on your account — try again shortly.",
  verifyFailed: "The code could not be checked. Nothing was changed on your account — try again shortly.",
  revokeFailed: "That factor could not be revoked. Nothing was changed — reload the page and try again.",
} as const;
