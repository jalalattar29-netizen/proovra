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
  /**
   * Review remediation A (2026-11-27) — optimistic concurrency. The field
   * revision the caller based this change on (see {@link codingFieldRevision}).
   * When given and the field has moved on, nothing is written and the result
   * is a {@link CodingValueConflict}. Omitted (older clients, bulk coding):
   * last writer wins, still inside the locked transaction.
   */
  expectedRevision?: number;
};

/**
 * Review remediation A — the typed refusal for a stale coding change: the
 * field was written or cleared (another tab, another reviewer) after the
 * revision the caller based its change on. Carries what is stored now so the
 * client can show it without guessing.
 */
export const CODING_VALUE_CONFLICT = "CODING_VALUE_CONFLICT" as const;
export type CodingValueConflict = {
  ok: false;
  denial: typeof CODING_VALUE_CONFLICT;
  current: { revision: number; value: unknown | null };
};

export type WriteCodingValueResult =
  | { ok: true; codingValueId: string; revision: number }
  | { ok: false; denial: ReviewerDenialReason }
  | CodingValueConflict;

const TERMINAL_WORKFLOW_STATES = new Set<string>([
  "CLOSED",
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
]);

/*
 * Review remediation C (2026-11-27) — ONE LOCK FOR EVERYTHING THAT READS OR
 * CHANGES A REVIEW'S CODING STATE.
 *
 * A coding write/clear used to read the workflow (status, bound schema) and
 * then write in a separate transaction, so a final decision (completeness
 * check + snapshot) or a schema rebind could interleave: a value could land
 * on a review that had just closed, a snapshot could disagree with the stored
 * values, an old-schema write could be stored after the rebind.
 *
 * Every participant now takes the workflow row lock FIRST, inside the
 * transaction that does its work, and only then reads the state it decides
 * on (READ COMMITTED: a statement after the lock sees everything committed
 * by whoever held it before):
 *
 *   * writeCodingValue / clearCodingValue (and bulk coding, which calls them)
 *   * bindSchemaToWorkflow (coding-schema.service)
 *   * recordReviewDecision's decision transaction (review-decision.service)
 *   * Close (review-operations.service, pre-existing, same statement)
 *
 * Lock order is always: workflow row, then the coding / decision rows. No
 * participant takes a coding row lock before the workflow row, so the lock
 * cannot deadlock between them.
 */
/** The read surface + raw query the locked coding transaction uses. */
type CodingTxClient = Pick<
  PrismaClient,
  "evidenceReviewWorkflow" | "codingField" | "codingValue" | "codingValueHistory" | "$queryRaw"
>;

/**
 * Take the workflow row lock (`SELECT … FOR UPDATE`) inside the caller's
 * transaction. Returns false when no such workflow exists in this workspace.
 */
