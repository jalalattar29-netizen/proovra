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

export type AcquisitionRawInput = {
  /** Evidence.captureEnvironment.uploadSource, e.g. WEB_APP / INTAKE_LINK /
   *  MOBILE_APP / API / UNKNOWN. */
  uploadSource?: string | null;
  /** Evidence.captureMethod enum, e.g. EXTERNAL_INTAKE_UPLOAD. */
  captureMethod?: string | null;
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
  /** Product label: Intake Link / Direct Upload / Mobile Capture /
   *  API Submission / Public Secure Link / QR Code Intake / Unknown. */
  method: string;
  /** SMS / WhatsApp / Email / QR Code / Public Secure Link / PROOVRA Mobile /
   *  Not applicable, or null when unknown. */
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

function isIntakeAcquisition(raw: AcquisitionRawInput): boolean {
  return (
    up(raw.captureMethod) === "EXTERNAL_INTAKE_UPLOAD" ||
    up(raw.uploadSource) === "INTAKE_LINK" ||
    Boolean(raw.intakeMode) ||
    Boolean(raw.deliveryChannelRaw)
  );
}

function mapDeliveryChannel(raw: AcquisitionRawInput): string | null {
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
  // No messaging record. Distinguish public/reusable links vs mobile/API.
  if (up(raw.uploadSource) === "MOBILE_APP") return "PROOVRA Mobile";
  if (isIntakeAcquisition(raw)) {
    const mode = up(raw.intakeMode);
    if (mode.includes("REUSABLE") || mode.includes("ANONYMOUS")) {
      return "Public Secure Link";
    }
  }
  return null;
}

function mapMethod(raw: AcquisitionRawInput, deliveryChannel: string | null): string {
  if (isIntakeAcquisition(raw)) {
    if (deliveryChannel === "Public Secure Link") return "Public Secure Link";
    return "Intake Link";
  }
  switch (up(raw.uploadSource)) {
    case "MOBILE_APP":
      return "Mobile Capture";
    case "API":
      return "API Submission";
    case "WEB_APP":
      return "Direct Upload";
    default:
      return "Unknown";
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

  // Nothing to say — not intake and no recognizable upload source.
  if (!intake && method === "Unknown") return null;

  return {
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
 * time, so NON-intake evidence never reads "Recorded at intake".
 *
 *   - Intake flow  → "Intake submitted at (server UTC)"
 *   - Mobile app   → "Recorded at mobile capture (server UTC)"
 *   - Web capture  → "Recorded at submission (server UTC)"
 *   - Unknown      → "Recorded at submission (server UTC)" (safe generic)
 */
export function getCaptureContextTimestampLabel(input: {
  uploadSource?: string | null;
  captureMethod?: string | null;
  acquisitionMethod?: string | null;
  isIntake?: boolean | null;
}): string {
  const method = (input.acquisitionMethod ?? "").toLowerCase();
  const isIntake =
    input.isIntake === true ||
    up(input.uploadSource) === "INTAKE_LINK" ||
    up(input.captureMethod) === "EXTERNAL_INTAKE_UPLOAD" ||
    method.includes("intake") ||
    method.includes("public secure link");
  if (isIntake) return "Intake submitted at (server UTC)";

  if (
    up(input.uploadSource) === "MOBILE_APP" ||
    method.includes("mobile") ||
    up(input.captureMethod) === "SECURE_CAMERA"
  ) {
    return "Recorded at mobile capture (server UTC)";
  }
  return "Recorded at submission (server UTC)";
}
