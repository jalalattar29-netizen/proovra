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
  INTAKE_SENDER_DISPLAY_MODES,
  type IntakeSenderDisplayMode,
  type IntakeWhatsappTemplateMode,
  INTAKE_WHATSAPP_TEMPLATE_MODES,
  isExternalWorkflowIntakeMode,
  renderIntakeEmailMessage,
  renderIntakeSmsMessage,
  renderIntakeWhatsappMessage,
  resolveIntakeSenderDisplay,
  sanitizeIntakeMessagePreview,
  validateCustomSenderDisplayName,
  WorkflowIntakeMode,
  WorkflowIntakeModeSchema,
  isIntakeLinkLocationPolicy,
  type IntakeLinkLocationPolicy,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import { error as logError } from "../utils/logger.js";
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
  /** The organization's identifier for its own customer. Optional, opaque. */
  customerId?: string | null;
  maxUses?: number;
  maxFileCountPerSession?: number | null;
  maxBytesPerSession?: bigint | null;
  allowedAcceptedKinds?: string[];
  consentPolicyVersion?: string | null;
  consentDisclosureText?: string | null;
  expiresAtUtc: Date;
  ipAllowlistCidrs?: string[];
  // Enterprise messaging — operator-chosen sender identity. PROOVRA
  // branding is always preserved by the shared resolver; this just
  // controls whether the message reads "PROOVRA secure intake" /
  // "Acme Insurance via PROOVRA" / "<custom> via PROOVRA".
  senderDisplayMode?: IntakeSenderDisplayMode;
  senderDisplayName?: string | null;
  // Operator-chosen location policy for the public contributor page.
  // Defaults to NONE when omitted so existing API callers see no
  // behavioural change. See packages/shared/src/intake-link-location.ts.
  locationPolicy?: IntakeLinkLocationPolicy;
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
      | "invalid_sender_display_name"
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

  // Sender identity — validated server-side so the API contract is
  // hard regardless of what the web client sent. PROOVRA branding is
  // applied at render time by `resolveIntakeSenderDisplay`; we only
  // store the operator's CHOICE here.
  const senderDisplayMode: IntakeSenderDisplayMode =
    input.senderDisplayMode &&
    (INTAKE_SENDER_DISPLAY_MODES as readonly string[]).includes(
      input.senderDisplayMode,
    )
      ? input.senderDisplayMode
      : "PROOVRA";
  let senderDisplayName: string | null = null;
  if (senderDisplayMode === "CUSTOM") {
    const v = validateCustomSenderDisplayName(input.senderDisplayName ?? "");
    if (!v.ok) {
      throw new WorkflowIntakeLinkError(
        "invalid_sender_display_name",
        `senderDisplayName failed validation: ${v.reason}`,
      );
    }
    senderDisplayName = v.value;
  }

  // Location policy — opt-in per link. Defaults to NONE when omitted
  // so older API callers and existing rows preserve their previous
  // (no-prompt) behaviour. New UI ships OPTIONAL as the default but
  // that is a CLIENT choice; the server default stays NONE.
  const locationPolicy: IntakeLinkLocationPolicy =
    input.locationPolicy && isIntakeLinkLocationPolicy(input.locationPolicy)
      ? input.locationPolicy
      : "NONE";

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
      // Authoritative. Normalised at the route boundary; an absent value is
      // null here and stays null everywhere downstream.
      customerId: input.customerId ?? null,
      maxUses,
      usedCount: 0,
      maxFileCountPerSession: input.maxFileCountPerSession ?? null,
      maxBytesPerSession: input.maxBytesPerSession ?? null,
      allowedAcceptedKinds: input.allowedAcceptedKinds ?? [],
      consentPolicyVersion: input.consentPolicyVersion ?? null,
      consentDisclosureText: input.consentDisclosureText ?? null,
      expiresAtUtc: input.expiresAtUtc,
      ipAllowlistCidrs: input.ipAllowlistCidrs ?? [],
      senderDisplayMode,
      senderDisplayName,
      locationPolicy,
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

