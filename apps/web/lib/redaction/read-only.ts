import { useOptionalPlatformContext } from "../platform-context";

/**
 * PRO-R3-06 / DEC-10 — the redaction console after the entitlement lapses.
 *
 * Reads outlive the entitlement: the API keeps a workspace's existing
 * redaction projects readable (GETs, the redacted-copy download and the
 * protective quarantine are not entitlement-gated in redaction.routes `gate`)
 * while every write that starts or advances work answers
 * ENTITLEMENT_REQUIRED. The surface opens on `planFeatures.redactionReadRetained`
 * and the pages offer only the reads, the download and the quarantine.
 *
 * True only when the server SAYS the entitlement is not held
 * (`redactionIncluded === false`); unknown (loading, older API) is not
 * read-only — the surface gate already decided whether the page renders.
 */
export function useRedactionReadOnly(): boolean {
  return useOptionalPlatformContext()?.envelope?.planFeatures?.redactionIncluded === false;
}

export const REDACTION_READ_ONLY_TITLE = "Redaction is no longer included in this workspace's plan";

export const REDACTION_READ_ONLY_MESSAGE =
  "Existing redaction projects stay available: you can open them, download redacted copies and quarantine a copy. Starting a project, editing regions, running detection, submitting, approving and publishing need a plan that includes redaction.";
