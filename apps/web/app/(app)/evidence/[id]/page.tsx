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
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) {
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
): { label: string; className: string } {
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

  if (rawName) return rawName;

  const mime = (part.mimeType ?? "").toLowerCase();
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

function renderAccentLastWord(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "Digital Evidence Record";

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return <span style={{ color: "#c3ebe2" }}>{parts[0]}</span>;
  }

  const last = parts.pop() ?? "";
  return (
    <>
      {parts.join(" ")} <span style={{ color: "#c3ebe2" }}>{last}</span>
    </>
  );
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
  const [deleteScheduledForUtc, setDeleteScheduledForUtc] = useState<string | null>(null);
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

  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null);
  const [originalDownloadUrl, setOriginalDownloadUrl] = useState<string | null>(null);
  const [originalMimeType, setOriginalMimeType] = useState<string | null>(null);
  const [originalSizeBytes, setOriginalSizeBytes] = useState<string | null>(null);
  const [originalFileName, setOriginalFileName] = useState<string | null>(null);

  const [parts, setParts] = useState<EvidencePart[]>([]);
  const [partsLoadFailed, setPartsLoadFailed] = useState(false);
  const [verificationPackageAvailable, setVerificationPackageAvailable] = useState(false);

  const isMultipart = parts.length > 1;
  const hasCase = Boolean(caseId);
  const isLocked = Boolean(lockedAt);
  const isArchived = Boolean(archivedAt);
  const isDeleted = Boolean(deletedAt);
  const canDelete = !isDeleted;

  const originalKind = useMemo(() => getEvidenceKind(originalMimeType), [originalMimeType]);

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
          setItemCount(typeof ev.itemCount === "number" && ev.itemCount > 0 ? ev.itemCount : 1);
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
          setVerificationPackageAvailable(Boolean(verificationPackageRes.value?.url));
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

    load();

    return () => {
      cancelled = true;
    };
  }, [params?.id]);

  const refreshEvidence = async () => {
    if (!params?.id) return;

    try {
      const [evidenceData, reportData, originalData, partsData, verificationData] =
        await Promise.allSettled([
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
        setItemCount(typeof ev.itemCount === "number" && ev.itemCount > 0 ? ev.itemCount : 1);
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
        evidenceId: params.id,
      });
      addToast("Failed to download report", "error");
    }
  };

  const handleDownloadVerificationPackage = async () => {
    if (!params?.id) return;

    try {
      addToast("Preparing verification package...", "info");
      const data = await apiFetch(`/v1/evidence/${params.id}/verification-package`);

      if (!data?.url) {
        addToast("Verification package not available", "info");
        return;
      }

      setVerificationPackageAvailable(true);
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
      let filename = originalFileName || "evidence-file";

      if (!downloadUrl) {
        const data = await apiFetch(`/v1/evidence/${params.id}/original`);
        downloadUrl = data?.url ?? data?.publicUrl ?? null;

        setOriginalPreviewUrl(data?.publicUrl ?? data?.url ?? null);
        setOriginalDownloadUrl(downloadUrl);
        setOriginalMimeType(data?.mimeType ?? null);
        setOriginalSizeBytes(data?.sizeBytes ?? null);
        setOriginalFileName(data?.originalFileName ?? null);

        if (data?.originalFileName) {
          filename = data.originalFileName;
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
      const ok = await tryDownloadFile(url, getPartDisplayName(part));
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

  const outerCardStyle = useMemo(
    () =>
      ({
        border: "1px solid rgba(79,112,107,0.16)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
      }) as const,
    []
  );

  const heroEditButtonStyle = useMemo(
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

  const heroPrimaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(158,216,207,0.14)",
        color: "#aebbb6",
        background:
          "linear-gradient(180deg, rgba(62,98,96,0.26) 0%, rgba(14,30,34,0.38) 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }) as const,
    []
  );

  const heroSecondaryButtonStyle = useMemo(
    () =>
      ({
        borderColor: "rgba(79,112,107,0.18)",
        color: "#aebbb6",
        backgroundImage:
          "linear-gradient(180deg, rgba(8,20,24,0.78) 0%, rgba(7,18,22,0.88) 100%), url('/images/site-velvet-bg.webp.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.03), 0 14px 28px rgba(0,0,0,0.10)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
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

  const heroReportReadyStyle = {
    border: "1px solid rgba(158,216,207,0.18)",
    background:
      "linear-gradient(180deg, rgba(191,232,223,0.16) 0%, rgba(255,255,255,0.05) 100%)",
    color: "#dff4ef",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 10px rgba(60,110,102,0.10)",
  } as const;

  const silverReportReadyStyle = {
    border: "1px solid rgba(79,112,107,0.14)",
    background:
      "linear-gradient(180deg, rgba(191,232,223,0.24) 0%, rgba(255,255,255,0.55) 100%)",
    color: "#2d5b59",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.55), 0 6px 14px rgba(41,83,85,0.05)",
  } as const;

  return (
    <div className="section app-section evidence-detail-page-shell">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ width: "100%", maxWidth: 960 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#afbbb7",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
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
                className="evidence-record-badges"
                style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}
              >
                {displayStatusMeta.label === "Report Ready" ? (
                  <span className="evidence-pill evidence-pill-case" style={heroReportReadyStyle}>
                    Report Ready
                  </span>
                ) : (
                  <span className={displayStatusMeta.className}>
                    {displayStatusMeta.label}
                  </span>
                )}

                {hasCase && (
                  <span className="evidence-pill evidence-pill-case">
                    Case Attached
                  </span>
                )}

                {isLocked && <span className="evidence-pill evidence-pill-locked">Locked</span>}
                {isArchived && <span className="evidence-pill evidence-pill-archived">Archived</span>}
                {isDeleted && <span className="evidence-pill evidence-pill-deleted">In Trash</span>}
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
                    className="max-w-[900px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                    style={{ margin: 0 }}
                  >
                    {renderAccentLastWord(label)}
                  </h1>

                  <Button
                    variant="secondary"
                    onClick={handleStartEditLabel}
                    disabled={loading || actionBusy || labelBusy || isDeleted}
                    className="rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                    style={heroEditButtonStyle}
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
                    style={heroSecondaryButtonStyle}
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
                  color: "#aab5b2",
                }}
              >
                {displaySubtitle || `${itemCount} item${itemCount === 1 ? "" : "s"}`}
              </p>

              <div
                className="evidence-hero-meta"
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
                    This evidence has been moved to secure trash. It remains recoverable until{" "}
                    <strong>{formatUtcDateTime(deleteScheduledForUtc)}</strong>. After that date,
                    it is scheduled for permanent deletion.
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
  <div
    style={{
      display: "grid",
      gap: 20,
      gridTemplateColumns: "minmax(0, 1.08fr) minmax(0, 0.92fr)",
      alignItems: "start",
    }}
  >
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
        <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#21353a]">
          Record Summary
        </div>

        <div
          className="mt-5 grid gap-4 sm:grid-cols-2"
          style={{ color: "#5d6d71" }}
        >
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              User Label
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {label}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Original Submitted File
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {originalFileName || "Original filename not available"}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Record ID
            </div>
            <div className="mt-2 break-all text-[0.96rem] leading-[1.75] text-[#23373b]">
              {evidenceId}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Evidence Type
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {getEvidenceTypeLabel(evidenceType)}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Structure
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {isMultipart
                ? `Multipart record (${sortedParts.length} items)`
                : "Single-file record"}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Evidence Composition
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {partTypeSummary.imageCount > 0 && (
                <span
                  className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                  style={silverReportReadyStyle}
                >
                  {partTypeSummary.imageCount} image
                  {partTypeSummary.imageCount > 1 ? "s" : ""}
                </span>
              )}

              {partTypeSummary.videoCount > 0 && (
                <span
                  className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                  style={{
                    border: "1px solid rgba(79,112,107,0.12)",
                    background:
                      "linear-gradient(180deg, rgba(240,243,241,0.92) 0%, rgba(255,255,255,0.68) 100%)",
                    color: "#31484d",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.56), 0 6px 14px rgba(0,0,0,0.03)",
                  }}
                >
                  {partTypeSummary.videoCount} video
                  {partTypeSummary.videoCount > 1 ? "s" : ""}
                </span>
              )}

              {partTypeSummary.audioCount > 0 && (
                <span
                  className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                  style={{
                    border: "1px solid rgba(183,157,132,0.16)",
                    background:
                      "linear-gradient(180deg, rgba(244,238,232,0.88) 0%, rgba(255,255,255,0.64) 100%)",
                    color: "#7a624d",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.58), 0 6px 14px rgba(92,69,50,0.04)",
                  }}
                >
                  {partTypeSummary.audioCount} audio
                </span>
              )}

              {partTypeSummary.pdfCount > 0 && (
                <span
                  className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                  style={{
                    border: "1px solid rgba(183,157,132,0.16)",
                    background:
                      "linear-gradient(180deg, rgba(248,243,238,0.9) 0%, rgba(255,255,255,0.66) 100%)",
                    color: "#8a6e57",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.58), 0 6px 14px rgba(92,69,50,0.04)",
                  }}
                >
                  {partTypeSummary.pdfCount} document
                  {partTypeSummary.pdfCount > 1 ? "s" : ""}
                </span>
              )}

              {partTypeSummary.otherCount > 0 && (
                <span
                  className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                  style={{
                    border: "1px solid rgba(79,112,107,0.12)",
                    background:
                      "linear-gradient(180deg, rgba(240,243,241,0.92) 0%, rgba(255,255,255,0.68) 100%)",
                    color: "#5f6d71",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.56), 0 6px 14px rgba(0,0,0,0.03)",
                  }}
                >
                  {partTypeSummary.otherCount} other
                </span>
              )}

              {partTypeSummary.imageCount === 0 &&
                partTypeSummary.videoCount === 0 &&
                partTypeSummary.audioCount === 0 &&
                partTypeSummary.pdfCount === 0 &&
                partTypeSummary.otherCount === 0 && (
                  <div className="text-[0.92rem] leading-[1.7] text-[#5d6d71]">
                    Not available
                  </div>
                )}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Case Assignment
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {caseId ? "Attached to case" : "Not assigned to any case"}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Subscription Plan
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {plan}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Current Status
            </div>
            <div style={{ marginTop: 10 }}>
              {displayStatusMeta.label === "Report Ready" ? (
                <span
                  className="inline-flex items-center rounded-full px-3 py-1.5 text-[0.76rem] font-semibold"
                  style={silverReportReadyStyle}
                >
                  Report Ready
                </span>
              ) : (
                <span className={displayStatusMeta.className}>
                  {displayStatusMeta.label}
                </span>
              )}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Recorded At
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {formatUtcDateTime(createdAt)}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Locked At
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {formatUtcDateTime(lockedAt)}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Archived At
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {formatUtcDateTime(archivedAt)}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Deleted At
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {formatUtcDateTime(deletedAt)}
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-[#9b826b]">
              Permanent Deletion Date
            </div>
            <div className="mt-2 text-[0.96rem] leading-[1.75] text-[#23373b]">
              {formatUtcDateTime(deleteScheduledForUtc)}
            </div>
          </div>

          <div className="sm:col-span-2">
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
        <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#21353a]">
          Record Actions
        </div>

        <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
          <Button
            onClick={handleDownloadReport}
            disabled={actionBusy || plan === "FREE" || isDeleted}
            className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
            style={landingPrimaryButtonStyle}
          >
            {t("downloadReport")}
          </Button>

          <Button
            variant="secondary"
            onClick={handleDownloadVerificationPackage}
            disabled={actionBusy || !verificationPackageAvailable || isDeleted}
            className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
            style={landingSecondaryButtonStyle}
          >
            Download Verification Package
          </Button>

          <Link href={`/share/${evidenceId}`}>
            <Button
              variant="secondary"
              disabled={isDeleted}
              className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
              style={landingTertiaryButtonStyle}
            >
              {t("shareLink")}
            </Button>
          </Link>
        </div>

        {plan === "FREE" && (
          <div style={{ fontSize: 12, color: "#6a777b", marginTop: 10 }}>
            Reports are disabled on Free. Upgrade to access PDF reports.
          </div>
        )}

        {!verificationPackageAvailable && (
          <div style={{ fontSize: 12, color: "#6a777b", marginTop: 10 }}>
            Verification package is not available yet.
          </div>
        )}

        <div
          className="mt-5 mb-3 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#9b826b]"
        >
          Case & Organization
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          <Button
            variant="secondary"
            onClick={handleOpenAssignCase}
            disabled={actionBusy || ownedCases.length === 0}
            className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
            style={landingSecondaryButtonStyle}
          >
            {caseId ? "Move to Case" : "Add to Case"}
          </Button>

          {caseId && (
            <Button
              variant="secondary"
              onClick={handleRemoveFromCase}
              disabled={actionBusy}
              className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
              style={landingTertiaryButtonStyle}
            >
              Remove from Case
            </Button>
          )}
        </div>

        <div
          className="mt-5 mb-3 text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#9b826b]"
        >
          Preservation Actions
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          <Button
            onClick={handleLock}
            disabled={
              actionBusy ||
              Boolean(lockedAt) ||
              !(status === "SIGNED" || status === "REPORTED")
            }
            className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
            style={lockedAt ? landingSecondaryButtonStyle : landingDangerButtonStyle}
          >
            {lockedAt ? "Permanently Locked" : "Lock Evidence Permanently"}
          </Button>

          {archivedAt ? (
            <Button
              variant="secondary"
              onClick={handleUnarchive}
              disabled={actionBusy}
              className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Restore Evidence
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={handleArchive}
              disabled={actionBusy}
              className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Archive Evidence
            </Button>
          )}

          {!isDeleted && (
            <Button
              onClick={handleDelete}
              disabled={actionBusy || !canDelete}
              className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
              style={canDelete ? landingDeleteButtonStyle : landingSecondaryButtonStyle}
            >
              Delete Evidence
            </Button>
          )}

          {isDeleted && (
            <Button
              variant="secondary"
              onClick={handleRestoreDeleted}
              disabled={actionBusy}
              className="w-full rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
              style={landingSecondaryButtonStyle}
            >
              Restore from Trash
            </Button>
          )}
        </div>

        {lockedAt && (
          <div style={{ fontSize: 12, color: "#6a777b", paddingTop: 10 }}>
            ✓ This record is legally sealed and can no longer be edited.
          </div>
        )}

        {!archivedAt && !isDeleted && (
          <div style={{ fontSize: 12, color: "#6a777b", paddingTop: 10 }}>
            Archive this record to remove it from active review while preserving it in storage.
          </div>
        )}

        {archivedAt && (
          <div style={{ fontSize: 12, color: "#6a777b", paddingTop: 10 }}>
            This record is archived. Restore it to return it to the active workspace.
          </div>
        )}

        <div
          style={{
            marginTop: 16,
            padding: 14,
            borderRadius: 16,
            background:
              "linear-gradient(135deg, rgba(214,184,157,0.10), rgba(214,184,157,0.04))",
            border: "1px solid rgba(214,184,157,0.14)",
            color: "#8f735a",
            lineHeight: 1.7,
          }}
        >
          <strong>Trash retention:</strong> When moved to trash, this
          record stays recoverable for 90 days before permanent deletion.
        </div>
      </div>
    </Card>
  </div>

  {(sortedParts.length > 0 ||
    originalPreviewUrl ||
    originalDownloadUrl ||
    originalMimeType ||
    originalSizeBytes) && (
    <Card
      className="relative mt-6 overflow-hidden rounded-[30px] border bg-transparent p-0 shadow-none"
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
        <div className="text-[1.08rem] font-semibold tracking-[-0.02em] text-[#21353a]">
          Original Evidence
        </div>

        {!isMultipart ? (
          <>
            <div
              style={{
                marginTop: 16,
                marginBottom: 16,
                padding: 14,
                borderRadius: 16,
                ...softCardStyle,
                color: "#5d6d71",
              }}
            >
              Original submitted evidence file. This file is preserved as part of the record.
            </div>

            <div
              style={{
                marginBottom: 14,
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
                marginBottom: 16,
              }}
            >
              <Button
                variant="secondary"
                onClick={handleOpenOriginal}
                disabled={!originalDownloadUrl || isDeleted}
                className="rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
                style={landingSecondaryButtonStyle}
              >
                Open Original
              </Button>

              <Button
                variant="secondary"
                onClick={handleDownloadOriginal}
                disabled={!originalDownloadUrl || isDeleted}
                className="rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
                style={landingTertiaryButtonStyle}
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
                    maxWidth: 520,
                    margin: "0 auto",
                    display: "block",
                    borderRadius: 18,
                    border: "1px solid rgba(79,112,107,0.10)",
                    boxShadow: "0 14px 28px rgba(0,0,0,0.08)",
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
                    maxWidth: 520,
                    margin: "0 auto",
                    display: "block",
                    borderRadius: 18,
                    border: "1px solid rgba(79,112,107,0.10)",
                    boxShadow: "0 14px 28px rgba(0,0,0,0.08)",
                  }}
                />
              </div>
            )}

            {originalPreviewUrl && originalKind === "audio" && (
              <div
                style={{
                  marginBottom: 12,
                  padding: 14,
                  borderRadius: 14,
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
              <div style={{ marginBottom: 12 }}>
                <iframe
                  src={originalPreviewUrl}
                  title="Original PDF evidence"
                  style={{
                    width: "100%",
                    minHeight: 560,
                    borderRadius: 18,
                    border: "1px solid rgba(79,112,107,0.10)",
                    background: "#fff",
                    boxShadow: "0 14px 28px rgba(0,0,0,0.08)",
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
            {sortedParts.map((part) => {
              const kind = getEvidenceKind(part.mimeType ?? null);
              const previewUrl = part.publicUrl ?? part.url ?? null;
              const downloadUrl = part.url ?? part.publicUrl ?? null;
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
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800, color: "#23373b" }}>
                        Item {part.partIndex + 1}
                        {part.isPrimary ? " (Primary)" : ""}
                      </div>
                      <div style={{ fontSize: 13, color: "#6a777b", marginTop: 4 }}>
                        {displayName}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <Button
                        variant="secondary"
                        onClick={() => handleOpenPart(part)}
                        disabled={!downloadUrl || isDeleted}
                        className="rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
                        style={landingSecondaryButtonStyle}
                      >
                        Open
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleDownloadPart(part)}
                        disabled={!downloadUrl || isDeleted}
                        className="rounded-[999px] border px-4 py-2.5 text-[0.86rem] font-semibold"
                        style={landingTertiaryButtonStyle}
                      >
                        Download
                      </Button>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 6,
                      marginTop: 12,
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
                        maxWidth: 420,
                        margin: "0 auto",
                        display: "block",
                        borderRadius: 16,
                        border: "1px solid rgba(79,112,107,0.10)",
                        boxShadow: "0 12px 24px rgba(0,0,0,0.06)",
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
                        maxWidth: 420,
                        margin: "0 auto",
                        display: "block",
                        borderRadius: 16,
                        border: "1px solid rgba(79,112,107,0.10)",
                        boxShadow: "0 12px 24px rgba(0,0,0,0.06)",
                      }}
                    />
                  )}
                </div>
              );
            })}
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

<style jsx global>{`
  @media (max-width: 1100px) {
    .evidence-detail-page-shell .container > div[style*="grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr)"] {
      grid-template-columns: 1fr !important;
    }
  }
`}</style>
    </div>
  );
}