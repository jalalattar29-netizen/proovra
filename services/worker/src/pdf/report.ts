import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signPdfIfEnabled } from "./signPdf.js";

type PDFDoc = InstanceType<typeof PDFDocument>;

export type ReportEvidence = {
  id: string;
  title?: string | null;

  type: string;
  status: string;
  verificationStatus?: string | null;

  captureMethod?: string | null;
  identityLevelSnapshot?: string | null;

  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByUserId?: string | null;
  createdByUserId?: string | null;
  uploadedByUserId?: string | null;
  lastAccessedByUserId?: string | null;
  lastAccessedAtUtc?: string | null;

  workspaceNameSnapshot?: string | null;
  organizationNameSnapshot?: string | null;
  organizationVerifiedSnapshot?: boolean | null;

  recordedIntegrityVerifiedAtUtc?: string | null;
  lastVerifiedAtUtc?: string | null;
  lastVerifiedSource?: string | null;

  verificationPackageGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  latestReportVersion?: number | null;
  reviewReadyAtUtc?: string | null;
  reviewerSummaryVersion?: number | null;

  capturedAtUtc: string | null;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  reportGeneratedAtUtc: string | null;

  mimeType: string | null;
  sizeBytes: string | null;
  durationSec: string | null;

  storageBucket: string | null;
  storageKey: string | null;
  publicUrl: string | null;
  storageRegion?: string | null;
  storageImmutable?: boolean | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;

  gps: {
    lat: string | null;
    lng: string | null;
    accuracyMeters: string | null;
  };

  fileSha256: string | null;
  fingerprintCanonicalJson: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  publicKeyPem: string | null;

  tsaProvider: string | null;
  tsaUrl: string | null;
  tsaSerialNumber: string | null;
  tsaGenTimeUtc: string | null;
  tsaTokenBase64: string | null;
  tsaMessageImprint: string | null;
  tsaHashAlgorithm: string | null;
  tsaStatus: string | null;
  tsaFailureReason: string | null;

  otsProofBase64?: string | null;
  otsHash?: string | null;
  otsStatus?: string | null;
  otsCalendar?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  otsFailureReason?: string | null;

  anchorMode?: string | null;
  anchorProvider?: string | null;
  anchorHash?: string | null;
  anchorReceiptId?: string | null;
  anchorTransactionId?: string | null;
  anchorPublicUrl?: string | null;
  anchorAnchoredAtUtc?: string | null;
};

export type ReportCustodyEvent = {
  sequence: number;
  atUtc: string;
  eventType: string;
  payloadSummary: string;
};

type ParsedFingerprintSummary = {
  multipart: boolean;
  itemCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  documentCount: number;
  mimeTypes: string[];
  partsCount: number;
};

type HeaderContext = {
  evidenceId: string;
  generatedAtUtc: string;
  status?: string;
};

type ClassifiedCustodyEvent = ReportCustodyEvent & {
  category: "forensic" | "access";
};

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

function safe(value: string | null | undefined, fallback = "N/A"): string {
  const t = typeof value === "string" ? value.trim() : "";
  return t ? t : fallback;
}

function safeBooleanLabel(
  value: boolean | null | undefined,
  trueLabel = "Yes",
  falseLabel = "No",
  unknownLabel = "N/A"
): string {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return unknownLabel;
}

