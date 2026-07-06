import { ApiError } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import type { BillingWallLike } from "./types";

type GenericApiErrorShape = {
  code?: string;
  message?: string;
  details?: unknown;
};

/**
 * Recognize the typed billing gate POST /v1/evidence returns when the
 * user (a) is on a TEAM workspace target AND (b) does not have an
 * active TEAM plan. This is an expected, user-recoverable condition,
 * not a server fault — Capture must surface a friendly message and
 * preserve staged materials so the user can switch workspace / upgrade
 * without re-uploading.
 *
 * The backend (services/api/src/routes/evidence.routes.ts) returns:
 *   HTTP 402
 *   { code: "TEAM_PLAN_REQUIRED",
 *     message: "...",
 *     target: "TEAM",
 *     requiredPlan: "TEAM" }
 *
 * Returns null when the error is NOT a TEAM plan gate.
 */
export type TeamPlanRequiredDetails = {
  message: string;
  target: "TEAM";
  requiredPlan: "TEAM";
};

export function isTeamPlanRequiredError(
  error: unknown
): error is (Error & { code: "TEAM_PLAN_REQUIRED" }) | ApiError {
  if (error instanceof ApiError && error.code === "TEAM_PLAN_REQUIRED") {
    return true;
  }
  const generic = error as GenericApiErrorShape | null | undefined;
  return Boolean(generic && generic.code === "TEAM_PLAN_REQUIRED");
}

export function buildTeamPlanRequiredDetails(
  error: unknown
): TeamPlanRequiredDetails | null {
  if (!isTeamPlanRequiredError(error)) return null;
  return {
    // Curated, user-safe message — never the raw backend message.
    message:
      "Creating evidence in a team workspace requires an active Team plan.",
    target: "TEAM",
    requiredPlan: "TEAM",
  };
}

export function buildStorageLimitMessage(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (
      error.code === "STORAGE_LIMIT_REACHED" ||
      (typeof error.message === "string" &&
        error.message.toLowerCase().includes("storage limit"))
    ) {
      const wall = error.details as BillingWallLike | undefined;
      const workspace = wall?.workspace;
      const storage = workspace?.storage;

      if (storage?.usedLabel && storage?.limitLabel) {
        return `Storage limit reached. Current usage: ${storage.usedLabel} / ${storage.limitLabel}.`;
      }

      return "Storage limit reached for this workspace. Please add storage or upgrade your plan.";
    }
  }

  const generic = error as { code?: string; message?: string; details?: unknown };
  if (generic?.code === "STORAGE_LIMIT_REACHED") {
    return "Storage limit reached for this workspace. Please add storage or upgrade your plan.";
  }

  return null;
}

export function describeMediaError(
  error: unknown,
  messages: {
    permissionDenied: string;
    notFound: string;
    busy: string;
    constrained: string;
    security: string;
    fallback: string;
  }
): string {
  if (!(error instanceof DOMException)) {
    return error instanceof Error && error.message
      ? `${messages.fallback} (${error.message})`
      : messages.fallback;
  }

  switch (error.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return messages.permissionDenied;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return messages.notFound;
    case "NotReadableError":
    case "TrackStartError":
      return messages.busy;
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return messages.constrained;
    case "SecurityError":
      return messages.security;
    default:
      return `${messages.fallback} (${error.name})`;
  }
}

export function logCaptureClientError(
  feature: string,
  error: unknown,
  extra?: Record<string, unknown>
) {
  console.error(`[capture] ${feature}`, error, extra ?? {});
  captureException(error, { feature, ...(extra ?? {}) });
}