export type IntakeArchiveScope = "active" | "archived" | "all";

export async function listWorkflowIntakeLinks(
  input: ListWorkflowIntakeLinksInput & { archiveScope?: IntakeArchiveScope },
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeLink[]> {
  // Archive scope is operator-driven via the page's Archived tab. The
  // default "active" matches what the Operations Console renders by
  // default; "archived" only shows hidden rows; "all" is the full set
  // (used by the All tab and by tests). Revoke and archive are
  // orthogonal: a revoked link can also be archived.
  const archiveScope = input.archiveScope ?? "active";
  const archiveWhere =
    archiveScope === "active"
      ? { archivedAtUtc: null }
      : archiveScope === "archived"
        ? { archivedAtUtc: { not: null } }
        : {};
  return client.workflowIntakeLink.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.workflowTemplateSlug
        ? { workflowTemplateSlug: input.workflowTemplateSlug }
        : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...archiveWhere,
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
// Archive / unarchive — orthogonal to revoke.
//
// Revoke closes the public door (the link cannot accept submissions).
// Archive only HIDES the row from the operator's default "Active" view
// so a workspace with hundreds of historical links stays manageable.
// Archiving a revoked link is fine; archiving an active link is fine.
// Unarchive simply nulls the columns.
//
// Idempotent: archiving an already-archived link is a no-op (the
// original archivedAtUtc / archivedByUserId are preserved so the audit
// trail still names the original actor).
// -----------------------------------------------------------------------------

export type ArchiveWorkflowIntakeLinkInput = {
  id: string;
  teamId: string;
  actorUserId: string;
};

export async function archiveWorkflowIntakeLink(
  input: ArchiveWorkflowIntakeLinkInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeLink | null> {
  const existing = await client.workflowIntakeLink.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) return null;
  if (existing.archivedAtUtc) return existing; // idempotent
  return client.workflowIntakeLink.update({
    where: { id: input.id },
    data: {
      archivedAtUtc: new Date(),
      archivedByUserId: input.actorUserId,
    },
  });
}

export async function unarchiveWorkflowIntakeLink(
  input: ArchiveWorkflowIntakeLinkInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbWorkflowIntakeLink | null> {
  const existing = await client.workflowIntakeLink.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) return null;
  if (!existing.archivedAtUtc) return existing; // idempotent
  return client.workflowIntakeLink.update({
    where: { id: input.id },
    data: {
      archivedAtUtc: null,
      archivedByUserId: null,
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
        | "whatsapp_template_unconfigured"
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
      recipientLabel: true,
      workflowTemplateSlug: true,
      workflowTemplateSnapshot: true,
      senderDisplayMode: true,
      senderDisplayName: true,
    },
  });
  if (!link) return { ok: false, reason: "link_not_found" };
  if (link.revokedAtUtc) return { ok: false, reason: "link_revoked" };
  if (link.expiresAtUtc.getTime() <= Date.now()) {
    return { ok: false, reason: "link_expired" };
  }
  if (!link.recipientPhone) return { ok: false, reason: "link_missing_phone" };

  // WhatsApp production delivery requires an approved Twilio Content
  // Template (Meta business-initiated rule). Refuse the send before
  // the dispatcher even creates a row when the template SID is
  // missing — a free-form WhatsApp Body would land with errorCode
  // 63016 and silently consume the operator's send budget. The
  // sender-identity endpoint surfaces this to the UI so WhatsApp is
  // disabled with a setup-required reason before the user clicks.
  if (input.channel === "WHATSAPP") {
    const templateSid = readIntakeWhatsappTemplateSid();
    if (!templateSid) {
      return { ok: false, reason: "whatsapp_template_unconfigured" };
    }
  }

  // Dynamic import avoids a circular dependency: communication.service
  // does not import workflow-intake-link.service, but workflow-intake-
  // link.service now wants the dispatch helper. The dynamic import
  // keeps the dependency graph linear at module-load time.
  const { enqueueOutboundMessage } = await import(
    "./communications/communication.service.js"
  );

  // Resolve sender identity from the link's stored mode + name.
  // PROOVRA branding is always added by the resolver — the operator
  // cannot opt out.
  const senderIdentity = resolveIntakeSenderDisplay({
    mode:
      (link.senderDisplayMode as IntakeSenderDisplayMode | null) ?? "PROOVRA",
    workspaceName: input.workspaceName,
    customName: link.senderDisplayName ?? null,
  });

  // Render the body via the shared SMS/WhatsApp renderer. The provider
  // receives the REAL URL; we sanitize the persisted preview separately
  // so a DB reader can never recover the raw token.
  const renderInput = {
    senderDisplay: senderIdentity.display,
    requestTypeSlug: link.workflowTemplateSlug,
    recipientLabel: link.recipientLabel ?? null,
    intakeUrl: input.intakeUrl,
    expiresAtUtc: link.expiresAtUtc.toISOString(),
    channel: input.channel,
    locale: "en" as const,
  };

  const body =
    input.channel === "WHATSAPP"
      ? renderIntakeWhatsappMessage(
          renderInput,
          resolveWhatsappTemplateMode(),
        )
      : renderIntakeSmsMessage(renderInput);

  // Sanitized preview is stored on the CommunicationMessage row so a
  // DB exfiltration cannot recover the raw token. The provider call
  // below still gets the real `body` (SMS) OR the template variables
  // (WhatsApp), but the persisted preview is always redacted.
  const sanitizedPreview = sanitizeIntakeMessagePreview(body);

  // Build the WhatsApp Content Template payload when applicable.
  // SMS remains body-only — Twilio rejects ContentSid+Body in the
  // same request, and our provider skips `Body` when `template` is
  // present, so we only attach `template` to WhatsApp sends.
  const template =
    input.channel === "WHATSAPP"
      ? buildIntakeWhatsappTemplatePayload({
          senderDisplay: senderIdentity.display,
          workflowTemplateSlug: link.workflowTemplateSlug,
          workflowTemplateSnapshot: link.workflowTemplateSnapshot,
          intakeUrl: input.intakeUrl,
          rawToken: input.rawToken,
          expiresAtUtc: link.expiresAtUtc,
        })
      : undefined;

  const result = await enqueueOutboundMessage(
    {
      teamId: input.teamId,
      channel: input.channel,
      purpose: "INTAKE_LINK",
      recipientPhone: link.recipientPhone,
      body,
      bodyPreviewOverride: sanitizedPreview,
      sender: "PROOVRA",
      related: { intakeLinkId: link.id },
      createdByUserId: input.actorUserId,
      template,
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

// WHATSAPP_INTAKE_TEMPLATE_MODE env switch — see shared
// INTAKE_WHATSAPP_TEMPLATE_MODES. Default `"plain"` reuses the SMS
// body shape so we never accidentally ship a free-form template
// through a WABA-strict sender. Operators enable `"rich"` after
// their WhatsApp Business profile is approved for free-form
// outbound or is inside the 24h session window.
function resolveWhatsappTemplateMode(): IntakeWhatsappTemplateMode {
  const raw = (process.env.WHATSAPP_INTAKE_TEMPLATE_MODE ?? "")
    .trim()
    .toLowerCase();
  if (
    (INTAKE_WHATSAPP_TEMPLATE_MODES as readonly string[]).includes(raw)
  ) {
    return raw as IntakeWhatsappTemplateMode;
  }
  return "plain";
}

/**
 * Read the Twilio Content Template SID for intake-link WhatsApp
 * delivery. Single source of truth so both the send path and the
 * sender-identity preview endpoint return the same answer.
 */
export function readIntakeWhatsappTemplateSid(): string | null {
  const raw = (process.env.TWILIO_WHATSAPP_INTAKE_TEMPLATE_SID ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Variable 4 in the Twilio Content Template can be either:
 *   - "token" — the template's button URL is configured as
 *     `https://app.proovra.com/intake/{{4}}` so variable 4 must be
 *     ONLY the token (the path suffix), never the full URL. This is
 *     the safer default because it pins the domain inside Twilio
 *     where Meta has already approved it.
 *   - "url"   — the template's button URL is configured as `{{4}}`
 *     directly, so variable 4 carries the full URL.
 *
 * Operator chooses via TWILIO_WHATSAPP_TEMPLATE_URL_FORMAT. The
 * shapes are mutually exclusive — passing a full URL when the
 * template wants a token produces a malformed link
 * (`https://app.proovra.com/intake/https://...`).
 */
export type IntakeWhatsappTemplateUrlFormat = "token" | "url";

function resolveIntakeWhatsappTemplateUrlFormat(): IntakeWhatsappTemplateUrlFormat {
  const raw = (process.env.TWILIO_WHATSAPP_TEMPLATE_URL_FORMAT ?? "")
    .trim()
    .toLowerCase();
  return raw === "url" ? "url" : "token";
}

function workflowTemplateLabel(
  slug: string,
  snapshot: unknown,
): string {
  if (snapshot && typeof snapshot === "object" && "name" in snapshot) {
    const name = (snapshot as { name?: unknown }).name;
    if (typeof name === "string" && name.trim().length > 0) {
      return name.trim().slice(0, 60);
    }
  }
  // Slug → label fallback: turn "general-evidence-record" into
  // "General evidence record". Capped at 60 chars so the WhatsApp
  // template renders cleanly (most templates target ~60 char headers).
  return slug
    .split("-")
    .map((part, i) =>
      i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join(" ")
    .slice(0, 60);
}

/**
 * Build the {1,2,3,4} ContentVariables payload for the intake-link
 * WhatsApp template.
 *
 *   {1} sender display name (e.g. "Acme Legal via PROOVRA")
 *   {2} request type label (e.g. "Insurance claim documents")
 *   {3} expiration date in the recipient-readable shape
 *   {4} link token OR full URL — depends on the template's button URL
 *       configuration (see resolveIntakeWhatsappTemplateUrlFormat).
 */
export function buildIntakeWhatsappTemplatePayload(input: {
  senderDisplay: string;
  workflowTemplateSlug: string;
  workflowTemplateSnapshot: unknown;
  intakeUrl: string;
  rawToken: string;
  expiresAtUtc: Date;
}): { contentSid: string; variables: Record<string, string>; language: string } | undefined {
  const contentSid = readIntakeWhatsappTemplateSid();
  if (!contentSid) return undefined;
  const language =
    (process.env.TWILIO_WHATSAPP_TEMPLATE_LANGUAGE ?? "").trim() || "en";
  const urlFormat = resolveIntakeWhatsappTemplateUrlFormat();
  const var4 = urlFormat === "url" ? input.intakeUrl : input.rawToken;
  const expirationLabel = input.expiresAtUtc.toISOString().slice(0, 10);
  const variables: Record<string, string> = {
    "1": input.senderDisplay.slice(0, 80),
    "2": workflowTemplateLabel(
      input.workflowTemplateSlug,
      input.workflowTemplateSnapshot,
    ),
    "3": expirationLabel,
    "4": var4,
  };
  return { contentSid, variables, language };
}

// -----------------------------------------------------------------------------
// Intake-links-e2e (Phase 3) — Operator-initiated EMAIL delivery of an
// intake link.
//
// Mirrors `sendIntakeLinkViaSms` but uses the existing Resend integration
// (services/email.service.ts → sendCustomEmailViaResend) directly. The
// shared communication.service.enqueueOutboundMessage is phone-only at
// the moment, so we build the CommunicationMessage row inline and update
// it after the provider call. Same `(provider, providerMessageId, status)`
// shape so the existing Twilio webhooks + retry sweeper read it the same
// way for the EMAIL channel.
//
// Hard guarantees:
//   - Refuses to send on revoked / expired links.
//   - Refuses when no recipient email is set.
//   - Recipient email is hashed (SHA-256 HMAC, same secret as phone
//     hashing) and only a masked preview ever lives in logs / the
//     CommunicationMessage row. Raw email is passed only to the Resend
//     client and never logged.
//   - Raw token is required by the caller (same contract as SMS) and is
//     never persisted by this function.
//   - Failure path still creates a CommunicationMessage row so the
//     audit trail captures the attempt (no silent drops).
// -----------------------------------------------------------------------------

export type SendIntakeLinkViaEmailInput = {
  teamId: string;
  intakeLinkId: string;
  rawToken: string;
  intakeUrl: string;
  actorUserId: string;
  workspaceName: string;
};

export type SendIntakeLinkViaEmailResult =
  | { ok: true; communicationMessageId: string; providerMessageId: string | null }
  | {
      ok: false;
      reason:
        | "link_not_found"
        | "link_revoked"
        | "link_expired"
        | "link_missing_email"
        | "provider_unconfigured"
        | "delivery_failed";
      communicationMessageId?: string;
    };

function maskEmailPreview(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return "(invalid)";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const localMasked =
    local.length <= 2
      ? local[0] + "•"
      : local[0] + "•".repeat(Math.max(1, local.length - 2)) + local[local.length - 1];
  return `${localMasked}@${domain}`;
}

export async function sendIntakeLinkViaEmail(
  input: SendIntakeLinkViaEmailInput,
  client: PrismaClient = defaultPrisma,
): Promise<SendIntakeLinkViaEmailResult> {
  const link = await client.workflowIntakeLink.findFirst({
    where: { id: input.intakeLinkId, teamId: input.teamId },
    select: {
      id: true,
      revokedAtUtc: true,
      expiresAtUtc: true,
      recipientEmail: true,
      recipientLabel: true,
      workflowTemplateSlug: true,
      senderDisplayMode: true,
      senderDisplayName: true,
    },
  });
  if (!link) return { ok: false, reason: "link_not_found" };
  if (link.revokedAtUtc) return { ok: false, reason: "link_revoked" };
  if (link.expiresAtUtc.getTime() <= Date.now()) {
    return { ok: false, reason: "link_expired" };
  }
  if (!link.recipientEmail) return { ok: false, reason: "link_missing_email" };

  // Dynamic imports avoid pulling Prisma + Resend into the module's
  // load-time graph (the create path doesn't need them).
  const prismaPkg = await import("@prisma/client");
  const { hashRecipientPhone } = await import(
    "./communications/communication.service.js"
  );
  const { sendCustomEmailViaResend } = await import("./email.service.js");

  const email = link.recipientEmail.trim().toLowerCase();
  // Reuse the phone-hash helper — it's a generic HMAC-SHA256 keyed by
  // COMMUNICATIONS_RECIPIENT_HASH_SECRET. Same hashing for the email
  // string gives us a recipient identity column we can deduplicate /
  // audit against without ever persisting the raw value.
  const recipientHash = hashRecipientPhone(email);
  const preview = maskEmailPreview(email);

  // Resolve sender identity from the link's stored mode + name. The
  // resolver always adds " via PROOVRA" (except for PROOVRA mode which
  // IS the brand); the operator cannot remove the wordmark.
  const senderIdentity = resolveIntakeSenderDisplay({
    mode:
      (link.senderDisplayMode as IntakeSenderDisplayMode | null) ?? "PROOVRA",
    workspaceName: input.workspaceName,
    customName: link.senderDisplayName ?? null,
  });

  // Render the email via the shared template — same renderer the web
  // preview studio uses, guaranteeing what the operator saw is what
  // the recipient gets.
  const rendered = renderIntakeEmailMessage({
    senderDisplay: senderIdentity.display,
    requestTypeSlug: link.workflowTemplateSlug,
    recipientLabel: link.recipientLabel ?? null,
    intakeUrl: input.intakeUrl,
    expiresAtUtc: link.expiresAtUtc.toISOString(),
    channel: "EMAIL",
    locale: "en",
  });

  // SECURITY: bodyPreview goes through the sanitizer so the raw token
  // never lands in CommunicationMessage. The provider call below
  // receives the real `rendered.text`/`rendered.html`.
  const sanitizedPreview = sanitizeIntakeMessagePreview(
    `${rendered.subject}\n${rendered.text}`,
  );

  // Pre-create the CommunicationMessage row in QUEUED so the audit
  // trail captures the attempt even if the provider call throws.
  let message;
  try {
    message = await client.communicationMessage.create({
      data: {
        teamId: input.teamId,
        channel: prismaPkg.CommunicationChannel.EMAIL,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
        purpose: prismaPkg.CommunicationPurpose.INTAKE_LINK,
        provider: prismaPkg.CommunicationProvider.RESEND,
        recipientHash,
        recipientPreview: preview,
        status: prismaPkg.CommunicationStatus.QUEUED,
        bodyPreview: sanitizedPreview,
        sender: senderIdentity.display.slice(0, 80),
        relatedIntakeLinkId: link.id,
        createdByUserId: input.actorUserId,
      },
    });
  } catch (err) {
    // If the row insert itself fails, surface failure to the caller —
    // we cannot proceed without an audit row. Bounded diagnostic only:
    // never the recipient, the body, or the raw driver message.
    logError("intake_link.delivery_row_insert_failed", {
      intakeLinkId: link.id,
      errorCode: err instanceof Error ? err.name.slice(0, 64) : "unknown_error",
    });
    return {
      ok: false,
      reason: "delivery_failed",
    };
  }

  // Provider call. sendCustomEmailViaResend returns {ok, providerMessageId, errorCode, errorMessage}.
  let providerResult;
  try {
    const { getEmailFromHeader, deterministicEmailKey } = await import(
      "./email.service.js"
    );
    providerResult = await sendCustomEmailViaResend({
      from: getEmailFromHeader(),
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // The CommunicationMessage row was inserted above, before the provider
      // call, precisely so the attempt is durable. Its id is therefore the
      // right thing to derive the provider idempotency key from.
      idempotencyKey: deterministicEmailKey("intake_link_message", message.id),
    });
  } catch (err) {
    providerResult = {
      ok: false as const,
      errorCode: "exception",
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    };
  }

  if (!providerResult.ok) {
    const errorCode = providerResult.errorCode ?? "unknown";
    const isUnconfigured =
      errorCode === "not_configured" || errorCode === "provider_unconfigured";
    await client.communicationMessage.update({
      where: { id: message.id },
      data: {
        status: prismaPkg.CommunicationStatus.FAILED,
        failedAtUtc: new Date(),
        errorCode: errorCode.slice(0, 80),
        errorMessage: (providerResult.errorMessage ?? "").slice(0, 400),
      },
    });
    return {
      ok: false,
      reason: isUnconfigured ? "provider_unconfigured" : "delivery_failed",
      communicationMessageId: message.id,
    };
  }

  await client.communicationMessage.update({
    where: { id: message.id },
    data: {
      status: prismaPkg.CommunicationStatus.SENT,
      sentAtUtc: new Date(),
      providerMessageId: providerResult.providerMessageId,
    },
  });
  return {
    ok: true,
    communicationMessageId: message.id,
    providerMessageId: providerResult.providerMessageId ?? null,
  };
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
  /** Organization-supplied customer identifier. Authoritative here. */
  customerId: string | null;
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
  archivedAtUtc: string | null;
  locationPolicy: string;
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
    customerId: link.customerId,
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
    archivedAtUtc: link.archivedAtUtc?.toISOString() ?? null,
    locationPolicy: link.locationPolicy,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}
