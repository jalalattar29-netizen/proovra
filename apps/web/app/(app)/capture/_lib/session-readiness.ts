import type {
  ChecklistStep,
  CollectionPlanTemplate,
  SessionItem,
} from "./types";
import { getChecklistStepById, getItemQualityStatus } from "./file-utils";

export type ReadinessStatus = "empty" | "collecting" | "blocked" | "warning" | "ready";

export type ReadinessIssueSeverity = "blocker" | "warning" | "info";

export type ReadinessIssue = {
  code: string;
  severity: ReadinessIssueSeverity;
  label: string;
  detail: string;
  itemId?: string;
  checklistStepId?: string;
};

export type CapturePlanMode = "CHECKLIST_REQUIRED" | "FLEXIBLE";

export type SessionReadinessSummary = {
  totalItems: number;
  requiredTotal: number;
  requiredCompleted: number;
  unmappedCount: number;
  warningCount: number;
  blockerCount: number;
};

export type SessionReadiness = {
  canFinalize: boolean;
  status: ReadinessStatus;
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
  missingRequiredSteps: ChecklistStep[];
  unmappedItems: SessionItem[];
  mappedItems: SessionItem[];
  itemQualityIssues: ReadinessIssue[];
  locationRequiredButMissing: boolean;
  aiRecommendedReview: boolean;
  summary: SessionReadinessSummary;
};

/**
 * Phase 30.12 — bounded vocabulary for resumable upload blockers
 * that gate Review & Sign. Each blocker carries a sessionId so the
 * UI can render a precise "this large file is blocking finalize"
 * message rather than a generic disabled state.
 *
 * This is a SHAPE-COMPATIBLE narrow type — the hook's full
 * `ReviewSignBlocker` discriminated union is wider but we only
 * need the kind discriminator here. Anything else that's not in
 * this list collapses to `failed_retryable`.
 */
export type ResumableReviewSignBlocker = {
  kind:
    | "upload_in_progress"
    | "server_verification_pending"
    | "hash_mismatch"
    | "session_expired"
    | "session_aborted"
    | "needs_recovery"
    | "failed_retryable";
  sessionId: string;
};

type BuildSessionReadinessParams = {
  items: SessionItem[];
  selectedPlan: CollectionPlanTemplate | undefined;
  planMode: CapturePlanMode;
  useLocation: boolean;
  /**
   * Phase 30.12 — resumable upload blockers from useResumableUploads().
   * When empty (the default), readiness reflects only the legacy
   * capture flow. When non-empty, Review & Sign is disabled and
   * the UI shows the precise blocker reason.
   */
  resumableBlockers?: ReadonlyArray<ResumableReviewSignBlocker>;
};

function createItemIssue(params: {
  code: string;
  severity: ReadinessIssueSeverity;
  label: string;
  detail: string;
  item: SessionItem;
  checklistStepId?: string | null;
}): ReadinessIssue {
  return {
    code: params.code,
    severity: params.severity,
    label: params.label,
    detail: params.detail,
    itemId: params.item.id,
    checklistStepId: params.checklistStepId ?? undefined,
  };
}

/** Phase 30.12 — humanised blocker label + detail (bounded). */
function resumableBlockerToIssue(
  b: ResumableReviewSignBlocker,
): ReadinessIssue {
  switch (b.kind) {
    case "upload_in_progress":
      return {
        code: "resumable_upload_in_progress",
        severity: "blocker",
        label: "Large file upload still in progress",
        detail:
          "A resumable upload is still uploading parts to storage. Review & Sign will become available when the upload completes and the server confirms verification.",
      };
    case "server_verification_pending":
      return {
        code: "resumable_server_verification_pending",
        severity: "blocker",
        label: "Server verification pending",
        detail:
          "The server is verifying the uploaded file. This usually takes a few seconds.",
      };
    case "hash_mismatch":
      return {
        code: "resumable_hash_mismatch",
        severity: "blocker",
        label: "Hash mismatch detected",
        detail:
          "The server-computed hash of the uploaded file does not match the expected value. The upload must be retried.",
      };
    case "session_expired":
      return {
        code: "resumable_session_expired",
        severity: "blocker",
        label: "Upload session expired",
        detail:
          "The upload session expired before all parts were uploaded. Re-stage the file and retry.",
      };
    case "session_aborted":
      return {
        code: "resumable_session_aborted",
        severity: "blocker",
        label: "Upload session aborted",
        detail:
          "An upload session was aborted. Discard or replace the affected file to continue.",
      };
    case "needs_recovery":
      return {
        code: "resumable_needs_recovery",
        severity: "blocker",
        label: "Recovery required before finalization",
        detail:
          "A previous upload requires operator action before this evidence can be finalized.",
      };
    case "failed_retryable":
      return {
        code: "resumable_failed_retryable",
        severity: "blocker",
        label: "Finalization blocked by upload session",
        detail:
          "A resumable upload reported a transient failure. Retry it from the operations panel.",
      };
  }
}

