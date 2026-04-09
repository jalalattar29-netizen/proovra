"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Card, Modal, useToast } from "../../../../components/ui";
import { useLocale } from "../../../providers";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";

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
  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml")
  ) {
    return "text";
  }

  return "other";
}

function getEvidenceTypeLabel(type: string | null | undefined): string {
  const normalized = (type ?? "").trim().toUpperCase();

  switch (normalized) {
    case "PHOTO":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "AUDIO":
      return "Audio";
    case "DOCUMENT":
      return "Document";
    default:
      return normalized || "Unknown";
  }
}

function getDisplayStatusMeta(
  rawStatus: string | null | undefined,
  labels: {
    signed: string;
    processing: string;
  }
): {
  label: string;
  className: string;
} {
  const status = (rawStatus ?? "").trim().toUpperCase();

  switch (status) {
    case "REPORTED":
      return {
        label: "REPORTED",
        className: "badge ready",
      };

    case "SIGNED":
      return {
        label: labels.signed,
        className: "badge signed",
      };

    case "UPLOADED":
      return {
        label: "UPLOADED",
        className: "badge ready",
      };

    case "UPLOADING":
      return {
        label: labels.processing,
        className: "badge processing",
      };

    case "CREATED":
      return {
        label: "CREATED",
        className: "badge processing",
      };

    default:
      return {
        label: status || "UNKNOWN",
        className: "badge ready",
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
  isPrimary?: boolean;
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

type EvidenceResponse = {
  evidence?: {
    id?: string;
    title?: string;
    displayTitle?: string;
    displaySubtitle?: string;
    itemCount?: number;
    status?: string;
    createdAt?: string | null;
    type?: string;
    lockedAt?: string | null;
    archivedAt?: string | null;
    deletedAt?: string | null;
    deleteScheduledForUtc?: string | null;
    caseId?: string | null;
  };
};

function getPartDisplayName(part: EvidencePart): string {
  const key = part.storageKey ?? "";
  const rawName = key.split("/").pop()?.trim();

  if (rawName) {
    return rawName;
  }

  const ext = (() => {
    const mime = (part.mimeType ?? "").toLowerCase();
    if (mime === "image/jpeg") return ".jpg";
    if (mime === "image/png") return ".png";
    if (mime === "image/webp") return ".webp";
    if (mime === "video/mp4") return ".mp4";
    if (mime === "video/webm") return ".webm";
    if (mime === "audio/mpeg") return ".mp3";
    if (mime === "audio/wav") return ".wav";
    if (mime === "application/pdf") return ".pdf";
    return "";
  })();

  return `item-${part.partIndex + 1}${ext}`;
}

function resolveDisplayTitle(
  evidence: EvidenceResponse["evidence"] | undefined
): string {
  return (
    evidence?.displayTitle?.trim() ||
    evidence?.title?.trim() ||
    "Digital Evidence Record"
  );
}

function resolveDisplaySubtitle(
  evidence: EvidenceResponse["evidence"] | undefined
): string {
  return evidence?.displaySubtitle?.trim() || "";
}

export default function EvidenceDetailPage() {
  const { t } = useLocale();
  const params = useParams<{ id: string }>();
  const { addToast } = useToast();
  const evidenceId = params?.id ?? "unknown";

  const [status, setStatus] = useState("CREATED");
  const [, setReportUrl] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [archivedAt, setArchivedAt] = useState<string | null>(null);
  const [deletedAt, setDeletedAt] = useState<string | null>(null);
  const [deleteScheduledForUtc, setDeleteScheduledForUtc] = useState<
    string | null
  >(null);
  const [plan, setPlan] = useState<string>("FREE");
  const [caseId, setCaseId] = useState<string | null>(null);
  const [evidenceType, setEvidenceType] = useState<string | null>(null);

  const [label, setLabel] = useState<string>("Digital Evidence Record");
  const [displaySubtitle, setDisplaySubtitle] = useState<string>("");
  const [itemCount, setItemCount] = useState<number>(1);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelBusy, setLabelBusy] = useState(false);

  const [loading, setLoading] = useState(true);
  const [, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [lockModalOpen, setLockModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  const [assignCaseModalOpen, setAssignCaseModalOpen] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [ownedCases, setOwnedCases] = useState<CaseOption[]>([]);

  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(
    null
  );
  const [originalDownloadUrl, setOriginalDownloadUrl] = useState<string | null>(
    null
  );
  const [originalMimeType, setOriginalMimeType] = useState<string | null>(null);
  const [originalSizeBytes, setOriginalSizeBytes] = useState<string | null>(
    null
  );
  const [originalFileName, setOriginalFileName] = useState<string | null>(null);

  const [parts, setParts] = useState<EvidencePart[]>([]);
  const [partsLoadFailed, setPartsLoadFailed] = useState(false);
  const [verificationPackageAvailable, setVerificationPackageAvailable] =
    useState(false);

  const isMultipart = parts.length > 1;
  const hasCase = Boolean(caseId);
  const isLocked = Boolean(lockedAt);
  const isArchived = Boolean(archivedAt);
  const isDeleted = Boolean(deletedAt);
  const canDelete = !isDeleted;
  const originalKind = useMemo(
    () => getEvidenceKind(originalMimeType),
    [originalMimeType]
  );

  const sortedParts = useMemo(
    () => [...parts].sort((a, b) => a.partIndex - b.partIndex),
    [parts]
  );

  const partTypeSummary = useMemo(() => {
    if (sortedParts.length === 0) {
      return {
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        pdfCount: 0,
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
        else acc.otherCount += 1;
        return acc;
      },
      {
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        pdfCount: 0,
        otherCount: 0,
      }
    );
  }, [sortedParts]);

  const displayStatusMeta = useMemo(
    () =>
      getDisplayStatusMeta(status, {
        signed: t("statusSigned"),
        processing: t("statusProcessing"),
      }),
    [status, t]
  );

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
          apiFetch("/v1/billing/status"),
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
          setEvidenceType(ev.type ?? null);
          setLabel(resolveDisplayTitle(ev));
          setLabelDraft(resolveDisplayTitle(ev));
          setDisplaySubtitle(resolveDisplaySubtitle(ev));
          setItemCount(
            typeof ev.itemCount === "number" && ev.itemCount > 0
              ? ev.itemCount
              : 1
          );
        } else {
          throw evidenceRes.reason;
        }

        if (billingRes.status === "fulfilled") {
          setPlan(billingRes.value?.entitlement?.plan ?? "FREE");
        } else {
          setPlan("FREE");
        }

        if (reportRes.status === "fulfilled") {
          setReportUrl(reportRes.value?.url ?? null);
        } else {
          setReportUrl(null);
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
          setPartsLoadFailed(false);
        } else {
          setParts([]);
          setPartsLoadFailed(true);
        }

        if (verificationPackageRes.status === "fulfilled") {
          setVerificationPackageAvailable(
            Boolean(verificationPackageRes.value?.url)
          );
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
        const message =
          err instanceof Error ? err.message : "Failed to load evidence";
        setError(message);
        captureException(err, {
          feature: "web_evidence_detail_load",
          evidenceId: params.id,
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [params?.id]);

  const refreshEvidence = async () => {
    if (!params?.id) return;

    try {
      const [
        evidenceData,
        reportData,
        originalData,
        partsData,
        verificationData,
      ] = await Promise.allSettled([
        apiFetch(`/v1/evidence/${params.id}`),
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
        setEvidenceType(ev.type ?? null);
        setLabel(resolveDisplayTitle(ev));
        setLabelDraft(resolveDisplayTitle(ev));
        setDisplaySubtitle(resolveDisplaySubtitle(ev));
        setItemCount(
          typeof ev.itemCount === "number" && ev.itemCount > 0
            ? ev.itemCount
            : 1
        );
      }

      if (reportData.status === "fulfilled") {
        setReportUrl(reportData.value?.url ?? null);
      } else {
        setReportUrl(null);
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
        setPartsLoadFailed(false);
      } else {
        setParts([]);
        setPartsLoadFailed(true);
      }

      if (verificationData.status === "fulfilled") {
        setVerificationPackageAvailable(Boolean(verificationData.value?.url));
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
      const nextResolvedSubtitle =
        data?.displaySubtitle || resolveDisplaySubtitle(ev);

      setLabel(nextResolvedLabel);
      setLabelDraft(nextResolvedLabel);
      setDisplaySubtitle(nextResolvedSubtitle);
      setItemCount(
        typeof data?.itemCount === "number" && data.itemCount > 0
          ? data.itemCount
          : itemCount
      );
      setIsEditingLabel(false);
      addToast("Evidence label updated", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_update_label",
        evidenceId: params.id,
      });
      const message =
        err instanceof Error ? err.message : "Failed to update label";
      addToast(message, "error");
    } finally {
      setLabelBusy(false);
    }
  };

  const handleLock = () => {
    setLockModalOpen(true);
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
      const message =
        err instanceof Error ? err.message : "Failed to lock evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleArchive = () => {
    setArchiveModalOpen(true);
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
      const message =
        err instanceof Error ? err.message : "Failed to archive evidence";
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
      const message =
        err instanceof Error ? err.message : "Failed to restore evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = () => {
    setDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!params?.id) return;

    setActionBusy(true);
    try {
      addToast("Deleting evidence...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}`, {
        method: "DELETE",
      });

      const nextDeletedAt =
        data?.evidence?.deletedAt ?? new Date().toISOString();
      const nextDeleteScheduledForUtc =
        data?.evidence?.deleteScheduledForUtc ?? null;

      setDeletedAt(nextDeletedAt);
      setDeleteScheduledForUtc(nextDeleteScheduledForUtc);
      setDeleteModalOpen(false);

      addToast("Evidence deleted", "success");
      await refreshEvidence();
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_delete",
        evidenceId: params.id,
      });
      const message =
        err instanceof Error ? err.message : "Failed to delete evidence";
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
      const message =
        err instanceof Error ? err.message : "Failed to restore evidence";
      setError(message);
      addToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadReport = async () => {
    if (!params?.id) return;

    try {
      addToast("Preparing report...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/report/latest`);
      const nextUrl = data?.url ?? null;
      setReportUrl(nextUrl);

      if (!nextUrl) {
        addToast("Report not available", "info");
        return;
      }

      window.open(nextUrl, "_blank", "noopener,noreferrer");
      addToast("Report downloaded", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_download_report",
        evidenceId: params?.id,
      });
      addToast("Failed to download report", "error");
    }
  };

  const handleDownloadVerificationPackage = async () => {
    if (!params?.id) return;

    try {
      addToast("Preparing verification package...", "info");
      const data = await apiFetch(
        `/v1/evidence/${params.id}/verification-package`
      );

      if (!data?.url) {
        addToast("Verification package not available", "info");
        return;
      }

      setVerificationPackageAvailable(true);
      window.open(data.url, "_blank", "noopener,noreferrer");
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

  const handleDownloadPart = (part: EvidencePart) => {
    const url = part.url ?? part.publicUrl ?? null;
    if (!url) {
      addToast("This item is not available right now", "info");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
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
      const message =
        err instanceof Error ? err.message : "Failed to add evidence to case";
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

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div
            className="page-title"
            style={{ marginBottom: 0, display: "grid", gap: 14 }}
          >
            <div className="evidence-record-badges">
              <span
                className="evidence-pill"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.09)",
                  color: "rgba(246,252,255,0.92)",
                }}
              >
                Evidence Record
              </span>

              <span className={displayStatusMeta.className}>
                {displayStatusMeta.label}
              </span>

              {isLocked && (
                <span className="evidence-pill evidence-pill-locked">
                  Locked
                </span>
              )}

              {isArchived && (
                <span className="evidence-pill evidence-pill-archived">
                  Archived
                </span>
              )}

              {isDeleted && (
                <span className="evidence-pill evidence-pill-deleted">
                  In Trash
                </span>
              )}

              {hasCase && (
                <span className="evidence-pill evidence-pill-case">
                  Case Attached
                </span>
              )}
            </div>

            <div style={{ width: "100%" }}>
              {!isEditingLabel ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <h1
                    className="hero-title pricing-hero-title"
                    style={{ margin: 0 }}
                  >
                    {label}
                  </h1>

                  <Button
                    variant="secondary"
                    onClick={handleStartEditLabel}
                    disabled={loading || actionBusy || labelBusy || isDeleted}
                  >
                    Edit Label
                  </Button>
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    maxLength={160}
                    disabled={labelBusy}
                    style={{
                      minWidth: 320,
                      maxWidth: "100%",
                      flex: "1 1 420px",
                      padding: "12px 14px",
                      borderRadius: 14,
                      border: "1px solid rgba(214,184,157,0.18)",
                      background: "rgba(255,255,255,0.05)",
                      color: "#eef4f1",
                      fontSize: 16,
                      fontWeight: 700,
                      boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
                    }}
                  />

                  <Button onClick={handleSaveLabel} disabled={labelBusy}>
                    {labelBusy ? "Saving..." : "Save"}
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={handleCancelEditLabel}
                    disabled={labelBusy}
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <p
                className="page-subtitle pricing-subtitle"
                style={{ marginTop: 8, marginBottom: 0 }}
              >
                {displaySubtitle ||
                  `${itemCount} item${itemCount === 1 ? "" : "s"}`}
              </p>

              <div
                className="evidence-hero-meta"
                style={{
                  display: "flex",
                  gap: 14,
                  flexWrap: "wrap",
                  marginTop: 14,
                  fontSize: 13,
                  color: "rgba(219,235,248,0.68)",
                }}
              >
                <span>Record ID: {shortId(evidenceId)}</span>
                <span>Type: {getEvidenceTypeLabel(evidenceType)}</span>
                <span>
                  {isMultipart ? `${sortedParts.length} items` : "Single file"}
                </span>
              </div>

              {isDeleted && (
                <div
                  className="evidence-delete-notice"
                  style={{
                    marginTop: 16,
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
                    Secure trash retention active
                  </div>
                  <div
                    className="evidence-delete-notice-text"
                    style={{ color: "rgba(254,202,202,0.86)", lineHeight: 1.7 }}
                  >
                    This evidence has been moved to secure trash. It remains
                    recoverable until{" "}
                    <strong>{formatUtcDateTime(deleteScheduledForUtc)}</strong>.
                    After that date, it is scheduled for permanent deletion.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <div className="grid-2">
            <Card className="evidence-legal-card app-card">
              <div className="evidence-section-title">Record Summary</div>

              <div className="evidence-legal-grid">
                <div>
                  <div className="evidence-legal-title">User Label</div>
                  <div className="evidence-legal-value">{label}</div>
                </div>

                <div>
                  <div className="evidence-legal-title">Original Submitted File</div>
                  <div className="evidence-legal-value">
                    {originalFileName || "Original filename not available"}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Record ID</div>
                  <div className="evidence-legal-value">{evidenceId}</div>
                </div>

                <div>
                  <div className="evidence-legal-title">Evidence Type</div>
                  <div className="evidence-legal-value">
                    {getEvidenceTypeLabel(evidenceType)}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Structure</div>
                  <div className="evidence-legal-value">
                    {isMultipart
                      ? `Multipart record (${sortedParts.length} items)`
                      : "Single-file record"}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Case Assignment</div>
                  <div className="evidence-legal-value">
                    {caseId ? "Attached to case" : "Not assigned to any case"}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Subscription Plan</div>
                  <div className="evidence-legal-value">{plan}</div>
                </div>
              </div>
            </Card>

            <Card className="evidence-legal-card app-card">
              <div className="evidence-section-title">Integrity & Legal Status</div>

              <div className="evidence-legal-grid">
                <div>
                  <div className="evidence-legal-title">Current Status</div>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <span className={displayStatusMeta.className}>
                      {displayStatusMeta.label}
                    </span>

                    {isLocked && (
                      <span className="evidence-pill evidence-pill-locked">
                        Locked
                      </span>
                    )}

                    {isArchived && (
                      <span className="evidence-pill evidence-pill-archived">
                        Archived
                      </span>
                    )}

                    {isDeleted && (
                      <span className="evidence-pill evidence-pill-deleted">
                        In Trash
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Recorded At</div>
                  <div className="evidence-legal-value">
                    {formatUtcDateTime(createdAt)}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Locked At</div>
                  <div className="evidence-legal-value">
                    {formatUtcDateTime(lockedAt)}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Archived At</div>
                  <div className="evidence-legal-value">
                    {formatUtcDateTime(archivedAt)}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Deleted At</div>
                  <div className="evidence-legal-value">
                    {formatUtcDateTime(deletedAt)}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">
                    Permanent Deletion Date
                  </div>
                  <div className="evidence-legal-value">
                    {formatUtcDateTime(deleteScheduledForUtc)}
                  </div>
                </div>

                <div>
                  <div className="evidence-legal-title">Legal State</div>
                  <div className="evidence-legal-value">
                    {isDeleted
                      ? "This record is currently in secure trash. It remains recoverable until the scheduled deletion date."
                      : isLocked
                        ? "This record has been permanently sealed. Its evidentiary state can no longer be modified."
                        : isArchived
                          ? "This record has been archived from the active workspace while remaining preserved in storage."
                          : "This record is active and available for review."}
                  </div>
                </div>

                {isMultipart && (
                  <div>
                    <div className="evidence-legal-title">Contained Items</div>
                    <div className="evidence-legal-value" style={{ fontWeight: 500 }}>
                      {partTypeSummary.imageCount > 0 && (
                        <div>{partTypeSummary.imageCount} image(s)</div>
                      )}
                      {partTypeSummary.videoCount > 0 && (
                        <div>{partTypeSummary.videoCount} video(s)</div>
                      )}
                      {partTypeSummary.audioCount > 0 && (
                        <div>{partTypeSummary.audioCount} audio item(s)</div>
                      )}
                      {partTypeSummary.pdfCount > 0 && (
                        <div>{partTypeSummary.pdfCount} pdf/document(s)</div>
                      )}
                      {partTypeSummary.otherCount > 0 && (
                        <div>{partTypeSummary.otherCount} other item(s)</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>

          <Card className="mt-6 evidence-legal-card app-card">
            <div className="evidence-section-title">Record Actions</div>

            <div
              className="evidence-callout evidence-callout-soft"
              style={{
                marginBottom: 14,
                padding: 14,
                borderRadius: 14,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
                color: "rgba(219,235,248,0.74)",
              }}
            >
              Export, verify, assign, seal, archive, or manage this evidence
              record.
            </div>

            <div className="footer-actions">
              <Button
                onClick={handleDownloadReport}
                disabled={actionBusy || plan === "FREE" || isDeleted}
              >
                {t("downloadReport")}
              </Button>

              <Button
                variant="secondary"
                onClick={handleDownloadVerificationPackage}
                disabled={actionBusy || !verificationPackageAvailable || isDeleted}
              >
                Download Verification Package
              </Button>

              <Link href={`/share/${evidenceId}`}>
                <Button variant="secondary" disabled={isDeleted}>
                  {t("shareLink")}
                </Button>
              </Link>
            </div>

            {plan === "FREE" && (
              <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 10 }}>
                Reports are disabled on Free. Upgrade to access PDF reports.
              </div>
            )}

            {!verificationPackageAvailable && (
              <div style={{ fontSize: 12, color: "rgba(219,235,248,0.56)", marginTop: 10 }}>
                Verification package is not available yet.
              </div>
            )}

            <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
              {!isDeleted && (
                <>
                  <Button
                    variant="secondary"
                    onClick={handleOpenAssignCase}
                    disabled={actionBusy || ownedCases.length === 0}
                  >
                    {caseId ? "Move to Case" : "Add to Case"}
                  </Button>

                  {caseId && (
                    <Button
                      variant="secondary"
                      onClick={handleRemoveFromCase}
                      disabled={actionBusy}
                    >
                      Remove from Case
                    </Button>
                  )}

                  <Button
                    onClick={handleLock}
                    disabled={
                      actionBusy ||
                      Boolean(lockedAt) ||
                      !(status === "SIGNED" || status === "REPORTED")
                    }
                    className={lockedAt ? "button-disabled" : "button-danger"}
                  >
                    {lockedAt
                      ? "Permanently Locked"
                      : "Lock Evidence Permanently"}
                  </Button>

                  {lockedAt && (
                    <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)", padding: "8px 0" }}>
                      ✓ This record is legally sealed and can no longer be edited.
                    </div>
                  )}

                  {archivedAt ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={handleUnarchive}
                        disabled={actionBusy}
                      >
                        Restore Evidence
                      </Button>
                      <div
                        style={{
                          fontSize: 12,
                          color: "rgba(219,235,248,0.64)",
                          padding: "8px 0",
                        }}
                      >
                        This record is archived. Restore it to return it to the
                        active workspace.
                      </div>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        onClick={handleArchive}
                        disabled={actionBusy}
                      >
                        Archive Evidence
                      </Button>
                      <div
                        style={{
                          fontSize: 12,
                          color: "rgba(219,235,248,0.56)",
                          padding: "8px 0",
                        }}
                      >
                        Archive this record to remove it from active review while
                        preserving it in storage.
                      </div>
                    </>
                  )}

                  <Button
                    onClick={handleDelete}
                    disabled={actionBusy || !canDelete}
                    className={canDelete ? "button-danger" : "button-disabled"}
                  >
                    Delete Evidence
                  </Button>

                  <div
                    className="evidence-callout evidence-callout-warning"
                    style={{
                      padding: 14,
                      borderRadius: 14,
                      background:
                        "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(214,184,157,0.04))",
                      border: "1px solid rgba(214,184,157,0.14)",
                      color: "rgba(230,201,174,0.92)",
                    }}
                  >
                    <strong>Trash retention:</strong> When moved to trash, this
                    record stays recoverable for 90 days before permanent deletion.
                  </div>
                </>
              )}

              {isDeleted && (
                <>
                  <Button
                    variant="secondary"
                    onClick={handleRestoreDeleted}
                    disabled={actionBusy}
                  >
                    Restore from Trash
                  </Button>
                  <div style={{ fontSize: 12, color: "rgba(219,235,248,0.64)", padding: "8px 0" }}>
                    This record is in secure trash and can be restored until{" "}
                    {formatUtcDateTime(deleteScheduledForUtc)}.
                  </div>
                </>
              )}
            </div>
          </Card>

          {(sortedParts.length > 0 ||
            originalPreviewUrl ||
            originalDownloadUrl ||
            originalMimeType ||
            originalSizeBytes) && (
            <Card className="mt-6 evidence-legal-card app-card">
              <div className="evidence-section-title">
                {isMultipart ? "Original Evidence Materials" : "Original Evidence"}
              </div>

              {isMultipart ? (
                <>
                  <div
                    className="evidence-callout"
                    style={{
                      marginBottom: 16,
                      padding: 14,
                      borderRadius: 14,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: "rgba(219,235,248,0.76)",
                    }}
                  >
                    This record contains <strong>{sortedParts.length}</strong>{" "}
                    original evidence items. Each item below can be reviewed and
                    downloaded separately.
                  </div>

                  <div style={{ display: "grid", gap: 16 }}>
                    {sortedParts.map((part) => {
                      const kind = getEvidenceKind(part.mimeType ?? null);
                      const previewUrl = part.publicUrl ?? part.url ?? null;
                      const downloadUrl = part.url ?? part.publicUrl ?? null;
                      const displayName = getPartDisplayName(part);

                      return (
                        <div
                          key={part.id}
                          className="evidence-item-card"
                          style={{
                            padding: 16,
                            borderRadius: 18,
                            background: "rgba(255,255,255,0.04)",
                            border: "1px solid rgba(255,255,255,0.06)",
                            boxShadow: "0 12px 30px rgba(0,0,0,0.14)",
                          }}
                        >
                          <div className="evidence-item-header">
                            <div>
                              <div style={{ fontWeight: 800, color: "#eef4f1" }}>
                                Item {part.partIndex + 1}
                                {part.isPrimary ? " (Primary)" : ""}
                              </div>
                              <div
                                style={{
                                  fontSize: 13,
                                  color: "rgba(219,235,248,0.60)",
                                  marginTop: 4,
                                }}
                              >
                                {displayName}
                              </div>
                            </div>

                            <div className="evidence-item-actions">
                              <Button
                                variant="secondary"
                                onClick={() => handleOpenPart(part)}
                                disabled={!downloadUrl || isDeleted}
                              >
                                Open
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={() => handleDownloadPart(part)}
                                disabled={!downloadUrl || isDeleted}
                              >
                                Download
                              </Button>
                            </div>
                          </div>

                          <div
                            className="evidence-meta-stack"
                            style={{
                              display: "grid",
                              gap: 6,
                              marginTop: 12,
                              marginBottom: 14,
                              color: "rgba(219,235,248,0.68)",
                              fontSize: 13,
                            }}
                          >
                            <div>Type: {part.mimeType ?? "Unknown"}</div>
                            <div>Kind: {kind}</div>
                            <div>Size: {formatBytes(part.sizeBytes ?? null)}</div>
                          </div>

                          {previewUrl && kind === "image" && (
                            <img
                              src={previewUrl}
                              alt={`Evidence item ${part.partIndex + 1}`}
                              className="evidence-preview-image"
                              style={{
                                width: "100%",
                                borderRadius: 16,
                                border: "1px solid rgba(255,255,255,0.08)",
                              }}
                            />
                          )}

                          {previewUrl && kind === "video" && (
                            <video
                              src={previewUrl}
                              controls
                              preload="metadata"
                              className="evidence-preview-video"
                              style={{
                                width: "100%",
                                borderRadius: 16,
                                border: "1px solid rgba(255,255,255,0.08)",
                              }}
                            />
                          )}

                          {previewUrl && kind === "audio" && (
                            <div
                              className="evidence-audio-box"
                              style={{
                                padding: 14,
                                borderRadius: 14,
                                background: "rgba(255,255,255,0.03)",
                                border: "1px solid rgba(255,255,255,0.06)",
                              }}
                            >
                              <audio
                                src={previewUrl}
                                controls
                                preload="metadata"
                                style={{ width: "100%" }}
                              />
                            </div>
                          )}

                          {previewUrl && kind === "pdf" && (
                            <div className="evidence-preview-frame">
                              <iframe
                                src={previewUrl}
                                title={`Evidence PDF item ${part.partIndex + 1}`}
                                className="evidence-iframe"
                                style={{
                                  width: "100%",
                                  minHeight: 520,
                                  borderRadius: 16,
                                  border: "1px solid rgba(255,255,255,0.08)",
                                  background: "#fff",
                                }}
                              />
                            </div>
                          )}

                          {!previewUrl && (
                            <div
                              className="evidence-callout"
                              style={{
                                padding: 12,
                                borderRadius: 14,
                                background: "rgba(255,255,255,0.04)",
                                border: "1px solid rgba(255,255,255,0.06)",
                                color: "rgba(219,235,248,0.72)",
                              }}
                            >
                              Preview is not available for this item right now.
                            </div>
                          )}

                          {previewUrl && (kind === "text" || kind === "other") && (
                            <div
                              className="evidence-callout"
                              style={{
                                padding: 12,
                                borderRadius: 14,
                                background: "rgba(255,255,255,0.04)",
                                border: "1px solid rgba(255,255,255,0.06)",
                                color: "rgba(219,235,248,0.72)",
                              }}
                            >
                              Preview is not available inside the page for this
                              file type. Use Open or Download.
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {partsLoadFailed && (
                    <div
                      className="evidence-callout"
                      style={{
                        marginTop: 14,
                        padding: 12,
                        borderRadius: 14,
                        background: "rgba(239,68,68,0.08)",
                        border: "1px solid rgba(239,68,68,0.10)",
                        color: "#fecaca",
                      }}
                    >
                      Failed to load evidence parts.
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div
                    className="evidence-callout"
                    style={{
                      marginBottom: 16,
                      padding: 14,
                      borderRadius: 14,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: "rgba(219,235,248,0.76)",
                    }}
                  >
                    Original submitted evidence file. This file is preserved as
                    part of the record.
                  </div>

                  <div
                    className="evidence-meta-stack"
                    style={{
                      marginBottom: 14,
                      display: "grid",
                      gap: 6,
                      color: "rgba(219,235,248,0.68)",
                      fontSize: 13,
                    }}
                  >
                    {originalFileName && <div>Original file: {originalFileName}</div>}
                    {originalMimeType && <div>Type: {originalMimeType}</div>}
                    {originalSizeBytes && (
                      <div>Size: {formatBytes(originalSizeBytes)}</div>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 10,
                      marginBottom: 14,
                    }}
                  >
                    <Button
                      variant="secondary"
                      onClick={handleOpenOriginal}
                      disabled={!originalDownloadUrl || isDeleted}
                    >
                      Open Original
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={handleDownloadOriginal}
                      disabled={!originalDownloadUrl || isDeleted}
                    >
                      Download Original
                    </Button>
                  </div>

                  {originalPreviewUrl && originalKind === "image" && (
                    <div style={{ marginBottom: 12 }}>
                      <img
                        src={originalPreviewUrl}
                        alt="Evidence preview"
                        className="evidence-preview-image"
                        style={{
                          width: "100%",
                          borderRadius: 16,
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      />
                    </div>
                  )}

                  {originalPreviewUrl && originalKind === "video" && (
                    <div style={{ marginBottom: 12 }}>
                      <video
                        src={originalPreviewUrl}
                        controls
                        preload="metadata"
                        className="evidence-preview-video"
                        style={{
                          width: "100%",
                          borderRadius: 16,
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      />
                    </div>
                  )}

                  {originalPreviewUrl && originalKind === "audio" && (
                    <div
                      className="evidence-audio-box"
                      style={{
                        marginBottom: 12,
                        padding: 14,
                        borderRadius: 14,
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <audio
                        src={originalPreviewUrl}
                        controls
                        preload="metadata"
                        style={{ width: "100%" }}
                      />
                    </div>
                  )}

                  {originalPreviewUrl && originalKind === "pdf" && (
                    <div
                      className="evidence-preview-frame"
                      style={{ marginBottom: 12 }}
                    >
                      <iframe
                        src={originalPreviewUrl}
                        title="Original PDF evidence"
                        className="evidence-iframe"
                        style={{
                          width: "100%",
                          minHeight: 620,
                          borderRadius: 16,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "#fff",
                        }}
                      />
                    </div>
                  )}

                  {!originalPreviewUrl &&
                    (originalKind === "text" || originalKind === "other") && (
                      <div
                        className="evidence-callout"
                        style={{
                          marginBottom: 12,
                          padding: 12,
                          borderRadius: 14,
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          color: "rgba(219,235,248,0.72)",
                        }}
                      >
                        <div style={{ marginBottom: 8 }}>
                          Preview is not available for this file type inside the
                          page.
                        </div>
                        <div>Use Open Original or Download Original.</div>
                      </div>
                    )}

                  {!originalPreviewUrl && !originalDownloadUrl && (
                    <div
                      className="evidence-callout"
                      style={{
                        padding: 12,
                        borderRadius: 14,
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        color: "rgba(219,235,248,0.72)",
                      }}
                    >
                      The original submitted file is currently unavailable for
                      access.
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
        </div>
      </div>

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
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmAssignCase}
              disabled={actionBusy || !selectedCaseId}
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
            >
              Cancel
            </Button>
            <div style={{ position: "relative" }}>
              <Button
                onClick={handleConfirmLock}
                disabled={actionBusy}
                className="button-danger"
              >
                {actionBusy ? "Locking..." : "Lock permanently"}
              </Button>
            </div>
          </div>
        }
      >
        <div style={{ fontSize: 15, lineHeight: 1.7, color: "#e2e8f0" }}>
          <p style={{ marginBottom: 16 }}>Once locked:</p>
          <ul style={{ marginLeft: 20, marginBottom: 16, color: "#cbd5e1" }}>
            <li style={{ marginBottom: 8 }}>• The evidence cannot be edited</li>
            <li>• It becomes legally sealed</li>
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
            >
              Cancel
            </Button>
            <Button onClick={handleConfirmArchive} disabled={actionBusy}>
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
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmDelete}
              disabled={actionBusy}
              className="button-danger"
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
              This evidence will be moved to secure trash and hidden from your
              active workspace.
              <br />
              <br />
              It will remain recoverable for <strong>90 days</strong>. After that
              period, it is scheduled for permanent deletion.
            </div>
          </div>

          <div
            style={{
              fontSize: 13,
              lineHeight: 1.65,
              color: "#cbd5e1",
            }}
          >
            Use this only when you no longer want the record in your active
            workspace but still want a temporary recovery period.
          </div>
        </div>
      </Modal>
    </div>
  );
}