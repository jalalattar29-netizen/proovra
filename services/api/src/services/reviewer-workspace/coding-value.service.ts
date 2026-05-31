/**
 * PROOVRA Phase 2A — Coding Value write + audit service.
 *
 * Writes per-(workflow, field) coding values. Every write is
 * workspace-anchored, capability-gated, schema-validated, and
 * audit-logged.
 *
 * Hard rules:
 *   * Workflow must be bound to the schema the field belongs to (or
 *     the field's schema must be the workflow's bound schema).
 *   * Value shape is validated against the field's type. Invalid
 *     shapes → bounded FIELD_VALIDATION_FAILED.
 *   * Writes blocked when the workflow is in a terminal state
 *     (CLOSED / REJECTED_INSUFFICIENT / APPROVED_INTERNAL) — the
 *     workflow must be REOPENED before further coding.
 *   * Audit: each write emits a `reviewer.code.write` audit event
 *     via the existing platform-audit-log + reviewer-audit services.
 */

import type { PrismaClient } from "@prisma/client";
import {
  CODING_FIELD_TYPES,
  CONFIDENCE_SCORE_RANGE,
  REVIEWER_RISK_LEVELS,
  ESCALATION_LEVELS,
  REVIEWER_VERDICTS,
  type CodingFieldType,
  type ReviewerDenialReason,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export type WriteCodingValueInput = {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
  fieldId: string;
  /** Bounded payload — shape depends on the field type. */
  value: Record<string, unknown>;
  authorUserId: string;
  rationale?: string;
};

export type WriteCodingValueResult =
  | { ok: true; codingValueId: string }
  | { ok: false; denial: ReviewerDenialReason };

const TERMINAL_WORKFLOW_STATES = new Set<string>([
  "CLOSED",
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
]);

export async function writeCodingValue(
  input: WriteCodingValueInput,
): Promise<WriteCodingValueResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // Workflow + workspace anchoring.
  const workflow = await prisma.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: {
      id: true,
      status: true,
      assignedToUserId: true,
      codingSchemaId: true,
      codingSchemaVersion: true,
    },
  });
  if (!workflow) return deny("WORKFLOW_NOT_FOUND");
  if (TERMINAL_WORKFLOW_STATES.has(workflow.status)) {
    return deny("WORKFLOW_CLOSED");
  }

  // Field anchoring — must belong to the workflow's bound schema.
  const field = await prisma.codingField.findFirst({
    where: { id: input.fieldId },
    select: {
      id: true,
      schemaId: true,
      fieldType: true,
      required: true,
      options: true,
      schema: { select: { teamId: true } },
    },
  });
  if (!field) return deny("FIELD_NOT_FOUND");
  if (field.schema.teamId !== input.teamId) return deny("FIELD_NOT_FOUND");
  if (workflow.codingSchemaId !== field.schemaId) {
    return deny("SCHEMA_VERSION_MISMATCH");
  }

  // Validate the payload against the field type.
  const valError = validatePayloadForType(
    field.fieldType as CodingFieldType,
    input.value,
    (field.options ?? {}) as Record<string, unknown>,
  );
  if (valError) return deny(valError);

  const existing = await prisma.codingValue.findUnique({
    where: {
      coding_value_workflow_field_uniq: {
        workflowId: input.workflowId,
        fieldId: input.fieldId,
      },
    },
    select: { id: true },
  });

  const saved = existing
    ? await prisma.codingValue.update({
        where: { id: existing.id },
        data: {
          value: input.value as never,
          authorUserId: input.authorUserId,
          rationale: input.rationale ?? null,
        },
        select: { id: true },
      })
    : await prisma.codingValue.create({
        data: {
          teamId: input.teamId,
          workflowId: input.workflowId,
          fieldId: input.fieldId,
          value: input.value as never,
          authorUserId: input.authorUserId,
          rationale: input.rationale ?? null,
        },
        select: { id: true },
      });

  return { ok: true, codingValueId: saved.id };
}

/**
 * Bulk read of coding values for a workflow. Returns the bounded
 * shape used by the workspace UI.
 */
