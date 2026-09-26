/**
 * CANONICAL NATIVE EVIDENCE-DETAIL PROJECTION (Master Program §5/B, M2) — pure.
 *
 * The mobile detail fetches GET /v1/evidence/:id/review-workspace but previously
 * read fields that don't exist on it (rw.parts / rw.integrity / rw.publicVerification),
 * so Custody/Integrity showed stubs instead of real data. This projects the REAL
 * documented shape (apps/web/.../review-workspace-types.ts) — custody forensic +
 * access events, TSA/OTS, signature, custody chain, relationships, provenance,
 * public verification — plus the separate /technical-metadata and /certifications
 * responses. Everything here binds real server data; nothing is fabricated. The
 * enterprise/team-only blocks (governance, AI/derived-review) are intentionally
 * NOT projected (they need a teamId / enterprise surface). `reviewerAudit` is
 * sent on every review-workspace reply and IS projected (projectReviewerAudit).
 */

export interface CustodyEvent {
  sequence: number;
  atUtc: string;
  eventType: string;
  summary: string;
  category: "forensic" | "access";
}

export interface PreservationView {
  verificationStatus: string | null;
  verificationStatusLabel: string;
  tsa: { status: string | null; provider: string | null; genTimeUtc: string | null; failureReason: string | null };
  ots: { status: string | null; effectiveStatus: string | null; proofPresent: boolean; anchoredAtUtc: string | null; bitcoinTxid: string | null; failureReason: string | null };
  signature: { recorded: boolean; valid: boolean | null; keyId: string | null };
  custodyChain: { valid: boolean | null; mode: string | null; reason: string | null };
}

export interface RelationshipView {
  id: string;
  relationshipType: string;
  direction: string;
  linkedId: string;
  linkedTitle: string;
  linkedStatus: string;
  /** relationships.items[].note (EvidenceRelationshipsSection.tsx:170). */
  note: string | null;
}

export interface ProvenanceView {
  mode: string | null;
  category: string | null;
  label: string | null;
  statement: string | null;
}

