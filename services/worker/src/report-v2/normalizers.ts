import { captureMethodDisplayLabel } from "@proovra/shared-runtime/technical-metadata";

import { ReportEvidenceAssetKind } from "./types.js";
import { normalizeEnumText, safe } from "./formatters.js";

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

/** Resolve a raw custody capture-method snapshot into a role-safe method label
 *  + a structure label. Intake → "Secure Intake Link". */
export function resolveCustodyCapturePresentation(
  raw: unknown,
  isIntake: boolean,
): { method: string | null; structure: string | null } {
  const rawStr =
    raw == null ? null : String(raw).trim().length > 0 ? String(raw) : null;
  if (!rawStr) return { method: null, structure: null };
  return {
    method: captureMethodDisplayLabel({ captureMethod: rawStr, isIntake }),
    structure: mapEvidenceStructureLabel(rawStr),
  };
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
  isIntake: boolean,
): unknown {
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
      isIntake,
    );
    if (hasSnapshot) next.captureMethodSnapshot = method;
    if (hasMethod) next.captureMethod = method;
    if (structure && next.evidenceStructureSnapshot == null) {
      next.evidenceStructureSnapshot = structure;
    }
  }

  // Non-intake evidence must never carry the intake authorization label.
  if (legacyIntakeUploadKind) {
    next.uploadKind = "web_upload_authorization";
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
  switch (safe(status, "").toUpperCase()) {
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
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

export function mapCaptureMethodLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "SECURE_CAMERA":
      return "Captured with PROOVRA secure camera";
    case "UPLOADED_FILE":
      return "Uploaded existing file";
    case "IMPORTED_DOCUMENT":
      return "Imported document";
    case "MULTIPART_PACKAGE":
      // MULTIPART_PACKAGE is an evidence STRUCTURE, not an acquisition method.
      // A multipart record is produced by a PROOVRA web/browser multi-file
      // upload, so the reviewer-facing capture method reads "PROOVRA Web
      // Upload". The structure is shown separately as "Multipart evidence
      // package".
      return "PROOVRA Web Upload";
    case "EXTERNAL_INTAKE_UPLOAD":
      // Intake-only value. Keeps the Technical Appendix "Capture Method"
      // consistent with the Technical Summary + Evidence Acquisition, which
      // both read "Secure Intake Link" for intake evidence (never the
      // misleading "Capture method not recorded"). Non-intake capture
      // methods are unaffected.
      return "Secure Intake Link";
    default:
      return "Capture method not recorded";
  }
}

export function mapIdentityLevelLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "BASIC_ACCOUNT":
      return "Basic account";
    case "VERIFIED_EMAIL":
      return "Verified email";
    case "OAUTH_BACKED_IDENTITY":
      return "OAuth-backed identity";
    case "ORGANIZATION_ACCOUNT":
      return "Organization account";
    case "VERIFIED_ORGANIZATION":
      return "Verified organization";
    default:
      return "Identity level not recorded";
  }
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
 * appear. This states the authenticated, OAuth-backed identity positively.
 * Raw custody data is unchanged.
 */
export const CAPTURE_IDENTITY_SNAPSHOT_SUMMARY =
  "Authenticated workspace user identity was recorded at submission. Submitted by an authenticated workspace user via an OAuth-backed account.";

export function mapCustodyEventLabel(eventType: string | null | undefined): string {
  switch (safe(eventType, "").toUpperCase()) {
    case "EVIDENCE_CREATED":
      return "Evidence record created";
    case "IDENTITY_SNAPSHOT_RECORDED":
      return "Identity snapshot recorded at intake";
    case "REPORT_IDENTITY_CONTEXT_RECORDED":
      return "Identity context recorded at report generation";
    case "UPLOAD_STARTED":
      // Legacy event for backward compatibility. New records use
      // UPLOAD_AUTHORIZED at intake (presign issuance).
      return "Upload authorization recorded (legacy label)";
    case "UPLOAD_AUTHORIZED":
      return "Upload authorization recorded";
    case "UPLOAD_COMPLETED":
      return "Upload completion confirmed";
    case "SIGNATURE_APPLIED":
      return "Digital signature applied";
    case "TIMESTAMP_APPLIED":
      return "Trusted timestamp token recorded";
    case "TIMESTAMP_FAILED":
      return "Trusted timestamp not obtained";
    case "REPORT_GENERATED":
      return "Report generated";
    case "REVIEW_READY":
      return "Review-ready state recorded";
    case "VERIFICATION_PACKAGE_GENERATED":
      return "Verification package generated";
    case "CERTIFICATION_REQUESTED":
      return "Certification requested";
    case "CERTIFICATION_ATTESTED":
      return "Certification attested";
    case "CERTIFICATION_REVOKED":
      return "Certification revoked";
    case "EVIDENCE_PURGED":
      return "Evidence purged";
    case "OTS_APPLIED":
      return "OpenTimestamps update recorded";
    case "OTS_FAILED":
      return "OpenTimestamps provider returned failure";
    case "OTS_ATTEMPT_ERROR":
      return "OpenTimestamps attempt errored";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    case "VERIFY_VIEWED":
      return "Verification page viewed";
    case "EVIDENCE_VIEWED":
      return "Evidence viewed";
    case "REPORT_DOWNLOADED":
      return "Report downloaded";
    case "VERIFICATION_PACKAGE_DOWNLOADED":
      return "Verification package downloaded";
    case "EVIDENCE_LOCKED":
      return "Object Lock retention applied to storage";
    case "STORAGE_PROTECTION_UNAVAILABLE":
      return "Storage protection unavailable (Object Lock not applied)";
    case "EVIDENCE_ARCHIVED":
      return "Evidence archived";
    case "EVIDENCE_RESTORED":
      return "Evidence restored";
    case "ANCHOR_PUBLISHED":
      return "External anchor published";
    case "ANCHOR_FAILED":
      return "External anchor failed";
    default:
      return normalizeEnumText(eventType);
  }
}

