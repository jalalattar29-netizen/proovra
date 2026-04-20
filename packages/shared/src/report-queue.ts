export type EnqueueReportJobOptions = {
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
};

export type ReportJobPayload = {
  evidenceId: string;
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
};

export const generateReportJobName = "GenerateReportJob";

export type ExistingReportJobState =
  | "active"
  | "completed"
  | "delayed"
  | "failed"
  | "paused"
  | "prioritized"
  | "waiting"
  | "waiting-children"
  | "unknown";

export type ReportJobEnqueueDecision =
  | {
      action: "skip";
      reason: string;
    }
  | {
      action: "replace";
    };

export function normalizeRegenerateReason(
  value: string | null | undefined
): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, "_");
  return cleaned || "manual";
}

export function buildReportJobId(
  evidenceId: string,
  options?: EnqueueReportJobOptions
): string {
  const normalizedEvidenceId = evidenceId.trim();
  if (!normalizedEvidenceId) {
    throw new Error("buildReportJobId: evidenceId is required");
  }

  if (options?.forceRegenerate) {
    return `report-refresh-${normalizeRegenerateReason(
      options.regenerateReason
    )}-${normalizedEvidenceId}`;
  }

  return `report-${normalizedEvidenceId}`;
}

export function buildReportJobPayload(
  evidenceId: string,
  options?: EnqueueReportJobOptions
): ReportJobPayload {
  const payload: ReportJobPayload = {
    evidenceId: evidenceId.trim(),
  };

  if (options?.forceRegenerate) {
    payload.forceRegenerate = true;
    payload.regenerateReason = normalizeRegenerateReason(
      options.regenerateReason
    );
  }

  return payload;
}

export function decideReportJobEnqueueAction(
  state: string | null | undefined
): ReportJobEnqueueDecision {
  const normalized = String(state ?? "unknown").trim().toLowerCase();

  switch (normalized) {
    case "waiting":
    case "delayed":
    case "active":
    case "prioritized":
    case "paused":
    case "waiting-children":
      return {
        action: "skip",
        reason: `job_${normalized}`,
      };
    case "completed":
    case "failed":
    case "unknown":
    default:
      return {
        action: "replace",
      };
  }
}
