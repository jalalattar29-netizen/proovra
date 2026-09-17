/**
 * Evidence Acquisition Context — a normalized, privacy-safe projection of
 * HOW evidence reached PROOVRA (acquisition method, delivery channel,
 * submission type/status, consent), built once server-side and reused by
 * the PDF report, public verify page, verification package, and internal
 * evidence detail.
 *
 * This is NOT evidence integrity, EXIF, GPS, capture context, or recipient
 * identity proof. It carries ONLY masked/hashed recipient values (never a
 * full phone/email) and NEVER provider IDs (Twilio SID, WhatsApp/message
 * IDs, webhook IDs).
 *
 * The pure mapper here maps raw DB enum values to product labels. Callers
 * pass ALREADY-masked recipient values (via the approved mask helpers) —
 * this module never sees a raw phone or email. Layer helpers strip the
 * recipient for public surfaces.
 */

import {
  acquisitionTimestampLabel,
  resolveEvidenceAcquisition,
  type ProjectedAcquisitionMode,
} from "@proovra/shared";

export type AcquisitionRawInput = {
  /**
   * UC-0 — Evidence.acquisitionMode, THE acquisition authority. The former
   * `uploadSource` / `captureMethod` inputs are gone: the first was inverted
   * for the mobile and citizen routes and the second is a structure field
   * completion overwrites.
   */
  acquisitionMode: string | null | undefined;
  /** WorkflowIntakeLink.intakeMode, e.g. EXTERNAL_ONE_TIME / EXTERNAL_REUSABLE
   *  / EXTERNAL_ANONYMOUS / EXTERNAL_PSEUDONYMOUS / AUTHENTICATED_*. */
  intakeMode?: string | null;
  /** Evidence.identityLevelSnapshot, e.g. BASIC_ACCOUNT / VERIFIED_EMAIL /
   *  OAUTH_BACKED_IDENTITY / ORGANIZATION_ACCOUNT / VERIFIED_ORGANIZATION. */
  identityLevel?: string | null;

  /** CommunicationMessage.channel, e.g. SMS / WHATSAPP / EMAIL / SYSTEM. */
  deliveryChannelRaw?: string | null;
  /** CommunicationMessage.status, e.g. QUEUED / SENT / DELIVERED / FAILED. */
  deliveryStatusRaw?: string | null;
  sentAtUtc?: string | null;
  deliveredAtUtc?: string | null;

  /** WorkflowIntakeSession lifecycle timestamps. */
  openedAtUtc?: string | null;
  submittedAtUtc?: string | null;

  /** Consent. */
  consentAcceptedAtUtc?: string | null;
  consentVersion?: string | null;

  /** ALREADY-masked recipient (never raw). e.g. "+49 ••• ••• 1234" or
   *  "ja***@gmail.com". Pass null to omit. */
  recipientMasked?: string | null;
  /** HMAC/SHA-256 recipient hash hex (package-only; prefixed at emit). */
  recipientHash?: string | null;
  /** "phone" | "email" — derived from the delivery channel. */
  recipientType?: "phone" | "email" | null;
};

export type EvidenceAcquisitionContext = {
  /** UC-0 — the acquisition authority's projected mode. */
  acquisitionMode: ProjectedAcquisitionMode;
  /** Product label: Intake Link / Public Secure Link / Direct Upload /
   *  PROOVRA Mobile App / Not recorded. */
  method: string;
  /** The ONLY valid intake delivery channels: SMS / WhatsApp / Email /
   *  Public Secure Link / PROOVRA Mobile. `null` only for non-intake
   *  acquisitions. */
  deliveryChannel: string | null;
  /** Remote Contributor / Authenticated User / Organization User /
   *  Anonymous Contributor / Unknown. */
  submissionType: string;
  /** Ordered subset of Sent / Delivered / Opened / Submitted. */
  submissionStatus: string[];
  /** Anonymous / Verified / Organization User / Unknown. */
  identityVerification: string;
  consentAccepted: boolean | null;
  consentAcceptedAtUtc: string | null;
  consentVersion: string | null;
  submittedAtUtc: string | null;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  openedAtUtc: string | null;
  recipientType: "phone" | "email" | null;
  recipientMasked: string | null;
  recipientHash: string | null;
  fullValueIncluded: false;
  /** True when the evidence was acquired via an intake/delivery route. */
  isIntake: boolean;
};

function up(v: string | null | undefined): string {
  return (v ?? "").toUpperCase();
}

