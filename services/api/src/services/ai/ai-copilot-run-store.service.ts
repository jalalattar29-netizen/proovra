/**
 * Phase D4 — Copilot run persistence (defensibility).
 *
 * Persists a BOUNDED run record (versions, status, structured result,
 * validated citations) + per-observation human interactions. Never stores raw
 * prompts, evidence bytes, or secrets. Idempotent by requestId.
 */
import { createHash } from "node:crypto";

import { prisma } from "../../db.js";
import { PRODUCT_KNOWLEDGE_VERSION } from "./proovra-product-knowledge.js";
import { COPILOT_SCHEMA_VERSION } from "./ai-copilot-schemas.js";

export const COPILOT_PROMPT_VERSION = "1.0.0";
export const SYSTEM_POLICY_VERSION = "1.0.0";
export const CONTEXT_SCHEMA_VERSION = "1.0.0";

export async function persistCopilotRun(input: {
  workspaceId: string;
  userId: string;
  feature: "CASE_COPILOT" | "REVIEWER_COPILOT";
  caseId?: string | null;
  reviewId?: string | null;
  requestId: string;
  model: string;
  workspacePolicyVersion: number;
  criteriaVersion?: string | null;
  processingMode: string;
  selectedObjectVersions: Array<{ id: string; version: number | null }>;
  status: string;
  boundedResult?: unknown;
  validatedCitations?: unknown;
}) {
  try {
    return await prisma.aiCopilotRun.upsert({
      where: { requestId: input.requestId },
      update: {
        status: input.status,
        boundedResultJson: (input.boundedResult ?? undefined) as never,
        validatedCitationsJson: (input.validatedCitations ?? undefined) as never,
      },
      create: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        feature: input.feature,
        caseId: input.caseId ?? null,
        reviewId: input.reviewId ?? null,
        requestId: input.requestId,
        provider: "openai",
        model: input.model,
        promptVersion: COPILOT_PROMPT_VERSION,
        systemPolicyVersion: SYSTEM_POLICY_VERSION,
        productKnowledgeVersion: PRODUCT_KNOWLEDGE_VERSION,
        contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
        outputSchemaVersion: COPILOT_SCHEMA_VERSION,
        workspacePolicyVersion: input.workspacePolicyVersion,
        criteriaVersion: input.criteriaVersion ?? null,
        processingMode: input.processingMode,
        selectedObjectVersionsJson: input.selectedObjectVersions as never,
        boundedResultJson: (input.boundedResult ?? undefined) as never,
        validatedCitationsJson: (input.validatedCitations ?? undefined) as never,
        status: input.status,
      },
    });
  } catch {
    // Persistence is defensibility metadata — its failure must never block
    // the advisory response (schema drift on an environment without the
    // migration applied degrades gracefully).
    return null;
  }
}

export type ObservationInteractionState = "ACCEPTED" | "EDITED" | "REJECTED";

export async function recordObservationInteraction(input: {
  copilotRunId: string;
  observationId: string;
  state: ObservationInteractionState;
  originalText: string;
  editedText?: string | null;
  actorId: string;
}) {
  const originalTextHash = createHash("sha256")
    .update(input.originalText ?? "")
    .digest("hex");
  return prisma.aiCopilotObservationReview.upsert({
    where: {
      copilotRunId_observationId_actorId: {
        copilotRunId: input.copilotRunId,
        observationId: input.observationId,
        actorId: input.actorId,
      },
    },
    update: {
      state: input.state,
      editedText: input.editedText?.slice(0, 600) ?? null,
      originalTextHash,
    },
    create: {
      copilotRunId: input.copilotRunId,
      observationId: input.observationId,
      state: input.state,
      originalTextHash,
      editedText: input.editedText?.slice(0, 600) ?? null,
      actorId: input.actorId,
    },
  });
}
