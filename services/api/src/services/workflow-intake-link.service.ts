/**
 * Phase 4 — Workflow intake link CRUD service.
 *
 * Authenticated administrative operations: create / list / get / revoke.
 * Does NOT serve public traffic — that path is in
 * external-intake.routes.ts which calls into workflow-intake-session.service.ts.
 *
 * Contract:
 *   - Every create gets a freshly-issued token from the token service. The
 *     raw token is returned to the caller exactly once; everything stored
 *     in the DB is an HMAC.
 *   - Listing never exposes the token hash. It is treated as a server-side
 *     secret on the same level as a password hash.
 *   - Revocation is idempotent.
 *
 * Phase 4 explicitly does NOT implement:
 *   - delivery (SMS / email) — Phase 5.
 *   - upload orchestration via the link — Phase 5+, wired into the existing
 *     authenticated capture pipeline with EXTERNAL_INTAKE_UPLOAD capture
 *     method.
 */

import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  WorkflowIntakeLink as DbWorkflowIntakeLink,
} from "@prisma/client";
import {
  isExternalWorkflowIntakeMode,
  WorkflowIntakeMode,
  WorkflowIntakeModeSchema,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import { issueIntakeToken } from "./workflow-intake-token.service.js";
import {
  liftIntakeTemplateToWorkflowTemplate,
  parseDbWorkflowTemplate,
} from "./workflow-template.service.js";
import {
  getIntakeTemplate,
} from "./capture-intake-templates.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type CreateWorkflowIntakeLinkInput = {
  teamId: string;
  workflowTemplateSlug: string;
  intakeMode: WorkflowIntakeMode;
  caseId?: string | null;
  recipientLabel?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  maxUses?: number;
  maxFileCountPerSession?: number | null;
  maxBytesPerSession?: bigint | null;
  allowedAcceptedKinds?: string[];
  consentPolicyVersion?: string | null;
  consentDisclosureText?: string | null;
  expiresAtUtc: Date;
  ipAllowlistCidrs?: string[];
};

export type CreateWorkflowIntakeLinkContext = {
  actorUserId: string;
};

export type CreatedWorkflowIntakeLinkResult = {
  link: DbWorkflowIntakeLink;
  rawToken: string;
};

