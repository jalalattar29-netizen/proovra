/**
 * UC-WEB-005 — what Capture says about a record's report right after seal.
 *
 * The poll used to read ONE boolean (`report.available`) and swallow every
 * error, so after eight polls a FAILED or BLOCKED report was announced as
 * "Verification artifacts are still generating" — a false promise on a custody
 * product. This reads the canonical output projection that
 * GET /v1/evidence/:id/artifacts/status already serves
 * (`outputs.report.state`, derived by the shared output lifecycle), stops as
 * soon as the state is terminal, and names the state it saw.
 *
 * Older API images (web deploys first) may not serve `outputs`; the legacy
 * `report.available` / `report.pending` booleans are the fallback.
 */

export type CaptureArtifactOutcome =
  | "READY"
  | "PENDING"
  | "FAILED"
  | "BLOCKED"
  | "NOT_ISSUED"
  | "UNKNOWN";

type StatusLike = {
  report?: { available?: unknown; pending?: unknown } | null;
  outputs?: {
    report?: { state?: unknown } | null;
    pollIntervalMs?: unknown;
  } | null;
} | null | undefined;

export function classifyArtifactStatus(status: StatusLike): {
  outcome: CaptureArtifactOutcome;
  terminal: boolean;
} {
  const state = status?.outputs?.report?.state;
  if (typeof state === "string") {
    switch (state) {
      case "READY":
        return { outcome: "READY", terminal: true };
      case "QUEUED":
      case "GENERATING":
        return { outcome: "PENDING", terminal: false };
      case "RETRYABLE_FAILURE":
      case "TERMINAL_FAILURE":
        return { outcome: "FAILED", terminal: true };
      case "BLOCKED":
        return { outcome: "BLOCKED", terminal: true };
      case "NOT_INCLUDED":
      case "NOT_APPLICABLE":
      case "ELIGIBLE_NOT_GENERATED":
        return { outcome: "NOT_ISSUED", terminal: true };
      default:
        return { outcome: "UNKNOWN", terminal: false };
    }
  }
  if (status?.report?.available === true) return { outcome: "READY", terminal: true };
  if (status?.report?.pending === true) return { outcome: "PENDING", terminal: false };
  return { outcome: "UNKNOWN", terminal: false };
}

/** The one sentence Capture shows for each outcome after a successful seal. */
export function artifactOutcomeToast(outcome: CaptureArtifactOutcome): {
  message: string;
  tone: "success" | "warning" | "info";
} {
  switch (outcome) {
    case "READY":
      return { message: "Evidence record created successfully!", tone: "success" };
    case "FAILED":
      return {
        message:
          "Evidence record created and sealed, but report generation failed. Retry it from the record's Reports section.",
        tone: "warning",
      };
    case "BLOCKED":
      return {
        message:
          "Evidence record created and sealed. Report generation is blocked by workspace governance or a hold.",
        tone: "warning",
      };
    case "NOT_ISSUED":
      return {
        message: "Evidence record created and sealed. No report is being generated for this record.",
        tone: "info",
      };
    case "PENDING":
      return {
        message: "Evidence record created. Verification artifacts are still generating.",
        tone: "warning",
      };
    default:
      return {
        message:
          "Evidence record created. Report status could not be confirmed yet; check the record for its current state.",
        tone: "warning",
      };
  }
}