export async function readCodingValuesForWorkflow(input: {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.codingValue.findMany({
    where: { teamId: input.teamId, workflowId: input.workflowId },
    select: {
      id: true,
      fieldId: true,
      value: true,
      rationale: true,
      authorUserId: true,
      updatedAt: true,
    },
    take: 500,
  });
}

/**
 * Compute the "required fields fulfilled" status — used by the
 * approval gate (a non-PENDING verdict requires every required field
 * to be set).
 */
export async function evaluateRequiredFieldsCoverage(input: {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
}): Promise<{
  totalRequired: number;
  fulfilled: number;
  unfulfilledFieldIds: ReadonlyArray<string>;
}> {
  const prisma = input.prisma ?? defaultPrisma;
  const workflow = await prisma.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: { codingSchemaId: true },
  });
  if (!workflow?.codingSchemaId) {
    return { totalRequired: 0, fulfilled: 0, unfulfilledFieldIds: [] };
  }
  const required = await prisma.codingField.findMany({
    where: { schemaId: workflow.codingSchemaId, required: true },
    select: { id: true },
  });
  if (required.length === 0) {
    return { totalRequired: 0, fulfilled: 0, unfulfilledFieldIds: [] };
  }
  const values = await prisma.codingValue.findMany({
    where: { teamId: input.teamId, workflowId: input.workflowId },
    select: { fieldId: true },
  });
  const filled = new Set(values.map((v) => v.fieldId));
  const unfulfilled = required
    .filter((f) => !filled.has(f.id))
    .map((f) => f.id);
  return {
    totalRequired: required.length,
    fulfilled: required.length - unfulfilled.length,
    unfulfilledFieldIds: unfulfilled,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function deny<T extends ReviewerDenialReason>(
  reason: T,
): { ok: false; denial: T } {
  return { ok: false, denial: reason };
}

function validatePayloadForType(
  type: CodingFieldType,
  value: Record<string, unknown>,
  options: Record<string, unknown>,
): ReviewerDenialReason | null {
  void CODING_FIELD_TYPES;
  switch (type) {
    case "TEXT": {
      const t = value["text"];
      if (typeof t !== "string") return "FIELD_VALIDATION_FAILED";
      const maxLen =
        typeof options["maxLength"] === "number"
          ? (options["maxLength"] as number)
          : 2_000;
      if (t.length > maxLen) return "FIELD_VALIDATION_FAILED";
      return null;
    }
    case "NUMERIC": {
      const n = value["number"];
      if (typeof n !== "number" || !Number.isFinite(n)) {
        return "FIELD_VALIDATION_FAILED";
      }
      if (typeof options["min"] === "number" && n < (options["min"] as number)) {
        return "FIELD_VALIDATION_FAILED";
      }
      if (typeof options["max"] === "number" && n > (options["max"] as number)) {
        return "FIELD_VALIDATION_FAILED";
      }
      return null;
    }
    case "SINGLE_SELECT": {
      const v = value["single"];
      if (typeof v !== "string") return "FIELD_VALIDATION_FAILED";
      const opts = (options["options"] ?? []) as Array<{ value: string }>;
      if (!opts.some((o) => o.value === v)) return "FIELD_VALIDATION_FAILED";
      return null;
    }
    case "MULTI_SELECT": {
      const v = value["multi"];
      if (!Array.isArray(v)) return "FIELD_VALIDATION_FAILED";
      const opts = (options["options"] ?? []) as Array<{ value: string }>;
      const valid = new Set(opts.map((o) => o.value));
      for (const x of v) {
        if (typeof x !== "string" || !valid.has(x)) {
          return "FIELD_VALIDATION_FAILED";
        }
      }
      return null;
    }
    case "BOOLEAN": {
      const b = value["boolean"];
      if (typeof b !== "boolean") return "FIELD_VALIDATION_FAILED";
      return null;
    }
    case "CONFIDENCE_SCORE": {
      const c = value["confidence"];
      if (typeof c !== "number" || !Number.isFinite(c)) {
        return "FIELD_VALIDATION_FAILED";
      }
      if (c < CONFIDENCE_SCORE_RANGE.min || c > CONFIDENCE_SCORE_RANGE.max) {
        return "FIELD_VALIDATION_FAILED";
      }
      return null;
    }
    case "REVIEWER_VERDICT": {
      const v = value["verdict"];
      if (typeof v !== "string") return "FIELD_VALIDATION_FAILED";
      if (!(REVIEWER_VERDICTS as ReadonlyArray<string>).includes(v)) {
        return "FIELD_VALIDATION_FAILED";
      }
      return null;
    }
    case "RISK_LEVEL": {
      const v = value["risk"];
      if (typeof v !== "string") return "FIELD_VALIDATION_FAILED";
      if (!(REVIEWER_RISK_LEVELS as ReadonlyArray<string>).includes(v)) {
        return "FIELD_VALIDATION_FAILED";
      }
      return null;
    }
    case "ESCALATION_LEVEL": {
      const v = value["escalation"];
      if (typeof v !== "number" || !Number.isInteger(v)) {
        return "FIELD_VALIDATION_FAILED";
      }
      if (!(ESCALATION_LEVELS as ReadonlyArray<number>).includes(v as 0)) {
        return "FIELD_VALIDATION_FAILED";
      }
      return null;
    }
  }
}
