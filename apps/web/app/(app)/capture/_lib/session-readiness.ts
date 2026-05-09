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

type BuildSessionReadinessParams = {
  items: SessionItem[];
  selectedPlan: CollectionPlanTemplate | undefined;
  planMode: CapturePlanMode;
  useLocation: boolean;
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

export function buildSessionReadiness({
  items,
  selectedPlan,
  planMode,
  useLocation,
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
