export type ReviewerArtifactRole =
  | "primary_evidence"
  | "supporting_evidence"
  | "attachment";

export type ReviewerArtifactRoleSource =
  | "private_role"
  | "checklist_step"
  | "fallback_single"
  | "fallback_root"
  | "fallback_first";

type IntakePlanStepSnapshot = {
  id: string | null;
  title: string | null;
  purposeLabel: string | null;
  description: string | null;
  required: boolean | null;
};

export type ResolvedReviewerArtifactRole = {
  artifactRole: ReviewerArtifactRole;
  roleSource: ReviewerArtifactRoleSource;
  isExplicit: boolean;
  checklistStepId: string | null;
  checklistStepLabel: string | null;
};

const PRIMARY_ROLE_RE =
  /\b(primary|principal|main|lead)(?:\s+evidence|\s+item|\s+media|\s+document|\s+file)?\b/i;
const SUPPORTING_ROLE_RE =
  /\b(support(?:ing)?|supplement(?:al)?|context|exhibit|attachment|secondary|reference)\b/i;
const ATTACHMENT_ROLE_RE = /\b(attachment|appendix|reference\s+only)\b/i;

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function classifyRoleText(value: string | null | undefined): ReviewerArtifactRole | null {
  const text = normalizeText(value);
  if (!text) return null;

  if (PRIMARY_ROLE_RE.test(text)) return "primary_evidence";
  if (ATTACHMENT_ROLE_RE.test(text)) return "attachment";
  if (SUPPORTING_ROLE_RE.test(text)) return "supporting_evidence";
  return null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractIntakePlanSteps(intakePlanJson: unknown): IntakePlanStepSnapshot[] {
  if (!intakePlanJson || typeof intakePlanJson !== "object") {
    return [];
  }

  const plan = intakePlanJson as {
    requiredSteps?: unknown;
    optionalSteps?: unknown;
    steps?: unknown;
  };

  const groups = [plan.requiredSteps, plan.optionalSteps, plan.steps];
  const steps: IntakePlanStepSnapshot[] = [];

  for (const group of groups) {
    if (!Array.isArray(group)) continue;

    for (const item of group) {
      if (!item || typeof item !== "object") continue;
      const step = item as Record<string, unknown>;
      steps.push({
        id: readString(step.id),
        title: readString(step.title),
        purposeLabel: readString(step.purposeLabel),
        description: readString(step.description),
        required: readBoolean(step.required),
      });
    }
  }

  return steps;
}

function findChecklistStep(
  intakePlanJson: unknown,
  checklistStepId: string | null | undefined
): IntakePlanStepSnapshot | null {
  const normalizedChecklistStepId = normalizeText(checklistStepId);
  if (!normalizedChecklistStepId) return null;

  const normalizedKey = normalizedChecklistStepId.toLowerCase();
  return (
    extractIntakePlanSteps(intakePlanJson).find(
      (step) => step.id?.toLowerCase() === normalizedKey
    ) ?? null
  );
}

function classifyChecklistStep(
  intakePlanJson: unknown,
  checklistStepId: string | null | undefined
): {
  artifactRole: ReviewerArtifactRole;
  checklistStepLabel: string | null;
} | null {
  const step = findChecklistStep(intakePlanJson, checklistStepId);
  const fallbackText = normalizeText(checklistStepId);

  const candidateTexts = [
    step?.purposeLabel ?? null,
    step?.title ?? null,
    step?.description ?? null,
    step?.id ?? null,
    fallbackText || null,
  ];

  for (const candidate of candidateTexts) {
    const artifactRole = classifyRoleText(candidate);
    if (artifactRole) {
      return {
        artifactRole,
        checklistStepLabel:
          step?.purposeLabel ??
          step?.title ??
          step?.id ??
          fallbackText ??
          null,
      };
    }
  }

  return null;
}

export function getReviewerArtifactRoleLabel(
  artifactRole: ReviewerArtifactRole | null | undefined
): string {
  switch (artifactRole) {
    case "primary_evidence":
      return "Primary evidence";
    case "supporting_evidence":
      return "Supporting evidence";
    case "attachment":
      return "Attachment";
    default:
      return "Evidence item";
  }
}

export function isPrimaryReviewerArtifactRole(
  artifactRole: ReviewerArtifactRole | null | undefined
): boolean {
  return artifactRole === "primary_evidence";
}

export function isExplicitReviewerArtifactRoleSource(
  roleSource: ReviewerArtifactRoleSource | null | undefined
): boolean {
  return roleSource === "private_role" || roleSource === "checklist_step";
}

export function compareReviewerArtifactRolePriority(
  left: ReviewerArtifactRole | null | undefined,
  right: ReviewerArtifactRole | null | undefined
): number {
  const priority = (value: ReviewerArtifactRole | null | undefined): number => {
    switch (value) {
      case "primary_evidence":
        return 0;
      case "supporting_evidence":
        return 1;
      case "attachment":
        return 2;
      default:
        return 3;
    }
  };

  return priority(left) - priority(right);
}

export function resolveReviewerArtifactRole(input: {
  privateRole?: string | null;
  checklistStepId?: string | null;
  intakePlanJson?: unknown;
  fallbackRole?: ReviewerArtifactRole | null;
  fallbackRoleSource?: ReviewerArtifactRoleSource | null;
}): ResolvedReviewerArtifactRole {
  const explicitPrivateRole = classifyRoleText(input.privateRole);
  if (explicitPrivateRole) {
    const matchedStep = findChecklistStep(
      input.intakePlanJson,
      input.checklistStepId ?? null
    );
    return {
      artifactRole: explicitPrivateRole,
      roleSource: "private_role",
      isExplicit: true,
      checklistStepId: readString(input.checklistStepId) ?? null,
      checklistStepLabel:
        matchedStep?.purposeLabel ?? matchedStep?.title ?? matchedStep?.id ?? null,
    };
  }

  const checklistRole = classifyChecklistStep(
    input.intakePlanJson,
    input.checklistStepId ?? null
  );
  if (checklistRole) {
    return {
      artifactRole: checklistRole.artifactRole,
      roleSource: "checklist_step",
      isExplicit: true,
      checklistStepId: readString(input.checklistStepId) ?? null,
      checklistStepLabel: checklistRole.checklistStepLabel,
    };
  }

  return {
    artifactRole: input.fallbackRole ?? "supporting_evidence",
    roleSource: input.fallbackRoleSource ?? "fallback_first",
    isExplicit: false,
    checklistStepId: readString(input.checklistStepId) ?? null,
    checklistStepLabel: null,
  };
}
