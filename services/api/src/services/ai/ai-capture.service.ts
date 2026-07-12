import type { AiProvider } from "./ai-provider.js";
import { AiResult, AiSeverity, AiTask } from "./ai-types.js";
import { AiCostGuard } from "./ai-cost-guard.js";
import { AI_LEGAL_DISCLAIMER } from "./ai-policy.js";
import { sanitizeUntrustedField } from "./prompt-context-sanitizer.service.js";
// Phase O1.5E — bounded ai.capture.review span.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";

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

// Phase B2 — CaptureItemReviewPayload type removed with the analyze-item endpoint.

function inferEvidenceTypeFromMimeType(mimeType: string | null | undefined): EvidenceType {
  const normalized = String(mimeType ?? "").trim().toLowerCase();
  if (normalized.startsWith("image/")) return "PHOTO";
  if (normalized.startsWith("video/")) return "VIDEO";
  if (normalized.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

/**
 * Issue #5 — AI privacy: filenames CAN carry highly sensitive information
 * (patient names, legal case names, police references, etc.). PROOVRA must
 * not forward raw filenames to the OpenAI provider. The provider receives
 * a redacted payload that preserves analytical signal (kind, mime category,
 * size bucket, mapping, client signals) but drops the literal filename.
 *
 * Local (server-side, in-process) deterministic logic and user-facing flag
 * detail strings may still reference the filename since they do not leave
 * PROOVRA's trust boundary.
 */
function redactFileName(originalName: string | null | undefined): string {
  // We deliberately surface a generic identifier so the model's downstream
  // text never echoes the original filename back to the user.
  return "redacted-filename";
}

function buildExtensionCategory(fileName: string | null | undefined): string {
  if (typeof fileName !== "string") return "unknown";
  const idx = fileName.lastIndexOf(".");
  if (idx < 0 || idx === fileName.length - 1) return "unknown";
  const ext = fileName.slice(idx + 1).toLowerCase();
  // Only return the extension shape (e.g., "ext-3char") rather than the raw
  // extension string, to avoid leaking unusual extensions that themselves
  // could be sensitive (".john-doe-medical").
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return "unusual";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"].includes(ext))
    return "image";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) return "audio";
  if (["pdf"].includes(ext)) return "pdf";
  if (["doc", "docx", "rtf", "txt", "md"].includes(ext)) return "document";
  if (["xls", "xlsx", "csv"].includes(ext)) return "spreadsheet";
  if (["ppt", "pptx"].includes(ext)) return "presentation";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  return "other";
}

function bucketSizeBytes(sizeBytes: number | null | undefined): string {
  const n = typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : 0;
  if (n <= 0) return "empty";
  if (n < 100 * 1024) return "tiny_lt_100KB";
  if (n < 1024 * 1024) return "small_lt_1MB";
  if (n < 10 * 1024 * 1024) return "medium_lt_10MB";
  if (n < 100 * 1024 * 1024) return "large_lt_100MB";
  if (n < 1024 * 1024 * 1024) return "very_large_lt_1GB";
  return "massive_gt_1GB";
}

type RedactedCaptureItem = {
  id: string;
  itemLabel: string;
  fileName: string;
  mimeType: string;
  extensionCategory: string;
  sizeBucket: string;
  checklistStepId: string | null;
  role?: string;
  sourceLabel?: string;
  clientSignals?: CaptureSessionItem["clientSignals"];
};

function buildRedactedItems(
  items: CaptureSessionItem[]
): RedactedCaptureItem[] {
  return items.map((item, index) => ({
    id: item.id,
    itemLabel: `Item ${index + 1}`,
    fileName: redactFileName(item.fileName),
    mimeType: item.mimeType,
    extensionCategory: buildExtensionCategory(item.fileName),
    sizeBucket: bucketSizeBytes(item.sizeBytes),
    checklistStepId: item.checklistStepId ?? null,
    // Phase E2 — role/sourceLabel are user free-text: sanitize (strip
    // secrets/URLs/GPS/control chars, bound length) before the provider.
    role: item.role ? sanitizeUntrustedField(item.role, 120) : item.role,
    sourceLabel: item.sourceLabel ? sanitizeUntrustedField(item.sourceLabel, 120) : item.sourceLabel,
    clientSignals: item.clientSignals,
  }));
}

function redactSessionPayloadForProvider(
  payload: CaptureSessionReviewPayload
): {
  collectionPlan: CaptureCollectionPlan;
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  useLocation: boolean;
  privacyNotice: string;
  items: RedactedCaptureItem[];
} {
  return {
    collectionPlan: payload.collectionPlan,
    planMode: payload.planMode,
    useLocation: payload.useLocation,
    privacyNotice:
      "Filenames have been redacted. Reference items by itemLabel or id. Do not invent filenames.",
    items: buildRedactedItems(payload.items),
  };
}

// Phase B2 — redactItemPayloadForProvider removed with the analyze-item endpoint.

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

// Phase B2 — buildDeterministicItemReview removed with the analyze-item endpoint.

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

// Phase O1.5E — bounded ai.capture.review span. NEVER prompts /
// responses / file contents / GPS in attributes.
await withProovraSpan(PROOVRA_SPAN_NAMES.AI_CAPTURE_REVIEW, { "proovra.operation": "ai_capture_review", "proovra.provider": "openai" }, () => undefined);
// Redacted payload for the provider — see redactSessionPayloadForProvider
// for the privacy rationale (Issue #5: never send raw filenames to AI).
const providerResult = await this.provider.run(
  AiTask.CAPTURE_SESSION_REVIEW,
  redactSessionPayloadForProvider(payload)
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

  // Phase B2 — analyzeItem removed (endpoint deleted; zero callers).
}
