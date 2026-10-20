import { custodyEventLabel, evidenceVerificationStatusLabel, objectLockModeLabel } from "@proovra/shared";
import {
  acquisitionAccountLabel,
  acquisitionIdentityBasisLabel,
  acquisitionIdentityLevelLabel,
  acquisitionOrganizationVerificationLabel,
  acquisitionWorkspaceLabel,
  identityLevelLabel,
  type AcquisitionIdentitySnapshot,
} from "@proovra/shared";
import { captureMethodDisplayLabel } from "@proovra/shared-runtime/technical-metadata";

import { ReportEvidenceAssetKind } from "./types.js";
import { safe } from "./formatters.js";

// ---------------------------------------------------------------------------
// Custody capture-method presentation.
//
// `completeEvidence` overwrites `evidence.capture_method` to the evidence
// STRUCTURE enum (MULTIPART_PACKAGE / BULK_IMPORT), and that raw value is
// copied verbatim into the `captureMethodSnapshot` custody-event payload. The
// enum is a structure, not an acquisition method, so it must never render as a
// reviewer-facing "Capture:" label nor leak into the exported custody JSON.
//
// These helpers resolve the raw snapshot into a role-safe capture METHOD
// ("Secure Intake Link" for intake, otherwise the flow-aware label) plus a
// separate STRUCTURE label ("Multipart evidence package"). The immutable
// stored custody payload + its hash are left untouched — only the PDF/report
// and the package-presentation copies use these normalized values.
// ---------------------------------------------------------------------------

/** Reviewer-facing evidence STRUCTURE label, or null when the raw value is not
 *  a structure enum. */
export function mapEvidenceStructureLabel(
  raw: string | null | undefined,
): string | null {
  switch (safe(raw, "").toUpperCase()) {
    case "MULTIPART_PACKAGE":
      return "Multipart evidence package";
    case "BULK_IMPORT":
      return "Bulk import set";
    default:
      return null;
  }
}

/**
 * The acquisition facts a custody presentation needs. UC-0: the METHOD label
 * comes from the record's acquisition authority; the raw custody snapshot only
 * ever contributes the STRUCTURE label.
 */
export type CustodyAcquisitionContext = {
  acquisitionMode: string | null;
  isIntake: boolean;
};

/** Resolve a raw custody capture-method snapshot into a role-safe method label
 *  + a structure label. */
export function resolveCustodyCapturePresentation(
  raw: unknown,
  acquisition: CustodyAcquisitionContext,
): { method: string | null; structure: string | null } {
  const rawStr =
    raw == null ? null : String(raw).trim().length > 0 ? String(raw) : null;
  if (!rawStr) return { method: null, structure: null };
  return {
    method: captureMethodDisplayLabel(acquisition),
    structure: mapEvidenceStructureLabel(rawStr),
  };
}

/**
 * THE EXPORTED CUSTODY ENTRY (ET-PKG-01, 2026-09-29).
 *
 * custody.json / forensic-custody.json carry each event's `payload` EXACTLY as
 * it was hashed, so a recipient can recompute `eventHash` with the formula the
 * package README states. The presentation copy (role-safe capture method,
 * structure label, relabelled upload kind) is added beside it as
 * `presentationPayload` — only when it differs — and is not part of the hash.
 *
 * Until 2026-09-29 the presentation copy REPLACED `payload`, so recomputing
 * the chain from the package produced mismatches that read as tampering.
 */
export function packageCustodyEntry<E extends { payload?: unknown }>(
  event: E,
  acquisition: CustodyAcquisitionContext,
): E & { presentationPayload?: unknown } {
  const presentation = normalizeCustodyEventPayloadForPresentation(event.payload, acquisition);
  return presentation === event.payload ? { ...event } : { ...event, presentationPayload: presentation };
}

/**
 * Presentation copy of a custody-event payload for the exported
 * custody.json / forensic-custody.json. Leaves non-capture payloads and the
 * event hash untouched; for payloads carrying `captureMethodSnapshot` /
 * `captureMethod`, replaces the raw structure enum with the role-safe capture
 * METHOD and adds an `evidenceStructureSnapshot` structure label. The raw enum
 * therefore never appears as a captureMethod/captureMethodSnapshot value.
 */
