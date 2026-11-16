import { resolveArtifactDownloadFailure, type ArtifactKind } from "@proovra/shared";

import { toSafeUserError } from "../feedback/toSafeUserError";

/**
 * UC-OUT-004 / RGA-04 — the report/package download refusal vocabulary.
 *
 * The bounded outcomes now live in ONE shared authority
 * (`resolveArtifactDownloadFailure`) used by every surface (Evidence Detail,
 * Reports index, version history, web/PWA and native). This thin web wrapper
 * keeps the existing call shape and adds the web-only safe-error reporting for a
 * failure the shared authority does not recognise (so an unexpected failure is
 * still filed, never shown as raw text).
 */
export function describeReportDownloadFailure(error: unknown): {
  message: string;
  tone: "info" | "error";
  report: boolean;
} {
  return describeArtifactDownloadFailure("report", error);
}

/** The same resolver for either artifact kind; RGA-04 consumers should use this. */
/**
 * B5B-F-102 — a VIEWER (A2-14) holds download_package but not
 * download_original, so the gate refuses the FULL_FORENSIC package with
 * FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS. The shared vocabulary has no case for
 * it yet (requested cross-lane) and fell to the 403 "blocked by workspace
 * governance, a hold, or export eligibility" sentence — a false reason. Said
 * here first, with the alternative the gate itself names.
 */
export const FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS_MESSAGE =
  "The full forensic package contains the original files, which your role cannot download in this workspace. Download the external disclosure package from the record's Artifacts instead.";

export function describeArtifactDownloadFailure(
  kind: ArtifactKind,
  error: unknown,
  context?: { version?: number | null },
): { message: string; tone: "info" | "error"; report: boolean } {
  if ((error as { code?: unknown } | null)?.code === "FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS") {
    return { message: FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS_MESSAGE, tone: "info", report: false };
  }
  const resolved = resolveArtifactDownloadFailure(kind, error, context);
  if (resolved) {
    return {
      message: resolved.message,
      // The existing web contract is a two-tone (info|error) badge; map the
      // shared severity onto it (warning renders as info on this surface).
      tone: resolved.severity === "error" ? "error" : "info",
      report: resolved.report,
    };
  }
  const noun = kind === "report" ? "report" : "verification package";
  const which = context?.version != null ? `${noun} v${context.version}` : `the ${noun}`;
  return {
    message: toSafeUserError(error, { message: `Could not download ${which}.` }).message,
    tone: "error",
    report: true,
  };
}
