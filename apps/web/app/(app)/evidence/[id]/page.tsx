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
  const [plan, setPlan] = useState<string>("FREE");
  const [caseId, setCaseId] = useState<string | null>(null);

  const [title, setTitle] = useState<string>("Digital Evidence Record");
  const [displaySubtitle, setDisplaySubtitle] = useState<string>("");
  const [itemCount, setItemCount] = useState<number>(1);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleBusy, setTitleBusy] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [lockModalOpen, setLockModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);

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

  const [parts, setParts] = useState<EvidencePart[]>([]);
  const [partsLoadFailed, setPartsLoadFailed] = useState(false);
  const [verificationPackageAvailable, setVerificationPackageAvailable] =
    useState(false);

  const isMultipart = parts.length > 1;

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

  const isImmutable = useMemo(() => {
    const normalized = status.trim().toUpperCase();
    return Boolean(lockedAt) || normalized === "SIGNED" || normalized === "REPORTED";
  }, [status, lockedAt]);

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
          setCaseId(ev.caseId ?? null);
          setTitle(resolveDisplayTitle(ev));
          setTitleDraft(resolveDisplayTitle(ev));
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
        } else {
          setOriginalPreviewUrl(null);
          setOriginalDownloadUrl(null);
          setOriginalMimeType(null);
          setOriginalSizeBytes(null);
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
        setCaseId(ev.caseId ?? null);
        setTitle(resolveDisplayTitle(ev));
        setTitleDraft(resolveDisplayTitle(ev));
        setDisplaySubtitle(resolveDisplaySubtitle(ev));
        setItemCount(
          typeof ev.itemCount === "number" && ev.itemCount > 0 ? ev.itemCount : 1
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
      } else {
        setOriginalPreviewUrl(null);
        setOriginalDownloadUrl(null);
        setOriginalMimeType(null);
        setOriginalSizeBytes(null);
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

  const handleStartEditTitle = () => {
    if (isImmutable) return;
    setTitleDraft(title);
    setIsEditingTitle(true);
  };

  const handleCancelEditTitle = () => {
    setTitleDraft(title);
    setIsEditingTitle(false);
  };

  const handleSaveTitle = async () => {
    if (!params?.id) return;

    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      addToast("Title cannot be empty", "error");
      return;
    }

    setTitleBusy(true);
    try {
      const data = await apiFetch(`/v1/evidence/${params.id}/title`, {
        method: "PATCH",
        body: JSON.stringify({ title: nextTitle }),
      });

      const ev = data?.evidence ?? {};
      const nextResolvedTitle = data?.displayTitle || resolveDisplayTitle(ev);
      const nextResolvedSubtitle =
        data?.displaySubtitle || resolveDisplaySubtitle(ev);

      setTitle(nextResolvedTitle);
      setTitleDraft(nextResolvedTitle);
      setDisplaySubtitle(nextResolvedSubtitle);
      setItemCount(
        typeof data?.itemCount === "number" && data.itemCount > 0
          ? data.itemCount
          : itemCount
      );
      setIsEditingTitle(false);
      addToast("Evidence title updated", "success");
    } catch (err) {
      captureException(err, {
        feature: "web_evidence_update_title",
        evidenceId: params.id,
      });
      const message =
        err instanceof Error ? err.message : "Failed to update title";
      addToast(message, "error");
    } finally {
      setTitleBusy(false);
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
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div style={{ width: "100%" }}>
              {!isEditingTitle ? (
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
                    {title}
                  </h1>

                  <Button
                    variant="secondary"
                    onClick={handleStartEditTitle}
                    disabled={loading || actionBusy || titleBusy || isImmutable}
                  >
                    Rename
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
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    maxLength={160}
                    disabled={titleBusy}
                    style={{
                      minWidth: 320,
                      maxWidth: "100%",
                      flex: "1 1 420px",
                      padding: "12px 14px",
                      borderRadius: 12,
                      border: "1px solid rgba(148,163,184,0.25)",
                      background: "rgba(15, 23, 42, 0.45)",
                      color: "#e2e8f0",
                      fontSize: 16,
                      fontWeight: 700,
                    }}
                  />

                  <Button onClick={handleSaveTitle} disabled={titleBusy}>
                    {titleBusy ? "Saving..." : "Save"}
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={handleCancelEditTitle}
                    disabled={titleBusy}
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <p
                className="page-subtitle pricing-subtitle"
                style={{ marginTop: 8 }}
              >
                {displaySubtitle || `${itemCount} item${itemCount === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <div className="grid-2">
            <Card>
              <div className="status-banner">
                <div
                  style={{
                    width: 54,
                    height: 54,
                    borderRadius: 16,
                    background: "rgba(255,255,255,0.18)",
                    display: "grid",
                    placeItems: "center",
                    fontWeight: 900,
                  }}
                >
                  ✓
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{title}</div>
                  <div style={{ marginTop: 6 }}>
                    <span className={displayStatusMeta.className}>
                      {displayStatusMeta.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 8 }}>
                    {displaySubtitle ||
                      (createdAt
                        ? `Created ${new Date(createdAt).toLocaleString()}`
                        : "—")}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                {loading ? (
                  <div className="app-loading">Loading…</div>
                ) : error ? (
                  <div className="error-text">{error}</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div className="row" style={{ borderTop: "none", paddingTop: 0 }}>
                      <div className="rowTitle evidence-meta-label">Status</div>
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <span className={displayStatusMeta.className}>
                          {displayStatusMeta.label}
                        </span>
                      </div>
                    </div>

                    <div className="row">
                      <div className="rowTitle evidence-meta-label">State</div>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          justifyContent: "flex-end",
                        }}
                      >
                        {lockedAt && (
                          <span
                            style={{
                              fontSize: 14,
                              fontWeight: 700,
                              color: "#65ebff",
                            }}
                          >
                            Evidence Locked
                          </span>
                        )}
                        {archivedAt && (
                          <span
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: "#94a3b8",
                            }}
                          >
                            Archived
                          </span>
                        )}
                        {!lockedAt && !archivedAt && (
                          <span style={{ color: "#94a3b8" }}>Active</span>
                        )}
                      </div>
                    </div>

                    <div className="row">
                      <div className="rowTitle evidence-meta-label">Case</div>
                      <div className="rowSub" style={{ margin: 0 }}>
                        {caseId ? "Attached to case" : "Not assigned to any case"}
                      </div>
                    </div>

                    <div className="row">
                      <div className="rowTitle evidence-meta-label">Structure</div>
                      <div className="rowSub" style={{ margin: 0 }}>
                        {isMultipart
                          ? `Multipart (${sortedParts.length} items)`
                          : "Single file"}
                      </div>
                    </div>

                    {isMultipart && (
                      <div className="row">
                        <div className="rowTitle evidence-meta-label">Contents</div>
                        <div
                          className="rowSub"
                          style={{ margin: 0, textAlign: "right" }}
                        >
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

                    {lockedAt && (
                      <div
                        className="row"
                        style={{
                          borderTop: "1px solid rgba(101, 235, 255, 0.15)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 13,
                            color: "#cbd5e1",
                            lineHeight: 1.5,
                          }}
                        >
                          This evidence is permanently sealed and cannot be modified.
                        </div>
                      </div>
                    )}

                    {archivedAt && (
                      <div
                        className="row"
                        style={{
                          borderTop: "1px solid rgba(148, 163, 184, 0.15)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 13,
                            color: "#cbd5e1",
                            lineHeight: 1.5,
                          }}
                        >
                          This evidence has been archived and removed from your
                          active workspace.
                        </div>
                      </div>
                    )}

                    <div className="row">
                      <div className="rowTitle evidence-meta-label">Plan</div>
                      <div className="rowSub" style={{ margin: 0 }}>
                        {plan}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>Actions</div>

              <div className="footer-actions">
                <Button
                  onClick={handleDownloadReport}
                  disabled={actionBusy || plan === "FREE"}
                >
                  {t("downloadReport")}
                </Button>

                <Button
                  variant="secondary"
                  onClick={handleDownloadVerificationPackage}
                  disabled={actionBusy || !verificationPackageAvailable}
                >
                  Download Verification Package
                </Button>

                <Link href={`/share/${evidenceId}`}>
                  <Button variant="secondary">{t("shareLink")}</Button>
                </Link>
              </div>

              {plan === "FREE" && (
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
                  Reports are disabled on Free. Upgrade to access PDF reports.
                </div>
              )}

              {!verificationPackageAvailable && (
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
                  Verification package is not available yet.
                </div>
              )}

              <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
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
                  {lockedAt ? "Permanently Locked" : "Lock Evidence Permanently"}
                </Button>

                {lockedAt && (
                  <div
                    style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}
                  >
                    ✓ This evidence is legally sealed and cannot be edited.
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
                      style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}
                    >
                      This evidence is archived. Click restore to bring it back to
                      your active workspace.
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
                      style={{ fontSize: 12, color: "#64748b", padding: "8px 0" }}
                    >
                      Archive this evidence to remove it from your active
                      workspace.
                    </div>
                  </>
                )}
              </div>
            </Card>
          </div>

          {(sortedParts.length > 0 ||
            originalPreviewUrl ||
            originalDownloadUrl ||
            originalMimeType ||
            originalSizeBytes) && (
            <Card className="mt-6">
              <div style={{ fontWeight: 800, marginBottom: 12 }}>
                {isMultipart ? "Evidence Items" : "Original Evidence"}
              </div>

              {isMultipart ? (
                <>
                  <div
                    style={{
                      marginBottom: 16,
                      padding: 14,
                      borderRadius: 12,
                      background: "rgba(15,23,42,0.35)",
                      color: "#cbd5e1",
                      fontSize: 14,
                      lineHeight: 1.6,
                    }}
                  >
                    This evidence contains <strong>{sortedParts.length}</strong>{" "}
                    items. Each item below can be previewed and downloaded
                    separately.
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 16,
                    }}
                  >
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
                            borderRadius: 14,
                            background: "rgba(15,23,42,0.28)",
                            border: "1px solid rgba(148,163,184,0.12)",
                            display: "grid",
                            gap: 10,
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
                              <div style={{ fontWeight: 800, color: "#e2e8f0" }}>
                                Item {part.partIndex + 1}
                                {part.isPrimary ? " (Primary)" : ""}
                              </div>
                              <div
                                style={{
                                  fontSize: 13,
                                  color: "#94a3b8",
                                  marginTop: 4,
                                }}
                              >
                                {displayName}
                              </div>
                            </div>

                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              <Button
                                variant="secondary"
                                onClick={() => handleOpenPart(part)}
                                disabled={!downloadUrl}
                              >
                                Open
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={() => handleDownloadPart(part)}
                                disabled={!downloadUrl}
                              >
                                Download
                              </Button>
                            </div>
                          </div>

                          <div
                            style={{
                              display: "grid",
                              gap: 4,
                              fontSize: 13,
                              color: "#94a3b8",
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
                                display: "block",
                                width: "100%",
                                maxWidth: "100%",
                                maxHeight: 560,
                                objectFit: "contain",
                                borderRadius: 12,
                                background: "rgba(15,23,42,0.35)",
                              }}
                            />
                          )}

                          {previewUrl && kind === "video" && (
                            <video
                              src={previewUrl}
                              controls
                              preload="metadata"
                              style={{
                                display: "block",
                                width: "100%",
                                maxWidth: "100%",
                                maxHeight: 560,
                                borderRadius: 12,
                                background: "#000",
                              }}
                            />
                          )}

                          {previewUrl && kind === "audio" && (
                            <div
                              style={{
                                padding: 16,
                                borderRadius: 12,
                                background: "rgba(15,23,42,0.35)",
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
                            <div
                              style={{
                                borderRadius: 12,
                                overflow: "hidden",
                                background: "#fff",
                              }}
                            >
                              <iframe
                                src={previewUrl}
                                title={`Evidence PDF item ${part.partIndex + 1}`}
                                style={{
                                  width: "100%",
                                  height: 760,
                                  border: "none",
                                  display: "block",
                                }}
                              />
                            </div>
                          )}

                          {!previewUrl && (
                            <div
                              style={{
                                padding: 14,
                                borderRadius: 12,
                                background: "rgba(15,23,42,0.35)",
                                color: "#94a3b8",
                                fontSize: 14,
                                lineHeight: 1.6,
                              }}
                            >
                              Preview is not available for this item right now.
                            </div>
                          )}

                          {previewUrl && (kind === "text" || kind === "other") && (
                            <div
                              style={{
                                padding: 14,
                                borderRadius: 12,
                                background: "rgba(15,23,42,0.35)",
                                color: "#cbd5e1",
                                fontSize: 14,
                                lineHeight: 1.6,
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
                      style={{
                        marginTop: 14,
                        padding: 16,
                        borderRadius: 12,
                        background: "rgba(15,23,42,0.35)",
                        color: "#94a3b8",
                        fontSize: 14,
                        lineHeight: 1.6,
                      }}
                    >
                      Failed to load evidence parts.
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div
                    style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}
                  >
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
                      disabled={!originalDownloadUrl}
                    >
                      Open Original
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={handleDownloadOriginal}
                      disabled={!originalDownloadUrl}
                    >
                      Download Original
                    </Button>
                  </div>

                  {originalPreviewUrl && originalKind === "image" && (
                    <div style={{ marginBottom: 12 }}>
                      <img
                        src={originalPreviewUrl}
                        alt="Evidence preview"
                        style={{
                          display: "block",
                          width: "100%",
                          maxWidth: "100%",
                          maxHeight: 560,
                          objectFit: "contain",
                          borderRadius: 12,
                          background: "rgba(15,23,42,0.35)",
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
                        style={{
                          display: "block",
                          width: "100%",
                          maxWidth: "100%",
                          maxHeight: 560,
                          borderRadius: 12,
                          background: "#000",
                        }}
                      />
                    </div>
                  )}

                  {originalPreviewUrl && originalKind === "audio" && (
                    <div
                      style={{
                        marginBottom: 12,
                        padding: 16,
                        borderRadius: 12,
                        background: "rgba(15,23,42,0.35)",
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
                      style={{
                        marginBottom: 12,
                        borderRadius: 12,
                        overflow: "hidden",
                        background: "#fff",
                      }}
                    >
                      <iframe
                        src={originalPreviewUrl}
                        title="Original PDF evidence"
                        style={{
                          width: "100%",
                          height: 760,
                          border: "none",
                          display: "block",
                        }}
                      />
                    </div>
                  )}

                  {!originalPreviewUrl &&
                    (originalKind === "text" || originalKind === "other") && (
                      <div
                        style={{
                          marginBottom: 12,
                          padding: 16,
                          borderRadius: 12,
                          background: "rgba(15,23,42,0.35)",
                          color: "#cbd5e1",
                          fontSize: 14,
                          lineHeight: 1.6,
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
                      style={{
                        padding: 16,
                        borderRadius: 12,
                        background: "rgba(15,23,42,0.35)",
                        color: "#94a3b8",
                        fontSize: 14,
                        lineHeight: 1.6,
                      }}
                    >
                      Original file is not available for preview or download at
                      this time.
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
              padding: 10,
              borderRadius: 10,
              border: "1px solid rgba(148, 163, 184, 0.25)",
              background: "rgba(15, 23, 42, 0.45)",
              color: "#e2e8f0",
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
        <div style={{ fontSize: 15, lineHeight: 1.6, color: "#e2e8f0" }}>
          <p style={{ marginBottom: 16 }}>Once locked:</p>
          <ul style={{ marginLeft: 20, marginBottom: 16, color: "#cbd5e1" }}>
            <li style={{ marginBottom: 8 }}>• The evidence cannot be edited</li>
            <li>• It becomes legally sealed</li>
          </ul>
          <p style={{ marginTop: 16, fontWeight: 600, color: "#f87171" }}>
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
        <div style={{ fontSize: 15, lineHeight: 1.6, color: "#e2e8f0" }}>
          <p style={{ marginBottom: 12 }}>
            This will remove the evidence from your active workspace.
          </p>
          <p style={{ marginBottom: 12 }}>
            The evidence will remain stored and can be restored later if needed.
          </p>
        </div>
      </Modal>
    </div>
  );
}