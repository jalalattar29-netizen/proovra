import { getReviewerEvidenceTypeLabel } from "@proovra/shared";
import type {
  DetailWorkspaceState,
  EvidenceListItem,
  EvidenceListScope,
  EvidenceRecord,
} from "./evidence-library-types";

export function detectEvidenceKind(
  mimeType: string | null | undefined
): "image" | "video" | "audio" | "document" | "other" {
  const mime = (mimeType ?? "").trim().toLowerCase();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml")
  ) {
    return "document";
  }

  return "other";
}

export function getEvidenceScope(item: Pick<EvidenceListItem, "archivedAt" | "deletedAt">): EvidenceListScope | "active" {
  if (item.deletedAt) return "deleted";
  if (item.archivedAt) return "archived";
  return "active";
}

export function getDisplayTitle(
  item: Pick<EvidenceListItem, "title" | "displayFileName" | "originalFileName" | "type" | "mimeType" | "itemCount"> |
    Pick<EvidenceRecord, "title" | "displayFileName" | "originalFileName" | "type" | "mimeType" | "itemCount">
): string {
  const direct = item.title?.trim();
  if (direct) return direct;

  const fileLabel = item.displayFileName?.trim() || item.originalFileName?.trim();
  if (fileLabel) return fileLabel;

  return getReviewerEvidenceTypeLabel({
    itemCount: item.itemCount,
    evidenceType: item.type,
    mimeType: item.mimeType,
  });
}

export function getRecordStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "REPORTED":
      return "Reported";
    case "SIGNED":
      return "Signed";
    case "UPLOADED":
      return "Uploaded";
    case "UPLOADING":
      return "Uploading";
    case "CREATED":
      return "Created";
    default:
      return "Status not recorded";
  }
}

export function getVerificationStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
}

export function getCaptureMethodLabel(value: string | null | undefined): string {
  switch (String(value ?? "").trim().toUpperCase()) {
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

export function getIdentityLevelLabel(value: string | null | undefined): string {
  switch (String(value ?? "").trim().toUpperCase()) {
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

export function getEvidenceTypeLabel(
  item: Pick<EvidenceListItem, "type" | "mimeType" | "itemCount">,
  detail?: DetailWorkspaceState | null
): string {
  const summary = detail?.evidence?.contentSummary ?? null;

  return getReviewerEvidenceTypeLabel({
    itemCount: detail?.evidence?.itemCount ?? item.itemCount,
    structure: summary?.structure ?? null,
    imageCount: summary?.imageCount ?? null,
    videoCount: summary?.videoCount ?? null,
    audioCount: summary?.audioCount ?? null,
    pdfCount: summary?.pdfCount ?? null,
    textCount: summary?.textCount ?? null,
    otherCount: summary?.otherCount ?? null,
    evidenceType: item.type,
    mimeType: detail?.evidence?.mimeType ?? item.mimeType,
  });
}

export function getStructureLabel(
  item: Pick<EvidenceListItem, "itemCount">,
  detail?: DetailWorkspaceState | null
): string {
  const structure = detail?.evidence?.contentSummary?.structure;
  if (structure === "multipart") return "Multipart package";
  const count = detail?.evidence?.itemCount ?? item.itemCount ?? 1;
  return count > 1 ? "Multipart package" : "Single item";
}

export function getStatusTone(item: EvidenceListItem): "neutral" | "success" | "warning" | "danger" | "processing" {
  const scope = getEvidenceScope(item);
  if (scope === "deleted") return "danger";
  if (scope === "archived") return "warning";

  switch (String(item.status).trim().toUpperCase()) {
    case "REPORTED":
    case "SIGNED":
      return "success";
    case "UPLOADING":
    case "CREATED":
      return "processing";
    default:
      return "neutral";
  }
}
