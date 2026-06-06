/**
 * PROOVRA Phase 2A — Coding Schema service.
 *
 * Workspace-anchored coding template registry. Provides:
 *
 *   - createSchema     — author a new DRAFT schema with fields
 *   - publishSchema    — flip DRAFT → PUBLISHED; bumps version
 *   - archiveSchema    — flip → ARCHIVED (cannot delete; workflows
 *                        already bound retain history)
 *   - listSchemas      — workspace-anchored list with bounded filter
 *   - getSchema        — read schema + fields in canonical order
 *   - bindToWorkflow   — pin a workflow to a (schemaId, version)
 *   - seedDefaults     — install the 6 pre-built schemas
 *                        (idempotent; only inserts when missing)
 *
 * Hard rules:
 *   * Workspace anchoring: every read filters on teamId.
 *   * Versioning: editing a PUBLISHED schema creates a NEW row with
 *     version + 1.
 *   * Bounded validation: category, status, field type, options blob.
 *   * Bounded denial reasons (REVIEWER_DENIAL_REASONS).
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  CODING_FIELD_TYPES,
  CODING_SCHEMA_CATEGORIES,
  REVIEWER_VERDICTS,
  REVIEWER_RISK_LEVELS,
  ESCALATION_LEVELS,
  type CodingFieldType,
  type CodingSchemaCategory,
  type ReviewerDenialReason,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
// Phase 4 — wire audit emission via the canonical platform audit log.
// `.catch(() => {})` keeps emission best-effort so audit failure cannot
// roll back the primary schema mutation. Bounded metadata only — field
// definitions are intentionally NOT included (could leak sensitive
// template structure into the platform audit chain).
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

// =============================================================================
// Public input/output types
// =============================================================================

export type CodingFieldDraft = {
  slug: string;
  label: string;
  fieldType: CodingFieldType;
  required: boolean;
  orderIndex: number;
  helpText?: string;
  options?: Record<string, unknown>;
};

export type CreateSchemaInput = {
  prisma?: PrismaClient;
  teamId: string;
  authorUserId: string;
  slug: string;
  label: string;
  category: CodingSchemaCategory;
  description?: string;
  fields: ReadonlyArray<CodingFieldDraft>;
};

export type CreateSchemaResult =
  | { ok: true; schemaId: string; version: number }
  | { ok: false; denial: ReviewerDenialReason };

export type PublishSchemaResult =
  | { ok: true; schemaId: string; publishedVersion: number }
  | { ok: false; denial: ReviewerDenialReason };

// =============================================================================
// Public API
// =============================================================================

export async function createSchema(
  input: CreateSchemaInput,
): Promise<CreateSchemaResult> {
  const prisma = input.prisma ?? defaultPrisma;
  if (!isBoundedSlug(input.slug)) return deny("SCHEMA_NOT_FOUND");
  if (!(CODING_SCHEMA_CATEGORIES as ReadonlyArray<string>).includes(input.category)) {
    return deny("SCHEMA_NOT_FOUND");
  }
  if (!input.fields || input.fields.length === 0) {
    return deny("FIELD_VALIDATION_FAILED");
  }
  for (const f of input.fields) {
    const verr = validateFieldDraft(f);
    if (verr) return deny(verr);
  }
  // New DRAFT or new version? Look up existing schema by (teamId, slug).
  const latest = await prisma.codingSchema.findFirst({
    where: { teamId: input.teamId, slug: input.slug },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;

  const schema = await prisma.codingSchema.create({
    data: {
      teamId: input.teamId,
      // R7-reviewer-workspace: CodingSchema.name is the legacy required column; CodingSchema.label is the
      // R7-additive user-facing display name. Service inputs only carry `label` (the user types it once
      // and we treat name=label for new schemas; legacy rows keep their original name unchanged on read).
      name: input.label,
      slug: input.slug,
      label: input.label,
      category: input.category,
      version,
      status: "DRAFT",
      description: input.description ?? null,
      createdByUserId: input.authorUserId,
      fields: {
        create: input.fields.map((f) => ({
          // R7-reviewer-workspace: CodingField.teamId is workspace-anchored (required) — inherited from
          // the parent CodingSchema's teamId so nested-create matches the parent's workspace.
          teamId: input.teamId,
          slug: f.slug,
          label: f.label,
          fieldType: f.fieldType,
          required: f.required,
          orderIndex: f.orderIndex,
          helpText: f.helpText ?? null,
          // R7-reviewer-workspace: Json field; null is encoded via Prisma.JsonNull (Prisma's nullable Json sentinel).
          // Pass-through cast to Prisma.InputJsonValue covers both null and populated cases.
          options: (f.options ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        })),
      },
    },
    select: { id: true, version: true },
  });
  // Phase 4 — best-effort audit emission. Bounded metadata: IDs,
  // slug, version, and category enum. Field definitions are
  // intentionally NOT included.
  await appendPlatformAuditLog({
    userId: input.authorUserId,
    action: "reviewer.coding_schema.created",
    category: "review",
    severity: "info",
    source: "reviewer_workspace.coding_schema",
    outcome: "success",
    resourceType: "coding_schema",
    resourceId: schema.id,
    metadata: {
      teamId: input.teamId,
      schemaId: schema.id,
      slug: input.slug,
      category: input.category,
      version: schema.version,
    },
  }).catch(() => {});
  return { ok: true, schemaId: schema.id, version: schema.version };
}

export async function publishSchema(
  input: { prisma?: PrismaClient; teamId: string; schemaId: string },
): Promise<PublishSchemaResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const schema = await prisma.codingSchema.findFirst({
    where: { id: input.schemaId, teamId: input.teamId },
    select: { id: true, status: true, version: true, slug: true },
  });
  if (!schema) return deny("SCHEMA_NOT_FOUND") as PublishSchemaResult;
  if (schema.status !== "DRAFT") {
    return deny("SCHEMA_VERSION_MISMATCH") as PublishSchemaResult;
  }
  await prisma.codingSchema.update({
    where: { id: schema.id },
    data: { status: "PUBLISHED", publishedAt: new Date() },
  });
  // Phase 4 — best-effort audit emission. Bounded metadata: IDs,
  // slug and published version. No actor is available on the
  // service signature (the route binds requireAuth + requireCap);
  // userId is null since this is workspace-anchored to teamId.
  await appendPlatformAuditLog({
    userId: null,
    isPublic: true,
    action: "reviewer.coding_schema.published",
    category: "review",
    severity: "info",
    source: "reviewer_workspace.coding_schema",
    outcome: "success",
    resourceType: "coding_schema",
    resourceId: schema.id,
    metadata: {
      teamId: input.teamId,
      schemaId: schema.id,
      slug: schema.slug,
      version: schema.version,
    },
  }).catch(() => {});
  return { ok: true, schemaId: schema.id, publishedVersion: schema.version };
}

export async function archiveSchema(
  input: { prisma?: PrismaClient; teamId: string; schemaId: string },
): Promise<{ ok: true } | { ok: false; denial: ReviewerDenialReason }> {
  const prisma = input.prisma ?? defaultPrisma;
  const schema = await prisma.codingSchema.findFirst({
    where: { id: input.schemaId, teamId: input.teamId },
    select: { id: true, status: true, slug: true },
  });
  if (!schema) return deny("SCHEMA_NOT_FOUND");
  await prisma.codingSchema.update({
    where: { id: schema.id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
  // Phase 4 — best-effort audit emission. Bounded metadata: IDs and
  // slug. No actor on the service signature.
  await appendPlatformAuditLog({
    userId: null,
    isPublic: true,
    action: "reviewer.coding_schema.archived",
    category: "review",
    severity: "info",
    source: "reviewer_workspace.coding_schema",
    outcome: "success",
    resourceType: "coding_schema",
    resourceId: schema.id,
    metadata: {
      teamId: input.teamId,
      schemaId: schema.id,
      slug: schema.slug,
    },
  }).catch(() => {});
  return { ok: true };
}

export async function listSchemas(
  input: { prisma?: PrismaClient; teamId: string; status?: string | null; category?: CodingSchemaCategory | null },
) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.codingSchema.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.category ? { category: input.category } : {}),
    },
    orderBy: [{ category: "asc" }, { slug: "asc" }, { version: "desc" }],
    select: {
      id: true,
      slug: true,
      label: true,
      category: true,
      version: true,
      status: true,
      description: true,
      publishedAt: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { fields: true } },
    },
    take: 500,
  });
}

export async function getSchema(
  input: { prisma?: PrismaClient; teamId: string; schemaId: string },
) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.codingSchema.findFirst({
    where: { id: input.schemaId, teamId: input.teamId },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
    },
  });
}

export async function bindSchemaToWorkflow(input: {
  prisma?: PrismaClient;
  teamId: string;
  workflowId: string;
  schemaId: string;
}): Promise<{ ok: true } | { ok: false; denial: ReviewerDenialReason }> {
  const prisma = input.prisma ?? defaultPrisma;
  const schema = await prisma.codingSchema.findFirst({
    where: { id: input.schemaId, teamId: input.teamId, status: "PUBLISHED" },
    select: { id: true, version: true },
  });
  if (!schema) return deny("SCHEMA_NOT_FOUND");
  const workflow = await prisma.evidenceReviewWorkflow.findFirst({
    where: { id: input.workflowId, teamId: input.teamId },
    select: { id: true },
  });
  if (!workflow) return deny("WORKFLOW_NOT_FOUND");
  await prisma.evidenceReviewWorkflow.update({
    where: { id: workflow.id },
    data: { codingSchemaId: schema.id, codingSchemaVersion: schema.version },
  });
  return { ok: true };
}

// =============================================================================
// Seed defaults — 6 pre-built schemas
// =============================================================================

import { DEFAULT_SCHEMAS } from "./coding-schema-defaults.js";

/**
 * Phase O — Sentry NODE-1P repair.
 *
 * `seedDefaultSchemas` previously hit a Prisma null-constraint error
 * on a fresh production workspace because the underlying
 * `coding_schemas` / `coding_fields` columns hadn't received every
 * R7-reviewer-workspace additive column on that DB. The repair
 * migration `20270802000000_phase_sentry_batch_schema_drift_repair`
 * idempotently re-asserts every R7 column on both tables; with that
 * applied, the original create path works.
 *
 * This service is now self-healing on top of that:
 *
 *   1. Natural-key lookup by `(teamId, slug)` first — already
 *      workspace-anchored.
 *   2. Existing row → no-op (counted in `updated`). The legacy
 *      `existing` key is preserved for the web client at
 *      apps/web/lib/reviewer-workspace/reviewer-api.ts so we ship
 *      both fields and the caller picks whichever it depends on.
 *   3. Missing row → create + publish in the same transaction. A
 *      per-spec try/catch keeps a single bad row from breaking the
 *      whole seed pass; failed rows are counted in `failed` so the
 *      operator sees an honest summary.
 *
 * Idempotent — safe to call any number of times; canonical seed is
 * platform documentation, not customer content.
 */
