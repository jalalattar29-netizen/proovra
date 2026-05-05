import type { AiProvider } from "./ai-provider.js";
import { AiResult, AiSeverity, AiTask } from "./ai-types.js";
import { AiCostGuard } from "./ai-cost-guard.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";

export type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

export type CapturePlanStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds?: EvidenceType[];
};

export type CaptureSessionItem = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checklistStepId?: string | null;
  role?: string;
  sourceLabel?: string;
  clientSignals?: {
    duplicateStatus?: "none" | "warning" | "duplicate";
    screenshotLike?: boolean;
    genericMime?: boolean;
    oldLastModified?: boolean;
    folderPathPresent?: boolean;
    locationIncluded?: boolean;
  };
};

export type CaptureCollectionPlan = {
  id: string;
  name: string;
  description: string;
  locationRequirement: "optional" | "recommended" | "required";
  steps: CapturePlanStep[];
};

export type CaptureSessionReviewPayload = {
  collectionPlan: CaptureCollectionPlan;
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  useLocation: boolean;
  items: CaptureSessionItem[];
};

export type CaptureItemReviewPayload = {
  collectionPlan: CaptureCollectionPlan;
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  useLocation: boolean;
  item: CaptureSessionItem;
  selectedStep: CapturePlanStep;
};

