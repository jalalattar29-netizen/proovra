/**
 * ARTIFACT HISTORY (T-14 ArtifactHistorySection) — every retained report and
 * verification-package version, from the review workspace
 * (`artifactVersions.history`), and the verification-package download.
 *
 * Every URL is minted ON TAP: GET …/verification-package, …/reports/:v and
 * …/verification-packages/:v record a custody download, so nothing here is
 * fetched on load. Pure: no React, no fetch.
 */

import { resolveArtifactDownloadFailure, type ArtifactKind } from "@proovra/shared";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ArtifactVersion {
  version: number;
  generatedAtIso: string | null;
  sizeBytes: string | null;
  latest: boolean;
  immutableRecorded: boolean;
  /** Packages only: the report version this package certifies (2026-09-29). */
  certifiesReportVersion: number | null;
  /**
   * Packages only: format 5 (sealed). An older package's signed anchoring
   * statement predates the chain-check rule (2026-09-29).
   */
  sealed: boolean;
}

export interface ArtifactHistory {
  reports: ArtifactVersion[];
  packages: ArtifactVersion[];
}

function versions(v: unknown): ArtifactVersion[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((x) => typeof x.version === "number")
    .map((x) => ({
      version: x.version as number,
      generatedAtIso: str(x.generatedAtUtc),
      sizeBytes: typeof x.sizeBytes === "number" ? String(x.sizeBytes) : str(x.sizeBytes),
      latest: x.latest === true,
      immutableRecorded: x.immutableRecorded === true,
      certifiesReportVersion:
        typeof x.certifiesReportVersion === "number" ? (x.certifiesReportVersion as number) : null,
      sealed: x.sealed === true,
    }));
}

export function projectArtifactHistory(rw: unknown): ArtifactHistory {
  const h = obj(obj(obj(rw).artifactVersions).history);
  return { reports: versions(h.reports), packages: versions(h.verificationPackages) };
}

export function buildPackageDownloadPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/verification-package`;
}
export function buildReportVersionPath(evidenceId: string, version: number): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/reports/${version}`;
}
export function buildPackageVersionPath(evidenceId: string, version: number): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/verification-packages/${version}`;
}

/**
 * RGA-04 — a report/package download failure in the ONE shared vocabulary
 * (`resolveArtifactDownloadFailure`, the same authority the web uses). A
 * failure it does not recognise gets a safe generic sentence, never raw text.
 */
export function artifactDownloadMessage(
  kind: ArtifactKind,
  error: { code?: string | null; statusCode?: number | null } | null,
  version?: number | null,
): string {
  const resolved = resolveArtifactDownloadFailure(
    kind,
    { code: error?.code ?? undefined, statusCode: error?.statusCode ?? undefined },
    { version: version ?? null },
  );
  if (resolved) return resolved.message;
  const noun = kind === "report" ? "report" : "verification package";
  return version != null ? `Could not download ${noun} v${version}.` : `Could not download the ${noun}.`;
}

/** Kept for existing callers: the package's bounded codes, through the shared authority. */
export function packageDownloadMessage(code: string | null, status: number | null): string {
  return artifactDownloadMessage("verificationPackage", {
    code,
    // A 2xx body with a code and no URL (e.g. still pending) reads as 202.
    statusCode: status ?? (code ? 202 : 503),
  });
}

/** "1.2 MB" style, or null. */
export function formatArtifactSize(bytes: string | null): string | null {
  const n = bytes === null ? NaN : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * MATCHED PAIRS (2026-10-06) — one row per immutable report version with the
 * package that certifies it, from `/artifacts/status` `versions` (the server's
 * own pairing). Null when an older API does not send it; the caller then shows
 * the per-family lists above.
 */
export interface MatchedPairView {
  reportVersion: number;
  generatedAtIso: string | null;
  sizeBytes: string | null;
  sha256: string | null;
  latest: boolean;
  issueReason: string | null;
  package: { version: number; generatedAtIso: string | null; sizeBytes: string | null; sha256: string | null; sealed: boolean } | null;
}

export function projectMatchedHistory(statusPayload: unknown): MatchedPairView[] | null {
  const v = obj(obj(statusPayload).versions);
  if (!Array.isArray(v.versions)) return null;
  return (v.versions as unknown[])
    .map(obj)
    .filter((x) => typeof x.reportVersion === "number")
    .map((x) => {
      const p = obj(x.package);
      return {
        reportVersion: x.reportVersion as number,
        generatedAtIso: str(x.generatedAtUtc),
        sizeBytes: str(x.sizeBytes),
        sha256: str(x.sha256),
        latest: x.latest === true,
        issueReason: str(x.issueReason),
        package:
          typeof p.version === "number"
            ? {
                version: p.version as number,
                generatedAtIso: str(p.generatedAtUtc),
                sizeBytes: str(p.sizeBytes),
                sha256: str(p.sha256),
                sealed: p.sealed === true,
              }
            : null,
      };
    });
}
