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
  isExternalWorkflowIntakeMode,
  renderIntakeEmailMessage,
  renderIntakeSmsMessage,
  resolveIntakeSenderDisplay,
  sanitizeIntakeMessagePreview,
  validateCustomSenderDisplayName,
  WorkflowIntakeMode,
  WorkflowIntakeModeSchema,
  isIntakeLinkLocationPolicy,
  type IntakeLinkLocationPolicy,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import {
  INTAKE_SEARCH_NEEDLE_MAX,
  intakeLinkIdentityArms,
  intakePhoneE164,
} from "./search/intake-identity-search.js";
import { error as logError } from "../utils/logger.js";
import {
  projectRecipientContact,
  type RecipientContactDisclosure,
} from "./privacy/recipient-contact-disclosure.js";
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
      // The canonical form beside the value as typed. Derived here, once, so
      // no search has to strip punctuation from every stored number.
      recipientPhoneE164: input.recipientPhone
        ? intakePhoneE164(input.recipientPhone)
        : null,
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

/**
 * SERVER-SIDE SEARCH OVER THE STORED VALUES.
 *
 * The page used to filter what it had already been sent, which meant it could
 * only ever match the MASKED previews — so "find the request I sent to
 * john@example.com" could not work by construction, and Customer ID was not
 * on the client at all. Sending the raw dataset down to fix that would have
 * been the wrong repair: it hands every reader every address to make a text
 * box work.
 *
 * So the match happens here, against the canonical columns, inside the
 * tenant-scoped where clause — a needle can never reach another workspace's
 * rows because the scope is applied in the same query, not beside it.
 *
 * THE RAW-CONTACT ARMS ARE GATED. A caller who may not SEE an address may not
 * ask whether it is here either: matching on it would answer the question the
 * mask exists to refuse. Customer ID, recipient label, workflow and link id
 * are open to any authorized reader.
 */
function buildIntakeLinkSearchFilter(
  search: string,
  options: { matchRecipientContact: boolean },
): Prisma.WorkflowIntakeLinkWhereInput | null {
  const needle = search.trim().slice(0, INTAKE_SEARCH_NEEDLE_MAX);
  if (!needle) return null;

  // The four identity arms come from the ONE module every surface shares, so
  // a phone number typed with spaces resolves the same way here as it does on
  // the Evidence list and in Reports.
  const or: Prisma.WorkflowIntakeLinkWhereInput[] = [
    ...intakeLinkIdentityArms(needle, options),
    // Local to this surface: the workflow this link was created from, and a
    // pasted link id, which is exact.
    { workflowTemplateSlug: { contains: needle, mode: "insensitive" } },
  ];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(needle)) {
    or.push({ id: needle });
  }

  return { OR: or };
}

export async function listWorkflowIntakeLinks(
  input: ListWorkflowIntakeLinksInput & {
    archiveScope?: IntakeArchiveScope;
    search?: string | null;
    /** Whether this caller may match on the raw recipient contact. */
    searchRecipientContact?: boolean;
  },
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
      // Inside the tenant scope, never beside it.
      ...(input.search
        ? (buildIntakeLinkSearchFilter(input.search, {
            matchRecipientContact: input.searchRecipientContact === true,
          }) ?? {})
        : {}),
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
// Phase 18 — Operator-initiated SMS delivery of an intake link.
//
// WhatsApp was retired as a product option, and with it the Twilio Content
// Template machinery this function carried for it: an approved template SID,
// a template-mode switch, a URL-format switch and a language setting, all of
// which existed only because Meta refuses a free-form business-initiated
// message. None of that has a caller now. It is removed rather than left
// unreachable, because dead transport code reads as a supported option to the
// next person and comes back to life the first time somebody "re-enables" it. The link itself is created via the existing path; this helper
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
  channel: "SMS";
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

  const body = renderIntakeSmsMessage(renderInput);

  // Sanitized preview is stored on the CommunicationMessage row so a
  // DB exfiltration cannot recover the raw token. The provider call
  // below still gets the real `body`, but the persisted preview is
  // always redacted.
  const sanitizedPreview = sanitizeIntakeMessagePreview(body);

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

/*
 * The WhatsApp Content Template helpers stood here: a template-mode switch, a
 * SID reader, a URL-format switch, a label helper and the payload builder —
 * about a hundred lines that existed solely because Meta refuses a free-form
 * business-initiated message. WhatsApp is retired as an intake delivery
 * option, so none of it has a caller.
 *
 * Removed rather than left unreachable. Dead transport code reads as a
 * supported option to whoever finds it next, and comes back to life the first
 * time somebody re-enables the channel without re-deciding whether it should
 * exist. The env vars it read are untouched in any deployment that set them.
 */


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

/**
 * The admin/API projection of an intake link.
 *
 * It used to return `recipientEmail` and `recipientPhone` RAW, and the routes
 * that serve it are gated on `evidence.read` — so every workspace member,
 * VIEWER included, could read the address a request had been delivered to
 * simply by listing intake links. The Evidence Detail card had already been
 * brought under a masked-by-default rule; this projection had not, which left
 * one data class with two disclosure rules depending on which endpoint you
 * asked.
 *
 * It now takes the disclosure decision as an argument and emits only what
 * that decision allows. There is no argument that makes it emit a raw value:
 * the raw values live behind the audited reveal route and nowhere else.
 */
export function projectWorkflowIntakeLink(
  link: DbWorkflowIntakeLink,
  disclosure: RecipientContactDisclosure,
): {
  id: string;
  teamId: string;
  workflowTemplateSlug: string;
  workflowTemplateVersion: number;
  intakeMode: string;
  caseId: string | null;
  recipientLabel: string | null;
  recipientEmailMasked: string | null;
  recipientPhoneMasked: string | null;
  /** Raw, for a caller the disclosure policy resolved as REVEALED. */
  recipientEmail: string | null;
  recipientPhone: string | null;
  hasRecipientEmail: boolean;
  hasRecipientPhone: boolean;
  recipientContactRevealAuthorized: boolean;
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
    ...projectRecipientContact(link, disclosure),
    // Customer ID is a DIFFERENT data class — organization-supplied business
    // metadata, governed by its own decision — and is deliberately not routed
    // through the recipient-contact policy.
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