function inferEvidenceTypeFromMimeType(mimeType: string | null | undefined): EvidenceType {
  const normalized = String(mimeType ?? "").trim().toLowerCase();
  if (normalized.startsWith("image/")) return "PHOTO";
  if (normalized.startsWith("video/")) return "VIDEO";
  if (normalized.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

function isCloseUpStep(step: CapturePlanStep): boolean {
  return /close[-_ ]?up|close-up|close up/i.test(step.id) || /close[-_ ]?up/i.test(step.title);
}

function compareFlags(primary: AiResult, secondary: AiResult): AiResult {
  return {
    ...primary,
    warnings: Array.from(new Set([...(primary.warnings ?? []), ...(secondary.warnings ?? [])])),
    suggestions: Array.from(
      new Set([...(primary.suggestions ?? []), ...(secondary.suggestions ?? [])])
    ),
    flags: [...(primary.flags ?? []), ...(secondary.flags ?? [])],
    legalDisclaimer: AI_LEGAL_DISCLAIMER,
  };
}

function buildDeterministicSessionReview(
  payload: CaptureSessionReviewPayload
): AiResult {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const flags: AiResult["flags"] = [];

  const requiredSteps = payload.collectionPlan.steps.filter((step) => step.required);
  const mappedStepIds = new Set(
    payload.items
      .map((item) => item.checklistStepId)
      .filter((value): value is string => Boolean(value))
  );

  const missingSteps = requiredSteps.filter((step) => !mappedStepIds.has(step.id));
  if (missingSteps.length > 0) {
    flags.push(
      ...missingSteps.map((step) => ({
        severity: "danger" as AiSeverity,
        title: `Missing required intake step: ${step.title}`,
        detail: `Required step ${step.title} is not satisfied by a mapped item.`,
        affectedStepId: step.id,
      }))
    );
    warnings.push(
      `Required intake steps are not complete. ${missingSteps.length} required step(s) remain.`
    );
    suggestions.push("Map the remaining required intake steps before finalizing.");
  }

  if (payload.planMode === "CHECKLIST_REQUIRED" && payload.collectionPlan.locationRequirement === "required" && !payload.useLocation) {
    flags.push({
      severity: "danger",
      title: "Location metadata required",
      detail:
        "The selected plan requires location metadata, but location consent is not enabled.",
    });
    warnings.push("Location metadata is required by the selected intake plan.");
    suggestions.push(
      "Enable location metadata or choose a plan that does not require location."
    );
  }

  const unmappedItems = payload.items.filter((item) => !item.checklistStepId);
  if (unmappedItems.length > 0) {
    flags.push({
      severity: "warning",
      title: "Unmapped session items",
      detail: `There are ${unmappedItems.length} file(s) without a checklist step mapping.`,
    });
    suggestions.push("Assign checklist steps to all staged items when using a required plan.");
  }

  payload.items.forEach((item) => {
    const itemKind = inferEvidenceTypeFromMimeType(item.mimeType);
    const step = payload.collectionPlan.steps.find(
      (candidate) => candidate.id === item.checklistStepId
    );

    if (item.clientSignals?.genericMime) {
      flags.push({
        severity: "warning",
        title: "Generic MIME type detected",
        detail: `The file ${item.fileName} has a generic MIME type and may need review.`,
        affectedItemId: item.id,
      });
      suggestions.push(
        "Provide a more specific file type or confirm the file mapping before finalizing."
      );
    }

    if (item.clientSignals?.duplicateStatus === "duplicate") {
      flags.push({
        severity: "warning",
        title: "Duplicate intake signal detected",
        detail: `Item ${item.fileName} may be a duplicate upload and should be reviewed.`,
        affectedItemId: item.id,
      });
      warnings.push("A duplicate intake signal is present. A reviewer should confirm whether this is intended.");
    }

    if (item.clientSignals?.oldLastModified) {
      flags.push({
        severity: "warning",
        title: "Old file timestamp detected",
        detail: `Item ${item.fileName} has an older last-modified timestamp than expected.`,
        affectedItemId: item.id,
      });
      suggestions.push(
        "Confirm whether the file age is appropriate for the intake scenario."
      );
    }

    if (item.clientSignals?.screenshotLike) {
      flags.push({
        severity: "info",
        title: "Screenshot-like file detected",
        detail: `Item ${item.fileName} appears to be a screenshot and may need direct capture review.`,
        affectedItemId: item.id,
      });
      suggestions.push(
        "Review whether the screenshot is the best match for the selected requirement."
      );
    }

    if (!step) {
      return;
    }

    if (step.acceptedKinds && !step.acceptedKinds.includes(itemKind)) {
      flags.push({
        severity: "warning",
        title: "Type mismatch for mapped requirement",
        detail: `The file ${item.fileName} is ${itemKind} but the requirement accepts ${step.acceptedKinds.join(
          ", "
        )}.`,
        affectedItemId: item.id,
        affectedStepId: step.id,
      });
      suggestions.push(
        "Confirm whether the current file type is suitable for the mapped requirement."
      );
    }

    if (isCloseUpStep(step)) {
      if (itemKind !== "PHOTO" && itemKind !== "VIDEO") {
        flags.push({
          severity: "warning",
          title: "Close-up requirement mapped to non-photo/video",
          detail: `The close-up requirement ${step.title} is mapped to a ${itemKind} file.`,
          affectedItemId: item.id,
          affectedStepId: step.id,
        });
        suggestions.push(
          "Use a photo or video file for close-up requirements when available."
        );
      } else {
        flags.push({
          severity: "info",
          title: "Close-up requirement mapped",
          detail:
            "The item is mapped to a close-up requirement, but visual close-up quality requires human review or future AI vision review.",
          affectedItemId: item.id,
          affectedStepId: step.id,
        });
      }
    }
  });

  if (unmappedItems.length > 5) {
    warnings.push(
      "There are more than five unmapped items, which may indicate an unorganized intake session."
    );
    suggestions.push(
      "Review unmapped items and assign checklist steps for better intake clarity."
    );
  }

  const summary =
    warnings.length > 0 || flags.length > 0
      ? "Captured session review identified advisory issues for reviewer assessment."
      : "Captured session looks consistent with the provided intake information.";

  return {
    status: "ok",
    summary,
    warnings,
    suggestions,
    flags,
    legalDisclaimer: AI_LEGAL_DISCLAIMER,
  };
}

function buildDeterministicItemReview(
  payload: CaptureItemReviewPayload
): AiResult {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const flags: AiResult["flags"] = [];

  const itemKind = inferEvidenceTypeFromMimeType(payload.item.mimeType);
  const expectedKinds = payload.selectedStep.acceptedKinds ?? [];

  if (expectedKinds.length > 0 && !expectedKinds.includes(itemKind)) {
    flags.push({
      severity: "warning",
      title: "Mapped item type does not match requirement",
      detail: `Selected step ${payload.selectedStep.title} accepts ${expectedKinds.join(
        ", "
      )} but the item is ${itemKind}.`,
      affectedItemId: payload.item.id,
      affectedStepId: payload.selectedStep.id,
    });
    suggestions.push(
      "Confirm that this file is appropriate for the selected intake requirement."
    );
  }

  if (isCloseUpStep(payload.selectedStep)) {
    if (itemKind !== "PHOTO" && itemKind !== "VIDEO") {
      flags.push({
        severity: "warning",
        title: "Close-up requirement mapped to non-photo/video",
        detail: `The selected close-up requirement ${payload.selectedStep.title} is mapped to a ${itemKind} file.`,
        affectedItemId: payload.item.id,
        affectedStepId: payload.selectedStep.id,
      });
      suggestions.push(
        "Use a photo or video if the requirement specifically asks for a close-up capture."
      );
    } else {
      flags.push({
        severity: "info",
        title: "Close-up review recommended",
        detail:
          "The item is mapped to a close-up requirement, but visual close-up quality requires human review or future AI vision review.",
        affectedItemId: payload.item.id,
        affectedStepId: payload.selectedStep.id,
      });
    }
  }

  if (payload.item.clientSignals?.genericMime) {
    flags.push({
      severity: "warning",
      title: "Generic MIME type",
      detail: `The file ${payload.item.fileName} has a generic MIME type and may need review.`,
      affectedItemId: payload.item.id,
      affectedStepId: payload.selectedStep.id,
    });
    suggestions.push(
      "Use a more specific file type or review the file metadata for accuracy."
    );
  }

  if (payload.item.clientSignals?.duplicateStatus === "duplicate") {
    warnings.push(
      "This item has a duplicate signal. A reviewer should confirm whether it is intended."
    );
    flags.push({
      severity: "warning",
      title: "Duplicate intake signal",
      detail: `Item ${payload.item.fileName} may be a duplicate upload.`,
      affectedItemId: payload.item.id,
      affectedStepId: payload.selectedStep.id,
    });
  }

  const summary =
    warnings.length > 0 || flags.length > 0
      ? "Item review identified advisory concerns for reviewer assessment."
      : "Item review did not identify obvious metadata issues.";

  return {
    status: "ok",
    summary,
    warnings,
    suggestions,
    flags,
    legalDisclaimer: AI_LEGAL_DISCLAIMER,
  };
}

export class AiCaptureService {
  constructor(
    private provider: AiProvider,
    private costGuard: AiCostGuard
  ) {}

  async analyzeSession(
    userId: string,
    payload: CaptureSessionReviewPayload
  ): Promise<AiResult> {
    const deterministic = buildDeterministicSessionReview(payload);
    const guard = this.costGuard.canAnalyzeCapture(userId, payload.collectionPlan.id);

    if (!guard.allowed) {
      return {
        ...deterministic,
        status: "blocked",
        summary:
          "AI capture review is blocked due to usage or budget limits.",
        warnings: [...deterministic.warnings, guard.reason ?? "Usage limit reached."],
        suggestions: [...deterministic.suggestions],
        legalDisclaimer: AI_LEGAL_DISCLAIMER,
      };
    }

const providerResult = await this.provider.run(
  AiTask.CAPTURE_SESSION_REVIEW,
  payload
);

if (providerResult.status === "ok") {
  this.costGuard.recordCaptureAnalysis(userId, payload.collectionPlan.id);
  return compareFlags(providerResult, deterministic);
}

return {
  ...deterministic,
  warnings: Array.from(
    new Set([
      ...deterministic.warnings,
      providerResult.summary,
      ...providerResult.warnings,
    ])
  ),
  suggestions: Array.from(
    new Set([
      ...deterministic.suggestions,
      "Continue capture normally; AI provider availability does not block Finish & Sign.",
    ])
  ),
  legalDisclaimer: AI_LEGAL_DISCLAIMER,
};
  }

  async analyzeItem(
    userId: string,
    payload: CaptureItemReviewPayload
  ): Promise<AiResult> {
    const deterministic = buildDeterministicItemReview(payload);
    const guard = this.costGuard.canAnalyzeCapture(userId, payload.collectionPlan.id);

    if (!guard.allowed) {
      return {
        ...deterministic,
        status: "blocked",
        summary:
          "AI item review is blocked due to usage or budget limits.",
        warnings: [...deterministic.warnings, guard.reason ?? "Usage limit reached."],
        suggestions: [...deterministic.suggestions],
        legalDisclaimer: AI_LEGAL_DISCLAIMER,
      };
    }

const providerResult = await this.provider.run(
AiTask.CAPTURE_ITEM_REVIEW,
payload
);

if (providerResult.status === "ok") {
  this.costGuard.recordCaptureAnalysis(userId, payload.collectionPlan.id);
  return compareFlags(providerResult, deterministic);
}

return {
  ...deterministic,
  warnings: Array.from(
    new Set([
      ...deterministic.warnings,
      providerResult.summary,
      ...providerResult.warnings,
    ])
  ),
  suggestions: Array.from(
    new Set([
      ...deterministic.suggestions,
      "Continue capture normally; AI provider availability does not block Finish & Sign.",
    ])
  ),
  legalDisclaimer: AI_LEGAL_DISCLAIMER,
};
  }
}