export function normalizeCustodyEventPayloadForPresentation(
  payload: unknown,
  acquisition: CustodyAcquisitionContext,
): unknown {
  const isIntake = acquisition.isIntake;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const obj = payload as Record<string, unknown>;
  const hasSnapshot = "captureMethodSnapshot" in obj;
  const hasMethod = "captureMethod" in obj;
  // `uploadKind` on the UPLOAD_AUTHORIZED event is written by the shared
  // authorization builder as "intake_authorization"; for authenticated Web /
  // Mobile Capture it must read the capture value, not the intake one.
  const legacyIntakeUploadKind =
    !isIntake &&
    String(obj.uploadKind ?? "").toLowerCase() === "intake_authorization";
  if (!hasSnapshot && !hasMethod && !legacyIntakeUploadKind) return payload;

  const next: Record<string, unknown> = { ...obj };

  if (hasSnapshot || hasMethod) {
    const raw = hasSnapshot ? obj.captureMethodSnapshot : obj.captureMethod;
    const { method, structure } = resolveCustodyCapturePresentation(
      raw,
      acquisition,
    );
    if (hasSnapshot) next.captureMethodSnapshot = method;
    if (hasMethod) next.captureMethod = method;
    if (structure && next.evidenceStructureSnapshot == null) {
      next.evidenceStructureSnapshot = structure;
    }
  }

  // Non-intake evidence must never carry the intake authorization label.
  // Historically that label was also written for the mobile and citizen
  // routes, so only a record the acquisition authority says was a web upload
  // is relabelled as one; anything else reads as a neutral authorization.
  if (legacyIntakeUploadKind) {
    next.uploadKind =
      acquisition.acquisitionMode === "PROOVRA_WEB_UPLOAD"
        ? "web_upload_authorization"
        : "upload_authorization";
  }

  return next;
}

export function mapRecordStatusLabel(status: string | null | undefined): string {
  switch (safe(status, "").toUpperCase()) {
    case "CREATED":
      return "Created";
    case "UPLOADING":
      return "Uploading";
    case "UPLOADED":
      return "Uploaded";
    case "SIGNED":
      return "Signed";
    case "REPORTED":
      return "Reported";
    default:
      return safe(status);
  }
}

export function mapVerificationStatusLabel(
  status: string | null | undefined
): string {
  // AUD-47 (2026-10-20) — THE shared vocabulary (@proovra/shared evidence-vocabulary).
  return evidenceVerificationStatusLabel(status);
}

export function mapCertificationStatusLabel(
  value: string | null | undefined
): string {
  switch (safe(value, "").toUpperCase()) {
    case "ATTESTED":
      return "Attested";
    case "REQUESTED":
      return "Requested";
    case "DRAFT":
      return "Draft";
    case "REVOKED":
      return "Revoked";
    default:
      return safe(value, "Not recorded");
  }
}

// UC-0 — `mapCaptureMethodLabel` (structure enum → method label) was removed.
// Every report "Capture Method" row reads `captureMethodDisplayLabel` over
// the record's acquisition snapshot instead.

/** THE identity-level label (@proovra/shared identityLevelLabel), for rows without a capture snapshot. */
export function mapIdentityLevelLabel(value: string | null | undefined): string {
  return identityLevelLabel(value);
}

export function mapAuthProviderLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "GOOGLE":
      return "Google";
    case "APPLE":
      return "Apple";
    case "EMAIL":
      return "Email";
    case "GUEST":
      return "Guest";
    default:
      return "Provider not recorded";
  }
}

export function mapVerificationSourceLabel(
  value: string | null | undefined
): string {
  switch (safe(value, "").toUpperCase()) {
    case "REPORT_GENERATED":
      return "Report generated";
    case "PUBLIC_VERIFY_VIEWED":
      // Legacy value: meaningful technical verifications are no longer tagged
      // with PUBLIC_VERIFY_VIEWED; public hits are tracked separately on
      // lastPublicVerifyViewAtUtc (analytics) without bumping lastVerified.
      return "Public verification page viewed (legacy)";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    default:
      return "Verification source not recorded";
  }
}

/**
 * Rewrite intake-specific custody wording to submission/upload wording for
 * NON-intake (normal Web Capture / Web Upload / mobile) evidence. Presentation
 * only — event types, hashes, ordering, and the raw custody.json are
 * unchanged. For real intake evidence (isIntake === true) the intake wording
 * is correct and preserved.
 */
export function applyFlowAwareCustodyWording(
  text: string,
  isIntake: boolean,
): string {
  if (isIntake || !text) return text;
  return text
    .replace(/recorded at intake/gi, "recorded at submission")
    .replace(/initial intake authorization/gi, "initial upload authorization")
    .replace(/intake authorization/gi, "upload authorization");
}

/**
 * For INTAKE evidence, the IDENTITY_SNAPSHOT_RECORDED custody event captures
 * the LINK CREATOR / workspace-owner's identity at link authorization — NOT
 * the remote contributor. The generated report must therefore NOT label it
 * "Identity snapshot recorded at intake" (which implies the contributor
 * captured the evidence). This returns the role-safe DISPLAY label for that
 * event, or null to fall through to the normal label. The raw custody event
 * type + hash chain + raw custody.json payloads are untouched — this is
 * presentation only.
 */