export function buildSessionReadiness({
  items,
  selectedPlan,
  planMode,
  useLocation,
  resumableBlockers,
}: BuildSessionReadinessParams): SessionReadiness {
  const requiredSteps = selectedPlan?.steps.filter((step) => step.required) ?? [];
  const mappedStepIds = new Set(
    items.map((item) => item.checklistStepId).filter(Boolean) as string[]
  );
  const missingRequiredSteps = requiredSteps.filter((step) => !mappedStepIds.has(step.id));
  const mappedItems = items.filter((item) => Boolean(item.checklistStepId));
  const unmappedItems = items.filter((item) => !item.checklistStepId);
  const blockers: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];

  if (items.length === 0) {
    blockers.push({
      code: "capture_empty_session",
      severity: "blocker",
      label: "Add at least one material to finish.",
      detail: "Capture requires at least one staged material before Review & Sign can start.",
    });
  }

  if (planMode === "CHECKLIST_REQUIRED") {
    missingRequiredSteps.forEach((step) => {
      blockers.push({
        code: "capture_required_step_missing",
        severity: "blocker",
        label: "Cannot finish yet",
        detail: `${step.title} has not been mapped to a staged material.`,
        checklistStepId: step.id,
      });
    });
  }

  const locationRequiredButMissing =
    selectedPlan?.locationRequirement === "required" && !useLocation;

  if (locationRequiredButMissing) {
    blockers.push({
      code: "capture_required_location_missing",
      severity: "blocker",
      label: "Location metadata is required by the selected plan.",
      detail: "Enable location and grant browser permission before finishing this evidence session.",
    });
  }

  unmappedItems.forEach((item) => {
    warnings.push(
      createItemIssue({
        code: "capture_item_unmapped",
        severity: "warning",
        label: "Needs mapping",
        detail: "This material is not mapped to a collection requirement.",
        item,
      })
    );
  });

  const itemQualityIssues = items.flatMap((item) => {
    const step = getChecklistStepById(selectedPlan, item.checklistStepId);
    const status = getItemQualityStatus({ item, step });

    if (status.tone === "success") return [];

    const severity: ReadinessIssueSeverity = "warning";
    return [
      createItemIssue({
        code: `capture_item_${status.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
        severity,
        label: status.label,
        detail: status.detail,
        item,
        checklistStepId: item.checklistStepId,
      }),
    ];
  });

  warnings.push(...itemQualityIssues);

  if (selectedPlan?.locationRequirement === "recommended" && !useLocation) {
    warnings.push({
      code: "capture_recommended_location_missing",
      severity: "warning",
      label: "Recommended location not included",
      detail: "The selected plan recommends location metadata, but it is not included for this session.",
    });
  }

  // Phase 30.12 — fold resumable upload blockers into the
  // readiness verdict. Each upload session that isn't COMPLETED +
  // VERIFIED contributes a precise blocker reason. The backend
  // finalize gate remains the ultimate authority — this is just
  // UI hygiene so the user sees why Review & Sign is disabled
  // rather than a generic "not ready" message.
  if (resumableBlockers && resumableBlockers.length > 0) {
    for (const b of resumableBlockers) {
      blockers.push(resumableBlockerToIssue(b));
    }
  }

  const requiredCompleted = requiredSteps.length - missingRequiredSteps.length;
  const canFinalize = blockers.length === 0;
  const warningCount = warnings.length;
  const blockerCount = blockers.length;

  let status: ReadinessStatus = "collecting";
  if (items.length === 0) {
    status = "empty";
  } else if (blockerCount > 0) {
    status = "blocked";
  } else if (warningCount > 0) {
    status = "warning";
  } else if (canFinalize) {
    status = "ready";
  }

  return {
    canFinalize,
    status,
    blockers,
    warnings,
    missingRequiredSteps,
    unmappedItems,
    mappedItems,
    itemQualityIssues,
    locationRequiredButMissing,
    aiRecommendedReview: warningCount > 0,
    summary: {
      totalItems: items.length,
      requiredTotal: requiredSteps.length,
      requiredCompleted,
      unmappedCount: unmappedItems.length,
      warningCount,
      blockerCount,
    },
  };
}
