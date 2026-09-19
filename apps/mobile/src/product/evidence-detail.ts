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
 * enterprise/team-only blocks (governance, reviewerAudit, AI/derived-review) are
 * intentionally NOT projected (they need a teamId / enterprise surface).
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
    });
  }
  return out;
}