export function mapTimestampStatusPublicLabel(
  status: string | null | undefined
): string {
  switch (safe(status, "").toUpperCase()) {
    case "STAMPED":
    case "GRANTED":
    case "VERIFIED":
    case "SUCCEEDED":
      return "Trusted timestamp token recorded";
    case "PENDING":
      return "Trusted timestamp pending";
    case "UNAVAILABLE":
      return "Trusted timestamp unavailable";
    case "FAILED":
      return "Trusted timestamp attempt failed";
    default:
      return "Trusted timestamp not configured";
  }
}

/**
 * Truthful OTS / Bitcoin anchoring labels.
 *
 * "OpenTimestamps Bitcoin anchoring verified" was previously returned for ANCHORED, but the
 * worker can persist ANCHORED before a Bitcoin transaction id is attached
 * (that lives behind a separate upgrade pass). For legal safety we no longer
 * return "verified" purely on the ANCHORED status. Use the txid-aware variant
 * mapOtsStatusPublicLabelWithTxid() to choose the precise label.
 */
export function mapOtsStatusPublicLabel(status: string | null | undefined): string {
  switch (safe(status, "").toUpperCase()) {
    case "ANCHORED":
      // Without txid context we cannot assert Bitcoin anchoring; report the
      // honest OTS state instead.
      return "OpenTimestamps proof present; Bitcoin anchoring pending";
    case "PENDING":
      return "OpenTimestamps proof present; Bitcoin anchoring pending";
    case "FAILED":
      return "OpenTimestamps anchoring failed";
    case "DISABLED":
      return "OpenTimestamps unavailable";
    default:
      return "OpenTimestamps not configured";
  }
}

/**
 * txid-aware variant: returns "Bitcoin anchoring verified" only when a Bitcoin
 * transaction id is actually recorded for the OTS proof. This is the function
 * report / verify / package surfaces should prefer when they have the txid.
 *
 * Phase IA-OTS-hybrid-fix (UX correction) — visible card surfaces
 * stay on short labels. The detailed PENDING+txid explanation is
 * provided ONLY by `mapOtsStatusTechnicalDetail` below for the
 * technical-appendix surface.
 */
export function mapOtsStatusPublicLabelWithTxid(params: {
  status: string | null | undefined;
  bitcoinTxid: string | null | undefined;
}): string {
  const status = safe(params.status, "").toUpperCase();
  const hasTxid =
    typeof params.bitcoinTxid === "string" &&
    /^[a-f0-9]{64}$/i.test(params.bitcoinTxid.trim());

  if (status === "ANCHORED" && hasTxid) {
    return "OpenTimestamps Bitcoin anchoring verified";
  }
  return mapOtsStatusPublicLabel(params.status);
}

/**
 * Phase IA-OTS-hybrid-fix (UX correction) — short canonical status
 * word for visible status badges, cover tiles, and compact cards:
 *
 *   ANCHORED  → "Anchored"
 *   PENDING   → "Pending"
 *   FAILED    → "Failed"
 *   DISABLED  → "Unavailable"
 *   anything else → "Not configured"
 *
 * Visible UI surfaces MUST prefer this helper over the longer
 * `mapOtsStatusPublicLabel` family. The detailed prose belongs in
 * the technical appendix only.
 */
export function mapOtsStatusShortLabel(
  status: string | null | undefined,
): string {
  switch (safe(status, "").toUpperCase()) {
    case "ANCHORED":
      return "Anchored";
    case "PENDING":
      return "Pending";
    case "FAILED":
      return "Failed";
    case "DISABLED":
      return "Unavailable";
    default:
      return "Not configured";
  }
}

/**
 * Phase IA-OTS-hybrid-fix (UX correction) — detailed sentence for
 * the technical appendix / smoke output ONLY. Spells out the
 * PENDING+txid hybrid state ("Bitcoin txid detected if present;
 * verification pending") so the appendix reader sees the full
 * picture, while visible cards stay short.
 *
 * NEVER use from a card/badge/cover surface — the cards must use
 * `mapOtsStatusShortLabel`.
 */
