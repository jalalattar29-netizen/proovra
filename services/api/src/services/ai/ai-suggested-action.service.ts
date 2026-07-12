/**
 * Phase C6 — Human-confirmed suggested actions.
 *
 * AI may PROPOSE a supported action. It may never execute one. Every suggestion
 * is a bounded proposal that the UI previews; a human explicitly confirms; the
 * mutation runs through the EXISTING canonical endpoint with normal authz +
 * audit. There is no AI-only mutation endpoint. Critical/forensic actions are
 * never AI-suggestable for one-click execution.
 */
import { createHash } from "node:crypto";

import type { AiCitation } from "./ai-citation.service.js";

/**
 * Official executable actions (server-derived ONLY — the model never invents
 * these; it may only explain why). All confirmationRequired, all executed via
 * existing canonical endpoints or navigation.
 *
 * Phase F-3 — GENERATE_VERIFICATION_PACKAGE and RETRY_ELIGIBLE_PACKAGE were
 * REMOVED from this registry: Verification Packages are produced by the
 * worker pipeline and PROOVRA has NO on-demand package-regeneration endpoint
 * (only GET /v1/evidence/:id/verification-package for retrieval). A declared
 * action without a real executor is a fake action; the registry only lists
 * actions with a proven backend path (report endpoints) or a real navigation
 * target (metadata section, reviewer assignment surface).
 */
export const SUGGESTABLE_ACTIONS = [
  "GENERATE_REPORT",
  "RETRY_ELIGIBLE_REPORT",
  "OPEN_MISSING_METADATA",
  "OPEN_REVIEWER_ASSIGNMENT",
] as const;
export type SuggestableActionType = (typeof SUGGESTABLE_ACTIONS)[number];

/**
 * Actions AI may NEVER suggest for one-click execution (forensic/legal weight).
 * These require a human to initiate through the normal governed UI, never an AI
 * suggestion chip.
 */
export const CRITICAL_ACTIONS = [
  "LEGAL_HOLD_CREATE",
  "LEGAL_HOLD_RELEASE",
  "RETENTION_CHANGE",
  "DESTRUCTION",
  "EVIDENCE_DELETE",
  "EVIDENCE_ARCHIVE",
  "SIGNER_LIFECYCLE",
  "ACCESS_REMOVAL",
  "FINAL_REVIEWER_DECISION",
  "EXTERNAL_LEGAL_OUTCOME",
] as const;
export type CriticalActionType = (typeof CRITICAL_ACTIONS)[number];

export type AiActionRiskLevel = "LOW" | "MEDIUM";

export type AiSuggestedAction = {
  suggestionId: string;
  actionType: SuggestableActionType;
  displayLabel: string;
  reason: string;
  affectedObject: { type: string; id: string; version: number | null };
  proposedChange: Record<string, string | number | boolean | null>;
  requiredPermission: string;
  confirmationRequired: true;
  riskLevel: AiActionRiskLevel;
  citations: AiCitation[];
  versionMeta: {
    promptVersion: string;
    modelVersion: string;
    contextSchemaVersion: string;
    outputSchemaVersion: string;
  };
};

export type SuggestionOutcome =
  | "ACCEPTED"
  | "EDITED"
  | "REJECTED"
  | "EXPIRED"
  | "EXECUTION_SUCCESS"
  | "EXECUTION_FAILURE";

export class ForbiddenAiActionError extends Error {
  readonly code = "AI_ACTION_FORBIDDEN";
  constructor(readonly actionType: string) {
    super(`AI may not suggest the critical action "${actionType}" for execution.`);
    this.name = "ForbiddenAiActionError";
  }
}

/** True if the action type is a critical/forensic action AI must never suggest. */
export function isCriticalAction(actionType: string): boolean {
  return (CRITICAL_ACTIONS as readonly string[]).includes(actionType);
}

/** True if the action type is on the AI-suggestable allowlist. */
export function isSuggestableAction(actionType: string): boolean {
  return (SUGGESTABLE_ACTIONS as readonly string[]).includes(actionType);
}

/**
 * Validate a model-proposed action. Throws for critical actions; rejects
 * anything not on the allowlist; forces confirmationRequired = true. The
 * returned action is a PROPOSAL only — it performs no mutation.
 */
export function buildSuggestedAction(input: {
  actionType: string;
  displayLabel: string;
  reason: string;
  affectedObject: { type: string; id: string; version: number | null };
  proposedChange: Record<string, string | number | boolean | null>;
  requiredPermission: string;
  riskLevel?: AiActionRiskLevel;
  citations: AiCitation[];
  versionMeta: AiSuggestedAction["versionMeta"];
}): AiSuggestedAction {
  if (isCriticalAction(input.actionType)) {
    throw new ForbiddenAiActionError(input.actionType);
  }
  if (!isSuggestableAction(input.actionType)) {
    throw new ForbiddenAiActionError(input.actionType);
  }
  const suggestionId = createHash("sha256")
    .update(
      `${input.actionType}|${input.affectedObject.type}|${input.affectedObject.id}|${JSON.stringify(input.proposedChange)}`,
    )
    .digest("hex")
    .slice(0, 32);
  return {
    suggestionId,
    actionType: input.actionType as SuggestableActionType,
    displayLabel: input.displayLabel.slice(0, 200),
    reason: input.reason.slice(0, 600),
    affectedObject: input.affectedObject,
    proposedChange: input.proposedChange,
    requiredPermission: input.requiredPermission,
    confirmationRequired: true,
    riskLevel: input.riskLevel ?? "LOW",
    citations: input.citations,
    versionMeta: input.versionMeta,
  };
}

/** Stable hash of the final human-confirmed payload (audit trail). */
export function finalPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}
