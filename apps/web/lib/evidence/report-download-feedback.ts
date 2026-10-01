import { toSafeUserError } from "../feedback/toSafeUserError";

/**
 * UC-OUT-004 — the report-download refusal vocabulary. The server's download
 * gate (`assertArtifactDownloadAllowed`) answers with a bounded set of
 * statuses/codes; each gets a user-safe sentence. Anything it cannot explain
 * goes through `toSafeUserError` (never raw text) and IS reported.
 */
export function describeReportDownloadFailure(error: unknown): {
  message: string;
  tone: "info" | "error";
  report: boolean;
} {
  const e = (error ?? {}) as { statusCode?: unknown; code?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (code === "report_artifact_missing") {
    return {
      message:
        "The report record exists, but its file is unavailable. Request a new version to regenerate it.",
      tone: "info",
      report: false,
    };
  }
  if (code === "GOVERNANCE_CHECK_FAILED" || code === "governance_schema_unavailable") {
    return { message: "Governance check is temporarily unavailable. Retry shortly.", tone: "info", report: false };
  }
  switch (status) {
    case 401:
      return { message: "Sign-in required to download this report.", tone: "info", report: false };
    case 403:
      if (code === "ACCESS_DENIED" || code === "PERSONAL_OWNER_REQUIRED") {
        return { message: "This report is not available to you in this workspace.", tone: "info", report: false };
      }
      return {
        message: "Report download is blocked by workspace governance, a hold, or export eligibility.",
        tone: "info",
        report: false,
      };
    case 404:
      return { message: "No report has been generated for this record yet.", tone: "info", report: false };
    case 409:
    case 410:
      return { message: "This report is not available for download right now.", tone: "info", report: false };
    case 503:
      return { message: "Report download is temporarily unavailable. Retry shortly.", tone: "info", report: false };
    default:
      return {
        message: toSafeUserError(error, { message: "Could not download the report." }).message,
        tone: "error",
        report: true,
      };
  }
}