export function mapOtsStatusTechnicalDetail(params: {
  status: string | null | undefined;
  bitcoinTxid: string | null | undefined;
}): string {
  const status = safe(params.status, "").toUpperCase();
  const hasTxid =
    typeof params.bitcoinTxid === "string" &&
    /^[a-f0-9]{64}$/i.test(params.bitcoinTxid.trim());
  switch (status) {
    case "ANCHORED":
      return hasTxid
        ? "OTS proof anchored; Bitcoin transaction id recorded; verification complete."
        : "OTS proof anchored; no Bitcoin transaction id recorded yet.";
    case "PENDING":
      return hasTxid
        ? "OTS proof present; Bitcoin transaction id detected; verification pending."
        : "OTS proof present; Bitcoin anchoring pending.";
    case "FAILED":
      return "OTS anchoring failed.";
    case "DISABLED":
      return "OTS unavailable.";
    default:
      return "OTS not configured.";
  }
}

export function mapObjectLockModePublicLabel(
  mode: string | null | undefined
): string {
  switch (safe(mode, "").toUpperCase()) {
    case "COMPLIANCE":
      return "Compliance retention lock";
    case "GOVERNANCE":
      return "Governance retention lock";
    default:
      return "Not recorded";
  }
}

export function mapAnchorModePublicLabel(mode: string | null | undefined): string {
  switch (safe(mode, "").toUpperCase()) {
    case "ANCHORED":
    case "ACTIVE":
      return "OpenTimestamps Bitcoin anchoring verified";
    case "BITCOIN_ANCHORING_PENDING":
    case "READY":
      return "OTS proof present; Bitcoin anchoring pending";
    case "FAILED":
      return "OpenTimestamps anchoring failed";
    case "NOT_CONFIGURED":
    case "OFF":
      return "Anchoring not recorded";
    case "PUBLIC":
      return "Bitcoin anchoring";
    case "PRIVATE":
      return "Private anchoring";
    case "HASH_ONLY":
      return "Digest anchoring";
    default:
      return "Anchoring not recorded";
  }
}

/**
 * OTS-aware variant of `mapAnchorModePublicLabel` for the report's
 * Technical Appendix "Anchor Mode" row.
 *
 * The row historically reflected the EvidenceAnchor (external
 * publication) pipeline only, which produced a misleading
 * "OTS proof present; Bitcoin anchoring pending" label on records whose
 * OTS proof was actually fully ANCHORED with a Bitcoin txid. The row
 * is supposed to summarize the *Bitcoin anchoring* state — i.e. OTS /
 * Bitcoin anchoring. This
 * helper inspects the canonical OTS facts FIRST and only falls back to
 * the EvidenceAnchor-derived mode when OTS state is unknown.
 *
 * Honest semantics:
 *   - OTS ANCHORED with valid txid/anchoredAt → "OpenTimestamps Bitcoin anchoring verified"
 *   - OTS PENDING / proof present, not yet upgraded → "OTS proof present,
 *     Bitcoin anchoring pending"
 *   - OTS FAILED → "OpenTimestamps anchoring failed"
 *   - OTS DISABLED / missing → fall through to anchor-mode label
 *     (typically "Anchoring not recorded")
 *
 * NEVER fabricates. Never asserts verified anchoring without canonical
 * proof signals (txid OR anchoredAtUtc).
 */
export function mapPublicAnchoringLabelFromOts(input: {
  otsStatus?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsProofPresent?: boolean | null;
  fallbackAnchorMode?: string | null;
}): string {
  const status = safe(input.otsStatus, "").toUpperCase();
  const hasTxid =
    typeof input.otsBitcoinTxid === "string" &&
    /^[a-f0-9]{64}$/i.test(input.otsBitcoinTxid.trim());
  const hasAnchoredAt = Boolean(input.otsAnchoredAtUtc);
  const hasProof = Boolean(input.otsProofPresent);

  if (status === "ANCHORED" && (hasTxid || hasAnchoredAt)) {
    return "OpenTimestamps Bitcoin anchoring verified";
  }
  if (status === "FAILED") {
    return "OpenTimestamps anchoring failed";
  }
  if (status === "PENDING" || hasProof) {
    return "OTS proof present; Bitcoin anchoring pending";
  }
  if (status === "DISABLED") {
    return "Anchoring not recorded";
  }
  return mapAnchorModePublicLabel(input.fallbackAnchorMode ?? null);
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
    .replace(/\bOAUTH_BACKED_IDENTITY\b/g, "OAuth-backed identity")
    .replace(/\bMULTIPART_PACKAGE\b/g, "Multipart package")
    .replace(/\bSECURE_CAMERA\b/g, "PROOVRA secure camera")
    .replace(/\bUPLOADED_FILE\b/g, "Uploaded existing file")
    .replace(/\bIMPORTED_DOCUMENT\b/g, "Imported document")
    .replace(/\bBASIC_ACCOUNT\b/g, "Basic account")
    .replace(/\bVERIFIED_EMAIL\b/g, "Verified email")
    .replace(/\bORGANIZATION_ACCOUNT\b/g, "Organization account")
    .replace(/\bVERIFIED_ORGANIZATION\b/g, "Verified organization")
    .replace(/_/g, " ");
}