export function intakeCustodyEventLabel(
  eventType: string | null | undefined,
  isIntake: boolean,
): string | null {
  if (!isIntake) return null;
  return safe(eventType, "").toUpperCase() === "IDENTITY_SNAPSHOT_RECORDED"
    ? "Link creator identity recorded"
    : null;
}

/**
 * Role-safe DISPLAY summary for the intake IDENTITY_SNAPSHOT_RECORDED event.
 * Replaces the payload-derived summary (which embeds the workspace owner's
 * email/provider) so the public report never shows the owner's contact
 * details nor implies the owner is the remote contributor. Raw custody data
 * is unchanged.
 */
export const INTAKE_IDENTITY_SNAPSHOT_SUMMARY =
  "Identity of the intake link creator (workspace account) was recorded when the secure link was authorized. The remote contributor's identity is not independently verified.";

/**
 * Role-safe DISPLAY summary for the NON-intake (authenticated Capture / Web
 * Upload / Mobile Capture) IDENTITY_SNAPSHOT_RECORDED event. The submitter is
 * the authenticated workspace user themselves — NOT a remote contributor — so
 * the intake "link creator / not independently verified" wording must never
 * appear. It names no sign-in method: the snapshot line that follows states
 * the account type recorded at capture (acquisitionIdentitySummary).
 * Raw custody data is unchanged.
 */
export const CAPTURE_IDENTITY_SNAPSHOT_SUMMARY =
  "Authenticated workspace user identity was recorded at submission.";

/**
 * ET-CUS-13: the report names custody events through THE shared label
 * (@proovra/shared custody-labels); this name is kept for its callers.
 */
export function mapCustodyEventLabel(eventType: string | null | undefined, payload?: unknown): string {
  return custodyEventLabel(eventType, payload);
}

export function mapObjectLockModePublicLabel(
  mode: string | null | undefined
): string {
  // AUD-47 (2026-10-20) — THE shared vocabulary (@proovra/shared evidence-vocabulary).
  return objectLockModeLabel(mode) ?? "Not recorded";
}

export function mapEvidenceAssetKindLabel(
  kind: ReportEvidenceAssetKind | null | undefined
): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    case "other":
      return "Other";
    default:
      return "Not recorded";
  }
}

export function normalizeReviewerText(value: string | null | undefined): string {
  return safe(value, "")
    .replace(/\bOAUTH_BACKED_IDENTITY\b/g, identityLevelLabel("OAUTH_BACKED_IDENTITY"))
    .replace(/\bMULTIPART_PACKAGE\b/g, "Multipart package")
    // UC-PROV-008 — no production writer emits SECURE_CAMERA; a legacy value
    // is named as what it is, never as a PROOVRA secure-camera capture.
    .replace(/\bSECURE_CAMERA\b/g, "Legacy capture-method value")
    .replace(/\bUPLOADED_FILE\b/g, "Uploaded existing file")
    .replace(/\bIMPORTED_DOCUMENT\b/g, "Imported document")
    .replace(/\bBASIC_ACCOUNT\b/g, identityLevelLabel("BASIC_ACCOUNT"))
    .replace(/\bVERIFIED_EMAIL\b/g, identityLevelLabel("VERIFIED_EMAIL"))
    .replace(/\bORGANIZATION_ACCOUNT\b/g, identityLevelLabel("ORGANIZATION_ACCOUNT"))
    .replace(/\bVERIFIED_ORGANIZATION\b/g, identityLevelLabel("VERIFIED_ORGANIZATION"))
    .replace(/_/g, " ");
}

/**
 * The report's identity rows, from THE capture-time acquisition snapshot when
 * the record has one (acquisition-identity.ts), else the legacy level label.
 */
export function reportIdentityLevelLabel(evidence: {
  identityLevelSnapshot?: string | null;
  acquisitionIdentity?: AcquisitionIdentitySnapshot | null;
}): string {
  return evidence.acquisitionIdentity
    ? acquisitionIdentityLevelLabel(evidence.acquisitionIdentity)
    : mapIdentityLevelLabel(evidence.identityLevelSnapshot);
}

export function reportIdentityRows(evidence: {
  acquisitionIdentity?: AcquisitionIdentitySnapshot | null;
}): Array<{ label: string; value: string }> {
  const s = evidence.acquisitionIdentity;
  if (!s) return [];
  return [
    { label: "Account Type", value: acquisitionAccountLabel(s) },
    { label: "Workspace Type", value: acquisitionWorkspaceLabel(s.workspaceKind) },
    { label: "Organization Verification", value: acquisitionOrganizationVerificationLabel(s) },
    { label: "Identity Snapshot", value: acquisitionIdentityBasisLabel(s.basis) },
  ];
}