/**
 * Intake is proven by the acquisition authority or by the intake-session join
 * (`intakeMode` / delivery channel come from WorkflowIntakeSession →
 * WorkflowIntakeLink / CommunicationMessage) — never by a label.
 */
function isIntakeAcquisition(raw: AcquisitionRawInput): boolean {
  return (
    resolveEvidenceAcquisition({ acquisitionMode: raw.acquisitionMode }).mode ===
      "SECURE_INTAKE_LINK" ||
    Boolean(raw.intakeMode) ||
    Boolean(raw.deliveryChannelRaw)
  );
}

function mapDeliveryChannel(raw: AcquisitionRawInput): string | null {
  // The ONLY valid intake delivery channels are SMS / WhatsApp / Email /
  // Public Secure Link / PROOVRA Mobile. Intake never resolves to null/Unknown.
  switch (up(raw.deliveryChannelRaw)) {
    case "SMS":
      return "SMS";
    case "WHATSAPP":
      return "WhatsApp";
    case "EMAIL":
      return "Email";
    case "SYSTEM":
    case "":
      break;
    default:
      break;
  }
  // (UC-0) The former "PROOVRA Mobile" channel was keyed on an uploadSource
  // that only the browser citizen route ever wrote — it was never mobile.
  // Any intake link with no SMS/WhatsApp/Email/mobile record was delivered via
  // the secure link itself (reusable, anonymous, pseudonymous, or a one-time
  // link shared manually). This is always a Public Secure Link — never null,
  // never "Unknown".
  if (isIntakeAcquisition(raw)) return "Public Secure Link";
  return null;
}

function mapMethod(raw: AcquisitionRawInput, deliveryChannel: string | null): string {
  void deliveryChannel;
  if (isIntakeAcquisition(raw)) {
    // Reusable / anonymous / pseudonymous links are public secure links; a
    // one-time link is a (non-public) secure intake link.
    const mode = up(raw.intakeMode);
    if (
      mode.includes("REUSABLE") ||
      mode.includes("ANONYMOUS") ||
      mode.includes("PSEUDONYMOUS")
    ) {
      return "Public Secure Link";
    }
    return "Intake Link";
  }
  switch (resolveEvidenceAcquisition({ acquisitionMode: raw.acquisitionMode }).mode) {
    case "PROOVRA_WEB_UPLOAD":
      return "Direct Upload";
    case "PROOVRA_MOBILE_APP":
      return "PROOVRA Mobile App";
    default:
      return "Not recorded";
  }
}

function mapIdentityVerification(raw: AcquisitionRawInput): string {
  switch (up(raw.identityLevel)) {
    case "ORGANIZATION_ACCOUNT":
    case "VERIFIED_ORGANIZATION":
      return "Organization User";
    case "VERIFIED_EMAIL":
    case "OAUTH_BACKED_IDENTITY":
      return "Verified";
    case "BASIC_ACCOUNT":
      // Anonymous intake contributors carry a basic (unverified) identity.
      if (up(raw.intakeMode).includes("ANONYMOUS")) return "Anonymous";
      return "Unknown";
    default:
      if (up(raw.intakeMode).includes("ANONYMOUS")) return "Anonymous";
      return "Unknown";
  }
}

function mapSubmissionType(raw: AcquisitionRawInput): string {
  const mode = up(raw.intakeMode);
  if (mode.startsWith("AUTHENTICATED")) {
    return up(raw.identityLevel).includes("ORGANIZATION")
      ? "Organization User"
      : "Authenticated User";
  }
  if (mode.includes("ANONYMOUS")) return "Anonymous Contributor";
  if (mode.startsWith("EXTERNAL") || mode.includes("FIELD_TEAM")) {
    return "Remote Contributor";
  }
  // Non-intake: derive from identity level.
  switch (up(raw.identityLevel)) {
    case "ORGANIZATION_ACCOUNT":
    case "VERIFIED_ORGANIZATION":
      return "Organization User";
    case "VERIFIED_EMAIL":
    case "OAUTH_BACKED_IDENTITY":
    case "BASIC_ACCOUNT":
      return "Authenticated User";
    default:
      return isIntakeAcquisition(raw) ? "Remote Contributor" : "Unknown";
  }
}

