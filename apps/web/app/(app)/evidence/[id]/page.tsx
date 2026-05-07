"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SHORT_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  CAPTURE_LOCATION_STATUS_LABEL,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  getReviewerEvidenceTypeLabel,
  hasCaptureLocationMetadata,
} from "@proovra/shared";
import { Button, Modal, useToast } from "../../../../components/ui";
import CaptureLocationMapPanel from "../../../../components/capture-location/CaptureLocationMapPanel";
import { useLocale } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import type {
  BillingOverviewResponse,
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
} from "../../../../components/billing/types";
import "./evidence-detail.css";

function formatBytes(sizeBytes: string | number | null | undefined): string {
  const n =
    typeof sizeBytes === "number"
      ? sizeBytes
      : sizeBytes
        ? Number(sizeBytes)
        : Number.NaN;

  if (!Number.isFinite(n) || n <= 0) return "Unknown size";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = n;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "Not available";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";

  const day = date.getUTCDate().toString().padStart(2, "0");
  const month = date.toLocaleString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");

  return `${day} ${month} ${year}, ${hours}:${minutes}:${seconds} UTC`;
}

function shortId(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not available";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function getEvidenceKind(
  mimeType: string | null
): "image" | "video" | "audio" | "pdf" | "text" | "other" {
  const mime = (mimeType ?? "").toLowerCase();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) {
    return "text";
  }

  return "other";
}

function getMimeExtension(mimeType: string | null | undefined): string {
  const mime = (mimeType ?? "").toLowerCase();

  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "video/quicktime":
      return ".mov";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "application/json":
      return ".json";
    default:
      return "";
  }
}

function sanitizePossibleFileName(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  const slashNormalized = raw.replace(/\\/g, "/");
  const last = slashNormalized.split("/").pop()?.trim() ?? "";
  if (!last) return null;

  if (last === "." || last === "..") return null;
  return last;
}

