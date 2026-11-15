"use client";

/**
 * "Open original" and "Download original" for the evidence page — extracted
 * from the orchestrator (page.tsx is held under an 80 KB byte guard).
 *
 * Wire contract D (2026-10-29): a record stored as several ORIGINAL files (a
 * segmented screen recording, a multi-file upload) has no single original.
 * The API answers 409 ORIGINAL_IS_MULTIPART instead of handing out part 0 as
 * if it were complete, and the originals are the parts listing — downloaded
 * one file at a time, each under its own RFC 6266 name. A single-file record
 * (a single-file recording included) downloads exactly as before.
 */
import { apiFetch, isApiResponseError } from "../../../../../lib/api";
import { captureException } from "../../../../../lib/sentry";
import { tryDownloadFile } from "../_tabs/_lib";
import {
  ARTIFACT_WINDOW_BLOCKED_MESSAGE,
  openArtifactUrlNow,
  openPendingArtifactWindow,
} from "../../../../../lib/evidence/artifact-window";

type Toast = (message: string, tone: "success" | "error" | "info") => void;

export function useOriginalDownload({
  evidenceId,
  addToast,
}: {
  evidenceId: string | null;
  addToast: Toast;
}) {
  /**
   * Wire contract D (2026-10-29) — a record stored as several ORIGINAL files
   * (a segmented screen recording, a multi-file upload) has no single
   * original: the API refuses to hand out part 0 as if it were complete
   * (409 ORIGINAL_IS_MULTIPART). The originals are its parts, one file each.
   */
  const isMultipartOriginal = (err: unknown): boolean =>
    isApiResponseError(err) && err.code === "ORIGINAL_IS_MULTIPART";

  const downloadOriginalParts = async () => {
    if (!evidenceId) return;
    const listing = (await apiFetch(`/v1/evidence/${evidenceId}/parts`)) as {
      originalDownloadBlockedByPolicy?: boolean;
      parts?: Array<{ partIndex: number; url?: string | null; displayName?: string | null; originalFileName?: string | null }>;
    };
    const parts = (listing.parts ?? []).filter((p) => Boolean(p.url));
    if (parts.length === 0) {
      addToast(
        listing.originalDownloadBlockedByPolicy
          ? "Original files are not available under this workspace's download policy"
          : "Original files not available",
        "info",
      );
      return;
    }
    // Sequential: one file at a time, each under its own name (the presigned
    // URL carries an RFC 6266 Content-Disposition).
    let blocked = 0;
    for (const part of parts) {
      const partUrl = part.url as string;
      const partFileName = part.originalFileName || part.displayName || `part-${part.partIndex + 1}`;
      const ok = await tryDownloadFile(partUrl, partFileName);
      // F-P1-04 — the fallback tab may be blocked after the awaits: count it.
      if (!ok && !openArtifactUrlNow(partUrl)) blocked += 1;
    }
    if (blocked > 0) {
      addToast(`${ARTIFACT_WINDOW_BLOCKED_MESSAGE} (${blocked} of ${parts.length} files did not open)`, "error");
      return;
    }
    addToast(`Original files downloaded (${parts.length} technical parts)`, "success");
  };

  const openOriginal = async () => {
    if (!evidenceId) return;
    // F-P1-04 — the tab opens IN the click, before the await (artifact-window.ts).
    const pending = openPendingArtifactWindow();
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/original`)) as {
        url?: string | null;
        publicUrl?: string | null;
      };
      const url = data.publicUrl ?? data.url ?? null;
      if (!url) {
        pending.close();
        addToast("Original file not available", "info");
        return;
      }
      if (pending.assign(url) === "blocked") addToast(ARTIFACT_WINDOW_BLOCKED_MESSAGE, "error");
    } catch (openError) {
      pending.close();
      if (isMultipartOriginal(openError)) {
        addToast("This record is stored as several original files. Use Download original files.", "info");
        return;
      }
      addToast("Failed to open original", "error");
      captureException(openError, { feature: "web_evidence_open_original", evidenceId });
    }
  };

  const downloadOriginal = async () => {
    if (!evidenceId) return;
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/original`)) as {
        url?: string | null;
        publicUrl?: string | null;
        originalFileName?: string | null;
      };
      const url = data.url ?? data.publicUrl ?? null;
      if (!url) {
        addToast("Original file not available", "info");
        return;
      }
      // Hoisted so BOTH arguments are plain identifiers at the call site.
      // The architecture audit resolves a request primitive by walking its
      // arguments; an inline `||` or property access made the site
      // unanalysable and forced a hand-reviewed exemption.
      const originalFileName = data.originalFileName || `evidence-${evidenceId}`;
      const ok = await tryDownloadFile(url, originalFileName);
      // F-P1-04 — a blocked fallback tab is said, never reported as downloaded.
      if (!ok && !openArtifactUrlNow(url)) {
        addToast(ARTIFACT_WINDOW_BLOCKED_MESSAGE, "error");
        return;
      }
      addToast(ok ? "Original downloaded" : "Original opened in a new tab", "success");
    } catch (downloadError) {
      if (isMultipartOriginal(downloadError)) {
        try {
          await downloadOriginalParts();
        } catch (partsError) {
          addToast("Failed to download original files", "error");
          captureException(partsError, { feature: "web_evidence_download_original_parts", evidenceId });
        }
        return;
      }
      addToast("Failed to download original", "error");
      captureException(downloadError, {
        feature: "web_evidence_download_original",
        evidenceId,
      });
    }
  };

  return { openOriginal, downloadOriginal };
}