function summarizeText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatBytesHuman(bytesStr: string | null): string {
  const n = bytesStr ? Number(bytesStr) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "N/A";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let idx = 0;
  let v = n;

  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }

  return `${v.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function shortHash(h: string | null | undefined, head = 10, tail = 8): string {
  const t = safe(h, "");
  if (!t) return "N/A";
  if (t.length <= head + tail + 3) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function redactIdentifier(
  value: string | null | undefined,
  visible = 6
): string {
  const t = safe(value, "");
  if (!t) return "Not included in external report";
  if (t.length <= visible * 2 + 3) return t;
  return `${t.slice(0, visible)}…${t.slice(-visible)}`;
}

function buildPublicEvidenceReference(
  evidenceId: string | null | undefined
): string {
  const t = safe(evidenceId, "");
  if (!t) return "Not recorded";
  if (t.length <= 16) return t;
  return `${t.slice(0, 8)}…${t.slice(-8)}`;
}

function buildPublicSigningKeyReference(
  keyId: string | null | undefined,
  version: number | null | undefined
): string {
  const id = safe(keyId, "");
  if (!id) return "Not recorded";

  const publicRef = id
    .replace(/^dw_/, "")
    .replace(/_kms$/i, "")
    .replace(/_/g, "-");

  return version ? `${publicRef} / v${version}` : publicRef;
}

function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

function normalizeEnumText(value: string | null | undefined): string {
  return safe(value, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapPublicEvidenceTypeLabel(
  evidence: ReportEvidence,
  summary: ParsedFingerprintSummary
): string {
  if (summary.itemCount > 1) {
    const hasImage = summary.imageCount > 0;
    const hasVideo = summary.videoCount > 0;
    const hasAudio = summary.audioCount > 0;
    const hasDocument = summary.documentCount > 0;

    const categories = [
      hasImage ? "Image" : null,
      hasVideo ? "Video" : null,
      hasAudio ? "Audio" : null,
      hasDocument ? "Document" : null,
    ].filter(Boolean) as string[];

    if (categories.length > 1) return "Mixed Media Evidence Package";
    if (categories.length === 1) return `${categories[0]} Evidence Package`;
    return "Multipart Evidence Package";
  }

  switch (safe(evidence.type, "").toUpperCase()) {
    case "PHOTO":
      return "Photo Evidence";
    case "VIDEO":
      return "Video Evidence";
    case "AUDIO":
      return "Audio Evidence";
    case "DOCUMENT":
      return "Document Evidence";
    default:
      if (safe(evidence.mimeType, "").startsWith("image/")) {
        return "Photo Evidence";
      }
      if (safe(evidence.mimeType, "").startsWith("video/")) {
        return "Video Evidence";
      }
      if (safe(evidence.mimeType, "").startsWith("audio/")) {
        return "Audio Evidence";
      }
      if (safe(evidence.mimeType, "").includes("pdf")) {
        return "Document Evidence";
      }
      return "Digital Evidence Record";
  }
}

function mapRecordStatusLabel(status: string | null | undefined): string {
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

function mapVerificationStatusLabel(
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

function mapCaptureMethodLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "SECURE_CAMERA":
      return "Captured with PROOVRA secure camera";
    case "UPLOADED_FILE":
      return "Uploaded existing file";
    case "IMPORTED_DOCUMENT":
      return "Imported document";
    case "MULTIPART_PACKAGE":
      return "Multipart package";
    default:
      return "Capture method not recorded";
  }
}

function mapIdentityLevelLabel(value: string | null | undefined): string {
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

function mapAuthProviderLabel(value: string | null | undefined): string {
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

function mapVerificationSourceLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "REPORT_GENERATED":
      return "Report generated";
    case "PUBLIC_VERIFY_VIEWED":
      return "Public verification page viewed";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    default:
      return "Verification source not recorded";
  }
}

function mapCustodyEventLabel(eventType: string | null | undefined): string {
  switch (safe(eventType, "").toUpperCase()) {
    case "EVIDENCE_CREATED":
      return "Evidence created";
    case "IDENTITY_SNAPSHOT_RECORDED":
      return "Identity snapshot recorded";
    case "UPLOAD_STARTED":
      return "Upload started";
    case "UPLOAD_COMPLETED":
      return "Upload completed";
    case "SIGNATURE_APPLIED":
      return "Digital signature applied";
    case "TIMESTAMP_APPLIED":
      return "Trusted timestamp applied";
    case "REPORT_GENERATED":
      return "Report generated";
    case "REVIEW_READY":
      return "Review-ready state recorded";
    case "VERIFICATION_PACKAGE_GENERATED":
      return "Verification package generated";
    case "OTS_APPLIED":
      return "OpenTimestamps update";
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
    default:
      return normalizeEnumText(eventType);
  }
}

function mapTimestampStatusPublicLabel(
  status: string | null | undefined
): string {
  switch (safe(status, "").toUpperCase()) {
    case "STAMPED":
    case "GRANTED":
    case "VERIFIED":
    case "SUCCEEDED":
      return "Trusted timestamp recorded";
    case "PENDING":
    case "UNAVAILABLE":
      return "Timestamp pending";
    case "FAILED":
      return "Timestamp failed";
    default:
      return "Timestamp not recorded";
  }
}

function mapOtsStatusPublicLabel(status: string | null | undefined): string {
  switch (safe(status, "").toUpperCase()) {
    case "ANCHORED":
      return "Public anchoring recorded";
    case "PENDING":
      return "Anchoring pending";
    case "FAILED":
      return "Anchoring failed";
    default:
      return "Anchoring not recorded";
  }
}

function mapObjectLockModePublicLabel(mode: string | null | undefined): string {
  switch (safe(mode, "").toUpperCase()) {
    case "COMPLIANCE":
      return "Compliance retention lock";
    case "GOVERNANCE":
      return "Governance retention lock";
    default:
      return "Not recorded";
  }
}

function mapAnchorModePublicLabel(mode: string | null | undefined): string {
  switch (safe(mode, "").toUpperCase()) {
    case "PUBLIC":
      return "Public anchoring";
    case "PRIVATE":
      return "Private anchoring";
    case "HASH_ONLY":
      return "Digest anchoring";
    default:
      return "Not recorded";
  }
}

function buildOrganizationDisplay(evidence: ReportEvidence): string {
  const org = safe(evidence.organizationNameSnapshot, "");
  const workspace = safe(evidence.workspaceNameSnapshot, "");

  if (org) {
    return evidence.organizationVerifiedSnapshot ? `${org} (verified)` : org;
  }

  if (workspace) return workspace;
  return "Not recorded";
}

function buildOrganizationStatus(evidence: ReportEvidence): string {
  const hasOrg = safe(evidence.organizationNameSnapshot, "") !== "";
  const hasWorkspace = safe(evidence.workspaceNameSnapshot, "") !== "";

  if (evidence.organizationVerifiedSnapshot === true) {
    return "Verified organization";
  }
  if (hasOrg) return "Organization recorded";
  if (hasWorkspace) return "Workspace recorded";
  return "Not recorded";
}

function buildFingerprintNarrative(summary: ParsedFingerprintSummary): string {
  const mimeText =
    summary.mimeTypes.length > 0 ? summary.mimeTypes.join(", ") : "not recorded";

  if (summary.itemCount <= 1) {
    return `Single-item evidence record. MIME types recorded: ${mimeText}.`;
  }

  return `Multipart evidence package with ${summary.itemCount} items (${summary.imageCount} image, ${summary.videoCount} video, ${summary.audioCount} audio, ${summary.documentCount} document). MIME types recorded: ${mimeText}. Full canonical fingerprint should be reviewed in the technical verification package.`;
}

function buildVerificationLinkLabel(
  kind: "public" | "technical" = "public"
): string {
  return kind === "technical"
    ? "Open technical verification view"
    : "Open public verification page";
}

function parseFingerprintSummary(
  fingerprintCanonicalJson: string | null | undefined
): ParsedFingerprintSummary {
  const fallback: ParsedFingerprintSummary = {
    multipart: false,
    itemCount: 1,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    documentCount: 0,
    mimeTypes: [],
    partsCount: 0,
  };

  if (!fingerprintCanonicalJson) return fallback;

  try {
    const parsed = JSON.parse(fingerprintCanonicalJson) as {
      file?: {
        multipart?: boolean;
        summary?: {
          itemCount?: number;
          imageCount?: number;
          videoCount?: number;
          audioCount?: number;
          documentCount?: number;
          mimeTypes?: string[];
        };
        parts?: Array<unknown>;
      };
    };

    const multipart = Boolean(parsed?.file?.multipart);
    const partsCount = Array.isArray(parsed?.file?.parts)
      ? parsed.file.parts.length
      : 0;
    const summary = parsed?.file?.summary;

    const itemCount =
      typeof summary?.itemCount === "number"
        ? summary.itemCount
        : multipart
          ? partsCount || 0
          : 1;

    return {
      multipart,
      itemCount,
      imageCount:
        typeof summary?.imageCount === "number" ? summary.imageCount : 0,
      videoCount:
        typeof summary?.videoCount === "number" ? summary.videoCount : 0,
      audioCount:
        typeof summary?.audioCount === "number" ? summary.audioCount : 0,
      documentCount:
        typeof summary?.documentCount === "number"
          ? summary.documentCount
          : 0,
      mimeTypes: Array.isArray(summary?.mimeTypes)
        ? summary.mimeTypes.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0
          )
        : [],
      partsCount,
    };
  } catch {
    return fallback;
  }
}

function normalizeTimestampStatus(
  status: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const s = safe(status, "").toUpperCase();
  if (
    s === "GRANTED" ||
    s === "STAMPED" ||
    s === "VERIFIED" ||
    s === "SUCCEEDED"
  ) {
    return "SUCCESS";
  }
  if (s === "PENDING" || s === "UNAVAILABLE") {
    return "WARNING";
  }
  if (s) return "DANGER";
  return "NEUTRAL";
}

function normalizeOtsStatus(
  status: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const s = safe(status, "").toUpperCase();
  if (s === "ANCHORED") return "SUCCESS";
  if (s === "PENDING") return "WARNING";
  if (s === "FAILED") return "DANGER";
  return "NEUTRAL";
}

function normalizeStorageProtectionStatus(
  immutable: boolean | null | undefined,
  mode: string | null | undefined,
  retainUntil: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const normalizedMode = safe(mode, "").toUpperCase();

  if (
    immutable &&
    normalizedMode === "COMPLIANCE" &&
    safe(retainUntil, "") !== ""
  ) {
    return "SUCCESS";
  }
  if (immutable || normalizedMode === "GOVERNANCE") {
    return "WARNING";
  }
  if (normalizedMode) {
    return "DANGER";
  }
  return "NEUTRAL";
}

function evidenceStructureLabel(summary: ParsedFingerprintSummary): string {
  if (summary.itemCount <= 1) return "Single evidence item";
  return "Multipart evidence package";
}

const ACCESS_EVENT_TYPES = new Set([
  "VERIFY_VIEWED",
  "EVIDENCE_VIEWED",
  "EVIDENCE_DOWNLOADED",
  "REPORT_DOWNLOADED",
  "VERIFICATION_PACKAGE_DOWNLOADED",
]);

function classifyCustodyEvent(event: ReportCustodyEvent): ClassifiedCustodyEvent {
  const eventType = safe(event.eventType, "").toUpperCase();
  return {
    ...event,
    category: ACCESS_EVENT_TYPES.has(eventType) ? "access" : "forensic",
  };
}

function splitCustodyEvents(events: ReportCustodyEvent[]) {
  const classified = events.map(classifyCustodyEvent);
  return {
    all: classified,
    forensic: classified.filter((ev) => ev.category === "forensic"),
    access: classified.filter((ev) => ev.category === "access"),
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_CANDIDATES: string[] = [
  path.resolve(__dirname, "assets"),
  path.resolve(__dirname, "../pdf/assets"),
  path.resolve(__dirname, "../assets"),
  path.resolve(process.cwd(), "src/pdf/assets"),
  path.resolve(process.cwd(), "services/worker/src/pdf/assets"),
];

function tryReadAsset(filename: string): Buffer | null {
  for (const dir of ASSETS_CANDIDATES) {
    try {
      const p = path.join(dir, filename);
      if (!fs.existsSync(p)) continue;
      return fs.readFileSync(p);
    } catch {
      // continue
    }
  }
  return null;
}

const BRAND = {
  name: env("REPORT_BRAND_NAME") ?? "PROOVRA",
  title: "Verification Report",

  ink: "#111827",
  muted: "#667085",
  line: "#D0D5DD",
  accent: "#1F3A5F",
  accentSoft: "#EAF1F8",
  paper: "#F8FAFC",

  success: "#245C4A",
  danger: "#8A3B2E",
  warning: "#8B6C1E",
};

let currentHeaderContext: HeaderContext | null = null;

function setHeaderContext(opts: HeaderContext): void {
  currentHeaderContext = opts;
}

function hr(doc: PDFDoc, y?: number): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yy = typeof y === "number" ? y : doc.y;

  doc.save();
  doc.lineWidth(0.9).strokeColor(BRAND.line);
  doc.moveTo(x, yy).lineTo(x + w, yy).stroke();
  doc.restore();
}

function addPageWithHeader(doc: PDFDoc): void {
  doc.addPage();
  if (currentHeaderContext) {
    drawHeader(doc, currentHeaderContext);
  }
}

function ensureSpace(doc: PDFDoc, neededHeight: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom - 10;
  if (doc.y + neededHeight > bottom) {
    addPageWithHeader(doc);
  }
}

function ensurePageWithHeader(
  doc: PDFDoc,
  neededHeight: number,
  opts?: HeaderContext
): void {
  if (opts) {
    setHeaderContext(opts);
  }

  const bottom = doc.page.height - doc.page.margins.bottom - 10;
  if (doc.y + neededHeight > bottom) {
    addPageWithHeader(doc);
  }
}

function paintPageBackground(doc: PDFDoc): void {
  const bg = tryReadAsset("paper-silver.png");
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  doc.save();
  doc.rect(0, 0, pageW, pageH).fill(BRAND.paper);

  if (bg) {
    try {
      doc.opacity(0.16);
      doc.image(bg, 0, 0, { width: pageW, height: pageH });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  const wm = tryReadAsset("logo.png");
  if (wm) {
    try {
      doc.opacity(0.045);
      const size = Math.min(pageW, pageH) * 0.6;
      const x = (pageW - size) / 2;
      const y = (pageH - size) / 2 - mmToPt(6);
      doc.image(wm, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  const seal = tryReadAsset("seal.png");
  if (seal) {
    try {
      doc.opacity(0.16);
      const size = mmToPt(44);
      const x = pageW - doc.page.margins.right - size + mmToPt(2);
      const y = doc.page.margins.top - mmToPt(1.5);
      doc.image(seal, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  doc.restore();
}

function drawBadge(doc: PDFDoc, text: string, x: number, y: number): void {
  const padX = 11;
  const padY = 4;

  doc.save();
  doc.font("Helvetica-Bold").fontSize(9);

  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();

  doc.fillColor(BRAND.accentSoft);
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 7).fill();

  doc.fillColor(BRAND.accent);
  doc.text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawCallout(
  doc: PDFDoc,
  opts: {
    title: string;
    body: string;
    tone?: "neutral" | "success" | "warning" | "danger";
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const tone = opts.tone ?? "neutral";
  const borderColor =
    tone === "success"
      ? BRAND.success
      : tone === "warning"
        ? BRAND.warning
        : tone === "danger"
          ? BRAND.danger
          : BRAND.accent;

  const fillColor =
    tone === "success"
      ? "#EEF8F3"
      : tone === "warning"
        ? "#FBF5E8"
        : tone === "danger"
          ? "#FCEDEA"
          : BRAND.accentSoft;

  doc.font("Helvetica-Bold").fontSize(10.2);
  const titleHeight = doc.heightOfString(opts.title, { width: w - 24 });

  doc.font("Helvetica").fontSize(9.3);
  const bodyHeight = doc.heightOfString(opts.body, {
    width: w - 24,
    lineGap: 1.5,
  });

  const blockHeight = titleHeight + bodyHeight + 18;
  ensureSpace(doc, blockHeight + 6);

  const y = doc.y;

  doc.save();
  doc.roundedRect(x, y, w, blockHeight, 9).fill(fillColor);
  doc
    .lineWidth(0.9)
    .strokeColor(borderColor)
    .roundedRect(x, y, w, blockHeight, 9)
    .stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.2);
  doc.text(opts.title, x + 12, y + 8, { width: w - 24 });
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica").fontSize(9.3);
  doc.text(opts.body, x + 12, y + 23, { width: w - 24, lineGap: 1.5 });
  doc.restore();

  doc.y = y + blockHeight + 6;
}

function drawHeader(
  doc: PDFDoc,
  opts: { evidenceId: string; generatedAtUtc: string; status?: string }
): void {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(3)).fill(BRAND.accent);
  doc.restore();

  doc.x = left;
  doc.y = top;

  const logo = tryReadAsset("logo.png");
  let brandX = left;

  if (logo) {
    try {
      const h = mmToPt(14);
      const logoW = h * 4.6;
      doc.image(logo, left, doc.y - 2, { fit: [logoW, h] });
      brandX = left + logoW + 13;
    } catch {
      brandX = left;
    }
  }

  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(20.5);
  doc.text(BRAND.name, brandX, doc.y + 1, { continued: true });

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(12.2);
  doc.text(` — ${BRAND.title}`);

  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const bx = left + w - 140;
    const by = top + 15;
    drawBadge(doc, textClamp(badgeText, 20), bx, by);
  }

  doc.moveDown(0.72);

  const metaW = w - 168;
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
  doc.text(
    `Evidence Reference: ${buildPublicEvidenceReference(opts.evidenceId)}`,
    left,
    doc.y,
    { width: metaW }
  );
  doc.moveDown(0.18);
  doc.text(`Generated (UTC): ${opts.generatedAtUtc}`, left, doc.y, {
    width: metaW,
  });

  doc.moveDown(0.52);
  hr(doc);
  doc.moveDown(0.5);
}

function textClamp(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 1))}…`
    : text;
}