function formatCaptureTimestampForFileName(value: string | null | undefined): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "unknown-time";
  }

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");

  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}Z`;
}

function buildGeneratedCaptureFileName(params: {
  mimeType?: string | null;
  recordedAt?: string | null;
  itemIndex?: number | null;
  isMultipart?: boolean;
}): string {
  const kind = getEvidenceKind(params.mimeType ?? null);
  const ext = getMimeExtension(params.mimeType ?? null);
  const ts = formatCaptureTimestampForFileName(params.recordedAt ?? null);

  const prefix =
    kind === "image"
      ? "PROOVRA-CAPTURE"
      : kind === "video"
        ? "PROOVRA-VIDEO-CAPTURE"
        : kind === "audio"
          ? "PROOVRA-AUDIO-CAPTURE"
          : kind === "pdf"
            ? "PROOVRA-DOCUMENT-CAPTURE"
            : "PROOVRA-EVIDENCE";

  const itemSuffix =
    params.isMultipart && typeof params.itemIndex === "number"
      ? `-ITEM-${params.itemIndex + 1}`
      : "";

  return `${prefix}-${ts}${itemSuffix}${ext}`;
}

function getDisplayStatusMeta(
  rawStatus: string | null | undefined,
  labels: {
    signed: string;
    processing: string;
  }
): {
  label: string;
  tone: "reportReady" | "signed" | "processing" | "ready";
} {
  const status = (rawStatus ?? "").trim().toUpperCase();

  switch (status) {
    case "REPORTED":
      return {
        label: "Report Ready",
        tone: "reportReady",
      };
    case "SIGNED":
      return {
        label: labels.signed,
        tone: "signed",
      };
    case "UPLOADED":
      return {
        label: "UPLOADED",
        tone: "ready",
      };
    case "UPLOADING":
      return {
        label: labels.processing,
        tone: "processing",
      };
    case "CREATED":
      return {
        label: "CREATED",
        tone: "processing",
      };
    default:
      return {
        label: status || "UNKNOWN",
        tone: "ready",
      };
  }
}

type CaseOption = {
  id: string;
  name: string;
  ownerUserId?: string;
  teamId?: string | null;
};

type EvidencePart = {
  id: string;
  partIndex: number;
  mimeType: string | null;
  sizeBytes?: string | number | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  sha256?: string | null;
  durationMs?: number | null;
  publicUrl?: string | null;
  url?: string | null;
  previewUrl?: string | null;
  isPrimary?: boolean;
  originalFileName?: string | null;
  fileName?: string | null;
  displayName?: string | null;
  capturedAt?: string | null;
  createdAt?: string | null;
  privateRole?: string | null;
  privateNote?: string | null;
  checklistStepId?: string | null;
  sourceLabel?: string | null;
  clientSignals?: Record<string, unknown> | null;
};

type PartsResponse = {
  evidenceId?: string;
  multipart?: boolean;
  primary?: {
    bucket?: string | null;
    key?: string | null;
    publicUrl?: string | null;
  } | null;
  parts?: EvidencePart[];
};

type OriginalResponse = {
  evidenceId?: string;
  bucket?: string | null;
  key?: string | null;
  originalFileName?: string | null;
  url?: string | null;
  publicUrl?: string | null;
  mimeType?: string | null;
  sizeBytes?: string | null;
};

type EvidenceRecord = {
  id?: string;
  title?: string;
  displayTitle?: string;
  displaySubtitle?: string;
  internalNotes?: string | null;
  itemCount?: number;
  status?: string;
  createdAt?: string | null;
  type?: string;
  lockedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  deleteScheduledForUtc?: string | null;
  caseId?: string | null;
  teamId?: string | null;
  organizationId?: string | null;
  workspaceType?: "PERSONAL" | "TEAM" | null;
  workspaceName?: string | null;
  reportGeneratedAtUtc?: string | null;
  verificationPackageGeneratedAtUtc?: string | null;
  capturedAtUtc?: string | null;
  deviceTimeIso?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyMeters?: number | null;
  intakePlanJson?: Record<string, unknown> | null;
};

type EvidenceResponse = {
  evidence?: EvidenceRecord;
};

type WorkspaceCapabilitySnapshot = {
  workspaceType: "PERSONAL" | "TEAM";
  workspaceName: string;
  plan: string;
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
  storageUsedLabel?: string | null;
  storageLimitLabel?: string | null;
  storageRemainingLabel?: string | null;
  billingStatus?: string | null;
  seatsIncluded?: number | null;
  seatsUsed?: number | null;
  seatsRemaining?: number | null;
  overSeatLimit?: boolean | null;
};

function getPartDisplayName(
  part: EvidencePart,
  fallbackRecordedAt?: string | null,
  isMultipart = false
): string {
  const preferred =
    sanitizePossibleFileName(part.originalFileName) ||
    sanitizePossibleFileName(part.displayName) ||
    sanitizePossibleFileName(part.fileName) ||
    sanitizePossibleFileName(part.storageKey);

  if (preferred) return preferred;

  return buildGeneratedCaptureFileName({
    mimeType: part.mimeType ?? null,
    recordedAt: part.capturedAt ?? part.createdAt ?? fallbackRecordedAt ?? null,
    itemIndex: typeof part.partIndex === "number" ? part.partIndex : null,
    isMultipart,
  });
}

function resolveDisplayTitle(evidence: EvidenceRecord | undefined): string {
  return (
    evidence?.displayTitle?.trim() ||
    evidence?.title?.trim() ||
    "Digital Evidence Record"
  );
}

function resolveDisplaySubtitle(evidence: EvidenceRecord | undefined): string {
  return evidence?.displaySubtitle?.trim() || "";
}

async function tryDownloadFile(url: string, filename: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Download fetch failed");

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(objectUrl);
    return true;
  } catch {
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function getVerificationUrl(evidenceId: string): string {
  const appBase =
    process.env.NEXT_PUBLIC_APP_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ||
    "https://app.proovra.com";

  return `${appBase.replace(/\/+$/, "")}/verify/${evidenceId}`;
}

function deriveWorkspaceCapabilities(params: {
  evidence?: EvidenceRecord;
  personal: PersonalWorkspaceSummary | null;
  teams: TeamWorkspaceSummary[];
  ownedCases: CaseOption[];
}): WorkspaceCapabilitySnapshot {
  const explicitTeamId = params.evidence?.teamId ?? null;
  const inferredTeamIdFromCase =
    !explicitTeamId && params.evidence?.caseId
      ? params.ownedCases.find((item) => item.id === params.evidence?.caseId)?.teamId ?? null
      : null;

  const effectiveTeamId = explicitTeamId || inferredTeamIdFromCase || null;

  if (effectiveTeamId) {
    const team = params.teams.find((item) => item.id === effectiveTeamId);
    if (team) {
      return {
        workspaceType: "TEAM",
        workspaceName:
          params.evidence?.workspaceName?.trim() || team.name || "Team Workspace",
        plan: team.plan ?? "FREE",
        reportsIncluded: Boolean(team.features?.reportsIncluded),
        verificationPackageIncluded: Boolean(
          team.features?.verificationPackageIncluded
        ),
        publicVerifyIncluded: Boolean(team.features?.publicVerifyIncluded),
        storageUsedLabel: team.storage?.usedLabel ?? null,
        storageLimitLabel: team.storage?.limitLabel ?? null,
        storageRemainingLabel: team.storage?.remainingLabel ?? null,
        billingStatus: team.billingStatus ?? null,
        seatsIncluded: team.seats?.included ?? null,
        seatsUsed: team.seats?.used ?? null,
        seatsRemaining: team.seats?.remaining ?? null,
        overSeatLimit: team.overSeatLimit ?? null,
      };
    }
  }

  return {
    workspaceType: "PERSONAL",
    workspaceName: params.evidence?.workspaceName?.trim() || "Personal Workspace",
    plan: params.personal?.plan ?? "FREE",
    reportsIncluded: Boolean(params.personal?.features?.reportsIncluded),
    verificationPackageIncluded: Boolean(
      params.personal?.features?.verificationPackageIncluded
    ),
    publicVerifyIncluded: Boolean(params.personal?.features?.publicVerifyIncluded),
    storageUsedLabel: params.personal?.storage?.usedLabel ?? null,
    storageLimitLabel: params.personal?.storage?.limitLabel ?? null,
    storageRemainingLabel: params.personal?.storage?.remainingLabel ?? null,
    billingStatus: params.personal?.subscription?.status ?? null,
    seatsIncluded: null,
    seatsUsed: null,
    seatsRemaining: null,
    overSeatLimit: null,
  };
}

export default function EvidenceDetailPage() {
  const { t } = useLocale();
  const params = useParams<{ id: string }>();
  const { addToast } = useToast();
  const evidenceId = params?.id ?? "unknown";

  const [status, setStatus] = useState("CREATED");
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [deletedAt, setDeletedAt] = useState<string | null>(null);
  const [deleteScheduledForUtc, setDeleteScheduledForUtc] = useState<string | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [workspaceNameFromEvidence, setWorkspaceNameFromEvidence] = useState<string | null>(null);
  const [evidenceType, setEvidenceType] = useState<string | null>(null);
  const [reportGeneratedAtUtc, setReportGeneratedAtUtc] = useState<string | null>(null);
  const [verificationPackageGeneratedAtUtc, setVerificationPackageGeneratedAtUtc] =
    useState<string | null>(null);
  const [capturedAtUtc, setCapturedAtUtc] = useState<string | null>(null);
  const [deviceTimeIso, setDeviceTimeIso] = useState<string | null>(null);
  const [captureLat, setCaptureLat] = useState<number | null>(null);
  const [captureLng, setCaptureLng] = useState<number | null>(null);
  const [captureAccuracyMeters, setCaptureAccuracyMeters] = useState<number | null>(null);
  const [internalNotes, setInternalNotes] = useState<string | null>(null);
  const [intakePlanJson, setIntakePlanJson] = useState<Record<string, unknown> | null>(null);

  const [label, setLabel] = useState<string>("Digital Evidence Record");
  const [displaySubtitle, setDisplaySubtitle] = useState<string>("");
  const [itemCount, setItemCount] = useState<number>(1);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelBusy, setLabelBusy] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [lockModalOpen, setLockModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareActionBusy, setShareActionBusy] = useState(false);

  const [assignCaseModalOpen, setAssignCaseModalOpen] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [ownedCases, setOwnedCases] = useState<CaseOption[]>([]);

  const [personalWorkspace, setPersonalWorkspace] =
    useState<PersonalWorkspaceSummary | null>(null);
  const [teamWorkspaces, setTeamWorkspaces] = useState<TeamWorkspaceSummary[]>([]);
  const [, setBillingOverview] =
    useState<BillingOverviewResponse | null>(null);

  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null);
  const [originalDownloadUrl, setOriginalDownloadUrl] = useState<string | null>(null);
  const [originalMimeType, setOriginalMimeType] = useState<string | null>(null);
  const [originalSizeBytes, setOriginalSizeBytes] = useState<string | null>(null);
  const [originalFileName, setOriginalFileName] = useState<string | null>(null);

  const [parts, setParts] = useState<EvidencePart[]>([]);
  const [reportAvailable, setReportAvailable] = useState(false);
  const [verificationPackageAvailable, setVerificationPackageAvailable] = useState(false);

  const sortedParts = useMemo(
    () => [...parts].sort((a, b) => a.partIndex - b.partIndex),
    [parts]
  );

  const isMultipart = useMemo(
    () => sortedParts.length > 1 || itemCount > 1,
    [sortedParts.length, itemCount]
  );

  const isLocked = Boolean(lockedAt);
  const isArchived = Boolean(archivedAt);
  const isDeleted = Boolean(deletedAt);
  const canDelete = !isDeleted;

  const originalKind = useMemo(() => getEvidenceKind(originalMimeType), [originalMimeType]);

  const partTypeSummary = useMemo(() => {
    if (sortedParts.length === 0) {
return {
  imageCount: 0,
  videoCount: 0,
  audioCount: 0,
  pdfCount: 0,
  textCount: 0,
  otherCount: 0,
};
    }

    return sortedParts.reduce(
      (acc, part) => {
        const kind = getEvidenceKind(part.mimeType ?? null);
if (kind === "image") acc.imageCount += 1;
else if (kind === "video") acc.videoCount += 1;
else if (kind === "audio") acc.audioCount += 1;
else if (kind === "pdf") acc.pdfCount += 1;
else if (kind === "text") acc.textCount += 1;
else acc.otherCount += 1;
        return acc;
      },
      {
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        textCount: 0,
        pdfCount: 0,
        otherCount: 0,
      }
    );
  }, [sortedParts]);

  const compositionSummary = useMemo(() => {
    const partsList: string[] = [];

    if (partTypeSummary.imageCount > 0) {
      partsList.push(`${partTypeSummary.imageCount} image${partTypeSummary.imageCount > 1 ? "s" : ""}`);
    }
    if (partTypeSummary.videoCount > 0) {
      partsList.push(`${partTypeSummary.videoCount} video${partTypeSummary.videoCount > 1 ? "s" : ""}`);
    }
    if (partTypeSummary.audioCount > 0) {
      partsList.push(`${partTypeSummary.audioCount} audio${partTypeSummary.audioCount > 1 ? " files" : ""}`);
    }
    if (partTypeSummary.pdfCount > 0) {
      partsList.push(`${partTypeSummary.pdfCount} document${partTypeSummary.pdfCount > 1 ? "s" : ""}`);
    }
    if (partTypeSummary.textCount > 0) {
  partsList.push(`${partTypeSummary.textCount} text file${partTypeSummary.textCount > 1 ? "s" : ""}`);
}
    if (partTypeSummary.otherCount > 0) {
      partsList.push(`${partTypeSummary.otherCount} other`);
    }

    if (partsList.length === 0) {
      if (itemCount > 1) return `${itemCount} items`;
      return "Single file";
    }

    return partsList.join(" • ");
  }, [partTypeSummary, itemCount]);

  const recordTypeLabel = useMemo(
    () =>
      getReviewerEvidenceTypeLabel({
        itemCount,
        structure: isMultipart ? "multipart" : "single",
        imageCount: partTypeSummary.imageCount,
        videoCount: partTypeSummary.videoCount,
        audioCount: partTypeSummary.audioCount,
        pdfCount: partTypeSummary.pdfCount,
        textCount: partTypeSummary.textCount,
        otherCount: partTypeSummary.otherCount,
        evidenceType,
        mimeType: originalMimeType,
      }),
    [
      evidenceType,
      isMultipart,
      itemCount,
      originalMimeType,
      partTypeSummary.audioCount,
      partTypeSummary.imageCount,
      partTypeSummary.otherCount,
      partTypeSummary.pdfCount,
      partTypeSummary.textCount,
      partTypeSummary.videoCount,
    ]
  );

  const effectiveHeroSubtitle = useMemo(() => {
    if (displaySubtitle) return displaySubtitle;
    if (isMultipart) {
      return `${itemCount} item${itemCount === 1 ? "" : "s"} • ${compositionSummary}`;
    }
    return compositionSummary || `${itemCount} item${itemCount === 1 ? "" : "s"}`;
  }, [displaySubtitle, isMultipart, itemCount, compositionSummary]);

  const effectiveOriginalSummaryName = useMemo(() => {
    const cleanedOriginal = sanitizePossibleFileName(originalFileName);
    if (cleanedOriginal) return cleanedOriginal;

    if (isMultipart) {
      return `Multiple original files (${sortedParts.length} items)`;
    }

    const firstPart = sortedParts[0];
    if (firstPart) {
      return getPartDisplayName(firstPart, createdAt, false);
    }

    if (originalMimeType) {
      return buildGeneratedCaptureFileName({
        mimeType: originalMimeType,
        recordedAt: createdAt,
        isMultipart: false,
      });
    }

    return "Original filename not available";
  }, [originalFileName, isMultipart, sortedParts, createdAt, originalMimeType]);

  const displayStatusMeta = useMemo(
    () =>
      getDisplayStatusMeta(status, {
        signed: t("statusSigned"),
        processing: t("statusProcessing"),
      }),
    [status, t]
  );

  const workspaceSnapshot = useMemo(
    () =>
      deriveWorkspaceCapabilities({
        evidence: {
          teamId,
          caseId,
          workspaceName: workspaceNameFromEvidence,
        },
        personal: personalWorkspace,
        teams: teamWorkspaces,
        ownedCases,
      }),
    [teamId, caseId, workspaceNameFromEvidence, personalWorkspace, teamWorkspaces, ownedCases]
  );

  const canAccessReports = workspaceSnapshot.reportsIncluded;
  const canAccessVerificationPackage = workspaceSnapshot.verificationPackageIncluded;
  const canUsePublicVerification = workspaceSnapshot.publicVerifyIncluded;
  const activePlan = workspaceSnapshot.plan;
  const activeWorkspaceName = workspaceSnapshot.workspaceName;
  const activeWorkspaceType = workspaceSnapshot.workspaceType;

  const evidenceRecordStateAllowsLock =
    status === "SIGNED" || status === "REPORTED";

  const canLockEvidence =
    !isDeleted && !isLocked && evidenceRecordStateAllowsLock;

  const canShareEvidence =
    !isDeleted && (canUsePublicVerification || canAccessReports || canAccessVerificationPackage);

  useEffect(() => {
    if (!params?.id) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const [
          evidenceRes,
          billingRes,
          reportRes,
          originalRes,
          casesRes,
          partsRes,
          verificationPackageRes,
        ] = await Promise.allSettled([
          apiFetch(`/v1/evidence/${params.id}`),
          apiFetch("/v1/billing/overview"),
          apiFetch(`/v1/evidence/${params.id}/report/latest`),
          apiFetch(`/v1/evidence/${params.id}/original`),
          apiFetch("/v1/cases"),
          apiFetch(`/v1/evidence/${params.id}/parts`),
          apiFetch(`/v1/evidence/${params.id}/verification-package`),
        ]);

        if (cancelled) return;

        if (evidenceRes.status === "fulfilled") {
          const data = evidenceRes.value as EvidenceResponse;
          const ev = data?.evidence ?? {};
          setStatus(ev.status ?? "CREATED");
          setCreatedAt(ev.createdAt ?? null);
          setLockedAt(ev.lockedAt ?? null);
          setArchivedAt(ev.archivedAt ?? null);
          setDeletedAt(ev.deletedAt ?? null);
          setDeleteScheduledForUtc(ev.deleteScheduledForUtc ?? null);
          setCaseId(ev.caseId ?? null);
          setTeamId(ev.teamId ?? null);
          setWorkspaceNameFromEvidence(ev.workspaceName ?? null);
          setEvidenceType(ev.type ?? null);
          setReportGeneratedAtUtc(ev.reportGeneratedAtUtc ?? null);
          setVerificationPackageGeneratedAtUtc(
            ev.verificationPackageGeneratedAtUtc ?? null
          );
          setCapturedAtUtc(ev.capturedAtUtc ?? null);
          setDeviceTimeIso(ev.deviceTimeIso ?? null);
          setCaptureLat(typeof ev.lat === "number" ? ev.lat : null);
          setCaptureLng(typeof ev.lng === "number" ? ev.lng : null);
          setCaptureAccuracyMeters(
            typeof ev.accuracyMeters === "number" ? ev.accuracyMeters : null
          );
          setInternalNotes(ev.internalNotes ?? null);
          setIntakePlanJson(ev.intakePlanJson ?? null);
          setLabel(resolveDisplayTitle(ev));
          setLabelDraft(resolveDisplayTitle(ev));
          setDisplaySubtitle(resolveDisplaySubtitle(ev));
          setItemCount(typeof ev.itemCount === "number" && ev.itemCount > 0 ? ev.itemCount : 1);
        } else {
          throw evidenceRes.reason;
        }

        if (billingRes.status === "fulfilled") {
          const overview = (billingRes.value ?? null) as BillingOverviewResponse | null;
          setBillingOverview(overview);
          setPersonalWorkspace(overview?.workspaces?.personal ?? null);
          setTeamWorkspaces(
            Array.isArray(overview?.workspaces?.teams) ? overview.workspaces.teams : []
          );
        } else {
          setBillingOverview(null);
          setPersonalWorkspace(null);
          setTeamWorkspaces([]);
        }

        if (reportRes.status === "fulfilled") {
          const generatedAtUtc =
            typeof reportRes.value?.generatedAtUtc === "string"
              ? reportRes.value.generatedAtUtc
              : null;
          setReportAvailable(Boolean(reportRes.value?.url && generatedAtUtc));
          if (generatedAtUtc) setReportGeneratedAtUtc(generatedAtUtc);
        } else {
          setReportAvailable(false);
        }

        if (casesRes.status === "fulfilled") {
          const items = Array.isArray(casesRes.value?.items)
            ? (casesRes.value.items as CaseOption[])
            : [];
          setOwnedCases(items);
        } else {
          setOwnedCases([]);
        }

        if (partsRes.status === "fulfilled") {
          const data = partsRes.value as PartsResponse;
          const items = Array.isArray(data?.parts) ? data.parts : [];
          items.sort((a, b) => a.partIndex - b.partIndex);
          setParts(items);
        } else {
          setParts([]);
        }

        if (verificationPackageRes.status === "fulfilled") {
          const generatedAtUtc =
            typeof verificationPackageRes.value?.generatedAtUtc === "string"
              ? verificationPackageRes.value.generatedAtUtc
              : null;
          setVerificationPackageAvailable(
            Boolean(verificationPackageRes.value?.url && generatedAtUtc)
          );
          if (generatedAtUtc) setVerificationPackageGeneratedAtUtc(generatedAtUtc);
        } else {
          setVerificationPackageAvailable(false);
        }

        if (originalRes.status === "fulfilled") {
          const original = originalRes.value as OriginalResponse;
          setOriginalPreviewUrl(original?.publicUrl ?? original?.url ?? null);
          setOriginalDownloadUrl(original?.url ?? original?.publicUrl ?? null);
          setOriginalMimeType(original?.mimeType ?? null);
          setOriginalSizeBytes(original?.sizeBytes ?? null);
          setOriginalFileName(original?.originalFileName ?? null);
        } else {
          setOriginalPreviewUrl(null);
          setOriginalDownloadUrl(null);
          setOriginalMimeType(null);
          setOriginalSizeBytes(null);
          setOriginalFileName(null);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load evidence";
        setError(message);
        captureException(err, {
          feature: "web_evidence_detail_load",
          evidenceId: params.id,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [params?.id]);

  const refreshEvidence = async () => {
    if (!params?.id) return;

    try {
      const [
        evidenceData,
        billingData,
        reportData,
        originalData,
        partsData,
        verificationData,
      ] = await Promise.allSettled([
        apiFetch(`/v1/evidence/${params.id}`),
        apiFetch("/v1/billing/overview"),
        apiFetch(`/v1/evidence/${params.id}/report/latest`),
        apiFetch(`/v1/evidence/${params.id}/original`),
        apiFetch(`/v1/evidence/${params.id}/parts`),
        apiFetch(`/v1/evidence/${params.id}/verification-package`),
      ]);

      if (evidenceData.status === "fulfilled") {
        const data = evidenceData.value as EvidenceResponse;
        const ev = data?.evidence ?? {};
        setStatus(ev.status ?? "CREATED");
        setCreatedAt(ev.createdAt ?? null);
        setLockedAt(ev.lockedAt ?? null);
        setArchivedAt(ev.archivedAt ?? null);
        setDeletedAt(ev.deletedAt ?? null);
        setDeleteScheduledForUtc(ev.deleteScheduledForUtc ?? null);
        setCaseId(ev.caseId ?? null);
        setTeamId(ev.teamId ?? null);
        setWorkspaceNameFromEvidence(ev.workspaceName ?? null);
        setEvidenceType(ev.type ?? null);
        setReportGeneratedAtUtc(ev.reportGeneratedAtUtc ?? null);
        setVerificationPackageGeneratedAtUtc(
          ev.verificationPackageGeneratedAtUtc ?? null
        );
        setCapturedAtUtc(ev.capturedAtUtc ?? null);
        setDeviceTimeIso(ev.deviceTimeIso ?? null);
        setCaptureLat(typeof ev.lat === "number" ? ev.lat : null);
        setCaptureLng(typeof ev.lng === "number" ? ev.lng : null);
        setCaptureAccuracyMeters(
          typeof ev.accuracyMeters === "number" ? ev.accuracyMeters : null
        );
        setInternalNotes(ev.internalNotes ?? null);
        setIntakePlanJson(ev.intakePlanJson ?? null);
        setLabel(resolveDisplayTitle(ev));
        setLabelDraft(resolveDisplayTitle(ev));
        setDisplaySubtitle(resolveDisplaySubtitle(ev));
        setItemCount(typeof ev.itemCount === "number" && ev.itemCount > 0 ? ev.itemCount : 1);
      }

      if (billingData.status === "fulfilled") {
        const overview = (billingData.value ?? null) as BillingOverviewResponse | null;
        setBillingOverview(overview);
        setPersonalWorkspace(overview?.workspaces?.personal ?? null);
        setTeamWorkspaces(
          Array.isArray(overview?.workspaces?.teams) ? overview.workspaces.teams : []
        );
      }

      if (reportData.status === "fulfilled") {
        const generatedAtUtc =
          typeof reportData.value?.generatedAtUtc === "string"
            ? reportData.value.generatedAtUtc
            : null;
        setReportAvailable(Boolean(reportData.value?.url && generatedAtUtc));
        if (generatedAtUtc) setReportGeneratedAtUtc(generatedAtUtc);
      } else {
        setReportAvailable(false);
      }

      if (originalData.status === "fulfilled") {
        const original = originalData.value as OriginalResponse;
        setOriginalPreviewUrl(original?.publicUrl ?? original?.url ?? null);
        setOriginalDownloadUrl(original?.url ?? original?.publicUrl ?? null);
        setOriginalMimeType(original?.mimeType ?? null);
        setOriginalSizeBytes(original?.sizeBytes ?? null);
        setOriginalFileName(original?.originalFileName ?? null);
      } else {
        setOriginalPreviewUrl(null);
        setOriginalDownloadUrl(null);
        setOriginalMimeType(null);
        setOriginalSizeBytes(null);
        setOriginalFileName(null);
      }

      if (partsData.status === "fulfilled") {
        const data = partsData.value as PartsResponse;
        const items = Array.isArray(data?.parts) ? data.parts : [];
        items.sort((a, b) => a.partIndex - b.partIndex);
        setParts(items);
      } else {
        setParts([]);
      }

      if (verificationData.status === "fulfilled") {
        const generatedAtUtc =
          typeof verificationData.value?.generatedAtUtc === "string"
            ? verificationData.value.generatedAtUtc
            : null;
        setVerificationPackageAvailable(
          Boolean(verificationData.value?.url && generatedAtUtc)
        );
        if (generatedAtUtc) setVerificationPackageGeneratedAtUtc(generatedAtUtc);
      } else {
        setVerificationPackageAvailable(false);
      }
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_refresh",
        evidenceId: params.id,
      });
    }
  };

  const handleStartEditLabel = () => {
    setLabelDraft(label);
    setIsEditingLabel(true);
  };

  const handleCancelEditLabel = () => {
    setLabelDraft(label);
    setIsEditingLabel(false);
  };

  const handleSaveLabel = async () => {
    if (!params?.id) return;

    const nextLabel = labelDraft.trim();
    if (!nextLabel) {
      addToast("Label cannot be empty", "error");
      return;
    }

    setLabelBusy(true);
    try {
      const data = await apiFetch(`/v1/evidence/${params.id}/label`, {
        method: "PATCH",
        body: JSON.stringify({ label: nextLabel }),
      });

      const ev = data?.evidence ?? {};
      const nextResolvedLabel = data?.displayLabel || resolveDisplayTitle(ev);
      const nextResolvedSubtitle = data?.displaySubtitle || resolveDisplaySubtitle(ev);

      setLabel(nextResolvedLabel);
      setLabelDraft(nextResolvedLabel);
      setDisplaySubtitle(nextResolvedSubtitle);
      setItemCount(typeof data?.itemCount === "number" && data.itemCount > 0 ? data.itemCount : itemCount);
      setIsEditingLabel(false);
      addToast("Evidence label updated", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_update_label",
        evidenceId: params.id,
      });
      const message = err instanceof Error ? err.message : "Failed to update label";
      addToast(message, "error");
    } finally {
      setLabelBusy(false);
    }
  };

  const handleLock = () => setLockModalOpen(true);
  const handleArchive = () => setArchiveModalOpen(true);
  const handleDelete = () => setDeleteModalOpen(true);

  const handleOpenShareModal = () => {
    if (!canShareEvidence) return;
    setShareModalOpen(true);
  };

  const handleCopyVerificationLink = async () => {
    if (!params?.id) return;
    if (!canUsePublicVerification) {
      addToast("Public verification is not enabled for this workspace", "info");
      return;
    }

    try {
      setShareActionBusy(true);
      const verificationUrl = getVerificationUrl(params.id);
      await navigator.clipboard.writeText(verificationUrl);
      addToast("Verification link copied", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_copy_verification_link",
        evidenceId: params.id,
      });
      addToast("Failed to copy verification link", "error");
    } finally {
      setShareActionBusy(false);
    }
  };

  const handleConfirmLock = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Permanently sealing evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/lock`, {
        method: "POST",
        body: JSON.stringify({ locked: true }),
      });
      setLockedAt(data.evidence?.lockedAt ?? new Date().toISOString());
      addToast("Evidence permanently locked", "success");
      setLockModalOpen(false);
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_lock",
        evidenceId: params.id,
      });
      const message = err instanceof Error ? err.message : "Failed to lock evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirmArchive = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Archiving evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/archive`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setArchivedAt(data.evidence?.archivedAt ?? new Date().toISOString());
      addToast("Evidence archived", "success");
      setArchiveModalOpen(false);
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_archive",
        evidenceId: params.id,
      });
      const message = err instanceof Error ? err.message : "Failed to archive evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleUnarchive = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Restoring evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/unarchive`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setArchivedAt(data.evidence?.archivedAt ?? null);
      addToast("Evidence restored", "success");
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_unarchive",
        evidenceId: params.id,
      });
      const message = err instanceof Error ? err.message : "Failed to restore evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Deleting evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}`, {
        method: "DELETE",
      });

      setDeletedAt(data?.evidence?.deletedAt ?? new Date().toISOString());
      setDeleteScheduledForUtc(data?.evidence?.deleteScheduledForUtc ?? null);
      setDeleteModalOpen(false);

      addToast("Evidence deleted", "success");
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_delete",
        evidenceId: params.id,
      });
      const message = err instanceof Error ? err.message : "Failed to delete evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleRestoreDeleted = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Restoring evidence from trash...", "info");
      await apiFetch(`/v1/evidence/${params.id}/restore`, {
        method: "POST",
        body: JSON.stringify({ restore: true }),
      });

      setDeletedAt(null);
      setDeleteScheduledForUtc(null);

      addToast("Evidence restored from trash", "success");
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_restore_deleted",
        evidenceId: params.id,
      });
      const message = err instanceof Error ? err.message : "Failed to restore evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadReport = async () => {
    if (!params?.id) return;

    if (!canAccessReports) {
      addToast(
        `${activeWorkspaceName} does not include PDF reports on the current plan`,
        "info"
      );
      return;
    }

    try {
      addToast("Preparing report...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/report/latest`);
      const nextUrl = data?.url ?? null;

      if (!nextUrl || typeof data?.generatedAtUtc !== "string") {
        setReportAvailable(false);
        addToast("Report not available", "info");
        return;
      }

      setReportAvailable(true);
      setReportGeneratedAtUtc(data.generatedAtUtc);
      window.open(nextUrl, "_blank", "noopener,noreferrer");
      addToast("Report downloaded", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_download_report",
        evidenceId: params.id,
      });
      addToast("Failed to download report", "error");
    }
  };

  const handleDownloadVerificationPackage = async () => {
    if (!params?.id) return;

    if (!canAccessVerificationPackage) {
      addToast(
        `${activeWorkspaceName} does not include verification packages on the current plan`,
        "info"
      );
      return;
    }

    try {
      addToast("Preparing verification package...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/verification-package`);

      if (!data?.url || typeof data?.generatedAtUtc !== "string") {
        setVerificationPackageAvailable(false);
        addToast("Verification package not available", "info");
        return;
      }

      setVerificationPackageAvailable(true);
      setVerificationPackageGeneratedAtUtc(data.generatedAtUtc);
      const ok = await tryDownloadFile(data.url, `verification-package-${params.id}.zip`);

      if (!ok) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      }

      addToast("Verification package downloaded", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_verification_package_download",
        evidenceId: params.id,
      });
      addToast("Failed to download verification package", "error");
    }
  };

  const handleOpenOriginal = async () => {
    if (!params?.id) return;

    try {
      if (!originalDownloadUrl) {
        const data = await apiFetch(`/v1/evidence/${params.id}/original`);
        const nextUrl = data?.url ?? data?.publicUrl ?? null;
        setOriginalPreviewUrl(data?.publicUrl ?? data?.url ?? null);
        setOriginalDownloadUrl(nextUrl);
        setOriginalMimeType(data?.mimeType ?? null);
        setOriginalSizeBytes(data?.sizeBytes ?? null);
        setOriginalFileName(data?.originalFileName ?? null);

        if (!nextUrl) {
          addToast("Original file not available", "info");
          return;
        }

        window.open(nextUrl, "_blank", "noopener,noreferrer");
        return;
      }

      window.open(originalDownloadUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_open_original",
        evidenceId: params.id,
      });
      addToast("Failed to open original", "error");
    }
  };

  const handleDownloadOriginal = async () => {
    if (!params?.id) return;

    try {
      let downloadUrl = originalDownloadUrl;
      let filename =
        sanitizePossibleFileName(originalFileName) ||
        buildGeneratedCaptureFileName({
          mimeType: originalMimeType,
          recordedAt: createdAt,
          isMultipart: false,
        });

      if (!downloadUrl) {
        const data = await apiFetch(`/v1/evidence/${params.id}/original`);
        downloadUrl = data?.url ?? data?.publicUrl ?? null;

        setOriginalPreviewUrl(data?.publicUrl ?? data?.url ?? null);
        setOriginalDownloadUrl(downloadUrl);
        setOriginalMimeType(data?.mimeType ?? null);
        setOriginalSizeBytes(data?.sizeBytes ?? null);
        setOriginalFileName(data?.originalFileName ?? null);

        if (data?.originalFileName) {
          filename = sanitizePossibleFileName(data.originalFileName) ?? filename;
        }
      }

      if (!downloadUrl) {
        addToast("Original file not available", "info");
        return;
      }

      const ok = await tryDownloadFile(downloadUrl, filename);

      if (!ok) {
        window.open(downloadUrl, "_blank", "noopener,noreferrer");
      }

      addToast("Original downloaded", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_download_original",
        evidenceId: params.id,
      });
      addToast("Failed to download original", "error");
    }
  };

  const handleOpenPart = (part: EvidencePart) => {
    const url = part.url ?? part.publicUrl ?? null;
    if (!url) {
      addToast("This item is not available right now", "info");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleDownloadPart = async (part: EvidencePart) => {
    const url = part.url ?? part.publicUrl ?? null;
    if (!url) {
      addToast("This item is not available right now", "info");
      return;
    }

    try {
      const ok = await tryDownloadFile(
        url,
        getPartDisplayName(part, createdAt, isMultipart)
      );
      if (!ok) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      addToast("Item downloaded", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_download_part",
        evidenceId: params.id,
        partId: part.id,
      });
      addToast("Failed to download this item", "error");
    }
  };

  const handleOpenAssignCase = () => {
    if (ownedCases.length === 0) {
      addToast("You do not have any accessible cases yet", "info");
      return;
    }

    setSelectedCaseId(caseId ?? "");
    setAssignCaseModalOpen(true);
  };

  const handleConfirmAssignCase = async () => {
    if (!params?.id || !selectedCaseId) return;

    setActionBusy(true);
    try {
      addToast("Adding evidence to case...", "info");

      await apiFetch(`/v1/cases/${selectedCaseId}/evidence`, {
        method: "POST",
        body: JSON.stringify({ evidenceId: params.id }),
      });

      setCaseId(selectedCaseId);
      setAssignCaseModalOpen(false);
      addToast("Evidence added to case", "success");
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_add_to_case",
        evidenceId: params.id,
        targetCaseId: selectedCaseId,
      });
      const message = err instanceof Error ? err.message : "Failed to add evidence to case";
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemoveFromCase = async () => {
    if (!params?.id || !caseId) return;

    setActionBusy(true);
    try {
      addToast("Removing evidence from case...", "info");

      await apiFetch(`/v1/cases/${caseId}/evidence/${params.id}`, {
        method: "DELETE",
      });

      setCaseId(null);
      addToast("Evidence removed from case", "success");
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_remove_from_case",
        evidenceId: params.id,
        caseId,
      });
      const message =
        err instanceof Error
          ? err.message
          : "Failed to remove evidence from case";
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const landingPrimaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.22)",
        color: "#eef3f1",
        background:
          "linear-gradient(180deg, rgba(58,92,95,0.96) 0%, rgba(20,38,42,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(18,40,44,0.22)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const landingSecondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.12)",
        color: "#24373b",
        background:
          "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
        boxShadow:
          "0 10px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.70)",
        textShadow: "0 1px 0 rgba(255,255,255,0.30)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const landingTertiaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.16)",
        color: "#7a624d",
        background:
          "linear-gradient(180deg, rgba(244,238,232,0.88) 0%, rgba(255,255,255,0.64) 100%)",
        boxShadow:
          "0 10px 20px rgba(92,69,50,0.05), inset 0 1px 0 rgba(255,255,255,0.72)",
        textShadow: "0 1px 0 rgba(255,255,255,0.32)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const landingDangerButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.20)",
        color: "#fff7f1",
        background:
          "linear-gradient(180deg, rgba(142,102,72,0.96) 0%, rgba(102,68,45,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 28px rgba(90,58,36,0.18)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const landingDeleteButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(194,78,78,0.20)",
        color: "#fff3f3",
        background:
          "linear-gradient(180deg, rgba(164,84,84,0.94) 0%, rgba(130,62,62,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 28px rgba(90,18,18,0.14)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const canAssignToCase = ownedCases.length > 0 && !isDeleted;
  const reportCapabilityHint = canAccessReports
    ? reportAvailable && reportGeneratedAtUtc
      ? `PDF reports are enabled for this workspace. Latest report generated at ${formatUtcDateTime(
          reportGeneratedAtUtc
        )}.`
      : "PDF reports are enabled, but no downloadable report artifact is available yet."
    : `${activeWorkspaceName} does not include PDF reports on the current plan.`;

  const packageCapabilityHint = canAccessVerificationPackage
    ? verificationPackageAvailable && verificationPackageGeneratedAtUtc
      ? `Verification packages are enabled. Latest package generated at ${formatUtcDateTime(
          verificationPackageGeneratedAtUtc
        )}.`
      : "Verification packages are enabled, but no downloadable package artifact is available yet."
    : `${activeWorkspaceName} does not include verification packages on the current plan.`;

  const originalRenderableUrl = useMemo(() => {
    if (originalKind === "video" || originalKind === "audio") {
      return originalDownloadUrl ?? originalPreviewUrl ?? null;
    }
    return originalPreviewUrl ?? originalDownloadUrl ?? null;
  }, [originalKind, originalDownloadUrl, originalPreviewUrl]);

  const hasCaptureLocation = useMemo(
    () =>
      hasCaptureLocationMetadata({
        lat: captureLat,
        lng: captureLng,
      }),
    [captureLat, captureLng]
  );

  const captureLocationCapturedAtLabel = useMemo(
    () => formatUtcDateTime(capturedAtUtc ?? deviceTimeIso ?? createdAt),
    [capturedAtUtc, createdAt, deviceTimeIso]
  );

  const intakePlanSummary = useMemo(() => {
    if (!intakePlanJson || typeof intakePlanJson !== "object") return null;
    const name =
      typeof intakePlanJson.templateName === "string"
        ? intakePlanJson.templateName
        : typeof intakePlanJson.templateId === "string"
          ? intakePlanJson.templateId
          : null;
    const mode =
      intakePlanJson.mode === "CHECKLIST_REQUIRED"
        ? "Checklist required"
        : intakePlanJson.mode === "FLEXIBLE"
          ? "Flexible intake"
          : "Flexible intake";

    if (!name) return mode;
    return `${name} • ${mode}`;
  }, [intakePlanJson]);

  const statusToneClass =
    displayStatusMeta.tone === "reportReady" || displayStatusMeta.tone === "signed"
      ? "success"
      : displayStatusMeta.tone === "processing"
        ? "warning"
        : "neutral";

  type ReviewRow = {
    label: string;
    value: string;
    ok: boolean;
  };

  const reviewReadinessRows: ReviewRow[] = [
    { label: "PDF report", value: reportAvailable ? "Available" : "Not available", ok: reportAvailable },
    { label: "Verification package", value: verificationPackageAvailable ? "Available" : "Not available", ok: verificationPackageAvailable },
    { label: "Public verification", value: canUsePublicVerification ? "Enabled" : "Not enabled", ok: canUsePublicVerification },
    { label: "Case context", value: caseId ? "Attached" : "Not assigned", ok: Boolean(caseId) },
    { label: "Capture location", value: hasCaptureLocation ? "Recorded" : "Not recorded", ok: hasCaptureLocation },
    { label: "Record lock", value: isLocked ? "Locked" : "Not locked", ok: isLocked },
  ];

  const integrityRows: ReviewRow[] = [
    { label: "Record state", value: displayStatusMeta.label, ok: status === "SIGNED" || status === "REPORTED" },
    { label: "SHA-256 fingerprint", value: sortedParts.some((part) => Boolean(part.sha256)) ? "Recorded" : "Not exposed", ok: sortedParts.some((part) => Boolean(part.sha256)) },
    { label: "Report artifact", value: reportAvailable ? "Ready" : "Unavailable", ok: reportAvailable },
    { label: "Verification package", value: verificationPackageAvailable ? "Ready" : "Unavailable", ok: verificationPackageAvailable },
    { label: "Retention state", value: isDeleted ? "Secure trash" : isLocked ? "Locked" : isArchived ? "Archived" : "Active", ok: !isDeleted },
  ];

  const reviewerAlerts: ReviewRow[] = [
    { label: "Case assignment", value: caseId ? "Evidence is linked to a case." : "Missing case assignment.", ok: Boolean(caseId) },
    { label: "Permanent lock", value: isLocked ? "Record is permanently locked." : "Record is not permanently locked.", ok: isLocked },
    { label: "Public verification", value: canUsePublicVerification ? "Public verification is enabled." : "Public verification is not enabled.", ok: canUsePublicVerification },
    { label: "Capture context", value: hasCaptureLocation ? "Capture location metadata recorded." : "No capture location metadata recorded.", ok: hasCaptureLocation },
    { label: "Package structure", value: isMultipart ? "Multipart evidence package." : "Single-file evidence record.", ok: true },
  ];

  return (
    <div className="evidence-enterprise-page">
      <div className="evidence-enterprise-shell">
        {error ? <div className="evidence-error">{error}</div> : null}

        <section className="evidence-card evidence-hero-card">
          <div className="evidence-hero-left">
            <p className="evidence-hero-kicker">Evidence Record</p>

            {!isEditingLabel ? (
              <>
                <h1 className="evidence-title">{label}</h1>
                <p className="evidence-subtitle">{effectiveHeroSubtitle}</p>
              </>
            ) : (
              <div className="evidence-label-edit-row">
                <input
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  maxLength={160}
                  disabled={labelBusy}
                  className="evidence-label-input"
                />
                <Button onClick={handleSaveLabel} disabled={labelBusy} className="evidence-btn evidence-btn-primary">
                  {labelBusy ? "Saving..." : "Save"}
                </Button>
                <Button variant="secondary" onClick={handleCancelEditLabel} disabled={labelBusy} className="evidence-btn evidence-btn-secondary">
                  Cancel
                </Button>
              </div>
            )}

            <div className="evidence-hero-meta">
              <span className={`evidence-pill ${statusToneClass}`}>{displayStatusMeta.label}</span>
              <span className="evidence-pill teal">{recordTypeLabel}</span>
              <span className="evidence-pill neutral">{isMultipart ? `${sortedParts.length || itemCount} items` : "Single file"}</span>
              <span className="evidence-pill neutral">Recorded: {formatUtcDateTime(createdAt)}</span>
              <span className="evidence-pill neutral">{activeWorkspaceName} · {activePlan}</span>
              {isLocked ? <span className="evidence-pill success">Locked</span> : null}
              {isDeleted ? <span className="evidence-pill danger">In Trash</span> : null}
            </div>

            <div className="evidence-hero-meta evidence-hero-meta-secondary">
              <span>Record ID: {shortId(evidenceId)}</span>
              <span>{activeWorkspaceType === "TEAM" ? "Team Workspace" : "Personal Workspace"}</span>
              <span>{compositionSummary}</span>
            </div>
          </div>

          <div className="evidence-hero-actions">
            <Button onClick={handleDownloadReport} disabled={actionBusy || !canAccessReports || !reportAvailable || isDeleted} className="evidence-btn evidence-btn-primary">
              {t("downloadReport")}
            </Button>

            <Button variant="secondary" onClick={handleDownloadVerificationPackage} disabled={actionBusy || !canAccessVerificationPackage || !verificationPackageAvailable || isDeleted} className="evidence-btn evidence-btn-secondary">
              Verification Package
            </Button>

            <Button variant="secondary" onClick={handleOpenShareModal} disabled={!canShareEvidence} className="evidence-btn evidence-btn-secondary">
              Share
            </Button>

            <Button onClick={handleLock} disabled={actionBusy || !canLockEvidence} className={isLocked ? "evidence-btn evidence-btn-secondary" : "evidence-btn evidence-btn-danger"}>
              {isLocked ? "Locked" : "Lock"}
            </Button>

            <Button variant="secondary" onClick={handleStartEditLabel} disabled={loading || actionBusy || labelBusy || isDeleted} className="evidence-btn evidence-btn-quiet">
              Edit Label
            </Button>
          </div>

          {isDeleted ? (
            <div className="evidence-alert danger evidence-hero-alert">
              <strong>Secure trash retention active.</strong> Recoverable until{" "}
              <strong>{formatUtcDateTime(deleteScheduledForUtc)}</strong>.
            </div>
          ) : null}
        </section>

        <div className="evidence-review-layout">
          <main className="evidence-review-main">
            <section className="evidence-card evidence-preview-card">
              <div className="evidence-preview-header">
                <div>
                  <p className="evidence-section-label">Main Review Workspace</p>
                  <h2 className="evidence-section-title">
                    {isMultipart ? "Evidence Items" : "Original Evidence"}
                  </h2>
                  <p className="evidence-section-muted">
                    Reviewer-facing evidence material with compact previews, core metadata, and item actions.
                  </p>
                </div>

                {!isMultipart ? (
                  <div className="evidence-preview-actions">
                    <Button variant="secondary" onClick={handleOpenOriginal} disabled={!originalDownloadUrl || isDeleted} className="evidence-mini-btn">
                      Open Original
                    </Button>
                    <Button variant="secondary" onClick={handleDownloadOriginal} disabled={!originalDownloadUrl || isDeleted} className="evidence-mini-btn">
                      Download
                    </Button>
                  </div>
                ) : null}
              </div>

              {!isMultipart ? (
                <>
                  <div className="evidence-original-summary">
                    <span>{effectiveOriginalSummaryName}</span>
                    {originalMimeType ? <span>{originalMimeType}</span> : null}
                    {originalSizeBytes ? <span>{formatBytes(originalSizeBytes)}</span> : null}
                  </div>

                  <div className="evidence-media-frame">
                    {originalRenderableUrl && originalKind === "image" ? <img src={originalRenderableUrl} alt={effectiveOriginalSummaryName} /> : null}

                    {originalRenderableUrl && originalKind === "video" ? (
                      <video controls playsInline preload="metadata">
                        <source src={originalRenderableUrl} type={originalMimeType ?? "video/mp4"} />
                        Your browser could not play this video.
                      </video>
                    ) : null}

                    {originalRenderableUrl && originalKind === "audio" ? (
                      <div className="evidence-audio-frame">
                        <audio controls preload="metadata">
                          <source src={originalRenderableUrl} type={originalMimeType ?? "audio/mpeg"} />
                          Your browser could not play this audio.
                        </audio>
                      </div>
                    ) : null}

                    {originalRenderableUrl && originalKind === "pdf" ? <iframe src={originalRenderableUrl} title="Original PDF evidence" /> : null}
                    {!originalRenderableUrl ? <div className="evidence-empty-preview">Preview is not available.</div> : null}
                  </div>
                </>
              ) : (
                <div className="evidence-items-grid">
                  {sortedParts.map((part) => {
                    const kind = getEvidenceKind(part.mimeType ?? null);
                    const previewUrl =
                      kind === "video" || kind === "audio"
                        ? part.url ?? part.publicUrl ?? part.previewUrl ?? null
                        : part.previewUrl ?? part.publicUrl ?? part.url ?? null;
                    const downloadUrl = part.url ?? part.publicUrl ?? null;
                    const displayName = getPartDisplayName(part, createdAt, true);
                    const hasTechnicalMetadata =
                      Boolean(part.sha256) ||
                      Boolean(part.durationMs) ||
                      Boolean(part.privateRole) ||
                      Boolean(part.sourceLabel) ||
                      Boolean(part.checklistStepId) ||
                      Boolean(part.privateNote);

                    return (
                      <article key={part.id} className={`evidence-item-card evidence-item-${kind}`}>
                        <div className="evidence-item-preview">
                          {previewUrl && kind === "image" ? <img src={previewUrl} alt={displayName} /> : null}

                          {previewUrl && kind === "video" ? (
                            <video controls playsInline preload="metadata">
                              <source src={previewUrl} type={part.mimeType ?? "video/mp4"} />
                              Your browser could not play this video.
                            </video>
                          ) : null}

                          {previewUrl && kind === "audio" ? (
                            <audio controls preload="metadata">
                              <source src={previewUrl} type={part.mimeType ?? "audio/mpeg"} />
                              Your browser could not play this audio.
                            </audio>
                          ) : null}

                          {previewUrl && kind === "pdf" ? <iframe src={previewUrl} title={displayName} /> : null}
                          {!previewUrl ? <div className="evidence-empty-preview">Preview not available.</div> : null}
                        </div>

                        <div className="evidence-item-body">
                          <div className="evidence-item-top">
                            <div className="evidence-item-title-wrap">
                              <small>Item {part.partIndex + 1}{part.isPrimary ? " · Primary" : ""}</small>
                              <strong title={displayName}>{displayName}</strong>
                            </div>

                            <span className="evidence-type-badge">{kind === "pdf" ? "document" : kind}</span>
                          </div>

                          <div className="evidence-item-compact">
                            <span>{part.mimeType ?? "Unknown type"}</span>
                            <span>{formatBytes(part.sizeBytes ?? null)}</span>
                          </div>

                          <div className="evidence-item-actions">
                            <Button variant="secondary" onClick={() => handleOpenPart(part)} disabled={!downloadUrl || isDeleted} className="evidence-mini-btn">
                              Open
                            </Button>
                            <Button variant="secondary" onClick={() => handleDownloadPart(part)} disabled={!downloadUrl || isDeleted} className="evidence-mini-btn">
                              Download
                            </Button>
                          </div>

                          {hasTechnicalMetadata ? (
                            <details className="evidence-technical-details">
                              <summary>View technical metadata</summary>
                              <div className="evidence-item-meta">
                                <div>Type: {part.mimeType ?? "Unknown"}</div>
                                <div>Kind: {kind === "pdf" ? "document" : kind}</div>
                                <div>Size: {formatBytes(part.sizeBytes ?? null)}</div>
                                {part.durationMs && part.durationMs > 0 ? <div>Duration: {(part.durationMs / 1000).toFixed(1)} sec</div> : null}
                                {part.sha256 ? <div>SHA-256: {shortId(part.sha256)}</div> : null}
                                {part.privateRole ? <div>Role: {part.privateRole}</div> : null}
                                {part.sourceLabel ? <div>Source: {part.sourceLabel}</div> : null}
                                {part.checklistStepId ? <div>Checklist step: {part.checklistStepId}</div> : null}
                                {part.privateNote ? <div>Note: {part.privateNote}</div> : null}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="evidence-card evidence-technical-card">
              <div className="evidence-card-inner">
                <p className="evidence-section-label">Technical / Context Area</p>
                <h2 className="evidence-section-title">Record Metadata & Lifecycle</h2>

                <div className="evidence-summary-list evidence-summary-compact">
                  <div className="evidence-kv full"><span>User label</span><strong>{label}</strong></div>
                  <div className="evidence-kv full"><span>Original submitted file</span><strong>{effectiveOriginalSummaryName}</strong></div>
                  <div className="evidence-kv full"><span>Record ID</span><strong>{evidenceId}</strong></div>
                  <div className="evidence-kv"><span>Evidence type</span><strong>{recordTypeLabel}</strong></div>
                  <div className="evidence-kv"><span>Structure</span><strong>{isMultipart ? `Multipart (${sortedParts.length || itemCount})` : "Single-file"}</strong></div>
                  <div className="evidence-kv"><span>Composition</span><strong>{compositionSummary}</strong></div>
                  <div className="evidence-kv"><span>Workspace</span><strong>{activeWorkspaceName}</strong></div>
                  <div className="evidence-kv"><span>Active plan</span><strong>{activePlan}</strong></div>
                  <div className="evidence-kv"><span>Case assignment</span><strong>{caseId ? "Attached" : "Not assigned"}</strong></div>
                  <div className="evidence-kv"><span>Storage</span><strong>{workspaceSnapshot.storageUsedLabel ?? "—"} used · {workspaceSnapshot.storageRemainingLabel ?? "—"} left</strong></div>
                  {intakePlanSummary ? <div className="evidence-kv full"><span>Intake plan</span><strong>{intakePlanSummary}</strong></div> : null}
                  <div className="evidence-kv"><span>Recorded at</span><strong>{formatUtcDateTime(createdAt)}</strong></div>
                  <div className="evidence-kv"><span>Locked at</span><strong>{formatUtcDateTime(lockedAt)}</strong></div>
                  <div className="evidence-kv"><span>Archived at</span><strong>{formatUtcDateTime(archivedAt)}</strong></div>
                  <div className="evidence-kv"><span>Deleted at</span><strong>{formatUtcDateTime(deletedAt)}</strong></div>
                </div>
              </div>
            </section>

            {hasCaptureLocation ? (
              <section className="evidence-card evidence-technical-card">
                <div className="evidence-card-inner">
                  <p className="evidence-section-label">Capture Context</p>
                  <h2 className="evidence-section-title">Location Metadata</h2>
                  <p className="evidence-section-muted">{CAPTURE_LOCATION_CONTEXT_DESCRIPTION}</p>

                  <div className="evidence-location-grid">
                    <div className="evidence-map-frame">
                      {captureLat !== null && captureLng !== null ? (
                        <CaptureLocationMapPanel
                          lat={captureLat}
                          lng={captureLng}
                          accuracyMeters={captureAccuracyMeters}
                          addToast={addToast}
                          height={300}
                        />
                      ) : null}
                    </div>

                    <div className="evidence-location-facts">
                      {[
                        [CAPTURE_LOCATION_STATUS_LABEL, "Yes"],
                        ["Latitude", formatCaptureLocationCoordinate(captureLat)],
                        ["Longitude", formatCaptureLocationCoordinate(captureLng)],
                        ["Accuracy radius", formatCaptureLocationAccuracy(captureAccuracyMeters)],
                        ["Captured at", captureLocationCapturedAtLabel],
                        ["Source", CAPTURE_LOCATION_SOURCE_LABEL],
                      ].map(([labelText, valueText]) => (
                        <div key={labelText} className="evidence-kv">
                          <span>{labelText}</span>
                          <strong>{valueText}</strong>
                        </div>
                      ))}

                      <div className="evidence-alert legal">
                        {CAPTURE_LOCATION_LEGAL_BOUNDARY ?? CAPTURE_LOCATION_SHORT_BOUNDARY}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {internalNotes?.trim() ? (
              <section className="evidence-card evidence-technical-card">
                <div className="evidence-card-inner">
                  <p className="evidence-section-label">Internal Notes</p>
                  <h2 className="evidence-section-title">Authenticated Workspace Note</h2>
                  <div className="evidence-note-box">{internalNotes.trim()}</div>
                </div>
              </section>
            ) : null}
          </main>

          <aside className="evidence-review-sidebar">
            <section className="evidence-card evidence-sticky-panel">
              <div className="evidence-card-inner">
                <p className="evidence-section-label">Legal Review Assistant</p>
                <h2 className="evidence-section-title">Review Readiness</h2>

                <div className="evidence-readiness-list">
                  {reviewReadinessRows.map((row) => (
                    <div key={row.label} className="evidence-check-row">
                      <div className={`evidence-check-dot ${row.ok ? "ok" : "warn"}`}>{row.ok ? "✓" : "!"}</div>
                      <strong>{row.label}</strong>
                      <span>{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="evidence-card">
              <div className="evidence-card-inner">
                <h2 className="evidence-section-title">Integrity State</h2>
                <div className="evidence-integrity-list">
                  {integrityRows.map((row) => (
                    <div key={row.label} className="evidence-check-row">
                      <div className={`evidence-check-dot ${row.ok ? "ok" : "warn"}`}>{row.ok ? "✓" : "!"}</div>
                      <strong>{row.label}</strong>
                      <span>{row.value}</span>
                    </div>
                  ))}
                </div>

                <div className="evidence-alert legal">
                  PROOVRA preserves and verifies recorded evidence integrity state. It does not independently determine factual truth, authorship, or legal admissibility.
                </div>
              </div>
            </section>

            <section className="evidence-card">
              <div className="evidence-card-inner">
                <h2 className="evidence-section-title">Reviewer Alerts</h2>
                <div className="evidence-integrity-list">
                  {reviewerAlerts.map((row) => (
                    <div key={row.label} className="evidence-check-row">
                      <div className={`evidence-check-dot ${row.ok ? "ok" : "warn"}`}>{row.ok ? "✓" : "!"}</div>
                      <strong>{row.label}</strong>
                      <span>{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="evidence-card">
              <div className="evidence-card-inner">
                <h2 className="evidence-section-title">Sharing & Export</h2>
                <div className="evidence-action-stack">
                  <Button onClick={handleDownloadReport} disabled={actionBusy || !canAccessReports || !reportAvailable || isDeleted} className="evidence-btn evidence-btn-primary">
                    {t("downloadReport")}
                  </Button>
                  <Button variant="secondary" onClick={handleDownloadVerificationPackage} disabled={actionBusy || !canAccessVerificationPackage || !verificationPackageAvailable || isDeleted} className="evidence-btn evidence-btn-secondary">
                    Download Verification Package
                  </Button>
                  <Button variant="secondary" onClick={handleOpenShareModal} disabled={!canShareEvidence} className="evidence-btn evidence-btn-bronze">
                    Share Evidence
                  </Button>
                </div>
                <div className="evidence-alert info">{reportCapabilityHint}</div>
                <div className="evidence-alert info">{packageCapabilityHint}</div>
              </div>
            </section>

            <section className="evidence-card">
              <div className="evidence-card-inner">
                <h2 className="evidence-section-title">Preservation Actions</h2>
                <div className="evidence-action-stack">
                  <Button variant="secondary" onClick={handleOpenAssignCase} disabled={actionBusy || !canAssignToCase} className="evidence-btn evidence-btn-secondary">
                    {caseId ? "Move to Case" : "Add to Case"}
                  </Button>

                  {caseId ? (
                    <Button variant="secondary" onClick={handleRemoveFromCase} disabled={actionBusy || isDeleted} className="evidence-btn evidence-btn-bronze">
                      Remove from Case
                    </Button>
                  ) : null}

                  <Button onClick={handleLock} disabled={actionBusy || !canLockEvidence} className={isLocked ? "evidence-btn evidence-btn-secondary" : "evidence-btn evidence-btn-danger"}>
                    {isLocked ? "Permanently Locked" : "Lock Evidence Permanently"}
                  </Button>

                  {isArchived ? (
                    <Button variant="secondary" onClick={handleUnarchive} disabled={actionBusy || isDeleted} className="evidence-btn evidence-btn-secondary">
                      Restore Evidence
                    </Button>
                  ) : (
                    <Button variant="secondary" onClick={handleArchive} disabled={actionBusy || isDeleted} className="evidence-btn evidence-btn-secondary">
                      Archive Evidence
                    </Button>
                  )}

                  {!isDeleted ? (
                    <Button onClick={handleDelete} disabled={actionBusy || !canDelete} className="evidence-btn evidence-btn-danger">
                      Delete Evidence
                    </Button>
                  ) : (
                    <Button variant="secondary" onClick={handleRestoreDeleted} disabled={actionBusy} className="evidence-btn evidence-btn-secondary">
                      Restore from Trash
                    </Button>
                  )}
                </div>

                <div className="evidence-alert legal">
                  <strong>Trash retention:</strong> When moved to trash, this record stays recoverable for 90 days before permanent deletion.
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>
                  <Modal
        isOpen={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        title="Share Evidence"
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <Button
              variant="secondary"
              onClick={() => setShareModalOpen(false)}
              disabled={shareActionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Close
            </Button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 14, color: "#cbd5e1", lineHeight: 1.7 }}>
            Share this evidence with a lawyer, insurer, investigator, or reviewer.
            Send the PDF report for a fixed record, and include the verification link
            for independent online review where enabled by the workspace.
          </div>

          <Button
            onClick={handleCopyVerificationLink}
            disabled={shareActionBusy || !canUsePublicVerification || isDeleted}
            className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
            style={landingPrimaryButtonStyle}
          >
            {shareActionBusy ? "Copying..." : "Copy Verification Link"}
          </Button>

          <Button
            variant="secondary"
            onClick={handleDownloadReport}
            disabled={actionBusy || !canAccessReports || !reportAvailable || isDeleted}
            className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
            style={landingSecondaryButtonStyle}
          >
            Download PDF Report
          </Button>

          <Button
            variant="secondary"
            onClick={handleDownloadVerificationPackage}
            disabled={
              actionBusy ||
              !canAccessVerificationPackage ||
              !verificationPackageAvailable ||
              isDeleted
            }
            className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
            style={landingTertiaryButtonStyle}
          >
            Download Verification Package
          </Button>

          {!canUsePublicVerification && (
            <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.7 }}>
              Public verification is not available on the current workspace configuration.
            </div>
          )}

          {!canAccessReports && (
            <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.7 }}>
              PDF reports are not included for {activeWorkspaceName} on the current plan.
            </div>
          )}

          {!canAccessVerificationPackage && (
            <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.7 }}>
              Verification packages are not included for {activeWorkspaceName} on the current plan.
            </div>
          )}

          {canAccessVerificationPackage && !verificationPackageAvailable && (
            <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.7 }}>
              Verification package is not available yet for this record.
            </div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={assignCaseModalOpen}
        onClose={() => setAssignCaseModalOpen(false)}
        title={caseId ? "Move evidence to case" : "Add evidence to case"}
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <Button
              variant="secondary"
              onClick={() => setAssignCaseModalOpen(false)}
              disabled={actionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmAssignCase}
              disabled={actionBusy || !selectedCaseId}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingPrimaryButtonStyle}
            >
              {actionBusy ? "Saving..." : caseId ? "Move" : "Add"}
            </Button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 14, color: "#cbd5e1", lineHeight: 1.6 }}>
            Choose one of your accessible cases.
          </div>

          <select
            value={selectedCaseId}
            onChange={(e) => setSelectedCaseId(e.target.value)}
            style={{
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(214,184,157,0.16)",
              background: "rgba(255,255,255,0.05)",
              color: "#eef4f1",
            }}
          >
            <option value="">Select a case...</option>
            {ownedCases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.teamId ? " (Team)" : " (Personal)"}
              </option>
            ))}
          </select>
        </div>
      </Modal>

      <Modal
        isOpen={lockModalOpen}
        onClose={() => setLockModalOpen(false)}
        title="Lock this evidence?"
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <Button
              variant="secondary"
              onClick={() => setLockModalOpen(false)}
              disabled={actionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmLock}
              disabled={actionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingDangerButtonStyle}
            >
              {actionBusy ? "Locking..." : "Lock permanently"}
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 15, lineHeight: 1.7, color: "#e2e8f0" }}>
          <p style={{ marginBottom: 16 }}>Once locked:</p>
          <ul style={{ marginLeft: 20, marginBottom: 16, color: "#cbd5e1" }}>
            <li style={{ marginBottom: 8 }}>• The evidence cannot be edited</li>
            <li style={{ marginBottom: 8 }}>• It becomes legally sealed</li>
            <li>• The preserved record remains shareable and reviewable</li>
          </ul>
          <p style={{ marginTop: 16, fontWeight: 700, color: "#fca5a5" }}>
            This action is irreversible.
          </p>
        </div>
      </Modal>

      <Modal
        isOpen={archiveModalOpen}
        onClose={() => setArchiveModalOpen(false)}
        title="Archive this evidence?"
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <Button
              variant="secondary"
              onClick={() => setArchiveModalOpen(false)}
              disabled={actionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmArchive}
              disabled={actionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingPrimaryButtonStyle}
            >
              {actionBusy ? "Archiving..." : "Archive"}
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 15, lineHeight: 1.7, color: "#e2e8f0" }}>
          <p style={{ marginBottom: 12 }}>
            This will remove the evidence from your active workspace.
          </p>
          <p style={{ marginBottom: 12 }}>
            The evidence will remain stored and can be restored later if needed.
          </p>
        </div>
      </Modal>

      <Modal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete this evidence?"
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <Button
              variant="secondary"
              onClick={() => setDeleteModalOpen(false)}
              disabled={actionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmDelete}
              disabled={actionBusy}
              className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
              style={landingDeleteButtonStyle}
            >
              {actionBusy ? "Deleting..." : "Delete Evidence"}
            </Button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 14 }}>
          <div
            className="evidence-delete-notice"
            style={{
              padding: 16,
              borderRadius: 16,
              background:
                "linear-gradient(135deg, rgba(127,29,29,0.18), rgba(69,10,10,0.12))",
              border: "1px solid rgba(248,113,113,0.14)",
            }}
          >
            <div
              className="evidence-delete-notice-title"
              style={{ color: "#fecaca", fontWeight: 800, marginBottom: 6 }}
            >
              90-day recovery window
            </div>
            <div
              className="evidence-delete-notice-text"
              style={{ color: "rgba(254,202,202,0.86)", lineHeight: 1.7 }}
            >
              This evidence will be moved to secure trash and hidden from your active workspace.
              <br />
              <br />
              It will remain recoverable for <strong>90 days</strong>. After that period, it is scheduled for permanent deletion.
            </div>
          </div>

          <div
            style={{
              fontSize: 13,
              lineHeight: 1.65,
              color: "#cbd5e1",
            }}
          >
            Use this only when you no longer want the record in your active workspace but still want a temporary recovery period.
          </div>
        </div>
      </Modal>
    </div>
  );
}
