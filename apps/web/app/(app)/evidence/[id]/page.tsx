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
        label: "Report Ready",
        className: "evidence-pill evidence-pill-report-ready",
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

function buildDownloadName(
  baseName: string | null | undefined,
  mimeType: string | null | undefined,
  fallback = "evidence-file"
) {
  const cleanedBase = (baseName ?? "").trim();
  if (cleanedBase) return cleanedBase;

  const mime = (mimeType ?? "").toLowerCase();
  const ext =
    mime === "image/jpeg"
      ? ".jpg"
      : mime === "image/png"
        ? ".png"
        : mime === "image/webp"
          ? ".webp"
          : mime === "video/mp4"
            ? ".mp4"
            : mime === "video/webm"
              ? ".webm"
              : mime === "audio/mpeg"
                ? ".mp3"
                : mime === "audio/wav"
                  ? ".wav"
                  : mime === "application/pdf"
                    ? ".pdf"
                    : "";

  return `${fallback}${ext}`;
}

async function forceBrowserDownload(
  url: string,
  filename: string
): Promise<boolean> {
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();

    window.setTimeout(() => {
      window.URL.revokeObjectURL(blobUrl);
    }, 1500);

    return true;
  } catch {
    return false;
  }
}

function HeroPill({
  children,
  bronze = false,
}: {
  children: React.ReactNode;
  bronze?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.16em]"
      style={{
        border: bronze
          ? "1px solid rgba(214,184,157,0.18)"
          : "1px solid rgba(255,255,255,0.10)",
        background: bronze
          ? "rgba(255,255,255,0.045)"
          : "rgba(255,255,255,0.045)",
        color: bronze ? "#d9ccbf" : "#dce3e0",
        boxShadow: "0 8px 18px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      {children}
    </span>
  );
}

function InfoField({
  label,
  value,
  valueClassName = "",
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div>
      <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
        {label}
      </div>
      <div
        className={`mt-2 text-[0.96rem] leading-[1.75] text-[#23373b] ${valueClassName}`.trim()}
      >
        {value}
      </div>
    </div>
  );
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

  const compositionLabel = useMemo(() => {
    if (isMultipart) {
      return `${sortedParts.length} items`;
    }

    if (partTypeSummary.imageCount > 0) return `${partTypeSummary.imageCount} image`;
    if (partTypeSummary.videoCount > 0) return `${partTypeSummary.videoCount} video`;
    if (partTypeSummary.audioCount > 0) return `${partTypeSummary.audioCount} audio`;
    if (partTypeSummary.pdfCount > 0) return `${partTypeSummary.pdfCount} document`;
    if (partTypeSummary.otherCount > 0) return `${partTypeSummary.otherCount} file`;

    return "1 item";
  }, [isMultipart, partTypeSummary, sortedParts.length]);

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

      const forced = await forceBrowserDownload(
        nextUrl,
        buildDownloadName(`${label || "evidence"}-report.pdf`, "application/pdf", "report")
      );

      if (!forced) {
        window.open(nextUrl, "_blank", "noopener,noreferrer");
      }

      addToast("Report ready", "success");
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

      const forced = await forceBrowserDownload(
        data.url,
        buildDownloadName(`${label || "evidence"}-verification-package.zip`, "application/zip", "verification-package")
      );

      if (!forced) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      }

      addToast("Verification package ready", "success");
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
      let nextUrl = originalDownloadUrl;
      let nextMimeType = originalMimeType;
      let nextName = originalFileName;

      if (!nextUrl) {
        const data = await apiFetch(`/v1/evidence/${params.id}/original`);
        nextUrl = data?.url ?? data?.publicUrl ?? null;
        nextMimeType = data?.mimeType ?? null;
        nextName = data?.originalFileName ?? null;

        setOriginalPreviewUrl(data?.publicUrl ?? data?.url ?? null);
        setOriginalDownloadUrl(nextUrl);
        setOriginalMimeType(nextMimeType);
        setOriginalSizeBytes(data?.sizeBytes ?? null);
        setOriginalFileName(nextName);
      }

      if (!nextUrl) {
        addToast("Original file not available", "info");
        return;
      }

      const forced = await forceBrowserDownload(
        nextUrl,
        buildDownloadName(nextName, nextMimeType, "original-evidence")
      );

      if (!forced) {
        const a = document.createElement("a");
        a.href = nextUrl;
        a.download = buildDownloadName(nextName, nextMimeType, "original-evidence");
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }

      addToast("Original file download started", "success");
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

    const filename = getPartDisplayName(part);
    const forced = await forceBrowserDownload(url, filename);

    if (!forced) {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    addToast("Item download started", "success");
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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

  const heroPrimaryButtonStyle = useMemo(
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

  const landingBronzeButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(183,157,132,0.18)",
        color: "#fff7f0",
        background:
          "linear-gradient(180deg, rgba(170,122,82,0.96) 0%, rgba(114,75,43,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.08), 0 14px 28px rgba(92,69,50,0.18)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const landingDangerButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(194,78,78,0.24)",
        color: "#fff1f1",
        background:
          "linear-gradient(180deg, rgba(156,50,50,0.94) 0%, rgba(108,28,28,0.98) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 28px rgba(90,18,18,0.20)",
        textShadow: "0 1px 0 rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }) as const,
    []
  );

  const softCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.10)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }) as const,
    []
  );

  const renderOriginalPreview = () => {
    if (isMultipart) {
      return (
        <div className="grid gap-4">
          {sortedParts.map((part) => {
            const kind = getEvidenceKind(part.mimeType ?? null);
            const previewUrl = part.publicUrl ?? part.url ?? null;
            const displayName = getPartDisplayName(part);

            return (
              <div
                key={part.id}
                style={{
                  padding: 16,
                  borderRadius: 20,
                  ...softCardStyle,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    alignItems: "center",
                    marginBottom: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, color: "#23373b" }}>
                      Item {part.partIndex + 1}
                      {part.isPrimary ? " (Primary)" : ""}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "#6a777b",
                        marginTop: 4,
                      }}
                    >
                      {displayName}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Button
                      variant="secondary"
                      onClick={() => handleOpenPart(part)}
                      disabled={isDeleted}
                      className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                      style={landingSecondaryButtonStyle}
                    >
                      Open
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => handleDownloadPart(part)}
                      disabled={isDeleted}
                      className="rounded-[999px] border px-4 py-2.5 text-[0.88rem] font-semibold"
                      style={landingSecondaryButtonStyle}
                    >
                      Download
                    </Button>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gap: 6,
                    marginBottom: 14,
                    color: "#6a777b",
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
                    style={{
                      width: "100%",
                      maxWidth: 720,
                      margin: "0 auto",
                      display: "block",
                      borderRadius: 20,
                      border: "1px solid rgba(79,112,107,0.10)",
                      boxShadow: "0 20px 50px rgba(0,0,0,0.12)",
                    }}
                  />
                )}

                {previewUrl && kind === "video" && (
                  <video
                    src={previewUrl}
                    controls
                    preload="metadata"
                    style={{
                      width: "100%",
                      maxWidth: 720,
                      margin: "0 auto",
                      display: "block",
                      borderRadius: 20,
                      border: "1px solid rgba(79,112,107,0.10)",
                      boxShadow: "0 20px 50px rgba(0,0,0,0.12)",
                    }}
                  />
                )}

                {previewUrl && kind === "audio" && (
                  <div
                    style={{
                      maxWidth: 720,
                      margin: "0 auto",
                      padding: 14,
                      borderRadius: 16,
                      background: "rgba(255,255,255,0.42)",
                      border: "1px solid rgba(79,112,107,0.08)",
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
                  <iframe
                    src={previewUrl}
                    title={`Evidence PDF item ${part.partIndex + 1}`}
                    style={{
                      width: "100%",
                      minHeight: 560,
                      borderRadius: 20,
                      border: "1px solid rgba(79,112,107,0.10)",
                      background: "#fff",
                    }}
                  />
                )}

                {!previewUrl && (
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 14,
                      background: "rgba(255,255,255,0.42)",
                      border: "1px solid rgba(79,112,107,0.08)",
                      color: "#6a777b",
                    }}
                  >
                    Preview is not available for this item right now.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <>
        <div
          style={{
            marginBottom: 16,
            display: "grid",
            gap: 6,
            color: "#6a777b",
            fontSize: 13,
          }}
        >
          {originalFileName && <div>Original file: {originalFileName}</div>}
          {originalMimeType && <div>Type: {originalMimeType}</div>}
          {originalSizeBytes && <div>Size: {formatBytes(originalSizeBytes)}</div>}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            justifyContent: "center",
            marginBottom: 18,
          }}
        >
          <Button
            variant="secondary"
            onClick={handleOpenOriginal}
            disabled={!originalDownloadUrl || isDeleted}
            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
            style={landingSecondaryButtonStyle}
          >
            Open Original
          </Button>

          <Button
            variant="secondary"
            onClick={handleDownloadOriginal}
            disabled={!originalDownloadUrl || isDeleted}
            className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
            style={landingBronzeButtonStyle}
          >
            Download Original
          </Button>
        </div>

        {originalPreviewUrl && originalKind === "image" && (
          <img
            src={originalPreviewUrl}
            alt="Evidence preview"
            style={{
              width: "100%",
              maxWidth: 760,
              margin: "0 auto",
              display: "block",
              borderRadius: 22,
              border: "1px solid rgba(79,112,107,0.10)",
              boxShadow: "0 20px 52px rgba(0,0,0,0.12)",
            }}
          />
        )}

        {originalPreviewUrl && originalKind === "video" && (
          <video
            src={originalPreviewUrl}
            controls
            preload="metadata"
            style={{
              width: "100%",
              maxWidth: 760,
              margin: "0 auto",
              display: "block",
              borderRadius: 22,
              border: "1px solid rgba(79,112,107,0.10)",
              boxShadow: "0 20px 52px rgba(0,0,0,0.12)",
            }}
          />
        )}

        {originalPreviewUrl && originalKind === "audio" && (
          <div
            style={{
              maxWidth: 760,
              margin: "0 auto",
              padding: 16,
              borderRadius: 18,
              background: "rgba(255,255,255,0.42)",
              border: "1px solid rgba(79,112,107,0.08)",
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
          <iframe
            src={originalPreviewUrl}
            title="Original PDF evidence"
            style={{
              width: "100%",
              minHeight: 640,
              borderRadius: 20,
              border: "1px solid rgba(79,112,107,0.10)",
              background: "#fff",
            }}
          />
        )}

        {!originalPreviewUrl &&
          (originalKind === "text" || originalKind === "other") && (
            <div
              style={{
                padding: 14,
                borderRadius: 16,
                background: "rgba(255,255,255,0.42)",
                border: "1px solid rgba(79,112,107,0.08)",
                color: "#6a777b",
                textAlign: "center",
              }}
            >
              Preview is not available for this file type inside the page. Use
              Open Original or Download Original.
            </div>
          )}

        {!originalPreviewUrl && !originalDownloadUrl && (
          <div
            style={{
              padding: 14,
              borderRadius: 16,
              background: "rgba(255,255,255,0.42)",
              border: "1px solid rgba(79,112,107,0.08)",
              color: "#6a777b",
              textAlign: "center",
            }}
          >
            The original submitted file is currently unavailable for access.
          </div>
        )}
      </>
    );
  };

  return (
    <div className="section app-section evidence-detail-page-shell">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ width: "100%", maxWidth: 980 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.055)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#dce3e0",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                  marginBottom: 18,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                Evidence Record
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginBottom: 16,
                }}
              >
                <HeroPill>{displayStatusMeta.label}</HeroPill>

                {hasCase && <HeroPill>Case Attached</HeroPill>}

                {isLocked && <HeroPill bronze>Locked</HeroPill>}
                {isArchived && <HeroPill bronze>Archived</HeroPill>}
                {isDeleted && <HeroPill bronze>In Trash</HeroPill>}
              </div>

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
                    className="max-w-[900px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#e7ece9] md:text-[2.22rem] lg:text-[2.72rem]"
                    style={{ margin: 0 }}
                  >
                    {label === "Digital Evidence Record" ? (
                      <>
                        Digital Evidence{" "}
                        <span style={{ color: "#c3ebe2" }}>Record</span>
                      </>
                    ) : (
                      label
                    )}
                  </h1>

                  <Button
                    onClick={handleStartEditLabel}
                    disabled={loading || actionBusy || labelBusy || isDeleted}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={heroPrimaryButtonStyle}
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
                      color: "#d8e0dd",
                      fontSize: 16,
                      fontWeight: 700,
                      boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
                    }}
                  />

                  <Button
                    onClick={handleSaveLabel}
                    disabled={labelBusy}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={heroPrimaryButtonStyle}
                  >
                    {labelBusy ? "Saving..." : "Save"}
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={handleCancelEditLabel}
                    disabled={labelBusy}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={heroPrimaryButtonStyle}
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <p
                style={{
                  marginTop: 10,
                  marginBottom: 0,
                  maxWidth: 760,
                  fontSize: "0.95rem",
                  lineHeight: 1.8,
                  letterSpacing: "-0.006em",
                  color: "#c7cfcc",
                }}
              >
                {displaySubtitle ||
                  `${itemCount} item${itemCount === 1 ? "" : "s"}`}
              </p>

              <div
                style={{
                  display: "flex",
                  gap: 14,
                  flexWrap: "wrap",
                  marginTop: 14,
                  fontSize: 13,
                  color: "rgba(194,204,201,0.72)",
                }}
              >
                <span>Record ID: {shortId(evidenceId)}</span>
                <span>Type: {getEvidenceTypeLabel(evidenceType)}</span>
                <span>{isMultipart ? `${sortedParts.length} items` : "Single file"}</span>
              </div>

              {isDeleted && (
                <div
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
                    style={{ color: "#fecaca", fontWeight: 800, marginBottom: 6 }}
                  >
                    Secure trash retention active
                  </div>
                  <div
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

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <div className="container relative z-10" style={{ paddingBottom: 72 }}>
          <div className="grid gap-5 lg:grid-cols-[1fr_0.88fr]">
            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                  Record Summary
                </div>

                <div className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2">
                  <InfoField label="User Label" value={label} />
                  <InfoField
                    label="Original Submitted File"
                    value={originalFileName || "Not available"}
                  />
                  <InfoField label="Record ID" value={evidenceId} valueClassName="break-all" />
                  <InfoField label="Evidence Type" value={getEvidenceTypeLabel(evidenceType)} />
                  <InfoField
                    label="Structure"
                    value={
                      isMultipart
                        ? `Multipart record (${sortedParts.length} items)`
                        : "Single-file record"
                    }
                  />
                  <InfoField
                    label="Evidence Composition"
                    value={
                      <span
                        className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.82rem] font-semibold"
                        style={{
                          color: "#3f6b68",
                          background: "rgba(158,216,207,0.14)",
                          border: "1px solid rgba(158,216,207,0.18)",
                        }}
                      >
                        {compositionLabel}
                      </span>
                    }
                  />
                  <InfoField
                    label="Case Assignment"
                    value={caseId ? "Attached to case" : "Not assigned to any case"}
                  />
                  <InfoField label="Subscription Plan" value={plan} />
                  <InfoField
                    label="Current Status"
                    value={
                      <span
                        className={displayStatusMeta.className}
                        style={
                          displayStatusMeta.className.includes("evidence-pill-report-ready")
                            ? {
                                color: "#31585d",
                                background:
                                  "linear-gradient(180deg, rgba(195,235,226,0.18) 0%, rgba(255,255,255,0.14) 100%)",
                                border: "1px solid rgba(158,216,207,0.24)",
                                boxShadow:
                                  "inset 0 1px 0 rgba(255,255,255,0.34), 0 4px 10px rgba(60,110,102,0.08)",
                              }
                            : undefined
                        }
                      >
                        {displayStatusMeta.label}
                      </span>
                    }
                  />
                  <InfoField label="Recorded At" value={formatUtcDateTime(createdAt)} />
                  <InfoField label="Locked At" value={formatUtcDateTime(lockedAt)} />
                  <InfoField label="Archived At" value={formatUtcDateTime(archivedAt)} />
                  <InfoField label="Deleted At" value={formatUtcDateTime(deletedAt)} />
                  <InfoField
                    label="Permanent Deletion Date"
                    value={formatUtcDateTime(deleteScheduledForUtc)}
                  />
                </div>

                <div className="mt-6">
                  <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
                    Legal State
                  </div>
                  <div className="mt-2 text-[0.96rem] leading-[1.8] text-[#23373b]">
                    {isDeleted
                      ? "This record is currently in secure trash. It remains recoverable until the scheduled deletion date."
                      : isLocked
                        ? "This record has been permanently sealed. Its evidentiary state can no longer be modified."
                        : isArchived
                          ? "This record has been archived from the active workspace while remaining preserved in storage."
                          : "This record is active and available for review."}
                  </div>
                </div>
              </div>
            </Card>

            <Card
              className="relative overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="relative z-10 p-6 md:p-7">
                <div className="text-[1.1rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                  Record Actions
                </div>

                <div className="mt-6 flex flex-col gap-3">
                  <Button
                    onClick={handleDownloadReport}
                    disabled={actionBusy || plan === "FREE" || isDeleted}
                    className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                    style={landingPrimaryButtonStyle}
                  >
                    {t("downloadReport")}
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={handleDownloadVerificationPackage}
                    disabled={actionBusy || !verificationPackageAvailable || isDeleted}
                    className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                    style={landingSecondaryButtonStyle}
                  >
                    Download Verification Package
                  </Button>

                  <Link href={`/share/${evidenceId}`}>
                    <Button
                      variant="secondary"
                      disabled={isDeleted}
                      className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                      style={landingSecondaryButtonStyle}
                    >
                      {t("shareLink")}
                    </Button>
                  </Link>
                </div>

                <div className="mt-7 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#9b826b]">
                  Case & Organization
                </div>

                <div className="mt-3 flex flex-col gap-3">
                  <Button
                    variant="secondary"
                    onClick={handleOpenAssignCase}
                    disabled={actionBusy || ownedCases.length === 0}
                    className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                    style={landingSecondaryButtonStyle}
                  >
                    {caseId ? "Move to Case" : "Add to Case"}
                  </Button>

                  {caseId && (
                    <Button
                      variant="secondary"
                      onClick={handleRemoveFromCase}
                      disabled={actionBusy}
                      className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                      style={landingSecondaryButtonStyle}
                    >
                      Remove from Case
                    </Button>
                  )}
                </div>

                <div className="mt-7 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#9b826b]">
                  Preservation Actions
                </div>

                <div className="mt-3 flex flex-col gap-3">
                  <Button
                    onClick={handleLock}
                    disabled={
                      actionBusy ||
                      Boolean(lockedAt) ||
                      !(status === "SIGNED" || status === "REPORTED")
                    }
                    className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                    style={lockedAt ? landingSecondaryButtonStyle : landingBronzeButtonStyle}
                  >
                    {lockedAt ? "Permanently Locked" : "Lock Evidence Permanently"}
                  </Button>

                  {archivedAt ? (
                    <Button
                      variant="secondary"
                      onClick={handleUnarchive}
                      disabled={actionBusy}
                      className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                      style={landingSecondaryButtonStyle}
                    >
                      Restore Evidence
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={handleArchive}
                      disabled={actionBusy}
                      className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                      style={landingSecondaryButtonStyle}
                    >
                      Archive Evidence
                    </Button>
                  )}

                  <Button
                    onClick={handleDelete}
                    disabled={actionBusy || !canDelete}
                    className="w-full rounded-[20px] border px-5 py-4 text-[0.96rem] font-semibold"
                    style={canDelete ? landingDangerButtonStyle : landingSecondaryButtonStyle}
                  >
                    Delete Evidence
                  </Button>
                </div>

                <div
                  className="mt-5 rounded-[18px] px-4 py-4"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(214,184,157,0.04))",
                    border: "1px solid rgba(214,184,157,0.14)",
                    color: "#8f735a",
                    lineHeight: 1.75,
                  }}
                >
                  <strong>Trash retention:</strong> When moved to trash, this
                  record stays recoverable for 90 days before permanent deletion.
                </div>

                {plan === "FREE" && (
                  <div style={{ fontSize: 12, color: "#6a777b", marginTop: 10 }}>
                    Reports are disabled on Free. Upgrade to access PDF reports.
                  </div>
                )}

                {!verificationPackageAvailable && (
                  <div style={{ fontSize: 12, color: "#6a777b", marginTop: 8 }}>
                    Verification package is not available yet.
                  </div>
                )}
              </div>
            </Card>
          </div>

          {(sortedParts.length > 0 ||
            originalPreviewUrl ||
            originalDownloadUrl ||
            originalMimeType ||
            originalSizeBytes) && (
            <Card
              className="relative mt-6 overflow-hidden rounded-[34px] border bg-transparent p-0 shadow-none"
              style={outerCardStyle}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24)_0%,rgba(248,249,246,0.34)_42%,rgba(239,241,238,0.42)_100%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_12%,rgba(255,255,255,0.34),transparent_28%)] opacity-90" />

              <div className="relative z-10 p-6 md:p-8">
                <div className="text-[1.14rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                  {isMultipart ? "Original Evidence Materials" : "Original Evidence"}
                </div>

                <div
                  style={{
                    marginTop: 16,
                    marginBottom: 18,
                    padding: 16,
                    borderRadius: 18,
                    ...softCardStyle,
                    color: "#5d6d71",
                    maxWidth: 920,
                  }}
                >
                  {isMultipart
                    ? `This record contains ${sortedParts.length} original evidence items. Each item below can be reviewed and downloaded separately.`
                    : "Original submitted evidence file. This file is preserved as part of the record."}
                </div>

                {renderOriginalPreview()}

                {partsLoadFailed && (
                  <div
                    style={{
                      marginTop: 14,
                      padding: 12,
                      borderRadius: 14,
                      background: "rgba(239,68,68,0.08)",
                      border: "1px solid rgba(239,68,68,0.10)",
                      color: "#b42318",
                    }}
                  >
                    Failed to load evidence parts.
                  </div>
                )}
              </div>
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
              style={landingBronzeButtonStyle}
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
              style={landingDangerButtonStyle}
            >
              {actionBusy ? "Deleting..." : "Delete Evidence"}
            </Button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 14 }}>
          <div
            style={{
              padding: 16,
              borderRadius: 16,
              background:
                "linear-gradient(135deg, rgba(127,29,29,0.18), rgba(69,10,10,0.12))",
              border: "1px solid rgba(248,113,113,0.14)",
            }}
          >
            <div style={{ color: "#fecaca", fontWeight: 800, marginBottom: 6 }}>
              90-day recovery window
            </div>
            <div style={{ color: "rgba(254,202,202,0.86)", lineHeight: 1.7 }}>
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