function section(
  doc: PDFDoc,
  title: string,
  render: () => void,
  options?: { minSpace?: number }
): void {
  const minSpace = options?.minSpace ?? 52;

  ensureSpace(doc, minSpace);

  hr(doc);
  doc.moveDown(0.2);

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(12.5);
  doc.text(title, doc.page.margins.left, doc.y);
  doc.restore();

  doc.moveDown(0.12);
  render();
  doc.moveDown(0.2);
}

function safeParagraph(
  doc: PDFDoc,
  text: string,
  options?: { fontSize?: number; color?: string; gap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const fontSize = options?.fontSize ?? 9;
  const gap = options?.gap ?? 1.8;

  doc.font("Helvetica").fontSize(fontSize);
  const needed = doc.heightOfString(text, { width: w, lineGap: gap }) + 5;
  ensureSpace(doc, needed);

  doc.save();
  doc.fillColor(options?.color ?? BRAND.muted);
  doc.text(text, x, doc.y, { width: w, lineGap: gap });
  doc.restore();
}

function prettifySummaryText(input: string): string {
  const raw = safe(input, "");
  if (!raw || raw === "N/A") return "N/A";

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parts = Object.entries(parsed).map(([k, v]) => {
      if (v === null || v === undefined) return `${k}: N/A`;
      if (typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    });
    return parts.join(" • ");
  } catch {
    return raw
      .replace(/^\{/, "")
      .replace(/\}$/, "")
      .replace(/","/g, " • ")
      .replace(/":"/g, ": ")
      .replace(/"/g, "");
  }
}

function kvGrid(
  doc: PDFDoc,
  rows: Array<[string, string]>,
  options?: { colGap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = options?.colGap ?? 16;
  const colW = (w - colGap) / 2;

  const calcCellHeight = (row?: [string, string]): number => {
    if (!row) return 0;
    const [k, v] = row;

    doc.font("Helvetica").fontSize(8.7);
    const keyH = doc.heightOfString(k, { width: colW });

    doc.font("Helvetica-Bold").fontSize(9.8);
    const valueH = doc.heightOfString(v, { width: colW });

    return keyH + valueH + 14;
  };

  const pairHeights: number[] = [];
  for (let i = 0; i < rows.length; i += 2) {
    pairHeights.push(
      Math.max(calcCellHeight(rows[i]), calcCellHeight(rows[i + 1]))
    );
  }

  const totalNeeded = pairHeights.reduce((a, b) => a + b, 0) + 4;
  ensureSpace(doc, totalNeeded);

  let currentY = doc.y;

  for (let i = 0; i < rows.length; i += 2) {
    const left = rows[i];
    const right = rows[i + 1];
    const rowHeight = pairHeights[i / 2];

    const renderCell = (row: [string, string] | undefined, colX: number) => {
      if (!row) return;
      const [k, v] = row;
      let y = currentY;

      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.7);
      doc.text(k, colX, y, { width: colW });
      doc.restore();

      y = doc.y + 1.5;

      doc.save();
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(9.8);
      doc.text(v, colX, y, { width: colW });
      doc.restore();
    };

    renderCell(left, x);
    renderCell(right, x + colW + colGap);

    currentY += rowHeight;
    doc.y = currentY;
  }
}

function monospaceStrip(
  doc: PDFDoc,
  label: string,
  value: string,
  options?: { maxChars?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const maxChars = options?.maxChars;
  const finalValue =
    typeof maxChars === "number" ? summarizeText(value, maxChars) : value;

  const labelFontSize = 8.8;
  const codeFontSize = 8.8;
  const labelGapAfter = 5;
  const bottomPadding = 10;

  doc.font("Helvetica").fontSize(labelFontSize);
  const labelHeight = doc.heightOfString(label, { width: w });

  doc.font("Courier").fontSize(codeFontSize);
  const textHeight = doc.heightOfString(finalValue, {
    width: w,
    lineGap: 1.5,
  });
  const blockHeight = Math.max(16, textHeight + 8);

  const neededHeight =
    labelHeight + labelGapAfter + blockHeight + bottomPadding;
  ensureSpace(doc, neededHeight);

  const labelY = doc.y;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(labelFontSize);
  doc.text(label, x, labelY, { width: w });
  doc.restore();

  const blockY = doc.y + 3;

  doc.save();
  doc.opacity(0.045);
  doc.roundedRect(x - 3, blockY - 3, w + 6, blockHeight + 6, 7).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Courier").fontSize(codeFontSize);
  doc.text(finalValue, x, blockY, {
    width: w,
    lineGap: 1.5,
  });
  doc.restore();

  doc.y = blockY + blockHeight;
  doc.moveDown(0.22);
}

function drawTable(
  doc: PDFDoc,
  headers: string[],
  rows: string[][],
  colWidths: number[]
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const headerH = 20;
  const rowPadY = 5;

  const calcRowHeight = (cells: string[]): number => {
    doc.font("Helvetica").fontSize(8.9);
    let maxH = 0;

    for (let i = 0; i < cells.length; i++) {
      const cw = colWidths[i];
      const h = doc.heightOfString(cells[i], {
        width: cw - 10,
        align: "left",
        lineGap: 1.5,
      });
      maxH = Math.max(maxH, h);
    }

    return Math.max(headerH, maxH + rowPadY * 2);
  };

  ensureSpace(doc, 120);

  const headerY = doc.y;

  doc.save();
  doc.opacity(0.06);
  doc.roundedRect(x, headerY, w, headerH, 5).fill(BRAND.accent);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(8.8);

  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 5, headerY + 5.5, {
      width: colWidths[i] - 10,
      lineBreak: false,
    });
    cx += colWidths[i];
  }
  doc.restore();

  doc.y = headerY + headerH;
  hr(doc, doc.y);
  doc.moveDown(0.08);

  for (const r of rows) {
    const prettyRow = [...r];
    if (prettyRow[3]) {
      prettyRow[3] = prettifySummaryText(prettyRow[3]);
    }

    const rh = calcRowHeight(prettyRow);
    ensureSpace(doc, rh + 10);

    const rowY = doc.y;

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(8.9);

    let rx = x;
    for (let i = 0; i < prettyRow.length; i++) {
      doc.text(prettyRow[i], rx + 5, rowY + rowPadY, {
        width: colWidths[i] - 10,
        lineGap: 1.5,
      });
      rx += colWidths[i];
    }
    doc.restore();

    doc.y = rowY + rh;
    hr(doc, doc.y);
    doc.moveDown(0.08);
  }
}

function drawQrBlock(
  doc: PDFDoc,
  opts: {
    title: string;
    qrBuffer: Buffer;
    size?: number;
    caption?: string;
    urlText?: string;
    urlLink?: string;
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const size = opts.size ?? 96;

  ensureSpace(doc, size + 60);

  const startY = doc.y;
  const blockH = Math.max(size + 16, 118);
  const textX = x + 14;
  const textW = w - size - 44;
  const qrX = x + w - size - 14;
  const qrY = startY + 11;

  doc.save();
  doc.opacity(0.035);
  doc.roundedRect(x, startY, w, blockH, 10).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.lineWidth(0.8).strokeColor(BRAND.line);
  doc.roundedRect(x, startY, w, blockH, 10).stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
  doc.text(opts.title, textX, startY + 12, { width: textW });
  doc.restore();

  let textY = startY + 30;

  if (opts.caption) {
    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9.1);
    doc.text(opts.caption, textX, textY, {
      width: textW,
      lineGap: 1.5,
    });
    doc.restore();
    textY = doc.y + 5;
  }

  if (opts.urlText) {
    doc.save();
    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.3);
    doc.text(opts.urlText, textX, textY, {
      width: textW,
      link: opts.urlLink,
      underline: Boolean(opts.urlLink),
      lineGap: 1.5,
    });
    doc.restore();
  }

  doc.image(opts.qrBuffer, qrX, qrY, { fit: [size, size] });

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(7.7);
  doc.text("Scan QR", qrX, startY + blockH - 13, {
    width: size,
    align: "center",
    lineBreak: false,
  });
  doc.restore();

  doc.y = startY + blockH + 6;
}

