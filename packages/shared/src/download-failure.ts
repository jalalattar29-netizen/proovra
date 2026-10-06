/**
 * RGA-04 — THE ONE typed authority for a report / verification-package download
 * failure, shared by every surface (Evidence Detail, Reports index, Artifacts &
 * Versions, version history, web/PWA and native through this contract).
 *
 * Before this, Evidence Detail and the Reports index each carried their own
 * switch over the same server statuses/codes and worded the same failure
 * differently (and sometimes classified it info vs error inconsistently). This
 * module is the single source: the download gate answers with a bounded set of
 * statuses and codes, and each maps to exactly one safe, actionable outcome.
 *
 * Pure and dependency-free (no web-only imports), so native and the API can use
 * it too. It returns `null` for a status/code it does not recognise, so the
 * caller's own safe-error reporter (e.g. the web `toSafeUserError`, which also
 * files the unknown for investigation) handles the genuinely-unexpected case —
 * this authority never invents copy for a failure nobody anticipated.
 *
 * It NEVER exposes storage keys, credentials, stack traces or raw internal codes.
 */

export type ArtifactKind = "report" | "verificationPackage";

export type DownloadFailureSeverity = "info" | "warning" | "error";
/** The single action a surface may offer for this outcome. */
export type DownloadFailureAction = "RETRY" | "RECOVER" | "REFRESH" | "NONE";

export type ArtifactDownloadFailure = {
  message: string;
  severity: DownloadFailureSeverity;
  /** Safe to retry the SAME download unchanged. */
  retryable: boolean;
  /** The one action the surface should offer, if any. */
  action: DownloadFailureAction;
  /** Whether a client error reporter should file this (true only for unknowns). */
  report: boolean;
};

type ErrorShape = { statusCode?: unknown; code?: unknown };

function noun(kind: ArtifactKind): string {
  return kind === "report" ? "report" : "verification package";
}

/**
 * Resolve a download failure to its canonical outcome, or `null` when the
 * status/code is not one the download gate is known to produce (the caller's
 * safe-error reporter then handles it).
 */
export function resolveArtifactDownloadFailure(
  kind: ArtifactKind,
  error: unknown,
  /** The specific version requested (history downloads), when one was. */
  context?: { version?: number | null },
): ArtifactDownloadFailure | null {
  const e = (error ?? {}) as ErrorShape;
  const status = typeof e.statusCode === "number" ? e.statusCode : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  const n = noun(kind);
  const Noun = kind === "report" ? "Report" : "Verification package";

  // ---- Bounded codes (precedence over status) -----------------------------
  if (code === "report_artifact_missing" || code === "verification_package_artifact_missing") {
    // An issued version is immutable: its missing file is never re-generated
    // in place. It is an integrity matter for support, not a recovery verb.
    return {
      message: `The ${n} record exists, but its stored file is unavailable. Contact support; nothing has been changed.`,
      severity: "warning",
      retryable: false,
      action: "NONE",
      report: false,
    };
  }
  /*
   * THE PACKAGE ENDPOINT'S OWN BOUNDED CODES (RGA-04 completion). Evidence
   * Detail carried a private switch over these; every surface reads them here.
   * Some arrive on a 2xx body (`{ code }` with no URL), some on an error.
   */
  switch (code) {
    case "verification_package_pending":
      return { message: "The verification package is still being generated. It will be available shortly.", severity: "info", retryable: true, action: "REFRESH", report: false };
    case "verification_package_blocked":
    case "PACKAGE_BLOCKED_BY_POLICY":
      return { message: "Downloading this verification package is blocked by workspace policy.", severity: "info", retryable: false, action: "NONE", report: false };
    case "verification_package_unavailable":
      return { message: "This verification package is unavailable in this workspace context.", severity: "info", retryable: false, action: "NONE", report: false };
    case "verification_package_not_included":
      return { message: "Verification packages are not included for this evidence record.", severity: "info", retryable: false, action: "NONE", report: false };
    case "verification_package_not_found":
    case "verification_package_not_generated":
      return { message: "No verification package has been generated for this record yet.", severity: "info", retryable: false, action: "NONE", report: false };
    case "verification_package_generation_failed":
      return { message: "The last attempt to build the verification package failed. The evidence record and its integrity state are unaffected.", severity: "warning", retryable: false, action: "RECOVER", report: false };
    case "verification_package_generation_stopped":
      return { message: "The verification package could not be produced for this record and generation has stopped.", severity: "warning", retryable: false, action: "NONE", report: false };
    case "REPORT_VERSION_NOT_FOUND":
    case "report_version_not_found":
    case "VERIFICATION_PACKAGE_VERSION_NOT_FOUND":
    case "verification_package_version_not_found":
      return { message: `The requested ${n} version does not exist for this record.`, severity: "info", retryable: false, action: "REFRESH", report: false };
    case "STORAGE_UNAVAILABLE":
    case "storage_unavailable":
      return { message: `The ${n} storage is temporarily unavailable. Retry shortly.`, severity: "info", retryable: true, action: "RETRY", report: false };
    default:
      break;
  }
  if (code === "GOVERNANCE_CHECK_FAILED" || code === "governance_schema_unavailable") {
    return {
      message: "The workspace policy check is temporarily unavailable. Retry shortly.",
      severity: "info",
      retryable: true,
      action: "RETRY",
      report: false,
    };
  }
  if (code === "ACCESS_DENIED" || code === "PERSONAL_OWNER_REQUIRED") {
    return {
      message: `This ${n} is not available to you in this workspace.`,
      severity: "info",
      retryable: false,
      action: "NONE",
      report: false,
    };
  }
  if (
    code === "BLOCKED_BY_HOLD" ||
    code === "BLOCKED_BY_LIFECYCLE" ||
    code === "BLOCKED_BY_REVIEW_GATE" ||
    code === "BLOCKED_BY_POLICY" ||
    code === "VERIFICATION_POLICY_BLOCKED"
  ) {
    return {
      message: `Downloading this ${n} is blocked by a legal hold, the record's lifecycle, or workspace policy.`,
      severity: "info",
      retryable: false,
      action: "NONE",
      report: false,
    };
  }

  // ---- Bounded statuses ----------------------------------------------------
  switch (status) {
    case 401:
      return { message: `Sign in to download this ${n}.`, severity: "info", retryable: false, action: "REFRESH", report: false };
    case 403:
      return {
        message: `Downloading this ${n} is blocked by workspace governance, a hold, or export eligibility.`,
        severity: "info",
        retryable: false,
        action: "NONE",
        report: false,
      };
    case 404:
      if (context?.version != null) {
        return {
          message: `${Noun} v${context.version} is not available for this record.`,
          severity: "info",
          retryable: false,
          action: "REFRESH",
          report: false,
        };
      }
      return {
        message:
          kind === "report"
            ? "No report has been generated for this record yet."
            : "No verification package has been generated for this record yet.",
        severity: "info",
        retryable: false,
        action: "NONE",
        report: false,
      };
    case 202:
      return {
        message: `${Noun} generation is still in progress. It will be available shortly.`,
        severity: "info",
        retryable: true,
        action: "REFRESH",
        report: false,
      };
    case 409:
    case 410:
      return { message: `This ${n} is not available for download right now.`, severity: "info", retryable: false, action: "NONE", report: false };
    case 503:
      return { message: `${Noun} download is temporarily unavailable. Retry shortly.`, severity: "info", retryable: true, action: "RETRY", report: false };
    default:
      // Unknown: let the caller's safe-error reporter handle (and file) it.
      return null;
  }
}