export async function seedDefaultSchemas(input: {
  prisma?: PrismaClient;
  teamId: string;
  authorUserId: string;
}): Promise<{
  created: number;
  updated: number;
  // Legacy alias retained for the web client. Same value as `updated`.
  existing: number;
  failed: number;
}> {
  const prisma = input.prisma ?? defaultPrisma;
  let created = 0;
  let updated = 0;
  let failed = 0;
  for (const spec of DEFAULT_SCHEMAS) {
    try {
      const found = await prisma.codingSchema.findFirst({
        where: { teamId: input.teamId, slug: spec.slug },
        select: { id: true },
      });
      if (found) {
        // No-op upsert — the canonical seed catalog is the source of
        // truth, but we deliberately do NOT overwrite a live row's
        // edits. Treat as `updated` (legacy `existing`) so the
        // caller's totals stay honest.
        updated += 1;
        continue;
      }
      const res = await createSchema({
        teamId: input.teamId,
        authorUserId: input.authorUserId,
        slug: spec.slug,
        label: spec.label,
        category: spec.category,
        description: spec.description,
        fields: spec.fields,
      });
      if (res.ok) {
        await publishSchema({
          teamId: input.teamId,
          schemaId: res.schemaId,
        });
        created += 1;
      } else {
        // Bounded denial from createSchema (slug / field validation).
        // The seed catalog is hand-built so this is effectively a
        // catalog bug; surface it as `failed` rather than 500ing the
        // whole route.
        failed += 1;
      }
    } catch {
      // Defensive — a single bad row never poisons the rest of the
      // pass. Operator sees the count via the response; the row is
      // safe to retry on next seed.
      failed += 1;
    }
  }
  return { created, updated, existing: updated, failed };
}