async function tryGenerateQrPngBuffer(data: string): Promise<Buffer | null> {
  try {
    const QRCodeModule = (await import("qrcode")) as {
      toBuffer?: (
        text: string,
        opts?: Record<string, unknown>
      ) => Promise<Buffer>;
      default?: {
        toBuffer?: (
          text: string,
          opts?: Record<string, unknown>
        ) => Promise<Buffer>;
      };
    };

    const toBuffer = QRCodeModule.toBuffer ?? QRCodeModule.default?.toBuffer;

    if (!toBuffer) {
      throw new Error("qrcode.toBuffer not found");
    }

    return await toBuffer(data, {
      margin: 1,
      width: 240,
    });
  } catch (error) {
    console.error("[PDF][QR] Failed to generate QR:", error);
    return null;
  }
}

function addFooters(
  doc: PDFDoc,
  opts: { generatedAtUtc: string; reportVersion: number }
): void {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom - 20;

    doc.save();
    doc.font("Helvetica").fontSize(8.6).fillColor(BRAND.muted);

    doc.text(
      `${BRAND.name} • Verification Report v${opts.reportVersion} • Generated (UTC): ${opts.generatedAtUtc}`,
      x,
      y,
      { width: w, align: "left" }
    );
    doc.text(`Page ${i + 1} / ${range.count}`, x, y, {
      width: w,
      align: "right",
    });

    doc.restore();
  }
}

function buildVerifyUrl(evidenceId: string, provided?: string | null): string {
  const v = typeof provided === "string" ? provided.trim() : "";
  if (v) return v;

  const base = (
    env("REPORT_VERIFY_BASE_URL") ?? "https://app.proovra.com/verify"
  )
    .trim()
    .replace(/\/+$/, "");

  return `${base}/${encodeURIComponent(evidenceId)}`;
}

function estimateEvidenceSummarySectionHeight(
  doc: PDFDoc,
  rows: Array<[string, string]>
): number {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = 16;
  const colW = (w - colGap) / 2;

  const calcCellHeight = (row?: [string, string]): number => {
    if (!row) return 0;
    const [k, v] = row;

    doc.font("Helvetica").fontSize(8.7);
    const keyH = doc.heightOfString(k, { width: colW });

    doc.font("Helvetica-Bold").fontSize(9.8);
    const valueH = doc.heightOfString(v, { width: colW });

    return keyH + valueH + 14;
  };

  let gridHeight = 0;
  for (let i = 0; i < rows.length; i += 2) {
    gridHeight += Math.max(calcCellHeight(rows[i]), calcCellHeight(rows[i + 1]));
  }

  return 18 + 10 + gridHeight + 12;
}