export interface PublicVerifyView {
  state: string | null;
  published: boolean;
  disabledReason: string | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function b(v: unknown): boolean {
  return v === true;
}
function bn(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function toEvent(raw: unknown, category: "forensic" | "access"): CustodyEvent | null {
  const e = o(raw);
  const eventType = s(e["eventType"]);
  if (!eventType) return null;
  return {
    sequence: typeof e["sequence"] === "number" ? (e["sequence"] as number) : 0,
    atUtc: s(e["atUtc"]) ?? "",
    eventType,
    summary: s(e["payloadSummary"]) ?? "",
    category,
  };
}

/** Forensic + access custody events (both Personal/PRO-visible), newest last by sequence. */
export function projectCustodyEvents(rw: unknown): { forensic: CustodyEvent[]; access: CustodyEvent[] } {
  const cl = o(o(rw)["custodyLifecycle"]);
  const forensic = arr(cl["forensicEvents"]).map((e) => toEvent(e, "forensic")).filter((x): x is CustodyEvent => x !== null);
  const access = arr(cl["accessEvents"]).map((e) => toEvent(e, "access")).filter((x): x is CustodyEvent => x !== null);
  return { forensic, access };
}

export function projectPreservation(rw: unknown): PreservationView {
  const pm = o(o(rw)["preservationMatrix"]);
  const tsa = o(pm["tsa"]);
  const ots = o(pm["ots"]);
  const sig = o(pm["signature"]);
  const chain = o(pm["custodyChain"]);
  return {
    verificationStatus: s(pm["verificationStatus"]),
    verificationStatusLabel: s(pm["verificationStatusLabel"]) ?? "",
    tsa: { status: s(tsa["status"]), provider: s(tsa["provider"]), genTimeUtc: s(tsa["genTimeUtc"]), failureReason: s(tsa["failureReason"]) },
    ots: { status: s(ots["status"]), effectiveStatus: s(ots["effectiveStatus"]), proofPresent: b(ots["proofPresent"]), anchoredAtUtc: s(ots["anchoredAtUtc"]), bitcoinTxid: s(ots["bitcoinTxid"]), failureReason: s(ots["failureReason"]) },
    signature: { recorded: b(sig["recorded"]), valid: bn(sig["valid"]), keyId: s(sig["keyId"]) },
    custodyChain: { valid: bn(chain["valid"]), mode: s(chain["mode"]), reason: s(chain["reason"]) },
  };
}

/* ------------------------------------------------------- capture location (T-12) */

/**
 * The position recorded ALONGSIDE the capture (`review-workspace.sourceCaptureLocation`).
 * Rendered only when present — never synthesised from an approximate or
 * inferred position (EvidenceIntegrityTab.tsx:431-457).
 */
export interface CaptureLocationView {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  legalBoundary: string | null;
  /** The server-built external map link (sourceCaptureLocation.externalMapUrl), https only. */
  externalMapUrl: string | null;
}
function numOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
export function projectCaptureLocation(rw: unknown): CaptureLocationView | null {
  const loc = o(rw)["sourceCaptureLocation"];
  if (!loc || typeof loc !== "object") return null;
  const l = o(loc);
  const lat = numOrNull(l["lat"]);
  const lng = numOrNull(l["lng"]);
  if (lat === null || lng === null) return null;
  const map = s(l["externalMapUrl"]);
  return {
    lat,
    lng,
    accuracyMeters: numOrNull(l["accuracyMeters"]),
    legalBoundary: s(l["legalBoundary"]),
    externalMapUrl: map && /^https:\/\//.test(map) ? map : null,
  };
}
/* ------------------------------------------------ reviewer audit (T-14) */

/** One workspace review action (review-workspace `reviewerAudit[]`, ReviewerAuditTrailSection). */
export interface ReviewerAuditItem {
  id: string;
  eventLabel: string;
  /** A name or email — never a raw id; "Workspace user" when the server sent none. */
  actorLabel: string;
  metadataRecorded: boolean;
  createdAtIso: string | null;
}

export function projectReviewerAudit(rw: unknown): ReviewerAuditItem[] {
  const list = o(rw)["reviewerAudit"];
  return (Array.isArray(list) ? list : [])
    .map((raw) => o(raw))
    .filter((x) => s(x["id"]) && s(x["eventType"]))
    .map((x) => {
      const actor = o(x["actor"]);
      const meta = x["metadata"];
      return {
        id: s(x["id"]) as string,
        eventLabel: (s(x["eventType"]) as string).replace(/_/g, " "),
        actorLabel: s(actor["displayName"]) ?? s(actor["email"]) ?? "Workspace user",
        metadataRecorded: !!meta && typeof meta === "object" && Object.keys(meta as object).length > 0,
        createdAtIso: s(x["createdAt"]),
      };
    });
}

export const REVIEWER_AUDIT_COPY = {
  title: "Workspace review activity",
  boundary: "Reviewer audit is separate from forensic custody and records workspace review actions only.",
  empty: "No reviewer audit activity recorded yet.",
} as const;

/** The web technical-appendix copy (LocationContextCard, IntegrityContextCard, EvidencePartMetadataTable, FullExifAccordion). */
export const LOCATION_NOT_PROVIDED = "Location was not provided for this evidence.";
export const INTEGRITY_SECTION_TITLE = "Security & Integrity";
export const INTEGRITY_ADVISORY =
  "These values summarize the recorded integrity state. Full signature, RFC 3161 timestamp token, and OpenTimestamps proofs are preserved in the Verification Package and the verification endpoint.";
export const PER_PARTS_EMPTY = "No per-part technical metadata is available for this record.";
export const EXIF_REPRESENTATIVE_NOTE =
  "Representative EXIF is shown for the primary media item. Full per-file EXIF for every part is included in the Verification Package.";

export const CAPTURE_LOCATION_COPY = {
  title: "Capture location",
  description:
    "The position recorded alongside the capture, with its recorded accuracy. This is where the capturing device reported itself to be — not a determination of where the subject matter is.",
} as const;

/* ------------------------------------------------------- case assignment (T-12) */

/**
 * Which case this record belongs to — `review-workspace.relationships.caseId/caseName`
 * (the web's "Case" row and "Assign case" modal, evidence/[id]/page.tsx:1447).
 * Native never read it, so a record's case was invisible from the record.
 */
export interface CaseAssignmentView {
  caseId: string | null;
  caseName: string | null;
  /** T-14 — the web Relationships facts (review-workspace relationships). Absent on local updates. */
  relatedEvidenceCount?: number | null;
  multipart?: boolean;
}
export function projectCaseAssignment(rw: unknown): CaseAssignmentView {
  const r = o(o(rw)["relationships"]);
  const count = r["relatedEvidenceCount"];
  return {
    caseId: s(r["caseId"]),
    caseName: s(r["caseName"]),
    relatedEvidenceCount: typeof count === "number" && Number.isFinite(count) ? count : null,
    multipart: r["multipart"] === true,
  };
}

/** The ELIGIBILITY-narrowed case list (cases.routes.ts:434-458). */
export function buildEligibleCasesPath(evidenceId: string): string {
  return `/v1/cases?eligibleForEvidenceId=${encodeURIComponent(evidenceId)}`;
}
export function parseEligibleCases(data: unknown): Array<{ id: string; name: string }> {
  return arr(o(data)["items"])
    .map((raw) => {
      const c = o(raw);
      const id = s(c["id"]);
      return id ? { id, name: s(c["name"]) ?? s(c["title"]) ?? "Untitled case" } : null;
    })
    .filter((x): x is { id: string; name: string } => x !== null);
}
export function buildCaseEvidencePath(caseId: string): string {
  return `/v1/cases/${encodeURIComponent(caseId)}/evidence`;
}
export function buildCaseEvidenceItemPath(caseId: string, evidenceId: string): string {
  return `${buildCaseEvidencePath(caseId)}/${encodeURIComponent(evidenceId)}`;
}
/** evidence/[id]/page.tsx toasts, verbatim. */
export const CASE_ASSIGN_COPY = {
  title: "Assign evidence to case",
  empty: "No attachable cases are available in this workspace.",
  added: "Evidence added to case",
  addFailed: "Assignment failed",
  removed: "Evidence removed from case",
  removeFailed: "Remove failed",
} as const;

export function projectRelationships(rw: unknown): RelationshipView[] {
  const items = arr(o(o(rw)["relationships"])["items"]);
  const out: RelationshipView[] = [];
  for (const raw of items) {
    const r = o(raw);
    const id = s(r["id"]);
    const linked = o(r["linkedEvidence"]);
    const linkedId = s(linked["id"]);
    if (!id || !linkedId) continue;
    out.push({
      id,
      relationshipType: s(r["relationshipType"]) ?? "",
      direction: s(r["direction"]) ?? "",
      linkedId,
      linkedTitle: s(linked["title"]) ?? "Evidence",
      linkedStatus: s(linked["status"]) ?? "",
      note: s(r["note"]),
    });
  }
  return out;
}

export function projectProvenance(rw: unknown): ProvenanceView | null {
  const acq = o(o(o(rw)["sourceContext"])["acquisition"]);
  const mode = s(acq["mode"]);
  const label = s(acq["label"]);
  if (!mode && !label) return null;
  return { mode, category: s(acq["category"]), label, statement: s(acq["statement"]) };
}

export function projectPublicVerify(rw: unknown): PublicVerifyView {
  const pv = o(o(rw)["publicVerificationSummary"]);
  return { state: s(pv["state"]), published: b(pv["published"]), disabledReason: s(pv["disabledReason"]) };
}

/* ----------------------------------------------------- Technical metadata + EXIF */

export interface TechnicalView {
  primaryMediaType: string | null;
  resolutionSummary: string | null;
  metadataStatus: string | null;
  filesAnalyzed: number | null;
  filesTotal: number | null;
  exif: { present: boolean; camera: string | null; lensModel: string | null; originalCaptureTime: string | null; iso: string | null; aperture: string | null; exposureTime: string | null; gpsPresent: boolean } | null;
  capture: { uploadSource: string | null; captureMethod: string | null; deviceClass: string | null; osName: string | null; browserName: string | null; timezone: string | null };
  /** T-14 — the authenticated per-part table (technicalMetadata.perParts; never on the public projection). */
  perParts: TechnicalPart[];
}

export interface TechnicalPart {
  partIndex: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  pageCount: number | null;
  codec: string | null;
  container: string | null;
  metadataStatusLabel: string | null;
}

/** The web technical-appendix formatters (sections-model.ts fmtDimensions / fmtDurationMs). */
export function fmtPartDimensions(w: number | null, h: number | null): string | null {
  if (w == null || h == null || w <= 0 || h <= 0) return null;
  return `${w}×${h}`;
}
export function fmtPartDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/** The web PartMeta rows that carry a value, as one labelled line. */
export function partMetaLine(part: TechnicalPart): string | null {
  const bits = [
    fmtPartDimensions(part.width, part.height) ? `Dimensions ${fmtPartDimensions(part.width, part.height)}` : null,
    fmtPartDuration(part.durationMs) ? `Duration ${fmtPartDuration(part.durationMs)}` : null,
    part.pageCount != null && part.pageCount > 0 ? `Pages ${part.pageCount}` : null,
    part.codec ? `Codec ${part.codec}` : null,
    part.container ? `Container ${part.container}` : null,
    part.metadataStatusLabel ? `Metadata ${part.metadataStatusLabel}` : null,
  ].filter(Boolean);
  return bits.length > 0 ? bits.join(" · ") : null;
}

/** The part row for a material: by part index, else by content hash. */
export function technicalPartFor(parts: TechnicalPart[], material: { index: number | null; sha256: string | null }): TechnicalPart | null {
  return (
    (material.index !== null ? parts.find((x) => x.partIndex === material.index) : undefined) ??
    (material.sha256 ? parts.find((x) => x.sha256 === material.sha256) : undefined) ??
    null
  );
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Project GET /v1/evidence/:id/technical-metadata → { technicalMetadata }. */
export function projectTechnical(data: unknown): TechnicalView | null {
  const tm = o(o(data)["technicalMetadata"]);
  if (Object.keys(tm).length === 0) return null;
  const media = o(tm["media"]);
  const exifRaw = tm["exif"];
  const exif = exifRaw && typeof exifRaw === "object" ? o(exifRaw) : null;
  const env = o(tm["captureEnvironment"]);
  return {
    primaryMediaType: s(media["primaryMediaType"]),
    resolutionSummary: s(media["resolutionSummary"]),
    metadataStatus: s(media["metadataStatus"]),
    filesAnalyzed: num(media["filesAnalyzed"]),
    filesTotal: num(media["filesTotal"]),
    exif: exif
      ? {
          present: b(exif["exifPresent"]),
          camera: s(exif["camera"]),
          lensModel: s(exif["lensModel"]),
          originalCaptureTime: s(exif["originalCaptureTime"]),
          iso: exif["iso"] != null ? String(exif["iso"]) : null,
          aperture: exif["aperture"] != null ? String(exif["aperture"]) : null,
          exposureTime: s(exif["exposureTime"]) ?? (exif["shutterSpeed"] != null ? String(exif["shutterSpeed"]) : null),
          gpsPresent: b(exif["gpsPresent"]),
        }
      : null,
    capture: {
      uploadSource: s(env["uploadSource"]),
      captureMethod: s(env["captureMethod"]),
      deviceClass: s(env["deviceClass"]),
      osName: s(env["osName"]),
      browserName: s(env["browserName"]),
      timezone: s(env["timezone"]),
    },
    perParts: arr(tm["perParts"]).map((raw) => {
      const x = o(raw);
      return {
        partIndex: num(x["partIndex"]),
        sha256: s(x["sha256"]),
        width: num(x["width"]),
        height: num(x["height"]),
        durationMs: num(x["durationMs"]),
        pageCount: num(x["pageCount"]),
        codec: s(x["codec"]),
        container: s(x["container"]),
        metadataStatusLabel: s(x["metadataStatusLabel"]),
      };
    }),
  };
}

/* ----------------------------------------------------------------- Certifications */

export interface CertificationView {
  id: string;
  declarationType: string;
  status: string;
  attestorName: string | null;
  attestedAtUtc: string | null;
  revoked: boolean;
  /** T-12 — the lifecycle fields the declarations panel needs (EvidenceCertificationsPanel.tsx). */
  version: number;
  requestedAtUtc: string | null;
  attestorTitle: string | null;
  attestorOrganization: string | null;
  statementMarkdown: string | null;
  certificationHash: string | null;
  revokedAtUtc: string | null;
  revokeReason: string | null;
}

/** Project GET /v1/evidence/:id/certifications → { certifications }. */
export function projectCertifications(data: unknown): CertificationView[] {
  const items = arr(o(data)["certifications"]);
  const out: CertificationView[] = [];
  for (const raw of items) {
    const c = o(raw);
    const id = s(c["id"]);
    if (!id) continue;
    out.push({
      id,
      declarationType: s(c["declarationType"]) ?? "Declaration",
      status: s(c["status"]) ?? "",
      attestorName: s(c["attestorName"]),
      attestedAtUtc: s(c["attestedAtUtc"]),
      revoked: !!c["revokedAtUtc"],
      version: typeof c["version"] === "number" && Number.isFinite(c["version"]) ? (c["version"] as number) : 1,
      requestedAtUtc: s(c["requestedAtUtc"]),
      attestorTitle: s(c["attestorTitle"]),
      attestorOrganization: s(c["attestorOrganization"]),
      statementMarkdown: s(c["statementMarkdown"]),
      certificationHash: s(c["certificationHash"]),
      revokedAtUtc: s(c["revokedAtUtc"]),
      revokeReason: s(c["revokeReason"]),
    });
  }
  return out;
}

/* ----------------------------------------------------------------- Materials */

/**
 * THE PRESERVED FILES OF A RECORD.
 *
 * `contentItems` on the review-workspace projection. The native detail screen
 * had custody, integrity and technical metadata but never listed the files
 * themselves, so on a multi-part record — which is what every mixed-media
 * capture produces — there was no way to see what was actually in it.
 *
 * `downloadable` and `previewable` are the SERVER'S decisions, computed from
 * the content-access policy and the record's own state. The client renders
 * them; it does not derive them, and it never offers an action the server has
 * already said no to.
 *
 * `viewUrl` is a short-lived presigned URL (600s) and is deliberately NOT
 * stored, logged or re-derived — it is used at the moment of the tap and
 * forgotten.
 */
export interface MaterialItem {
  id: string;
  index: number | null;
  label: string;
  kind: string | null;
  mimeType: string | null;
  sizeLabel: string | null;
  sha256: string | null;
  isPrimary: boolean;
  downloadable: boolean;
  previewable: boolean;
  viewUrl: string | null;
  /** The server's own note about what this file represents for a reviewer. */
  representationNote: string | null;
}

export function projectMaterials(rw: unknown): MaterialItem[] {
  // The review workspace nests the record's files at `evidence.contentItems`
  // (evidence.routes.ts review-workspace reply); reading the top level found
  // nothing, so the Materials list was always empty. The top level stays as a
  // fallback for a flat projection.
  const raw = o(o(rw)["evidence"])["contentItems"] ?? o(rw)["contentItems"];
  const items = Array.isArray(raw) ? raw : [];

  return items
    .map((entry) => {
      const it = o(entry);
      const id = s(it["id"]);
      if (!id) return null;
      return {
        id,
        index: num(it["index"]),
        label: s(it["label"]) ?? s(it["originalFileName"]) ?? "Untitled file",
        kind: s(it["kind"]),
        mimeType: s(it["mimeType"]),
        sizeLabel: s(it["displaySizeLabel"]),
        sha256: s(it["sha256"]),
        isPrimary: b(it["isPrimary"]),
        // Never widened: a client that decided for itself would offer a
        // download the server refuses.
        downloadable: b(it["downloadable"]),
        previewable: b(it["previewable"]),
        viewUrl: s(it["viewUrl"]),
        representationNote: s(it["reviewerRepresentationNote"]),
      };
    })
    .filter((m): m is MaterialItem => m !== null)
    .sort((a, b2) => (a.index ?? 0) - (b2.index ?? 0));
}

/**
 * Why a file cannot be opened, or null when it can.
 *
 * "Download" that silently does nothing is the worst of the three states; a
 * disabled control with a reason is the honest one.
 */
export function materialBlockedReason(item: MaterialItem): string | null {
  if (item.downloadable && item.viewUrl) return null;
  if (!item.downloadable) return "This file is not available for download in this workspace.";
  return "A download link could not be issued for this file.";
}

/* ------------------------------------------------------------------ Comments */

/**
 * REVIEWER COMMENTS on a record.
 *
 * `GET|POST /v1/evidence/:id/comments`. A record under review is discussed by
 * the people reviewing it, and until now that conversation existed only on the
 * web — a reviewer on a phone could read every hash and custody event and not
 * a single word anyone had said about them.
 *
 * VISIBILITY IS NOT COSMETIC. `INTERNAL` is private to the workspace and
 * `TEAM` is visible to the collaboration group; the default is INTERNAL and
 * this module keeps it, because a comment that turns out to be wider than its
 * author intended cannot be un-seen.
 */
export const EVIDENCE_COMMENT_VISIBILITIES = ["INTERNAL", "TEAM"] as const;
export type EvidenceCommentVisibility = (typeof EVIDENCE_COMMENT_VISIBILITIES)[number];

export const COMMENT_BODY_MAX = 4000;

export function buildCommentsPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/comments`;
}

export function buildCommentPath(evidenceId: string, commentId: string): string {
  return `${buildCommentsPath(evidenceId)}/${encodeURIComponent(commentId)}`;
}

export interface EvidenceComment {
  id: string;
  body: string;
  visibility: EvidenceCommentVisibility;
  authorName: string;
  authorId: string | null;
  createdAtIso: string | null;
  edited: boolean;
}

export function projectComments(payload: unknown): EvidenceComment[] {
  const raw = o(payload)["items"];
  const items = Array.isArray(raw) ? raw : [];

  return items
    .map((entry) => {
      const c = o(entry);
      const id = s(c["id"]);
      if (!id) return null;
      const author = o(c["author"]);
      const visibility = s(c["visibility"]);
      return {
        id,
        body: typeof c["body"] === "string" ? (c["body"] as string) : "",
        // An unrecognised visibility reads as the NARROWER one. Guessing wide
        // on a comment nobody can un-share is the wrong direction to be wrong.
        visibility: (visibility === "TEAM" ? "TEAM" : "INTERNAL") as EvidenceCommentVisibility,
        authorName: s(author["displayName"]) ?? s(author["email"]) ?? "Someone",
        authorId: s(author["id"]),
        createdAtIso: s(c["createdAt"]),
        edited: b(c["edited"]),
      };
    })
    .filter((c): c is EvidenceComment => c !== null)
    // Oldest first: a conversation reads forwards.
    .sort((a, b2) => {
      const at = a.createdAtIso ? Date.parse(a.createdAtIso) : 0;
      const bt = b2.createdAtIso ? Date.parse(b2.createdAtIso) : 0;
      return at - bt;
    });
}

export function isSendableComment(body: string): boolean {
  const v = body.trim();
  return v.length >= 1 && v.length <= COMMENT_BODY_MAX;
}

export function buildCommentBody(
  body: string,
  visibility: EvidenceCommentVisibility = "INTERNAL",
) {
  return { body: body.trim(), visibility };
}

export function commentVisibilityLabel(visibility: EvidenceCommentVisibility): string {
  return visibility === "TEAM" ? "Visible to the group" : "Workspace only";
}

// ---------------------------------------------------------------------------
// DUPLICATE DETECTION
// ---------------------------------------------------------------------------
//
// GET /v1/evidence/:id/duplicates
//
// Read the GROUPED view, not the four legacy per-category arrays. The web
// panel's own header records why it stopped reading them:
//
//   "The same record could appear in 2–3 of the four arrays and the part-level
//    array repeated a parent record once per matching part — so a single
//    duplicate with 8 matching parts produced 8 identical rows."
//
// It also records the second defect: the backend pre-substituted "Digital
// Evidence Record" for every empty title, so the title cascade never ran and
// every row showed the same fallback. The grouped view carries `rawTitle`
// (null when the column is empty) precisely so the cascade CAN run, and this
// module runs it.

import { humanizeEnum } from "./domain-display";
import { listEnvelope } from "./envelope";
import { GENERATION_REQUEST_OUTCOMES } from "./domain-enums.generated";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export function buildDuplicatesPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/duplicates`;
}

export interface DuplicateMatch {
  evidenceId: string;
  /** The record's own name, through the cascade, never a blanket fallback. */
  title: string;
  type: string;
  itemCount: number;
  createdAtIso: string | null;
  matchReasons: string[];
  matchedPartsCount: number;
}

export interface DuplicateReport {
  matches: DuplicateMatch[];
  totalRecords: number;
  /** The server's own statement of what this check could NOT see. */
  limitation: string | null;
}

/**
 * The title cascade: the record's own title, then the display filename, then
 * the original filename, then the type, then a short id.
 *
 * `rawTitle` is null when the column is empty — that is the point of the field.
 * A surface that read the pre-substituted title would show the same words on
 * every row and tell the reader nothing about which record is which.
 */
function duplicateTitle(d: Record<string, unknown>): string {
  const raw = str(d.rawTitle);
  if (raw) return raw;
  const display = str(d.displayFileName);
  if (display) return display;
  const original = str(d.originalFileName);
  if (original) return original;
  const type = str(d.type);
  if (type) return humanizeEnum(type);
  const id = str(d.evidenceId);
  return id ? `Record ${id.slice(0, 8)}` : "Record";
}

export function parseDuplicateReport(payload: unknown): DuplicateReport {
  const d = obj(payload);
  const matches = rows(d.groupedMatches)
    .map((raw) => {
      const m = obj(raw);
      const evidenceId = str(m.evidenceId);
      if (!evidenceId) return null;
      return {
        evidenceId,
        title: duplicateTitle(m),
        type: str(m.type) ?? "",
        itemCount: typeof m.itemCount === "number" ? m.itemCount : 0,
        createdAtIso: str(m.createdAt),
        matchReasons: rows(m.matchReasons).filter((r): r is string => typeof r === "string"),
        matchedPartsCount:
          typeof m.matchedPartsCount === "number" ? m.matchedPartsCount : 0,
      };
    })
    .filter((m): m is DuplicateMatch => m !== null);

  return {
    matches,
    totalRecords:
      typeof d.totalRecords === "number" ? d.totalRecords : matches.length,
    limitation: str(d.limitation),
  };
}

/**
 * What a duplicate check can and cannot see.
 *
 * Shown whether or not anything matched, because "no duplicates found" without
 * this sentence reads as "there are none", which is a stronger claim than the
 * check can support.
 */
export const DUPLICATE_LIMITATION =
  "Duplicate detection is limited to accessible records and recorded hashes or metadata.";

/** The web MATCH_REASON_LABELS, verbatim (DuplicateDetectionPanel.tsx:16). */
export function duplicateReasonLabel(reason: string): string {
  switch (reason.toUpperCase()) {
    case "EXACT_HASH":
      return "Exact file hash";
    case "FINGERPRINT":
      return "Fingerprint";
    case "PART_HASH":
      return "Part-level hash";
    case "METADATA":
      return "Filename + size";
    default:
      return humanizeEnum(reason);
  }
}

/**
 * A single line describing WHY this record is flagged — the web's reason
 * chips, with the part-level count as `× n` (DuplicateDetectionPanel.tsx:106).
 */
export function duplicateMatchSummary(match: DuplicateMatch): string {
  const reasons = match.matchReasons.map((r) =>
    r.toUpperCase() === "PART_HASH" && match.matchedPartsCount > 1
      ? `${duplicateReasonLabel(r)} × ${match.matchedPartsCount}`
      : duplicateReasonLabel(r),
  );
  return reasons.length > 0 ? reasons.join(" · ") : "Matched";
}

/** DuplicateDetectionPanel.tsx:234-251, verbatim. */
export const DUPLICATE_COPY = {
  loading: "Checking accessible duplicates...",
  empty: "No accessible duplicate or related records found.",
  summary: (total: number) =>
    total === 1
      ? "1 record shares one or more file hashes or metadata."
      : `${total} records share one or more file hashes or metadata.`,
  open: "Open record →",
} as const;

// ---------------------------------------------------------------------------
// REPORT AND PACKAGE GENERATION
// ---------------------------------------------------------------------------
//
// POST /v1/evidence/:id/reports/regenerate — ONE request for BOTH artifacts,
// because the verification package is built inside the report job.
//
// ===========================================================================
// READ THE OUTCOME, NOT THE BOOLEAN
// ===========================================================================
// The web's own closure note records what happened when a client did not:
// `enqueued: false` covered six different server answers, so a Redis outage, a
// permanently blocked record, a persist failure and a missing principal all
// read as "Generation is already under way for this record." Five of the six
// were false, and two described work that was never going to happen.
//
// The outcome vocabulary is GENERATED from `packages/shared`, so a new outcome
// cannot exist canonically and be unknown here.

export function buildRegeneratePath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/reports/regenerate`;
}

export type GenerationTone = "success" | "info" | "error";

export interface GenerationOutcome {
  outcome: string;
  /** The SERVER's sentence when it sent one; a safe fallback otherwise. */
  message: string;
  tone: GenerationTone;
  /** Whether a new unit of work was actually accepted. */
  acceptedWork: boolean;
}

const GENERATION_FALLBACK: Readonly<Record<string, string>> = {
  ENQUEUED:
    "Generation requested. The report and verification package will appear here when they complete.",
  SUPERSEDED:
    "Generation requested. The earlier attempt is kept as history; this is a new request.",
  ALREADY_ACTIVE: "Generation is already under way for this record.",
  QUEUE_UNAVAILABLE:
    "We could not schedule generation right now. The request is saved and will be picked up automatically; the record is unaffected.",
  NOT_INCLUDED:
    "Reports and verification packages are not included for this evidence record.",
  RECOVERABLE_BLOCKED:
    "Generation is currently blocked for this record. It becomes possible again when the block is lifted.",
  TERMINAL:
    "The previous generation attempt stopped and cannot be retried in its current state.",
  REQUEST_PERSIST_FAILED:
    "We could not record the request. Please try again; the record is unaffected.",
  EVIDENCE_NOT_FOUND: "This evidence record is not available.",
  WORKSPACE_UNRESOLVED:
    "This older evidence record needs a workspace association before new output generation can be requested. Its existing materials are unaffected.",
  REQUESTER_REQUIRED: "This request could not be attributed and was not made.",
  NOTHING_TO_RECOVER:
    "Nothing is missing or failed for this record. Its report and verification package are available.",
  NOT_RECOVERABLE: "This output cannot be recovered in the record's current state.",
  REPLAYED: "This request was already received. No additional version was created.",
  UNRECOGNIZED:
    "The request was answered, but this screen could not read the result. The record's current state is shown.",
};

const GENERATION_TONE: Readonly<Record<string, GenerationTone>> = {
  ENQUEUED: "success",
  SUPERSEDED: "success",
  ALREADY_ACTIVE: "info",
  QUEUE_UNAVAILABLE: "info",
  NOT_INCLUDED: "info",
  RECOVERABLE_BLOCKED: "info",
  TERMINAL: "info",
  REQUEST_PERSIST_FAILED: "error",
  EVIDENCE_NOT_FOUND: "error",
  WORKSPACE_UNRESOLVED: "info",
  REQUESTER_REQUIRED: "error",
  NOTHING_TO_RECOVER: "info",
  NOT_RECOVERABLE: "info",
  REPLAYED: "info",
  UNRECOGNIZED: "info",
};

/** ENQUEUED and SUPERSEDED are the only two that scheduled new work. */
export function generationAcceptedWork(outcome: string): boolean {
  return outcome === "ENQUEUED" || outcome === "SUPERSEDED";
}

export function readGenerationOutcome(payload: unknown): GenerationOutcome {
  const d = obj(payload);
  const raw = str(d.outcome);
  const known = raw !== null && (GENERATION_REQUEST_OUTCOMES as readonly string[]).includes(raw);
  // The legacy boolean only when no typed outcome arrived, and `false` reads
  // as ALREADY_ACTIVE exactly as the web reader does — not as a failure. A
  // NAMED outcome this build does not know is UNRECOGNIZED: reading it as
  // ALREADY_ACTIVE told a person work was under way when nothing said so.
  const outcome = known
    ? (raw as string)
    : raw !== null && raw.trim() !== ""
      ? "UNRECOGNIZED"
      : d.enqueued === true
        ? "ENQUEUED"
        : "ALREADY_ACTIVE";

  const serverMessage = str(d.message)?.trim() ?? null;
  return {
    outcome,
    message:
      serverMessage && serverMessage.length > 0
        ? serverMessage
        : (GENERATION_FALLBACK[outcome] ?? "Generation was requested."),
    tone: GENERATION_TONE[outcome] ?? "info",
    acceptedWork: generationAcceptedWork(outcome),
  };
}

/**
 * THE PER-OUTPUT VERBS AND THE NEW-VERSION WORDS are the shared table
 * (`@proovra/shared` output-action-copy), the same one the web renders: a
 * missing package is "Recover verification package", never a regeneration of
 * both, and a new version is its own confirmed action.
 */
export {
  NEW_VERSION_LABEL,
  formatEstimatedBytes,
  makeClientRequestKey,
  newVersionConsequence,
  outputActionLabel,
  outputUnavailableReasonCopy,
  outputUnavailableReasonShort,
} from "@proovra/shared";

/** The intents a per-output control sends; NEW_VERSION has its own body. */
export type OutputRequestIntent = "GENERATE" | "RETRY" | "RECOVER";

/** The per-output verbs a control may render; anything else renders nothing. */
export function asOutputRequestIntent(action: string | null | undefined): OutputRequestIntent | null {
  return action === "GENERATE" || action === "RETRY" || action === "RECOVER" ? action : null;
}

/** Body for one output's action. The server re-derives what runs. */
export function buildOutputRequestBody(intent: OutputRequestIntent): string {
  return JSON.stringify({ intent });
}

/**
 * Body for the separate, confirmed new version. The key is minted once per
 * confirmation and reused only while that request is unanswered, so a request
 * that landed is answered with the first one (REPLAYED), never a second version.
 */
export function buildNewVersionBody(clientRequestKey: string): string {
  return JSON.stringify({ intent: "NEW_VERSION", clientRequestKey });
}

/** A failed request the server did not answer may have landed: keep the key. */
export function requestWasAnswered(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

// ---------------------------------------------------------------------------
// ANNOTATIONS AND LEGAL NOTES
// ---------------------------------------------------------------------------
//
// GET/POST   /v1/evidence/:id/annotations
// PATCH/DEL  /v1/evidence/:id/annotations/:annotationId
// GET/POST   /v1/evidence/:id/legal-notes
// PATCH/DEL  /v1/evidence/:id/legal-notes/:noteId
//
// ===========================================================================
// THE BOUNDARY IS THE POINT
// ===========================================================================
// These are INTERNAL workspace materials. The web carries the sentence on the
// panel and so does Native, because a note sitting beside hashes and custody
// events reads as part of the evidence record unless something says it is not.
// They are not in public verification, not in the fixed PDF report, and not in
// the verification package.
//
// Both surfaces are shown only when the SERVER-projected enterprise gate says
// so — the same `isPlatformAdmin || isEnterpriseWorkspace` the web reads.
// Nothing here derives that; absent reads as false.
//
// The vocabularies are GENERATED from schema.prisma, so a new annotation or
// note type cannot exist canonically and be unknown natively.

export function buildAnnotationsPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/annotations`;
}
export function buildAnnotationPath(evidenceId: string, annotationId: string): string {
  return `${buildAnnotationsPath(evidenceId)}/${encodeURIComponent(annotationId)}`;
}
export function buildLegalNotesPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/legal-notes`;
}
export function buildLegalNotePath(evidenceId: string, noteId: string): string {
  return `${buildLegalNotesPath(evidenceId)}/${encodeURIComponent(noteId)}`;
}

export const INTERNAL_MATERIALS_BOUNDARY =
  "Reviewer comments, legal notes and annotations are internal workspace materials. " +
  "They are not included in public verification, the fixed PDF report, or the " +
  "verification package.";

/* ------------------------------------------------------------ legal notes */

export const LEGAL_NOTE_MAX = 6000;

export interface LegalNote {
  id: string;
  body: string;
  noteType: string;
  authorLabel: string | null;
  createdAtIso: string | null;
}

/**
 * `GET /v1/evidence/:id/legal-notes` → `{ items: [...] }`.
 *
 * This read `notes`, then `legalNotes`, then fell through to the bare
 * payload — so every record that HAD notes rendered as one that had none.
 * Those keys are not kept as fallbacks: the route has sent `items` since the
 * commit that introduced it, so they were never a shape the server used. They
 * were the defect, and a fallback would preserve it where nothing can see it.
 */
export function parseLegalNotes(payload: unknown): LegalNote[] {
  return rows(listEnvelope(payload, ["items"]))
    .map((raw) => {
      const n = obj(raw);
      const id = str(n.id);
      if (!id) return null;
      const author = obj(n.author);
      return {
        id,
        body: str(n.body) ?? "",
        noteType: str(n.noteType) ?? "GENERAL",
        // A raw user id is not an author. Absent stays absent.
        authorLabel: str(author.displayName) ?? str(author.email),
        createdAtIso: str(n.createdAt),
      };
    })
    .filter((n): n is LegalNote => n !== null);
}

export function validateLegalNote(body: string): string | null {
  const b = body.trim();
  if (b.length === 0) return "Write the note first.";
  if (b.length > LEGAL_NOTE_MAX) {
    return `A legal note cannot be longer than ${LEGAL_NOTE_MAX} characters.`;
  }
  return null;
}

export function buildLegalNoteBody(body: string, noteType: string) {
  return { body: body.trim(), noteType };
}

export function legalNoteTypeLabel(noteType: string): string {
  return humanizeEnum(noteType);
}

/**
 * A PRIVILEGED note is not an ordinary one.
 *
 * The type is a claim about what the note IS, and privilege is the claim with
 * consequences — it is why "not included in any export" has to be visible on
 * the row rather than only in a panel header somebody scrolled past.
 */
export function legalNoteIsPrivileged(noteType: string): boolean {
  return noteType.toUpperCase() === "PRIVILEGED";
}

/* ------------------------------------------------------------ annotations */

export const ANNOTATION_BODY_MAX = 4000;

export interface EvidenceAnnotation {
  id: string;
  annotationType: string;
  body: string | null;
  evidencePartId: string | null;
  pageNumber: number | null;
  mediaTimestampMs: number | null;
  authorLabel: string | null;
  createdAtIso: string | null;
}

/**
 * `GET /v1/evidence/:id/annotations` → `{ items: [...] }`. See
 * `parseLegalNotes` for why neither the bare payload nor the invented
 * `annotations` key is accepted.
 */
export function parseAnnotations(payload: unknown): EvidenceAnnotation[] {
  return rows(listEnvelope(payload, ["items"]))
    .map((raw) => {
      const a = obj(raw);
      const id = str(a.id);
      if (!id) return null;
      const author = obj(a.author);
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return {
        id,
        annotationType: str(a.annotationType) ?? "TEXT",
        body: str(a.body),
        evidencePartId: str(a.evidencePartId),
        pageNumber: n(a.pageNumber),
        mediaTimestampMs: n(a.mediaTimestampMs),
        authorLabel: str(author.displayName) ?? str(author.email),
        createdAtIso: str(a.createdAt),
      };
    })
    .filter((a): a is EvidenceAnnotation => a !== null);
}

export function validateAnnotation(body: string): string | null {
  const b = body.trim();
  if (b.length === 0) return "Write the annotation first.";
  if (b.length > ANNOTATION_BODY_MAX) {
    return `An annotation cannot be longer than ${ANNOTATION_BODY_MAX} characters.`;
  }
  return null;
}

/**
 * A TEXT annotation on a phone, deliberately.
 *
 * POINT / BOX / REGION carry coordinates against a rendered frame, and a
 * device that does not render the media at a known scale cannot produce an
 * honest one — a coordinate guessed from a thumbnail would be a claim about
 * where in the evidence something is, which is exactly the kind of claim this
 * product does not invent. TEXT with TIME_ONLY carries no spatial claim, so it
 * is the one a phone can make truthfully. Every type is READ and rendered.
 */
export function buildAnnotationBody(body: string, mediaTimestampMs?: number | null) {
  const ms = typeof mediaTimestampMs === "number" && mediaTimestampMs >= 0 ? mediaTimestampMs : null;
  return {
    annotationType: "TEXT",
    // TIME_ONLY when a timestamp is given, and still TIME_ONLY when it is not:
    // what this annotation asserts is "about this record", never "at this
    // point in the frame".
    coordinateSpace: "TIME_ONLY",
    body: body.trim(),
    ...(ms !== null ? { mediaTimestampMs: ms } : {}),
  };
}

export function annotationTypeLabel(annotationType: string): string {
  return humanizeEnum(annotationType);
}

/** Where an annotation points, in words, from what the record actually has. */
export function annotationAnchorLabel(a: EvidenceAnnotation): string | null {
  if (a.pageNumber !== null) return `Page ${a.pageNumber}`;
  if (a.mediaTimestampMs !== null) {
    const total = Math.floor(a.mediaTimestampMs / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `At ${mm}:${ss}`;
  }
  // A spatial annotation whose coordinates this surface does not render is
  // named as such rather than shown without its anchor, which would place it
  // nowhere and read as being about the whole record.
  if (["POINT", "BOX", "REGION"].includes(a.annotationType.toUpperCase())) {
    return "Marked on the media";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle action paths
// ---------------------------------------------------------------------------
//
// One builder per action, so a call site names the route it hits. The screen
// previously assembled them from one template with a runtime suffix, which
// meant neither a reader nor the capability analyzer could tell which endpoint
// a given button called.

export function buildEvidencePath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}`;
}
export function buildEvidenceLockPath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/lock`;
}
export function buildEvidenceArchivePath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/archive`;
}
export function buildEvidenceLabelPath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/label`;
}
export function buildEvidenceOriginalPath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/original`;
}
export function buildEvidenceRelationshipsPath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/relationships`;
}
export function buildEvidenceRelationshipPath(
  evidenceId: string,
  relationshipId: string,
): string {
  return `${buildEvidenceRelationshipsPath(evidenceId)}/${encodeURIComponent(relationshipId)}`;
}

/* ------------------------------------------------------- relationships */

/** `RelationshipBody.note`: trimmed, max 1000 (evidence.routes.ts:462). */
export const RELATIONSHIP_NOTE_MAX = 1000;

/**
 * The link types, from the schema.
 *
 * Generated from `EvidenceRelationshipType` rather than typed out here, so a
 * type added to the schema cannot quietly become one this surface refuses to
 * offer. The generator is guarded by `test/domain-enums-generated.test.mjs`.
 */
export { EVIDENCE_RELATIONSHIP_TYPES } from "./domain-enums.generated";

export function relationshipTypeLabel(type: string): string {
  return humanizeEnum(type);
}

export function validateRelationshipNote(note: string): string | null {
  if (note.trim().length > RELATIONSHIP_NOTE_MAX) {
    return `A note cannot be longer than ${RELATIONSHIP_NOTE_MAX} characters.`;
  }
  return null;
}

/**
 * The create body.
 *
 * An empty note is OMITTED rather than sent as "": the field is
 * `.optional().nullable()`, and sending an empty string would store a note
 * that says nothing where "no note" is the truthful state.
 */
export function buildRelationshipBody(input: {
  targetEvidenceId: string;
  relationshipType: string;
  note: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    targetEvidenceId: input.targetEvidenceId,
    relationshipType: input.relationshipType,
  };
  const note = input.note.trim();
  if (note) body.note = note;
  return body;
}

/**
 * Whether this record can have its links changed, and why not.
 *
 * Creating and removing a link both need `evidence.update_metadata` on THIS
 * record (the route's D21 note), which is the same write a rename needs - so
 * the same lifecycle states refuse it, and they refuse it in the same words
 * rather than in two descriptions that could drift.
 */
export function relationshipEditRefusal(lifecycle: EvidenceLifecycle | null): string | null {
  if (!lifecycle) return "Linking is unavailable until the record's state is known.";
  if (lifecycle.productState === "TRASHED") return "A record in the trash cannot be linked.";
  if (lifecycle.productState === "DESTROYED") return "This record has been destroyed.";
  if (evidenceIsLocked(lifecycle)) {
    return "This record is permanently locked and its links cannot be changed.";
  }
  return null;
}

/* --------------------------------------------------- the ORIGINAL file */

/**
 * What the person is told before the request is made.
 *
 * Not after. The route appends EVIDENCE_VIEWED to the custody chain and an
 * `evidence.downloaded` audit row the moment it answers, so by the time a
 * toast could explain it the entry already exists. A custody chain whose
 * entries surprise the person named in them is not doing its job.
 */
export const ORIGINAL_ACCESS_CONSEQUENCE =
  "Opening the original file is recorded on this record's custody chain, with " +
  "your name and the time. The link expires after 10 minutes.";

/**
 * The presigned link, from the response the route actually sends.
 *
 * `url` and `publicUrl` are both read because the web reads both
 * (evidence/[id]/page.tsx:574), and an absent link is null rather than an
 * empty string — "not available" and "available at nowhere" are different
 * answers and only one of them should reach a button.
 */
export function parseOriginalLink(payload: unknown): string | null {
  const d = obj(payload);
  return str(d.url) ?? str(d.publicUrl);
}

/**
 * Whether the original can be fetched at all, in the record's current state.
 *
 * A DESTROYED record has no bytes left to presign, and the route answers 404
 * "Original file not found". Offering the control anyway would promise
 * something the product has deliberately made impossible.
 */
export function originalAccessRefusal(lifecycle: EvidenceLifecycle | null): string | null {
  if (lifecycle?.productState === "DESTROYED") {
    return "This record has been destroyed. Its original file no longer exists.";
  }
  return null;
}

/* ------------------------------------------------------ the record label */

/** `UpdateEvidenceLabelBody`: trimmed, 1..160 (evidence.routes.ts:388). */
export const EVIDENCE_LABEL_MAX = 160;

export function validateEvidenceLabel(label: string): string | null {
  const l = label.trim();
  if (l.length === 0) return "Name the record first.";
  if (l.length > EVIDENCE_LABEL_MAX) {
    return `A record name cannot be longer than ${EVIDENCE_LABEL_MAX} characters.`;
  }
  return null;
}

export function buildEvidenceLabelBody(label: string): { label: string } {
  return { label: label.trim() };
}

/**
 * Whether this record can be renamed, and why not when it cannot.
 *
 * The route answers 409 for a locked record and 409 for a deleted one. Both
 * are already in the lifecycle projection the screen loads, so the refusal is
 * stated where the control is rather than discovered by pressing it — and the
 * wording is the route's own, so the two cannot drift.
 *
 * An ABSENT lifecycle withholds: this screen's rule throughout is that a
 * projection it has not read is not permission it may assume.
 */
export function evidenceLabelRefusal(lifecycle: EvidenceLifecycle | null): string | null {
  if (!lifecycle) return "Renaming is unavailable until the record's state is known.";
  // productState is the canonical state (ACTIVE | ARCHIVED | TRASHED |
  // DESTROYED). Reading it is what keeps this from becoming a second opinion
  // about whether the record is still there.
  if (lifecycle.productState === "TRASHED") return "A record in the trash cannot be renamed.";
  if (lifecycle.productState === "DESTROYED") return "This record has been destroyed.";
  if (evidenceIsLocked(lifecycle)) {
    return "This record is permanently locked and cannot be renamed.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The record's LIFECYCLE capabilities
// ---------------------------------------------------------------------------
//
// `evidence.lifecycle` is the canonical projection the server computes from
// the same authority the write path calls. Its own type says: "Every field is
// a RESULT. Nothing here lets a client re-derive a verdict."
//
// ===========================================================================
// THE SCREEN WAS OFFERING LOCK, ARCHIVE AND TRASH UNCONDITIONALLY
// ===========================================================================
// It rendered all three whatever the record's state, and offered no UNLOCK at
// all — so a record could be locked from the phone and never released there,
// and Archive was shown on a record already archived, on one under legal hold,
// and on one inside an object-lock retention window. Each of those is a
// refusal the server was always going to make.
//
// Every verdict below is READ. Nothing recomputes one, and an absent
// projection withholds rather than offers: a client that defaulted to "yes"
// would put a destructive control in front of someone the server will refuse.

export interface EvidenceLifecycle {
  productState: string;
  canArchive: boolean;
  canUnarchive: boolean;
  canTrash: boolean;
  canRestoreFromTrash: boolean;
  /** The server's reason, when it gave one. */
  trashBlockReason: string | null;
  archiveBlockReason: string | null;
  legalHold: boolean;
  effectiveRetentionUntilIso: string | null;
  /** `objectLockCompliance` (shared evidence-retention-lifecycle.ts:531). */
  objectLockCompliance: boolean;
}

export function parseEvidenceLifecycle(payload: unknown): EvidenceLifecycle | null {
  const d = obj(payload);
  const l = obj(d.lifecycle ?? obj(d.evidence).lifecycle);
  if (!("productState" in l)) return null;
  return {
    productState: str(l.productState) ?? "ACTIVE",
    canArchive: l.canArchive === true,
    canUnarchive: l.canUnarchive === true,
    canTrash: l.canTrash === true,
    canRestoreFromTrash: l.canRestoreFromTrash === true,
    trashBlockReason: str(l.trashBlockReason),
    archiveBlockReason: str(l.archiveBlockReason),
    legalHold: l.legalHold === true,
    effectiveRetentionUntilIso: str(l.effectiveRetentionUntilUtc),
    objectLockCompliance: l.objectLockCompliance === true,
  };
}

/**
 * The block reasons, as sentences.
 *
 * The server sends a CODE, not prose, so these are the native rendering of a
 * server verdict rather than a second opinion about it. An unrecognised code
 * is reported as refused without a reason — never as permitted.
 */
export function lifecycleBlockReasonLabel(code: string | null): string | null {
  switch (code) {
    case "ALREADY_IN_STATE":
      return "This record is already in that state.";
    case "EVIDENCE_LOCKED":
      return "This record is locked. Unlock it first.";
    case "TERMINAL_DESTROYED":
      return "This record has been destroyed and cannot change state.";
    case "NOT_TRASHED":
      return "This record is not in the trash.";
    case "TRASH_GRACE_ACTIVE":
      return "This record is inside its trash grace period.";
    case "APP_RETENTION_ACTIVE":
      return "A retention policy still covers this record.";
    case "OBJECT_LOCK_RETENTION_ACTIVE":
      return "Storage retention still covers this record.";
    case "LEGAL_HOLD_ACTIVE":
      return "A legal hold is in force on this record.";
    case null:
      return null;
    default:
      // An unknown code is still a refusal. Saying "this cannot be done" with
      // no reason is honest; treating it as permitted would not be.
      return "This is not available for this record right now.";
  }
}

/**
 * Whether the record is locked, from the state the server reports.
 *
 * A locked record is the one case where the block reason names the remedy —
 * EVIDENCE_LOCKED on a trash or archive attempt means unlock first — so the
 * lock state is read from those reasons rather than guessed from a status
 * string the client would have to interpret.
 */
export function evidenceIsLocked(lifecycle: EvidenceLifecycle | null): boolean {
  if (!lifecycle) return false;
  return (
    lifecycle.trashBlockReason === "EVIDENCE_LOCKED" ||
    lifecycle.archiveBlockReason === "EVIDENCE_LOCKED"
  );
}

export function buildEvidenceUnlockPath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/unlock`;
}
/** POST {restore:true} — out of Trash (web evidence/[id]/page.tsx:718). */
export function buildEvidenceRestorePath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/restore`;
}

/** The web's words for Trash on the record (page.tsx:1069-1085, :1864-1896). */
export const TRASH_COPY = {
  bannerTitle: "This record is in trash",
  bannerBody:
    "Mutating actions (download, lock, archive, assign to case, generate report/package) are disabled while the record is in trash. Restore it to bring it back to the active library.",
  restore: "Restore from trash",
  moveAction: "Move to trash",
  moveTitle: "Move evidence to trash",
  moveBody:
    "Nothing is deleted. The record leaves Active evidence and can be restored from Trash; its content, custody history and verification state are unchanged.",
  moveBody2: "Any retention or legal hold on this record continues to apply in Trash — moving it here does not shorten either.",
} as const;

/** The web's confirm for removing a relationship (EvidenceRelationshipsSection.tsx:196-206). */
export function relationshipRemoveCopy(relationshipType: string, linkedTitle: string) {
  return {
    title: "Remove this relationship?",
    body: `Remove the "${relationshipType.replace(/_/g, " ").toLowerCase()}" relationship with "${linkedTitle}"? The linked evidence record itself is not affected.`,
    confirm: "Remove relationship",
  };
}

export function buildEvidenceUnarchivePath(evidenceId: string): string {
  return `${buildEvidencePath(evidenceId)}/unarchive`;
}

/* ------------------------------------------- T-14 — What needs attention (page.tsx:1972) */

export type RiskSeverity = "danger" | "warning" | "info" | "neutral";
export interface RiskSignal {
  severity: RiskSeverity;
  title: string;
  detail: string | null;
}

const RISK_ORDER: Record<RiskSeverity, number> = { danger: 0, warning: 1, info: 2, neutral: 3 };

function normalizeRiskSeverity(v: string | null): RiskSeverity {
  if (v === "danger" || v === "warning" || v === "info" || v === "neutral") return v;
  // Unknown severities never over-alert (web normalizeSeverity).
  if (v === "critical" || v === "high") return "danger";
  return "info";
}

/** The web buildRiskSignals over review-workspace reviewerAlerts + sourceContext, severity-first. */
export function projectRiskSignals(rw: unknown): RiskSignal[] {
  const root = o(rw);
  const signals: RiskSignal[] = arr(root["reviewerAlerts"]).map((raw) => {
    const a = o(raw);
    return { severity: normalizeRiskSeverity(s(a["severity"])), title: s(a["label"]) ?? "Review alert", detail: s(a["detail"]) };
  });
  const sc = o(root["sourceContext"]);
  const cs = o(sc["clientSignalsSummary"]);
  if (cs["screenshotLikeStatus"] === "DETECTED") {
    signals.push({ severity: "warning", title: "Screenshot filename heuristic", detail: "Filename and client-metadata heuristic only. This is advisory, not image-forensic or AI proof." });
  }
  if (cs["genericMime"] === true) {
    signals.push({ severity: "info", title: "Generic MIME type", detail: "Generic file typing was recorded in client signals. Review source context separately." });
  }
  if (cs["oldLastModified"] === true) {
    signals.push({ severity: "neutral", title: "File timestamp note", detail: "Client metadata shows the file was modified before upload. This is common for existing documents and is advisory only." });
  }
  if (sc["importedUpload"] === true) {
    signals.push({ severity: "info", title: "Imported upload", detail: "Imported upload means PROOVRA preserved the uploaded file and recorded integrity state. It does not independently prove original capture source." });
  }
  return signals.sort((a, b) => RISK_ORDER[a.severity] - RISK_ORDER[b.severity]);
}

export interface EvidenceAttention {
  risks: RiskSignal[];
  needsCase: boolean;
  needsReviewer: boolean;
  missingReport: boolean;
  missingPackage: boolean;
}

/** The web WhatNeedsAttentionStrip rules; null when there is nothing to say. */
export function deriveEvidenceAttention(input: {
  hasCase: boolean;
  canSeeReviewerOps: boolean;
  reviewStatus: string | null;
  reportState: string | null;
  packageState: string | null;
  signals: RiskSignal[];
}): EvidenceAttention | null {
  const needsCase = !input.hasCase;
  const needsReviewer = input.canSeeReviewerOps && (!input.reviewStatus || input.reviewStatus === "NOT_STARTED");
  // "Missing" is a canonical STATE, not a plan flag beside an absence.
  const missingReport = input.reportState === "ELIGIBLE_NOT_GENERATED";
  const missingPackage = input.packageState === "ELIGIBLE_NOT_GENERATED";
  const risks = input.signals.slice(0, 3);
  if (!needsCase && !needsReviewer && !missingReport && !missingPackage && risks.length === 0) return null;
  return { risks, needsCase, needsReviewer, missingReport, missingPackage };
}

/* ----------------------------------------------- T-14 — boundaries (web copy) */

/** EvidenceReviewTab.tsx:287 — the private-notes boundary callout. */
export const PRIVATE_NOTES_BOUNDARY =
  "Private review notes are not included in public verification or external packages unless explicitly exported.";

/** LocationContextCard.tsx — used when the server states no boundary of its own. */
export const DEFAULT_LOCATION_BOUNDARY =
  "Location is device/browser-reported and permission-based. It may support context, but it does not independently prove physical presence.";

/** EvidenceIntegrityTab.tsx:427 — the source context's first stated limitation. */
export function projectSourceBoundary(rw: unknown): string | null {
  const lim = arr(o(o(rw)["sourceContext"])["limitations"]);
  return typeof lim[0] === "string" && (lim[0] as string).length > 0 ? (lim[0] as string) : null;
}