export async function lockReviewWorkflowRow(
  tx: Pick<PrismaClient, "$queryRaw">,
  input: { workflowId: string; teamId: string },
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "evidence_review_workflows"
     WHERE "id" = ${input.workflowId}::uuid AND "team_id" = ${input.teamId}::uuid
       FOR UPDATE`;
  return rows.length === 1;
}

/**
 * Review remediation A — the revision of one coded field: the number of
 * `coding_value_history` rows for (workflow, field). Every write and every
 * effective clear appends exactly one history row, the table is append-only
 * (no code path updates or deletes it), so the count only ever grows and two
 * different stored states never share a revision (no A-B-A). It needs no
 * schema migration. Read it under the workflow lock to decide a write.
 */
export async function codingFieldRevision(
  client: Pick<PrismaClient, "codingValueHistory">,
  input: { teamId: string; workflowId: string; fieldId: string },
): Promise<number> {
  return client.codingValueHistory.count({
    where: { teamId: input.teamId, workflowId: input.workflowId, fieldId: input.fieldId },
  });
}

/**
 * Run `fn` in a transaction holding the workflow lock. A caller that is
 * already inside a transaction passes its client (no `$transaction`): the
 * lock and the work then run in theirs.
 */
async function inLockedWorkflowTx<T>(
  prisma: PrismaClient,
  input: { workflowId: string; teamId: string },
  fn: (tx: CodingTxClient) => Promise<T>,
  onMissing: () => T,
): Promise<T> {
  const body = async (tx: CodingTxClient): Promise<T> => {
    if (!(await lockReviewWorkflowRow(tx, input))) return onMissing();
    return fn(tx);
  };
  return typeof (prisma as { $transaction?: unknown }).$transaction === "function"
    ? prisma.$transaction((tx) => body(tx as unknown as CodingTxClient))
    : body(prisma as unknown as CodingTxClient);
}

async function conflictFor(
  tx: CodingTxClient,
  input: { teamId: string; workflowId: string; fieldId: string },
  revision: number,
): Promise<CodingValueConflict> {
  const stored = await tx.codingValue.findFirst({
    where: { teamId: input.teamId, workflowId: input.workflowId, fieldId: input.fieldId },
    select: { value: true },
  });
  return {
    ok: false,
    denial: CODING_VALUE_CONFLICT,
    current: { revision, value: stored?.value ?? null },
  };
}

export async function writeCodingValue(
  input: WriteCodingValueInput,
): Promise<WriteCodingValueResult> {
  const prisma = input.prisma ?? defaultPrisma;
  return inLockedWorkflowTx<WriteCodingValueResult>(
    prisma,
    input,
    (tx) => writeCodingValueLocked(tx, input),
    () => deny("WORKFLOW_NOT_FOUND"),
  );
}

async function writeCodingValueLocked(
  tx: CodingTxClient,
  input: WriteCodingValueInput,
): Promise<WriteCodingValueResult> {
  // Workflow + workspace anchoring — read UNDER the lock, so a decision or a
  // rebind that committed first is seen, and one still pending waits for us.
  const workflow = await tx.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: {
      id: true,
      status: true,
      codingSchemaId: true,
    },
  });
  if (!workflow) return deny("WORKFLOW_NOT_FOUND");
  if (TERMINAL_WORKFLOW_STATES.has(workflow.status)) {
    return deny("WORKFLOW_CLOSED");
  }

  // Field anchoring — must belong to the workflow's CURRENTLY bound schema.
  const field = await tx.codingField.findFirst({
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

  // Review remediation A — refuse a change based on a superseded revision.
  const revision = await codingFieldRevision(tx, input);
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    return conflictFor(tx, input, revision);
  }

  /*
   * PRO-099 (FEATURES-17) — ONE WRITE ON THE UNIQUE KEY.
   *
   * A read on (workflow, field) followed by a create let two concurrent first
   * writes both see "absent"; the second create hit the unique constraint and
   * surfaced as an unmapped P2002, a 500 that lost that reviewer's value. The
   * write is now an upsert on the same key, which the database resolves as
   * one statement (INSERT … ON CONFLICT … DO UPDATE): both writers succeed and
   * the later one is the stored value, exactly as two sequential writes are.
   */
  /*
   * PRO-R2-17 — THE VALUE AND ITS HISTORY ROW ARE ONE WRITE. The current row
   * is still one per (workflow, field); every write also appends what was
   * written, by whom and why, so a later reviewer's value never erases an
   * earlier one. (A caller that is already inside a transaction passes its
   * client, which has no $transaction: both statements then run in theirs.)
   * Both now run inside the locked transaction (review remediation C).
   */
  const writeBoth = async (client: Pick<PrismaClient, "codingValue" | "codingValueHistory">) => {
    const row = await client.codingValue.upsert({
    where: {
      coding_value_workflow_field_uniq: {
        workflowId: input.workflowId,
        fieldId: input.fieldId,
      },
    },
    create: {
      teamId: input.teamId,
      workflowId: input.workflowId,
      fieldId: input.fieldId,
      value: input.value as never,
      authorUserId: input.authorUserId,
      rationale: input.rationale ?? null,
    },
    update: {
      value: input.value as never,
      authorUserId: input.authorUserId,
      rationale: input.rationale ?? null,
    },
    select: { id: true },
    });
    await client.codingValueHistory.create({
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
    return row;
  };
  const saved = await writeBoth(tx);

  // Exactly one history row was appended: the new revision.
  return { ok: true, codingValueId: saved.id, revision: revision + 1 };
}

/**
 * Review remediation §6 (F-13) — the history value recorded when a reviewer
 * explicitly clears a field. It is never a valid field payload, so it can
 * never be mistaken for a coded value.
 */
export const CODING_VALUE_CLEARED_MARKER = Object.freeze({ cleared: true });

export type ClearCodingValueInput = {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
  fieldId: string;
  actorUserId: string;
  rationale?: string;
  /** Same contract as {@link WriteCodingValueInput.expectedRevision}. */
  expectedRevision?: number;
};

export type ClearCodingValueResult =
  | {
      ok: true;
      /** false when nothing was set (idempotent no-op; no history row). */
      cleared: boolean;
      /** The id of the removed current-value row, or null. */
      codingValueId: string | null;
      /** The field's revision after this clear (unchanged by a no-op). */
      revision: number;
    }
  | { ok: false; denial: ReviewerDenialReason }
  | CodingValueConflict;

/**
 * Review remediation §6 (F-13) — explicitly clear a coded field.
 *
 * Same anchoring as {@link writeCodingValue}: the workflow must exist in this
 * workspace and not be terminal (CLOSED / APPROVED_INTERNAL /
 * REJECTED_INSUFFICIENT → WORKFLOW_CLOSED); the field must belong to this
 * workspace (FIELD_NOT_FOUND) and to the workflow's CURRENTLY bound schema
 * (SCHEMA_VERSION_MISMATCH). The capability check (`review.code`) and the
 * caller's reach stay with the route, exactly as for writes.
 *
 * Removes the current value row and appends a history row whose value is
 * `{ "cleared": true }`, in one transaction. Idempotent: when nothing is set
 * it returns `{ ok: true, cleared: false }` and writes nothing.
 */
export async function clearCodingValue(
  input: ClearCodingValueInput,
): Promise<ClearCodingValueResult> {
  const prisma = input.prisma ?? defaultPrisma;
  return inLockedWorkflowTx<ClearCodingValueResult>(
    prisma,
    input,
    (tx) => clearCodingValueLocked(tx, input),
    () => deny("WORKFLOW_NOT_FOUND"),
  );
}

async function clearCodingValueLocked(
  tx: CodingTxClient,
  input: ClearCodingValueInput,
): Promise<ClearCodingValueResult> {
  // Read under the workflow lock (review remediation C), as for writes.
  const workflow = await tx.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: { id: true, status: true, codingSchemaId: true },
  });
  if (!workflow) return deny("WORKFLOW_NOT_FOUND");
  if (TERMINAL_WORKFLOW_STATES.has(workflow.status)) {
    return deny("WORKFLOW_CLOSED");
  }
  const field = await tx.codingField.findFirst({
    where: { id: input.fieldId },
    select: { id: true, schemaId: true, schema: { select: { teamId: true } } },
  });
  if (!field) return deny("FIELD_NOT_FOUND");
  if (field.schema.teamId !== input.teamId) return deny("FIELD_NOT_FOUND");
  if (workflow.codingSchemaId !== field.schemaId) {
    return deny("SCHEMA_VERSION_MISMATCH");
  }

  // Review remediation A — refuse a clear based on a superseded revision.
  const revision = await codingFieldRevision(tx, input);
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    return conflictFor(tx, input, revision);
  }

  const clearBoth = async (
    client: Pick<PrismaClient, "codingValue" | "codingValueHistory">,
  ): Promise<{ cleared: boolean; codingValueId: string | null }> => {
    const existing = await client.codingValue.findFirst({
      where: {
        teamId: input.teamId,
        workflowId: input.workflowId,
        fieldId: input.fieldId,
      },
      select: { id: true },
    });
    if (!existing) return { cleared: false, codingValueId: null };
    // deleteMany: a concurrent clear that removed the row first makes this
    // one a no-op instead of a P2025.
    const removed = await client.codingValue.deleteMany({
      where: { id: existing.id },
    });
    if (removed.count === 0) return { cleared: false, codingValueId: null };
    await client.codingValueHistory.create({
      data: {
        teamId: input.teamId,
        workflowId: input.workflowId,
        fieldId: input.fieldId,
        value: CODING_VALUE_CLEARED_MARKER as never,
        authorUserId: input.actorUserId,
        rationale: input.rationale ?? null,
      },
      select: { id: true },
    });
    return { cleared: true, codingValueId: existing.id };
  };
  const res = await clearBoth(tx);
  return { ok: true, ...res, revision: res.cleared ? revision + 1 : revision };
}

/**
 * The read surface the coding helpers need. Satisfied by the PrismaClient and
 * by an interactive-transaction client (`Prisma.TransactionClient`).
 */
export type CodingReadClient = Pick<
  PrismaClient,
  | "evidenceReviewWorkflow"
  | "codingField"
  | "codingValue"
  | "codingSchema"
  | "workspaceGovernancePolicy"
>;

export type CodingValueProjectionRow = {
  id: string;
  fieldId: string;
  value: unknown;
  rationale: string | null;
  authorUserId: string | null;
  updatedAt: Date;
};

export type OtherSchemaCodingValueRow = CodingValueProjectionRow & {
  schemaId: string;
  schemaLabel: string | null;
  schemaVersion: number;
  fieldSlug: string;
  fieldLabel: string;
  fieldType: string;
};

/**
 * Review remediation §6 (F-26) — the coding values of a workflow, split by
 * the schema they were coded against.
 *
 *   * `values` — only values whose field belongs to the CURRENTLY bound
 *     schema (`workflow.codingSchemaId`). These are the current values.
 *   * `otherSchemaValues` — values coded against a previously bound schema.
 *     Kept (never deleted) and listed as history, never as current.
 *
 * An unbound workflow has no current values: everything is "other".
 * Unknown workflow → both empty.
 */
export async function readCodingValuesPartitioned(input: {
  prisma?: CodingReadClient;
  teamId: string;
  workflowId: string;
}): Promise<{
  boundSchemaId: string | null;
  values: CodingValueProjectionRow[];
  otherSchemaValues: OtherSchemaCodingValueRow[];
}> {
  const prisma = input.prisma ?? defaultPrisma;
  const workflow = await prisma.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: { codingSchemaId: true },
  });
  if (!workflow) return { boundSchemaId: null, values: [], otherSchemaValues: [] };
  const rows = await prisma.codingValue.findMany({
    where: { teamId: input.teamId, workflowId: input.workflowId },
    select: {
      id: true,
      fieldId: true,
      value: true,
      rationale: true,
      authorUserId: true,
      updatedAt: true,
      field: {
        select: {
          schemaId: true,
          slug: true,
          label: true,
          fieldType: true,
          orderIndex: true,
          schema: { select: { label: true, version: true } },
        },
      },
    },
    take: 500,
  });
  const boundSchemaId = workflow.codingSchemaId ?? null;
  const values: CodingValueProjectionRow[] = [];
  const otherSchemaValues: OtherSchemaCodingValueRow[] = [];
  for (const r of rows) {
    const base: CodingValueProjectionRow = {
      id: r.id,
      fieldId: r.fieldId,
      value: r.value,
      rationale: r.rationale,
      authorUserId: r.authorUserId,
      updatedAt: r.updatedAt,
    };
    if (boundSchemaId !== null && r.field.schemaId === boundSchemaId) {
      values.push(base);
    } else {
      otherSchemaValues.push({
        ...base,
        schemaId: r.field.schemaId,
        schemaLabel: r.field.schema.label ?? null,
        schemaVersion: r.field.schema.version,
        fieldSlug: r.field.slug,
        fieldLabel: r.field.label,
        fieldType: r.field.fieldType,
      });
    }
  }
  otherSchemaValues.sort(
    (a, b) =>
      a.schemaId.localeCompare(b.schemaId) ||
      a.fieldLabel.localeCompare(b.fieldLabel),
  );
  return { boundSchemaId, values, otherSchemaValues };
}

/**
 * Review remediation A — every coded field's revision for a workflow
 * (`fieldId → revision`, see {@link codingFieldRevision}). A field missing
 * from the map has revision 0 (never written).
 */
export async function readCodingFieldRevisions(
  client: Pick<PrismaClient, "codingValueHistory">,
  input: { teamId: string; workflowId: string },
): Promise<Record<string, number>> {
  const groups = await client.codingValueHistory.groupBy({
    by: ["fieldId"],
    where: { teamId: input.teamId, workflowId: input.workflowId },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const g of groups) out[g.fieldId] = g._count._all;
  return out;
}

/**
 * Review remediation A — the current values (partitioned as
 * {@link readCodingValuesPartitioned}) and the field revisions read from ONE
 * snapshot (REPEATABLE READ), so a value is never paired with a revision from
 * a later write. Each current/other value carries its field's `revision`.
 */
export async function readCodingValuesWithRevisions(input: {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
}): Promise<{
  boundSchemaId: string | null;
  values: Array<CodingValueProjectionRow & { revision: number }>;
  otherSchemaValues: Array<OtherSchemaCodingValueRow & { revision: number }>;
  revisions: Record<string, number>;
}> {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.$transaction(
    async (tx) => {
      const client = tx as unknown as PrismaClient;
      const partition = await readCodingValuesPartitioned({ ...input, prisma: client });
      const revisions = await readCodingFieldRevisions(client, input);
      const rev = (fieldId: string) => revisions[fieldId] ?? 0;
      return {
        boundSchemaId: partition.boundSchemaId,
        values: partition.values.map((v) => ({ ...v, revision: rev(v.fieldId) })),
        otherSchemaValues: partition.otherSchemaValues.map((v) => ({ ...v, revision: rev(v.fieldId) })),
        revisions,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export type CodingSnapshot = {
  schemaId: string;
  schemaVersion: number;
  /** ISO-8601 UTC instant the snapshot was taken. */
  capturedAtUtc: string;
  /**
   * One entry per field of the bound schema, in field order. `value` is the
   * stored payload, or null when the field was not coded.
   */
  values: Array<{
    fieldId: string;
    slug: string;
    label: string;
    fieldType: string;
    value: unknown;
  }>;
};

/**
 * Review remediation §6 (F-20) — the immutable coding snapshot stored on the
 * finalizing DECISION_LOGGED event.
 *
 * Read-only. Pass the decision's transaction client so the snapshot reads the
 * same state the decision commits. Returns null when the workflow is unknown
 * in this workspace or no schema is bound. Only fields of the CURRENTLY bound
 * schema are captured (values coded against an earlier schema are not part of
 * this round's assessment).
 */
export async function buildCodingSnapshot(
  client: CodingReadClient,
  input: { teamId: string; workflowId: string; now?: Date },
): Promise<CodingSnapshot | null> {
  const workflow = await client.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: { codingSchemaId: true, codingSchemaVersion: true },
  });
  if (!workflow?.codingSchemaId) return null;
  const schema = await client.codingSchema.findFirst({
    where: { id: workflow.codingSchemaId, teamId: input.teamId },
    select: { id: true, version: true },
  });
  if (!schema) return null;
  const fields = await client.codingField.findMany({
    where: { schemaId: schema.id },
    orderBy: [{ orderIndex: "asc" }, { slug: "asc" }],
    select: { id: true, slug: true, label: true, fieldType: true },
  });
  const stored = fields.length
    ? await client.codingValue.findMany({
        where: {
          teamId: input.teamId,
          workflowId: input.workflowId,
          fieldId: { in: fields.map((f) => f.id) },
        },
        select: { fieldId: true, value: true },
      })
    : [];
  const byField = new Map(stored.map((v) => [v.fieldId, v.value]));
  return {
    schemaId: schema.id,
    schemaVersion: workflow.codingSchemaVersion ?? schema.version,
    capturedAtUtc: (input.now ?? new Date()).toISOString(),
    values: fields.map((f) => ({
      fieldId: f.id,
      slug: f.slug,
      label: f.label,
      fieldType: f.fieldType,
      value: byField.has(f.id) ? (byField.get(f.id) ?? null) : null,
    })),
  };
}

export type CodingIncompleteRefusal = {
  reason: "coding_incomplete";
  missingFieldIds: string[];
  missingLabels: string[];
};

/**
 * Review remediation §6 (F-18) — the optional complete-coding policy.
 *
 * Returns a refusal ONLY when ALL hold:
 *   * workspace_governance_policies.review_requires_complete_coding is true
 *     and its `since` timestamp is set;
 *   * `roundStartedAt` (the current round's Start) is not null and is at or
 *     after that `since` — rounds started earlier are never refused (no
 *     retroactive enforcement);
 *   * `decision` is APPROVE or REJECT (REQUEST_INFO and anything else is
 *     never refused for coding);
 *   * at least one required field of the bound schema has no value
 *     (evaluateRequiredFieldsCoverage).
 * Otherwise null. Read-only; pass the decision's transaction client.
 */
export async function codingCompletenessRefusal(
  client: CodingReadClient,
  input: {
    teamId: string;
    workflowId: string;
    decision: string;
    roundStartedAt: Date | null;
  },
): Promise<CodingIncompleteRefusal | null> {
  if (input.decision !== "APPROVE" && input.decision !== "REJECT") return null;
  if (!input.roundStartedAt) return null;
  const policy = await client.workspaceGovernancePolicy.findUnique({
    where: { teamId: input.teamId },
    select: {
      reviewRequiresCompleteCoding: true,
      reviewRequiresCompleteCodingSince: true,
    },
  });
  if (!policy?.reviewRequiresCompleteCoding) return null;
  const since = policy.reviewRequiresCompleteCodingSince;
  if (!since) return null;
  if (input.roundStartedAt.getTime() < since.getTime()) return null;
  const coverage = await evaluateRequiredFieldsCoverage({
    prisma: client,
    teamId: input.teamId,
    workflowId: input.workflowId,
  });
  if (coverage.unfulfilledFieldIds.length === 0) return null;
  const missing = await client.codingField.findMany({
    where: { id: { in: [...coverage.unfulfilledFieldIds] } },
    orderBy: [{ orderIndex: "asc" }, { slug: "asc" }],
    select: { id: true, label: true },
  });
  return {
    reason: "coding_incomplete",
    missingFieldIds: missing.map((f) => f.id),
    missingLabels: missing.map((f) => f.label),
  };
}

/**
 * PRO-R2-17 — every value written for a workflow's fields, oldest first
 * (bounded). The current value of a field is its latest row.
 */
export async function readCodingValueHistoryForWorkflow(input: {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.codingValueHistory.findMany({
    where: { teamId: input.teamId, workflowId: input.workflowId },
    orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      fieldId: true,
      value: true,
      rationale: true,
      authorUserId: true,
      recordedAt: true,
    },
    take: 1000,
  });
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
 * Compute the "required fields fulfilled" status of the bound schema. A
 * missing required field means the assessment is incomplete (a warning);
 * it refuses a decision only through {@link codingCompletenessRefusal}
 * when the workspace policy is on.
 */
export async function evaluateRequiredFieldsCoverage(input: {
  prisma?: CodingReadClient;
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