function estimateForensicIntegrityStatementHeight(
  doc: PDFDoc,
  opts: {
    verifyUrl: string;
    structureLabel: string;
    externalMode?: boolean;
  }
): number {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font("Helvetica").fontSize(10.2);
  const intro1 = doc.heightOfString(
    "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica").fontSize(9.8);
  const intro2 = doc.heightOfString(
    "PROOVRA applies cryptographic integrity controls, structured evidence fingerprinting, trusted timestamping records, OpenTimestamps anchoring evidence, and immutable storage protection designed to preserve the integrity state of the submitted evidence at the time of completion.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica-Bold").fontSize(10.1);
  const h1 = doc.heightOfString("Integrity materials included in this report:", {
    width: w,
  });
  const h2 = doc.heightOfString("Independent review may include:", {
    width: w,
  });

  doc.font("Helvetica").fontSize(9.8);
  const bullets = [
    opts.structureLabel === "Single evidence item"
      ? "• A SHA-256 cryptographic hash of the original evidence file"
      : "• A SHA-256 cryptographic hash representing the multipart evidence set",
    "• A canonical fingerprint record describing the evidence state and metadata",
    "• A fingerprint hash derived from the canonical record",
    "• A digital signature generated using the PROOVRA signing key",
    "• A trusted RFC 3161 timestamp token issued by the configured Time Stamping Authority, when available",
    "• OpenTimestamps anchoring evidence for the evidence digest, when available",
    "• A forensic chain of custody timeline documenting relevant integrity-related system events",
    "• Immutable storage controls using AWS S3 Object Lock, when enabled for the evidence object",
  ];

  const steps =
    opts.structureLabel === "Single evidence item"
      ? [
          "1. Obtaining the original evidence file",
          "2. Computing the SHA-256 hash of the evidence file",
          "3. Comparing the computed hash with the value listed in this report",
          "4. Verifying the digital signature using the provided public key",
          "5. Verifying the RFC 3161 timestamp token, when present",
          "6. Verifying the OpenTimestamps proof, when present",
          "7. Reviewing the forensic chain of custody events",
          "8. Reviewing immutable storage protection details, when present",
        ]
      : [
          "1. Obtaining the complete multipart evidence set",
          "2. Reviewing the canonical fingerprint and listed evidence parts",
          "3. Validating the multipart composite hash against the hashes and structure recorded in the canonical fingerprint",
          "4. Verifying the digital signature using the provided public key",
          "5. Verifying the RFC 3161 timestamp token, when present",
          "6. Verifying the OpenTimestamps proof, when present",
          "7. Reviewing the forensic chain of custody events",
          "8. Reviewing immutable storage protection details, when present",
        ];

  const bulletsHeight = bullets.reduce(
    (sum, item) => sum + doc.heightOfString(item, { width: w, lineGap: 1.8 }),
    0
  );

  const stepsHeight = steps.reduce(
    (sum, item) => sum + doc.heightOfString(item, { width: w, lineGap: 1.8 }),
    0
  );

  doc.font("Helvetica").fontSize(9.2);
  const note = doc.heightOfString(
    "Where present, the RFC 3161 timestamp provides evidence that the signed integrity state existed at or before the issuance time recorded by the Time Stamping Authority. Where present, OpenTimestamps provides additional independent public anchoring evidence linked to the recorded evidence digest.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica-Bold").fontSize(10.2);
  const legalTitle = doc.heightOfString("Legal Notice", { width: w - 24 });

  doc.font("Helvetica").fontSize(9.3);
  const legalBody = doc.heightOfString(
    "Cryptographic verification confirms integrity of the recorded evidence state only. It does not independently establish authorship, factual accuracy, legal admissibility, context, or probative weight. These issues remain subject to judicial, administrative, or expert evaluation under the applicable law and procedure.",
    { width: w - 24, lineGap: 1.5 }
  );
  const legalBlock = legalTitle + legalBody + 24;

  const externalMode = opts.externalMode !== false;
  const linkLabelText = externalMode
    ? "Public verification page:"
    : "Verification link:";
  const linkBodyText = externalMode
    ? "Open public verification page"
    : opts.verifyUrl;

  doc.font("Helvetica-Bold").fontSize(9.2);
  const linkLabel = doc.heightOfString(linkLabelText, { width: w });

  doc.font("Helvetica").fontSize(8.8);
  const link = doc.heightOfString(linkBodyText, {
    width: w,
    lineGap: 1.5,
  });

  return (
    28 +
    intro1 +
    intro2 +
    h1 +
    bulletsHeight +
    h2 +
    stepsHeight +
    note +
    legalBlock +
    linkLabel +
    link
  );
}

function renderForensicIntegrityStatement(
  doc: PDFDoc,
  opts: {
    verifyUrl: string;
    structureLabel: string;
    externalMode?: boolean;
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  safeParagraph(
    doc,
    "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    { fontSize: 10.2, color: BRAND.ink }
  );
  doc.moveDown(0.15);

  safeParagraph(
    doc,
    "PROOVRA applies cryptographic integrity controls, structured evidence fingerprinting, trusted timestamping records, OpenTimestamps anchoring evidence, and immutable storage protection designed to preserve the integrity state of the submitted evidence at the time of completion.",
    { fontSize: 9.8, color: BRAND.ink }
  );
  doc.moveDown(0.18);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(10.1);
  doc.text("Integrity materials included in this report:", x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.12);

  const bullets = [
    opts.structureLabel === "Single evidence item"
      ? "A SHA-256 cryptographic hash of the original evidence file"
      : "A SHA-256 cryptographic hash representing the multipart evidence set",
    "A canonical fingerprint record describing the evidence state and metadata",
    "A fingerprint hash derived from the canonical record",
    "A digital signature generated using the PROOVRA signing key",
    "A trusted RFC 3161 timestamp token issued by the configured Time Stamping Authority, when available",
    "OpenTimestamps anchoring evidence, when available",
    "A forensic custody timeline documenting relevant integrity-related system events",
    "Immutable storage protection using AWS S3 Object Lock, when available",
  ];

  for (const b of bullets) {
    safeParagraph(doc, `• ${b}`, { fontSize: 9.8, color: BRAND.ink });
  }

  doc.moveDown(0.16);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(10.1);
  doc.text("Independent review may include:", x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.12);

  const steps =
    opts.structureLabel === "Single evidence item"
      ? [
          "Obtaining the original evidence file",
          "Computing the SHA-256 hash of the evidence file",
          "Comparing the computed hash with the value listed in this report",
          "Verifying the digital signature using the provided public key",
          "Verifying the RFC 3161 timestamp token, when present",
          "Verifying the OpenTimestamps proof, when present",
          "Reviewing the forensic chain of custody events",
          "Reviewing immutable storage details, when present",
        ]
      : [
          "Obtaining the complete multipart evidence set",
          "Reviewing the canonical fingerprint and listed evidence parts",
          "Validating the multipart composite hash against the hashes and structure recorded in the canonical fingerprint",
          "Verifying the digital signature using the provided public key",
          "Verifying the RFC 3161 timestamp token, when present",
          "Verifying the OpenTimestamps proof, when present",
          "Reviewing the forensic chain of custody events",
          "Reviewing immutable storage details, when present",
        ];

  for (let i = 0; i < steps.length; i++) {
    safeParagraph(doc, `${i + 1}. ${steps[i]}`, {
      fontSize: 9.8,
      color: BRAND.ink,
    });
  }

  doc.moveDown(0.16);

  safeParagraph(
    doc,
    "Where present, the RFC 3161 timestamp provides evidence that the signed integrity state existed at or before the issuance time recorded by the Time Stamping Authority. Where present, OpenTimestamps provides additional independent public anchoring evidence linked to the recorded evidence digest.",
    { fontSize: 9.2, color: BRAND.muted }
  );
  doc.moveDown(0.16);

  drawCallout(doc, {
    title: "Legal Notice",
    body:
      "Cryptographic verification confirms integrity of the recorded evidence state only. It does not independently establish authorship, factual accuracy, legal admissibility, context, or probative weight. These issues remain subject to judicial, administrative, or expert evaluation under the applicable law and procedure.",
    tone: "warning",
  });

  const externalMode = opts.externalMode !== false;
  const linkLabelText = externalMode
    ? "Public verification page:"
    : "Verification link:";
  const linkBodyText = externalMode
    ? "Open public verification page"
    : opts.verifyUrl;

  const labelHeight = doc.heightOfString(linkLabelText, { width: w });
  const linkHeight = doc.heightOfString(linkBodyText, {
    width: w,
    lineGap: 1.5,
  });

  ensureSpace(doc, labelHeight + linkHeight + 12);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(9.2);
  doc.text(linkLabelText, x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.08);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.8);
  doc.text(linkBodyText, x, doc.y, {
    width: w,
    link: opts.verifyUrl,
    underline: true,
    lineGap: 1.5,
  });
  doc.restore();
}

function buildExecutiveRows(
  evidence: ReportEvidence,
  structureLabel: string,
  fingerprintSummary: ParsedFingerprintSummary
): Array<[string, string]> {
  return [
    ["Evidence Reference", buildPublicEvidenceReference(evidence.id)],
    [
      "Evidence Type",
      mapPublicEvidenceTypeLabel(evidence, fingerprintSummary),
    ],
    ["Record Status", mapRecordStatusLabel(evidence.status)],
    [
      "Verification Status",
      mapVerificationStatusLabel(evidence.verificationStatus),
    ],
    ["Capture Method", mapCaptureMethodLabel(evidence.captureMethod)],
    ["Identity Level", mapIdentityLevelLabel(evidence.identityLevelSnapshot)],
    ["Submitted By", safe(evidence.submittedByEmail)],
    ["Auth Provider", mapAuthProviderLabel(evidence.submittedByAuthProvider)],
    ["Organization / Workspace", buildOrganizationDisplay(evidence)],
    ["Organization Status", buildOrganizationStatus(evidence)],
    ["Evidence Structure", structureLabel],
    ["Captured (UTC)", safe(evidence.capturedAtUtc)],
    ["Uploaded (UTC)", safe(evidence.uploadedAtUtc)],
    ["Signed (UTC)", safe(evidence.signedAtUtc)],
    [
      "Integrity Verified At (UTC)",
      safe(evidence.recordedIntegrityVerifiedAtUtc),
    ],
    [
      "Storage Protection",
      mapObjectLockModePublicLabel(evidence.storageObjectLockMode),
    ],
    ["Retention Until (UTC)", safe(evidence.storageObjectLockRetainUntilUtc)],
  ];
}

function buildVerificationSummaryRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>,
  structureLabel: string,
  fingerprintSummary: ParsedFingerprintSummary,
  externalMode: boolean
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Display Title", safe(evidence.title, "Digital Evidence Record")],
    ["Evidence Reference", buildPublicEvidenceReference(evidence.id)],
    [
      "Evidence Type",
      mapPublicEvidenceTypeLabel(evidence, fingerprintSummary),
    ],
    ["Evidence Structure", structureLabel],
    ["MIME Type", safe(evidence.mimeType)],
    ["File Size", formatBytesHuman(evidence.sizeBytes)],
    [
      "Duration",
      evidence.durationSec ? `${evidence.durationSec} sec` : "N/A",
    ],
    ["Latest Report Version", String(evidence.latestReportVersion ?? "N/A")],
    [
      "Reviewer Summary Version",
      String(evidence.reviewerSummaryVersion ?? "N/A"),
    ],
    ["Report Generated At (UTC)", safe(evidence.reportGeneratedAtUtc)],
    ["Last Verified At (UTC)", safe(evidence.lastVerifiedAtUtc)],
    [
      "Last Verified Source",
      mapVerificationSourceLabel(evidence.lastVerifiedSource),
    ],
    ["Review Ready At (UTC)", safe(evidence.reviewReadyAtUtc)],
    ["Forensic Custody Events", String(custody.forensic.length)],
    ["Access Activity Events", String(custody.access.length)],
    ["Public Verification Page", "See QR / verification link section"],
  ];

  if (!externalMode) {
    rows.splice(8, 0, [
      "Verification Package Version",
      String(evidence.verificationPackageVersion ?? "N/A"),
    ]);
    rows.splice(12, 0, [
      "Verification Package Generated At (UTC)",
      safe(evidence.verificationPackageGeneratedAtUtc),
    ]);
  }

  return rows;
}

function buildReviewReadinessRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>
): Array<[string, string]> {
  return [
    [
      "Human Summary Ready",
      evidence.reviewReadyAtUtc ? "Yes" : "Not recorded",
    ],
    [
      "Verification Status",
      mapVerificationStatusLabel(evidence.verificationStatus),
    ],
    [
      "Timestamp Status",
      mapTimestampStatusPublicLabel(evidence.tsaStatus),
    ],
    ["Public Anchoring Status", mapOtsStatusPublicLabel(evidence.otsStatus)],
    [
      "Immutable Storage",
      safeBooleanLabel(
        evidence.storageImmutable,
        "Verified",
        "Not fully verified",
        "Not reported"
      ),
    ],
    [
      "Chain of Custody Present",
      custody.forensic.length > 0 ? "Yes" : "No",
    ],
    [
      "Public / Access Activity Present",
      custody.access.length > 0 ? "Yes" : "No",
    ],
    [
      "Technical Materials Available",
      evidence.fileSha256 &&
      evidence.fingerprintHash &&
      evidence.signatureBase64 &&
      evidence.signingKeyId
        ? "Yes"
        : "Incomplete",
    ],
    ["Submitted By", safe(evidence.submittedByEmail)],
    ["Identity Level", mapIdentityLevelLabel(evidence.identityLevelSnapshot)],
    ["Capture Method", mapCaptureMethodLabel(evidence.captureMethod)],
    ["Organization / Workspace", buildOrganizationDisplay(evidence)],
  ];
}