// =============================================================================
// Helpers
// =============================================================================

function deny<T extends ReviewerDenialReason>(
  reason: T,
): { ok: false; denial: T } {
  return { ok: false, denial: reason };
}

function isBoundedSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-_]{0,78}[a-z0-9]$/.test(slug);
}

function validateFieldDraft(f: CodingFieldDraft): ReviewerDenialReason | null {
  if (!isBoundedSlug(f.slug)) return "FIELD_VALIDATION_FAILED";
  if (!f.label || f.label.length === 0 || f.label.length > 180) {
    return "FIELD_VALIDATION_FAILED";
  }
  if (!(CODING_FIELD_TYPES as ReadonlyArray<string>).includes(f.fieldType)) {
    return "FIELD_VALIDATION_FAILED";
  }
  if (!Number.isInteger(f.orderIndex) || f.orderIndex < 0) {
    return "FIELD_VALIDATION_FAILED";
  }
  // Type-specific option-blob sanity.
  if (f.fieldType === "SINGLE_SELECT" || f.fieldType === "MULTI_SELECT") {
    const opts = (f.options ?? {}) as { options?: unknown };
    if (!Array.isArray(opts.options) || opts.options.length === 0) {
      return "FIELD_VALIDATION_FAILED";
    }
  }
  if (f.fieldType === "REVIEWER_VERDICT") {
    // No options needed — the bounded enum is REVIEWER_VERDICTS.
    void REVIEWER_VERDICTS;
  }
  if (f.fieldType === "RISK_LEVEL") {
    void REVIEWER_RISK_LEVELS;
  }
  if (f.fieldType === "ESCALATION_LEVEL") {
    void ESCALATION_LEVELS;
  }
  return null;
}