/** Ordered, never-invented submission status flags. */
function mapSubmissionStatus(raw: AcquisitionRawInput): string[] {
  const out: string[] = [];
  const status = up(raw.deliveryStatusRaw);
  if (raw.sentAtUtc || status === "SENT" || status === "DELIVERED") {
    out.push("Sent");
  }
  if (raw.deliveredAtUtc || status === "DELIVERED") out.push("Delivered");
  if (raw.openedAtUtc) out.push("Opened");
  if (raw.submittedAtUtc) out.push("Submitted");
  return out;
}

/**
 * Build the normalized acquisition context, or null when there is no
 * meaningful acquisition signal at all (e.g. legacy evidence with no
 * capture environment and no intake linkage).
 */
export function buildEvidenceAcquisitionContext(
  raw: AcquisitionRawInput,
): EvidenceAcquisitionContext | null {
  const intake = isIntakeAcquisition(raw);
  const deliveryChannel = mapDeliveryChannel(raw);
  const method = mapMethod(raw, deliveryChannel);

  // Nothing to say — not intake and acquisition not recorded. Absence is not
  // rendered as a failure; the acquisition statement says "not recorded".
  if (!intake && method === "Not recorded") return null;

  return {
    acquisitionMode: resolveEvidenceAcquisition({ acquisitionMode: raw.acquisitionMode }).mode,
    method,
    deliveryChannel,
    submissionType: mapSubmissionType(raw),
    submissionStatus: mapSubmissionStatus(raw),
    identityVerification: mapIdentityVerification(raw),
    consentAccepted: raw.consentAcceptedAtUtc ? true : null,
    consentAcceptedAtUtc: raw.consentAcceptedAtUtc ?? null,
    consentVersion: raw.consentVersion ?? null,
    submittedAtUtc: raw.submittedAtUtc ?? null,
    sentAtUtc: raw.sentAtUtc ?? null,
    deliveredAtUtc: raw.deliveredAtUtc ?? null,
    openedAtUtc: raw.openedAtUtc ?? null,
    recipientType: raw.recipientMasked ? (raw.recipientType ?? null) : null,
    recipientMasked: raw.recipientMasked ?? null,
    recipientHash: raw.recipientMasked ? (raw.recipientHash ?? null) : null,
    fullValueIncluded: false,
    isIntake: intake,
  };
}

/** Public-safe view (PDF + Verify): NEVER any recipient value. */
export type PublicAcquisition = {
  acquisitionMode: ProjectedAcquisitionMode;
  method: string;
  deliveryChannel: string | null;
  submissionType: string;
  submissionStatus: string[];
  identityVerification: string;
  consentAccepted: boolean | null;
  consentVersion: string | null;
  submittedAtUtc: string | null;
  /** True only for intake/delivery acquisitions — drives whether the
   *  Evidence Acquisition table/card renders. */
  isIntake: boolean;
};

export function toPublicAcquisition(
  ctx: EvidenceAcquisitionContext,
): PublicAcquisition {
  return {
    acquisitionMode: ctx.acquisitionMode,
    method: ctx.method,
    deliveryChannel: ctx.deliveryChannel,
    submissionType: ctx.submissionType,
    submissionStatus: ctx.submissionStatus,
    identityVerification: ctx.identityVerification,
    consentAccepted: ctx.consentAccepted,
    consentVersion: ctx.consentVersion,
    submittedAtUtc: ctx.submittedAtUtc,
    isIntake: ctx.isIntake,
  };
}

/** Internal view: adds the MASKED recipient (never raw, never provider IDs). */
export type InternalAcquisition = PublicAcquisition & {
  recipientType: "phone" | "email" | null;
  recipientMasked: string | null;
  submissionStatus: string[];
  consentAcceptedAtUtc: string | null;
};

export function toInternalAcquisition(
  ctx: EvidenceAcquisitionContext,
): InternalAcquisition {
  return {
    ...toPublicAcquisition(ctx),
    consentAcceptedAtUtc: ctx.consentAcceptedAtUtc,
    recipientType: ctx.recipientType,
    recipientMasked: ctx.recipientMasked,
  };
}

/**
 * Choose the correct Capture Context timestamp label for the server-recorded
 * time, so NON-intake evidence never reads "Recorded at intake". Decided by
 * the acquisition authority (shared `acquisitionTimestampLabel`).
 */
export function getCaptureContextTimestampLabel(input: {
  acquisitionMode: string | null | undefined;
  isIntake?: boolean | null;
}): string {
  const a = resolveEvidenceAcquisition({ acquisitionMode: input.acquisitionMode });
  return acquisitionTimestampLabel(a.mode, input.isIntake === true);
}
