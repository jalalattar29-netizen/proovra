/**
 * ARTIFACT HISTORY (T-14 ArtifactHistorySection) — every retained report and
 * verification-package version, from the review workspace
 * (`artifactVersions.history`), and the verification-package download.
 *
 * Every URL is minted ON TAP: GET …/verification-package, …/reports/:v and
 * …/verification-packages/:v record a custody download, so nothing here is
 * fetched on load. Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ArtifactVersion {
  version: number;
  generatedAtIso: string | null;
  sizeBytes: string | null;
  latest: boolean;
  immutableRecorded: boolean;
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

/** The web's words for a package that could not be opened, by the server's code, else its status. */
export function packageDownloadMessage(code: string | null, status: number | null): string {
  switch (code) {
    case "verification_package_pending":
      return "Verification package is still being generated. Retry shortly.";
    case "verification_package_blocked":
    case "PACKAGE_BLOCKED_BY_POLICY":
      return "Verification package is blocked by governance policy.";
    case "verification_package_unavailable":
      return "Verification package is unavailable for this workspace context.";
    case "verification_package_not_included":
      return "Verification packages are not included for this evidence record.";
    case "verification_package_not_found":
      return "Verification package was not found.";
    case "verification_package_not_generated":
      return "No verification package has been generated for this record yet.";
    case "verification_package_generation_failed":
      return "The last attempt to build the verification package failed. The evidence record and its integrity state are unaffected.";
    case "verification_package_generation_stopped":
      return "The verification package could not be produced for this record and generation has stopped.";
    case "GOVERNANCE_CHECK_FAILED":
    case "governance_schema_unavailable":
      return "Governance check is temporarily unavailable. Retry shortly.";
    default:
      if (status === 401) return "Sign-in required to download this package.";
      if (status === 403) return "Verification package is blocked by governance policy.";
      return "Unable to download verification package.";
  }
}

/** "1.2 MB" style, or null. */
export function formatArtifactSize(bytes: string | null): string | null {
  const n = bytes === null ? NaN : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
