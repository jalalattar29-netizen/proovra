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
export function describeArtifactDownloadFailure(
  kind: ArtifactKind,
  error: unknown,
): { message: string; tone: "info" | "error"; report: boolean } {
  const resolved = resolveArtifactDownloadFailure(kind, error);
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
  return {
    message: toSafeUserError(error, { message: `Could not download the ${noun}.` }).message,
    tone: "error",
    report: true,
  };
}
