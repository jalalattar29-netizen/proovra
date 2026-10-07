import { custodyEventLabel } from "@proovra/shared";
import { OTS_ANCHOR_CLAIM_LABELS, resolveOtsAnchorClaim } from "@proovra/shared";
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

export function mapTimestampStatusPublicLabel(
  status: string | null | undefined
): string {
  switch (safe(status, "").toUpperCase()) {
    case "STAMPED":
    case "GRANTED":
    case "VERIFIED":
    case "SUCCEEDED":
      return "Trusted timestamp token recorded";
    case "RECORDED_NOT_VALIDATED":
      // ET-TSA-01: a token kept from before validation existed; never validated.
      return "Trusted timestamp recorded, not validated";
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
  /** 2026-09-29: the one OTS claim needs these; "verified" only for BITCOIN_VERIFIED. */
  anchoredAtUtc?: string | Date | null;
  anchorCheck?: string | null;
}): string {
  const status = safe(params.status, "").toUpperCase();
  if (status === "ANCHORED") {
    const claim = resolveOtsAnchorClaim({
      status: params.status,
      anchoredAtUtc: params.anchoredAtUtc ?? null,
      anchorCheck: params.anchorCheck ?? null,
    });
    // An ANCHORED status with no anchor time is not an anchor at all.
    if (claim === "VERIFIED" || claim === "ANCHORED_NOT_CHECKED") return OTS_ANCHOR_CLAIM_LABELS[claim];
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
      // A MODE says anchoring happened, not that anyone checked it (2026-09-29).
      return OTS_ANCHOR_CLAIM_LABELS.ANCHORED_NOT_CHECKED;
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
  otsAnchorCheck?: string | null;
}): string {
  const status = safe(input.otsStatus, "").toUpperCase();
  const hasProof = Boolean(input.otsProofPresent);

  // THE ONE OTS CLAIM (2026-09-29): a txid or anchored-at time shows anchor
  // material; only a chain-verified anchor reads "verified".
  if (status === "ANCHORED") {
    const claim = resolveOtsAnchorClaim({
      status: input.otsStatus,
      anchoredAtUtc: input.otsAnchoredAtUtc ?? null,
      anchorCheck: input.otsAnchorCheck ?? null,
    });
    if (claim === "VERIFIED" || claim === "ANCHORED_NOT_CHECKED") return OTS_ANCHOR_CLAIM_LABELS[claim];
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