export class WorkflowIntakeLinkError extends Error {
  constructor(
    public readonly code:
      | "feature_disabled"
      | "template_not_found"
      | "intake_mode_not_external"
      | "intake_mode_not_supported_by_template"
      | "expiry_in_past"
      | "max_uses_invalid"
      | "internal",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WorkflowIntakeLinkError";
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function loadEffectiveWorkflowTemplate(
  teamId: string,
  slug: string,
  client: Pick<PrismaClient, "evidenceWorkflowTemplate">,
): Promise<{
  source: "platform_seed" | "platform_db" | "workspace_db";
  templateId: string | null;
  version: number;
  snapshot: unknown;
  intakeModes: WorkflowIntakeMode[];
}> {
  // 1. Workspace-scoped DB row wins by slug.
  const workspaceRow = await client.evidenceWorkflowTemplate.findFirst({
    where: { teamId, slug, archived: false },
  });
  if (workspaceRow) {
    const parsed = parseDbWorkflowTemplate(workspaceRow);
    if (parsed) {
      return {
        source: "workspace_db",
        templateId: workspaceRow.id,
        version: parsed.version,
        snapshot: parsed,
        intakeModes: parsed.intakeModes,
      };
    }
  }

  // 2. Global DB row.
  const globalRow = await client.evidenceWorkflowTemplate.findFirst({
    where: { teamId: null, slug, archived: false },
  });
  if (globalRow) {
    const parsed = parseDbWorkflowTemplate(globalRow);
    if (parsed) {
      return {
        source: "platform_db",
        templateId: globalRow.id,
        version: parsed.version,
        snapshot: parsed,
        intakeModes: parsed.intakeModes,
      };
    }
  }

  // 3. Seed list as a final fallback.
  const seed = getIntakeTemplate(slug);
  if (seed) {
    const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
    return {
      source: "platform_seed",
      templateId: null,
      version: lifted.version,
      snapshot: lifted,
      intakeModes: lifted.intakeModes,
    };
  }

  throw new WorkflowIntakeLinkError("template_not_found");
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

export async function createWorkflowIntakeLink(
  input: CreateWorkflowIntakeLinkInput,
  ctx: CreateWorkflowIntakeLinkContext,
  client: PrismaClient = defaultPrisma,
): Promise<CreatedWorkflowIntakeLinkResult> {
  // Mode must validate against the canonical enum and must be EXTERNAL_*.
  const intakeMode = WorkflowIntakeModeSchema.parse(input.intakeMode);
  if (!isExternalWorkflowIntakeMode(intakeMode)) {
    throw new WorkflowIntakeLinkError("intake_mode_not_external");
  }

  // Expiry must be in the future.
  if (input.expiresAtUtc.getTime() <= Date.now()) {
    throw new WorkflowIntakeLinkError("expiry_in_past");
  }

  const maxUses = input.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000) {
    throw new WorkflowIntakeLinkError("max_uses_invalid");
  }

  // Resolve effective template + snapshot.
  const tpl = await loadEffectiveWorkflowTemplate(
    input.teamId,
    input.workflowTemplateSlug,
    client,
  );
  if (!tpl.intakeModes.includes(intakeMode)) {
    throw new WorkflowIntakeLinkError("intake_mode_not_supported_by_template");
  }

  // Issue a fresh token. issueIntakeToken returns null when the secret is
  // not configured — that is the master kill switch.
  const issued = issueIntakeToken();
  if (!issued) {
    throw new WorkflowIntakeLinkError("feature_disabled");
  }

  const link = await client.workflowIntakeLink.create({
    data: {
      teamId: input.teamId,
      workflowTemplateId: tpl.templateId,
      workflowTemplateSlug: input.workflowTemplateSlug,
      workflowTemplateVersion: tpl.version,
      workflowTemplateSnapshot: tpl.snapshot as Prisma.InputJsonValue,
      intakeMode,
      caseId: input.caseId ?? null,
      tokenHash: issued.tokenHash,
      tokenVersion: issued.tokenVersion,
      recipientLabel: input.recipientLabel ?? null,
      recipientEmail: input.recipientEmail ?? null,
      recipientPhone: input.recipientPhone ?? null,
      maxUses,
      usedCount: 0,
      maxFileCountPerSession: input.maxFileCountPerSession ?? null,
      maxBytesPerSession: input.maxBytesPerSession ?? null,
      allowedAcceptedKinds: input.allowedAcceptedKinds ?? [],
      consentPolicyVersion: input.consentPolicyVersion ?? null,
      consentDisclosureText: input.consentDisclosureText ?? null,
      expiresAtUtc: input.expiresAtUtc,
      ipAllowlistCidrs: input.ipAllowlistCidrs ?? [],
      createdByUserId: ctx.actorUserId,
    },
  });

  return { link, rawToken: issued.rawToken };
}

// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------

export type ListWorkflowIntakeLinksInput = {
  teamId: string;
  status?: "ACTIVE" | "REVOKED" | "EXPIRED";
  workflowTemplateSlug?: string;
  caseId?: string;
  limit?: number;
};

export async function listWorkflowIntakeLinks(
  input: ListWorkflowIntakeLinksInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeLink[]> {
  return client.workflowIntakeLink.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.workflowTemplateSlug
        ? { workflowTemplateSlug: input.workflowTemplateSlug }
        : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

// -----------------------------------------------------------------------------
// Get
// -----------------------------------------------------------------------------

export async function getWorkflowIntakeLink(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeLink | null> {
  return client.workflowIntakeLink.findUnique({ where: { id } });
}

// -----------------------------------------------------------------------------
// Revoke
// -----------------------------------------------------------------------------

export type RevokeWorkflowIntakeLinkInput = {
  id: string;
  teamId: string;
  actorUserId: string;
  reason?: string | null;
};

export async function revokeWorkflowIntakeLink(
  input: RevokeWorkflowIntakeLinkInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeLink | null> {
  const existing = await client.workflowIntakeLink.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) return null;

  if (existing.status === "REVOKED") {
    return existing; // idempotent
  }

  return client.workflowIntakeLink.update({
    where: { id: input.id },
    data: {
      status: "REVOKED",
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: input.reason ?? null,
    },
  });
}

// -----------------------------------------------------------------------------
// Public projection — what we return to admins on list/get.
// NEVER includes the raw token (which is only available at creation time)
// or the token hash (server secret).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Phase 18 — Operator-initiated SMS / WhatsApp delivery of an intake
// link. The link itself is created via the existing path; this helper
// is a thin wrapper that:
//
//   - refuses to send if the link is revoked or expired
//   - composes the operational SMS body via the shared template
//   - calls `enqueueOutboundMessage` so the send goes through the
//     rate-limit / opt-out / provider abstraction
//
// The raw token is required and never persisted by this function — the
// caller has it from the initial create call (or it was re-issued via
// the regenerate flow, which is out of scope for Phase 18).
// -----------------------------------------------------------------------------

export type SendIntakeLinkViaSmsInput = {
  teamId: string;
  intakeLinkId: string;
  rawToken: string;
  intakeUrl: string;
  channel: "SMS" | "WHATSAPP";
  actorUserId: string;
  workspaceName: string;
};

export type SendIntakeLinkViaSmsResult =
  | { ok: true; communicationMessageId: string }
  | {
      ok: false;
      reason:
        | "link_not_found"
        | "link_revoked"
        | "link_expired"
        | "link_missing_phone"
        | "delivery_failed_or_skipped";
    };

export async function sendIntakeLinkViaSms(
  input: SendIntakeLinkViaSmsInput,
  client: PrismaClient = defaultPrisma,
): Promise<SendIntakeLinkViaSmsResult> {
  const link = await client.workflowIntakeLink.findFirst({
    where: { id: input.intakeLinkId, teamId: input.teamId },
    select: {
      id: true,
      revokedAtUtc: true,
      expiresAtUtc: true,
      recipientPhone: true,
    },
  });
  if (!link) return { ok: false, reason: "link_not_found" };
  if (link.revokedAtUtc) return { ok: false, reason: "link_revoked" };
  if (link.expiresAtUtc.getTime() <= Date.now()) {
    return { ok: false, reason: "link_expired" };
  }
  if (!link.recipientPhone) return { ok: false, reason: "link_missing_phone" };

  // Dynamic import avoids a circular dependency: communication.service
  // does not import workflow-intake-link.service, but workflow-intake-
  // link.service now wants the dispatch helper. The dynamic import
  // keeps the dependency graph linear at module-load time.
  const { enqueueOutboundMessage } = await import(
    "./communications/communication.service.js"
  );
  const { renderIntakeLinkSmsBody, appendStopFooter } = await import(
    "@proovra/shared"
  );

  const body = appendStopFooter(
    renderIntakeLinkSmsBody({
      workspaceName: input.workspaceName,
      intakeUrl: input.intakeUrl,
    }),
  );

  const result = await enqueueOutboundMessage(
    {
      teamId: input.teamId,
      channel: input.channel,
      purpose: "INTAKE_LINK",
      recipientPhone: link.recipientPhone,
      body,
      sender: "PROOVRA",
      related: { intakeLinkId: link.id },
      createdByUserId: input.actorUserId,
    },
    client,
  );
  if (
    result.status === "sent" ||
    result.status === "queued" ||
    result.status === "retry_scheduled"
  ) {
    return { ok: true, communicationMessageId: result.message.id };
  }
  return { ok: false, reason: "delivery_failed_or_skipped" };
}

export function projectWorkflowIntakeLink(link: DbWorkflowIntakeLink): {
  id: string;
  teamId: string;
  workflowTemplateSlug: string;
  workflowTemplateVersion: number;
  intakeMode: string;
  caseId: string | null;
  recipientLabel: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  maxUses: number;
  usedCount: number;
  maxFileCountPerSession: number | null;
  maxBytesPerSession: string | null;
  allowedAcceptedKinds: string[];
  consentPolicyVersion: string | null;
  status: string;
  expiresAtUtc: string;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: link.id,
    teamId: link.teamId,
    workflowTemplateSlug: link.workflowTemplateSlug,
    workflowTemplateVersion: link.workflowTemplateVersion,
    intakeMode: link.intakeMode,
    caseId: link.caseId,
    recipientLabel: link.recipientLabel,
    recipientEmail: link.recipientEmail,
    recipientPhone: link.recipientPhone,
    maxUses: link.maxUses,
    usedCount: link.usedCount,
    maxFileCountPerSession: link.maxFileCountPerSession,
    maxBytesPerSession:
      link.maxBytesPerSession !== null && link.maxBytesPerSession !== undefined
        ? link.maxBytesPerSession.toString()
        : null,
    allowedAcceptedKinds: link.allowedAcceptedKinds,
    consentPolicyVersion: link.consentPolicyVersion,
    status: link.status,
    expiresAtUtc: link.expiresAtUtc.toISOString(),
    revokedAtUtc: link.revokedAtUtc?.toISOString() ?? null,
    revokedReason: link.revokedReason,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}