export async function buildReportPdf(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;
  verifyUrl?: string | null;
  downloadUrl?: string | null;
  externalMode?: boolean;
}): Promise<Buffer> {
  const doc = new PDFDocument({
    autoFirstPage: true,
    margin: 50,
    bufferPages: true,
  });

  paintPageBackground(doc);
  doc.on("pageAdded", () => paintPageBackground(doc));

  const buildToken = params.buildInfo
    ? `;PROOVRA_BUILD=${params.buildInfo}`
    : "";

  doc.info = {
    Title: `${BRAND.name} — Verification Report`,
    Subject:
      "Executive Evidence Summary > Verification Summary > Review Readiness > Chain of Custody > Technical Appendix",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: BRAND.name,
    Producer: BRAND.name,
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const verifyUrl = buildVerifyUrl(params.evidence.id, params.verifyUrl);
  const technicalUrl = verifyUrl.includes("?")
    ? `${verifyUrl}&tab=technical`
    : `${verifyUrl}?tab=technical`;

  const fingerprintSummary = parseFingerprintSummary(
    params.evidence.fingerprintCanonicalJson
  );
  const structureLabel = evidenceStructureLabel(fingerprintSummary);
  const custody = splitCustodyEvents(params.custodyEvents);

  const finalDisplayStatus = mapRecordStatusLabel(params.evidence.status);

  const headerContext: HeaderContext = {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: finalDisplayStatus,
  };

  setHeaderContext(headerContext);
  drawHeader(doc, headerContext);

  const hasCoreCrypto =
    Boolean(params.evidence.fileSha256) &&
    Boolean(params.evidence.fingerprintHash) &&
    Boolean(params.evidence.signatureBase64) &&
    Boolean(params.evidence.signingKeyId);

  const timestampTone = normalizeTimestampStatus(params.evidence.tsaStatus);
  const otsTone = normalizeOtsStatus(params.evidence.otsStatus);
  const storageTone = normalizeStorageProtectionStatus(
    params.evidence.storageImmutable,
    params.evidence.storageObjectLockMode,
    params.evidence.storageObjectLockRetainUntilUtc
  );

  const integrityVerified =
    safe(params.evidence.verificationStatus, "").toUpperCase() ===
      "RECORDED_INTEGRITY_VERIFIED" || hasCoreCrypto;

  const externalMode = params.externalMode !== false;

  const includeTechnicalQr =
    !externalMode &&
    (Boolean(params.downloadUrl) ||
      env("REPORT_INCLUDE_TECHNICAL_QR") === "true");

  doc.save();
  doc.fillColor(integrityVerified ? BRAND.success : BRAND.danger);
  doc.font("Helvetica-Bold").fontSize(13.2);
  doc.text(
    integrityVerified
      ? "Recorded Integrity Verified"
      : "Recorded Integrity Review Required",
    doc.page.margins.left,
    doc.y
  );
  doc.restore();
  doc.moveDown(0.2);

  drawCallout(doc, {
    title: "Executive conclusion",
    body: integrityVerified
      ? "This report indicates that recorded integrity materials are present and assembled for reviewer inspection. The report supports later verification of the recorded evidence state."
      : "This report contains incomplete or review-required integrity information. Reviewer inspection is still possible, but conclusions should not be made without manual assessment.",
    tone: integrityVerified ? "success" : "danger",
  });

  drawCallout(doc, {
    title: "Important legal limitation",
    body:
      "PROOVRA verifies the recorded integrity state of an evidence record. It does not independently prove factual truth, authorship, context, or guaranteed legal admissibility.",
    tone: "warning",
  });

  {
    const rows = buildExecutiveRows(
      params.evidence,
      structureLabel,
      fingerprintSummary
    );
    const neededHeight = estimateEvidenceSummarySectionHeight(doc, rows);
    const availableHeight =
      doc.page.height - doc.page.margins.bottom - 10 - doc.y;

    if (availableHeight < neededHeight) {
      addPageWithHeader(doc);
    }

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(15);
    doc.text("Executive Evidence Summary", doc.page.margins.left, doc.y);
    doc.restore();
    doc.moveDown(0.14);

    kvGrid(doc, rows);
    doc.moveDown(0.12);
  }

  addPageWithHeader(doc);

  section(
    doc,
    "Verification Summary",
    () => {
      safeParagraph(
        doc,
        "This section provides the primary reviewer-facing summary of the evidence record, including verification status, identity linkage, capture method, report generation state, and review timestamps.",
        { fontSize: 9.5, color: BRAND.muted }
      );
      doc.moveDown(0.12);

      kvGrid(
        doc,
        buildVerificationSummaryRows(
          params.evidence,
          custody,
          structureLabel,
          fingerprintSummary,
          externalMode
        )
      );

      doc.moveDown(0.14);

      drawCallout(doc, {
        title: "Public verification page",
        body:
          "Use the QR code or the public verification link section to open the reviewer-facing verification record.",
        tone: "neutral",
      });

      drawCallout(doc, {
        title: "What reviewers can inspect",
        body:
          "Reviewers can inspect the recorded integrity summary, chain of custody, timestamp records, OpenTimestamps status, immutable storage protection, report versioning, and technical materials.",
        tone: "neutral",
      });
    },
    { minSpace: 120 }
  );

  addPageWithHeader(doc);

  section(
    doc,
    "Review Readiness",
    () => {
      safeParagraph(
        doc,
        "This section is structured for reviewer workflows. It focuses on the practical review state rather than low-level cryptographic details.",
        { fontSize: 9.4, color: BRAND.muted }
      );
      doc.moveDown(0.12);

      kvGrid(doc, buildReviewReadinessRows(params.evidence, custody));
      doc.moveDown(0.14);

      drawCallout(doc, {
        title: "Reviewer guidance",
        body:
          "Use the public verification page for the human summary and review trail first. Open the technical view only when deeper validation is required.",
        tone: "neutral",
      });

      drawCallout(doc, {
        title: "Who this report is for",
        body:
          "This report is designed for evidence-sensitive review workflows such as legal review, compliance review, investigations, insurance review, and verification-oriented journalism workflows.",
        tone: "neutral",
      });
    },
    { minSpace: 120 }
  );

  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Open verification page",
        qrBuffer: qrBuf,
        size: 102,
        caption:
          "Scan to open the public reviewer-facing verification page for this evidence record.",
        urlText: buildVerificationLinkLabel("public"),
        urlLink: verifyUrl,
      });
    }
  }

  addPageWithHeader(doc);

  section(
    doc,
    "Storage & Timestamping",
    () => {
      kvGrid(doc, [
        ["Storage Region", safe(params.evidence.storageRegion)],
        [
          "Storage Protection Mode",
          mapObjectLockModePublicLabel(params.evidence.storageObjectLockMode),
        ],
        [
          "Retention Until (UTC)",
          safe(params.evidence.storageObjectLockRetainUntilUtc),
        ],
        [
          "Legal Hold",
          safe(params.evidence.storageObjectLockLegalHoldStatus, "OFF"),
        ],
        [
          "Immutable Storage",
          safeBooleanLabel(
            params.evidence.storageImmutable,
            "Verified",
            "Not fully verified",
            "Not reported"
          ),
        ],
        ["RFC 3161 Provider", safe(params.evidence.tsaProvider)],
        ["RFC 3161 URL", safe(params.evidence.tsaUrl)],
        ["RFC 3161 Serial", safe(params.evidence.tsaSerialNumber)],
        ["RFC 3161 Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
        ["RFC 3161 Hash Algorithm", safe(params.evidence.tsaHashAlgorithm)],
        [
          "RFC 3161 Status",
          mapTimestampStatusPublicLabel(params.evidence.tsaStatus),
        ],
        [
          "Public Anchoring Status",
          mapOtsStatusPublicLabel(params.evidence.otsStatus),
        ],
        ["OTS Calendar", safe(params.evidence.otsCalendar)],
        ["OTS Anchored At (UTC)", safe(params.evidence.otsAnchoredAtUtc)],
        ["OTS Upgraded At (UTC)", safe(params.evidence.otsUpgradedAtUtc)],
        ["OTS Bitcoin TxID", shortHash(params.evidence.otsBitcoinTxid)],
      ]);

      doc.moveDown(0.14);

      drawCallout(doc, {
        title:
          storageTone === "SUCCESS"
            ? "Immutable storage verified"
            : storageTone === "WARNING"
              ? "Storage protection recorded"
              : storageTone === "DANGER"
                ? "Storage protection requires review"
                : "Storage protection not reported",
        body:
          storageTone === "SUCCESS"
            ? "This report records immutable-style storage protection consistent with Object Lock COMPLIANCE mode and a retention-until timestamp."
            : storageTone === "WARNING"
              ? "Some storage protection indicators are recorded, but the report does not fully confirm COMPLIANCE immutable protection."
              : storageTone === "DANGER"
                ? "Storage metadata indicates a state that should be reviewed before relying on immutability conclusions."
                : "No verifiable storage-protection information was included in the report payload.",
        tone:
          storageTone === "SUCCESS"
            ? "success"
            : storageTone === "DANGER"
              ? "danger"
              : "warning",
      });

      drawCallout(doc, {
        title:
          timestampTone === "SUCCESS"
            ? "Trusted timestamp recorded"
            : timestampTone === "WARNING"
              ? "Timestamp pending or unavailable"
              : timestampTone === "DANGER"
                ? "Timestamp failure recorded"
                : "Timestamp not reported",
        body:
          timestampTone === "SUCCESS"
            ? "An RFC 3161 timestamp record is available and may support later review of when the recorded integrity state existed."
            : timestampTone === "WARNING"
              ? "The report does not confirm a final trusted timestamp result."
              : timestampTone === "DANGER"
                ? `Timestamp processing reported a failure state. ${safe(
                    params.evidence.tsaFailureReason,
                    ""
                  )}`.trim()
                : "No trusted timestamp record was included.",
        tone:
          timestampTone === "SUCCESS"
            ? "success"
            : timestampTone === "DANGER"
              ? "danger"
              : "warning",
      });

      drawCallout(doc, {
        title:
          otsTone === "SUCCESS"
            ? "OpenTimestamps anchored"
            : otsTone === "WARNING"
              ? "OpenTimestamps pending"
              : otsTone === "DANGER"
                ? "OpenTimestamps failed"
                : "OpenTimestamps not reported",
        body:
          otsTone === "SUCCESS"
            ? "An OpenTimestamps proof is recorded in an anchored state and may provide additional independent public anchoring evidence."
            : otsTone === "WARNING"
              ? "OpenTimestamps proof data is present but not yet in a final anchored state."
              : otsTone === "DANGER"
                ? `OpenTimestamps processing reported a failure state. ${safe(
                    params.evidence.otsFailureReason,
                    ""
                  )}`.trim()
                : "No OpenTimestamps record was included.",
        tone:
          otsTone === "SUCCESS"
            ? "success"
            : otsTone === "DANGER"
              ? "danger"
              : "warning",
      });
    },
    { minSpace: 140 }
  );

  addPageWithHeader(doc);

  section(
    doc,
    "Chain of Custody Summary",
    () => {
      safeParagraph(
        doc,
        "Forensic events are listed separately from access activity. This separation reflects the distinction between integrity-relevant lifecycle events and later viewing or download activity.",
        { fontSize: 8.9, color: BRAND.muted }
      );
      doc.moveDown(0.12);

      drawCallout(doc, {
        title: "Sequence note",
        body:
          "Original event sequence numbers are preserved from the full evidence timeline. Access-related events are shown separately, so numbering may appear non-consecutive within this section.",
        tone: "neutral",
      });

      if (custody.forensic.length === 0) {
        drawCallout(doc, {
          title: "No forensic custody events recorded",
          body: "No forensic custody events were provided for this report.",
          tone: "warning",
        });
      } else {
        const innerW =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const colWidths = [
          Math.max(44, innerW * 0.08),
          Math.max(118, innerW * 0.24),
          Math.max(132, innerW * 0.22),
          innerW -
            (Math.max(44, innerW * 0.08) +
              Math.max(118, innerW * 0.24) +
              Math.max(132, innerW * 0.22)),
        ];

        const headers = ["Seq", "At (UTC)", "Event", "Summary"];
        const rows = custody.forensic.map((ev) => [
          String(ev.sequence),
          safe(ev.atUtc),
          mapCustodyEventLabel(ev.eventType),
          safe(ev.payloadSummary),
        ]);

        drawTable(doc, headers, rows, colWidths);
      }
    },
    { minSpace: 120 }
  );

  if (custody.access.length > 0) {
    ensurePageWithHeader(doc, 180);

    section(
      doc,
      "Access Activity",
      () => {
        const innerW =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const colWidths = [
          Math.max(44, innerW * 0.08),
          Math.max(118, innerW * 0.24),
          Math.max(132, innerW * 0.22),
          innerW -
            (Math.max(44, innerW * 0.08) +
              Math.max(118, innerW * 0.24) +
              Math.max(132, innerW * 0.22)),
        ];

        const headers = ["Seq", "At (UTC)", "Event", "Summary"];
        const rows = custody.access.map((ev) => [
          String(ev.sequence),
          safe(ev.atUtc),
          mapCustodyEventLabel(ev.eventType),
          safe(ev.payloadSummary),
        ]);

        drawTable(doc, headers, rows, colWidths);
      },
      { minSpace: 100 }
    );
  }

  addPageWithHeader(doc);

  section(
    doc,
    externalMode
      ? "Technical Appendix — Reviewer-Facing Technical Summary"
      : "Technical Appendix — Identity, Fingerprint, Signature, and Anchoring",
    () => {
      kvGrid(doc, [
        ["Submitted By Email", safe(params.evidence.submittedByEmail)],
        [
          "Submitted By Provider",
          mapAuthProviderLabel(params.evidence.submittedByAuthProvider),
        ],
        [
          "Submitted By User Ref",
          redactIdentifier(params.evidence.submittedByUserId),
        ],
        [
          "Created By User Ref",
          redactIdentifier(params.evidence.createdByUserId),
        ],
        [
          "Uploaded By User Ref",
          redactIdentifier(params.evidence.uploadedByUserId),
        ],
        [
          "Last Accessed By User Ref",
          redactIdentifier(params.evidence.lastAccessedByUserId),
        ],
        ["Last Accessed At (UTC)", safe(params.evidence.lastAccessedAtUtc)],
        ["Capture Method", mapCaptureMethodLabel(params.evidence.captureMethod)],
        [
          "Identity Level",
          mapIdentityLevelLabel(params.evidence.identityLevelSnapshot),
        ],
        ["Organization / Workspace", buildOrganizationDisplay(params.evidence)],
        ["Organization Status", buildOrganizationStatus(params.evidence)],
      ]);

      doc.moveDown(0.12);

      drawCallout(doc, {
        title: "Fingerprint structure summary",
        body: buildFingerprintNarrative(fingerprintSummary),
        tone: "neutral",
      });

      if (externalMode) {
        drawCallout(doc, {
          title: "External report note",
          body:
            "This external report includes reviewer-facing technical summaries only. Deep technical materials should be reviewed through the technical verification workflow or verification package when required.",
          tone: "neutral",
        });
      }

      monospaceStrip(doc, "File SHA-256", safe(params.evidence.fileSha256));
      monospaceStrip(
        doc,
        "Fingerprint Hash",
        safe(params.evidence.fingerprintHash)
      );

      if (!externalMode) {
        monospaceStrip(
          doc,
          "Signing Key Reference",
          buildPublicSigningKeyReference(
            params.evidence.signingKeyId,
            params.evidence.signingKeyVersion
          )
        );
        monospaceStrip(
          doc,
          "Signature (Base64) (excerpt)",
          safe(params.evidence.signatureBase64),
          { maxChars: 260 }
        );
        monospaceStrip(
          doc,
          "Public Key (PEM) (excerpt)",
          safe(params.evidence.publicKeyPem),
          { maxChars: 260 }
        );
      } else {
        drawCallout(doc, {
          title: "Technical signature materials",
          body:
            "Detailed signature materials and public-key verification artifacts are available through the technical verification workflow and verification package, where enabled.",
          tone: "neutral",
        });
      }

      if (fingerprintSummary.itemCount > 1) {
        ensureSpace(doc, 180);

        doc.save();
        doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
        doc.text("Multipart Evidence Summary", doc.page.margins.left, doc.y);
        doc.restore();
        doc.moveDown(0.14);

        kvGrid(doc, [
          ["Structure", structureLabel],
          ["Total Items", String(fingerprintSummary.itemCount)],
          ["Fingerprint Parts", String(fingerprintSummary.partsCount)],
          ["Images", String(fingerprintSummary.imageCount)],
          ["Videos", String(fingerprintSummary.videoCount)],
          ["Audio", String(fingerprintSummary.audioCount)],
          ["Documents", String(fingerprintSummary.documentCount)],
          [
            "MIME Types",
            fingerprintSummary.mimeTypes.length > 0
              ? summarizeText(fingerprintSummary.mimeTypes.join(", "), 80)
              : "N/A",
          ],
        ]);

        doc.moveDown(0.12);
      }

      ensureSpace(doc, 220);

      doc.save();
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
      doc.text("RFC 3161 Time Stamping Authority", doc.page.margins.left, doc.y);
      doc.restore();
      doc.moveDown(0.14);

      kvGrid(doc, [
        ["Timestamp Provider", safe(params.evidence.tsaProvider)],
        ["Timestamp URL", safe(params.evidence.tsaUrl)],
        ["Serial Number", safe(params.evidence.tsaSerialNumber)],
        ["Generation Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
        ["Hash Algorithm", safe(params.evidence.tsaHashAlgorithm)],
        [
          "Timestamp Status",
          mapTimestampStatusPublicLabel(params.evidence.tsaStatus),
        ],
      ]);

      if (!externalMode) {
        monospaceStrip(
          doc,
          "Timestamp Message Imprint",
          safe(params.evidence.tsaMessageImprint),
          { maxChars: 140 }
        );
      }

      if (!externalMode && params.evidence.tsaTokenBase64) {
        monospaceStrip(
          doc,
          "Timestamp Token (Base64) (excerpt)",
          safe(params.evidence.tsaTokenBase64),
          { maxChars: 220 }
        );
      }

      if (params.evidence.otsStatus || params.evidence.otsHash) {
        ensureSpace(doc, 180);

        doc.save();
        doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
        doc.text("OpenTimestamps", doc.page.margins.left, doc.y);
        doc.restore();
        doc.moveDown(0.14);

        kvGrid(doc, [
          ["OTS Status", mapOtsStatusPublicLabel(params.evidence.otsStatus)],
          ["OTS Calendar", safe(params.evidence.otsCalendar)],
          ["OTS Anchored At (UTC)", safe(params.evidence.otsAnchoredAtUtc)],
          ["OTS Upgraded At (UTC)", safe(params.evidence.otsUpgradedAtUtc)],
          ["OTS Bitcoin TxID", shortHash(params.evidence.otsBitcoinTxid)],
        ]);

        if (!externalMode && params.evidence.otsHash) {
          monospaceStrip(doc, "OTS Hash", safe(params.evidence.otsHash), {
            maxChars: 180,
          });
        }

        if (!externalMode && params.evidence.otsProofBase64) {
          monospaceStrip(
            doc,
            "OTS Proof (Base64) (excerpt)",
            safe(params.evidence.otsProofBase64),
            { maxChars: 220 }
          );
        }

        if (params.evidence.otsFailureReason) {
          if (!externalMode) {
            monospaceStrip(
              doc,
              "OTS Failure / Detail",
              summarizeText(safe(params.evidence.otsFailureReason), 160),
              { maxChars: 160 }
            );
          } else {
            drawCallout(doc, {
              title: "Anchoring detail",
              body:
                "Additional anchoring failure details are available through the technical verification workflow.",
              tone: "warning",
            });
          }
        }
      }

      if (
        params.evidence.anchorProvider ||
        params.evidence.anchorPublicUrl ||
        params.evidence.anchorHash
      ) {
        ensureSpace(doc, 160);

        doc.save();
        doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
        doc.text("External Anchoring", doc.page.margins.left, doc.y);
        doc.restore();
        doc.moveDown(0.14);

        kvGrid(doc, [
          ["Anchor Mode", mapAnchorModePublicLabel(params.evidence.anchorMode)],
          ["Anchor Provider", safe(params.evidence.anchorProvider)],
          ["Anchor Anchored At (UTC)", safe(params.evidence.anchorAnchoredAtUtc)],
          [
            "Anchor Public URL",
            summarizeText(safe(params.evidence.anchorPublicUrl), 84),
          ],
          ["Anchor Receipt ID", shortHash(params.evidence.anchorReceiptId)],
          ["Anchor Transaction ID", shortHash(params.evidence.anchorTransactionId)],
        ]);

        if (!externalMode) {
          monospaceStrip(doc, "Anchor Hash", safe(params.evidence.anchorHash), {
            maxChars: 180,
          });
        }
      }
    },
    { minSpace: 120 }
  );

  if (includeTechnicalQr) {
    const qrBuf = await tryGenerateQrPngBuffer(technicalUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Technical materials",
        qrBuffer: qrBuf,
        size: 100,
        caption:
          "Scan to open the technical verification view for this evidence record.",
        urlText: buildVerificationLinkLabel("technical"),
        urlLink: technicalUrl,
      });
    }
  }

  const forensicBlockHeight = estimateForensicIntegrityStatementHeight(doc, {
    verifyUrl,
    structureLabel,
    externalMode,
  });

  ensurePageWithHeader(doc, forensicBlockHeight + 40);

  section(
    doc,
    "Forensic Integrity Statement",
    () => {
      renderForensicIntegrityStatement(doc, {
        verifyUrl,
        structureLabel,
        externalMode,
      });
    },
    { minSpace: 140 }
  );

  addFooters(doc, {
    generatedAtUtc: params.generatedAtUtc,
    reportVersion: params.version,
  });

  const endPromise = new Promise<void>((resolve, reject) => {
    doc.once("end", resolve);
    doc.once("error", reject);
  });

  doc.end();
  await endPromise;

  const pdf = Buffer.concat(chunks);
  return signPdfIfEnabled(pdf);
}