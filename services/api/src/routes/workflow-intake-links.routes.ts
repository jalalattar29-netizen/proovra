import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
/**
 * Phase 4 — Authenticated admin routes for workflow intake links.
 *
 *   POST  /v1/workflow/intake-links              — create
 *   GET   /v1/workflow/intake-links              — list
 *   GET   /v1/workflow/intake-links/:id          — get
 *   POST  /v1/workflow/intake-links/:id/revoke   — revoke
 *
 * All routes require authentication. Mutations additionally require role
 * >= ADMIN on the target workspace, matching the rule established by
 * Phase 2 workflow.routes.ts.
 *
 * Feature flag: every route returns 503 with
 *   { error: { code: "FEATURE_DISABLED", reason: "..." } }
 * when WORKFLOW_INTAKE_LINKS_ENABLED is not "true" or
 * WORKFLOW_INTAKE_TOKEN_SECRET is not configured.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  CUSTOMER_ID_MAX_LENGTH,
  INTAKE_LINK_LOCATION_POLICIES,
  normalizeCustomerId,
  WORKFLOW_INTAKE_LINK_STATUSES,
  WORKFLOW_INTAKE_MODES,
  type Permission,
} from "@proovra/shared";

import { authorizeOrFail } from "../middleware/authorize.js";
import {
  resolveRecipientContactDisclosure,
  revealRecipientContact,
} from "../services/privacy/recipient-contact-disclosure.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  assertWorkspaceAllowsIntake,
} from "../services/billing-enforcement.service.js";
import {
  archiveWorkflowIntakeLink,
  createWorkflowIntakeLink,
  getWorkflowIntakeLink,
  listWorkflowIntakeLinks,
  projectWorkflowIntakeLink,
  revokeWorkflowIntakeLink,
  unarchiveWorkflowIntakeLink,
  WorkflowIntakeLinkError,
} from "../services/workflow-intake-link.service.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  loadIntakeLinkSubmissions,
  projectIntakeLinkList,
  projectIntakeLinkListItem,
} from "../services/intake-link-lifecycle.service.js";
import {
  dispatchIntakeLinkDelivery,
  type DispatchIntakeDeliveryResult,
} from "../services/intake-link-delivery-dispatcher.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  workflowIntakeFeatureDisabledReason,
} from "../services/workflow-intake-token.service.js";

// -----------------------------------------------------------------------------
// Zod schemas
// -----------------------------------------------------------------------------

// Intake-links-e2e — explicit delivery method. Default is MANUAL so any
// existing caller that omits the field gets the legacy "create only, no
// send" behaviour. EMAIL / SMS trigger an immediate send via
// the matching channel using `sendIntakeLinkViaEmail` /
// `sendIntakeLinkViaSms`. The page UI gates which recipient field is
// required; the backend re-validates here so an API caller cannot bypass.
/*
 * THE DELIVERY METHODS AN INTAKE LINK CAN BE CREATED WITH.
 *
 * WhatsApp was retired as a product option. It is gone from here, so a create
 * that names it is refused as invalid input rather than accepted into a path
 * that no longer exists — the failure lands at the boundary, in the caller's
 * own words, instead of somewhere further in.
 *
 * HISTORICAL ROWS ARE NOT TOUCHED. `CommunicationChannel` still has WHATSAPP
 * (it is also the MFA and verified-contact-factor channel, which this change
 * has nothing to do with), a delivery recorded before the retirement still
 * says WhatsApp, and every read path still renders it truthfully. Retiring an
 * option is a statement about what may be created next, not a licence to
 * rewrite what already happened.
 *
 * MANUAL is "Copy link": the link is created and nothing is sent. It is a
 * stored delivery method — the row has to record that no message was
 * attempted — and the copy button on top of it is a local UI action. Both are
 * true and neither is a transport.
 */
export const DELIVERY_METHODS = ["MANUAL", "EMAIL", "SMS"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

const CreateBody = z
  .object({
    teamId: z.string().uuid(),
    workflowTemplateSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/, {
        message: "slug must be kebab-case",
      }),
    intakeMode: z.enum(WORKFLOW_INTAKE_MODES),
    caseId: z.string().uuid().nullable().optional(),
    recipientLabel: z.string().max(180).nullable().optional(),
    recipientEmail: z.string().email().nullable().optional(),
    recipientPhone: z.string().max(32).nullable().optional(),
    /*
     * Customer ID — optional, and validated through the ONE shared rule so the
     * public API, the wizard and any future caller cannot disagree about what
     * a usable identifier is. Empty string collapses to null: absence is
     * absence.
     */
    customerId: z
      .string()
      .max(CUSTOMER_ID_MAX_LENGTH)
      .nullable()
      .optional()
      .transform((v) => normalizeCustomerId(v))
      .refine((v) => v !== undefined, {
        message:
          "customerId may contain letters, digits and the separators . _ - / : # and spaces",
      }),
    maxUses: z.number().int().min(1).max(10_000).optional(),
    maxFileCountPerSession: z.number().int().min(1).max(500).nullable().optional(),
    maxBytesPerSession: z
      .union([z.number().int().min(1), z.string().regex(/^\d{1,20}$/)])
      .nullable()
      .optional(),
    allowedAcceptedKinds: z
      .array(z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]))
      .max(4)
      .optional(),
    consentPolicyVersion: z.string().max(40).nullable().optional(),
    consentDisclosureText: z.string().max(4000).nullable().optional(),
    expiresAtUtc: z.string().datetime(),
    ipAllowlistCidrs: z.array(z.string().max(64)).max(32).optional(),
    // Intake-links-e2e (Phase 2/4) — explicit delivery channel.
    deliveryMethod: z.enum(DELIVERY_METHODS).default("MANUAL"),
    // The PUBLIC origin the contributor's link should point at. Only
    // consumed when deliveryMethod !== MANUAL; the link itself stores
    // only the token hash and does NOT persist this URL.
    intakeUrlBase: z.string().url().max(1000).optional(),
    // Intake-links-e2e Phase 5 — per-form-submit nonce. The dispatcher
    // hashes this with (linkId, channel) so a double-click never
    // produces two real provider sends. Optional: when omitted we
    // synthesise a random one (no dedup; the API caller opted out).
    idempotencyKey: z.string().min(1).max(120).optional(),
    // Intake-link enterprise messaging — sender identity. The
    // service layer re-validates `senderDisplayName` via
    // validateCustomSenderDisplayName; the route just type-gates
    // the enum + length here. PROOVRA branding is appended by the
    // shared resolver and cannot be removed.
    senderDisplayMode: z
      .enum(["PROOVRA", "WORKSPACE", "CUSTOM"])
      .optional(),
    senderDisplayName: z.string().min(1).max(80).nullable().optional(),
    // Location collection policy for the public contributor page.
    // Optional in the API; the service layer defaults to NONE so a
    // caller that omits the field gets the safe "do not ask"
    // behaviour. The web modal sends an explicit value per the
    // operator's choice (default OPTIONAL in the UI).
    locationPolicy: z.enum(INTAKE_LINK_LOCATION_POLICIES).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.senderDisplayMode === "CUSTOM" && !data.senderDisplayName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["senderDisplayName"],
        message:
          "senderDisplayName is required when senderDisplayMode is CUSTOM",
      });
    }
    if (data.deliveryMethod === "EMAIL" && !data.recipientEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipientEmail"],
        message: "recipientEmail is required when deliveryMethod is EMAIL",
      });
    }
    if (
      data.deliveryMethod === "SMS" &&
      !data.recipientPhone
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipientPhone"],
        message:
          "recipientPhone is required when deliveryMethod is SMS",
      });
    }
    if (data.deliveryMethod !== "MANUAL" && !data.intakeUrlBase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intakeUrlBase"],
        message:
          "intakeUrlBase is required when deliveryMethod is EMAIL / SMS",
      });
    }
  });

const ListQuery = z.object({
  teamId: z.string().uuid(),
  status: z.enum(WORKFLOW_INTAKE_LINK_STATUSES).optional(),
  workflowTemplateSlug: z.string().max(120).optional(),
  caseId: z.string().uuid().optional(),
  /**
   * Free-text search over the stored values: Customer ID, recipient name,
   * workflow, link id, and — for a caller allowed to see them — the recipient
   * email and phone.
   */
  search: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // Operations Console — archive scope. Default "active" so the
  // default list query continues to behave exactly as it did before
  // the column was added.
  archiveScope: z.enum(["active", "archived", "all"]).optional(),
});

const RevokeBody = z
  .object({
    reason: z.string().max(400).nullable().optional(),
  })
  .optional();

const ParamsId = z.object({ id: z.string().uuid() });

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sendFeatureDisabled(reply: FastifyReply): void {
  const reason = workflowIntakeFeatureDisabledReason() ?? "unknown";
  reply.code(503).send({
    error: {
      code: "FEATURE_DISABLED",
      reason,
      message: "Workflow intake links are not enabled on this deployment",
    },
  });
}

/**
 * THE INTAKE WORKFLOW GATE.
 *
 * Creating a link, sending it, revoking it, archiving it: these are steps in
 * a workflow, not acts of workspace administration. Nothing here touches
 * settings, billing, membership, SSO, retention or governance.
 *
 * It used to route through the canonical primitive and then ALSO require the
 * DB role to be OWNER or ADMIN. The comment that stood here said why in as
 * many words: "the intake_link.* caps are also held by REVIEWER, so the role
 * check is retained ... to avoid widening this administration surface". That
 * is a raw role-name check placed on top of the capability model precisely
 * because the two disagreed — and the capability model was right. Canonical
 * REVIEWER holds `workflow.intake_link.create` and `.revoke`, and the DB role
 * MEMBER maps to REVIEWER, so an ordinary operational member was told they
 * may create intake links by the permission registry and told 404 by the
 * route.
 *
 * That produced a genuinely incoherent product: the same member could open
 * an intake record, read its recipient's full contact details, search by
 * them, and review the evidence that arrived — but could not create the link
 * that starts any of it.
 *
 * The role check is gone. The capability is the whole answer, and it is
 * unchanged: `authorizeOrFail` still enforces ACTIVE membership, org
 * lifecycle, the operation capability, fail-closed denial and anti-enumeration
 * 404s. VIEWER and CONTRIBUTOR hold neither intake capability and are refused
 * exactly as before.
 *
 * NOTHING ELSE MOVES. No permission was granted to any role by this change —
 * the registry is untouched — so no other surface can widen with it. What
 * changed is that this route stopped overriding the registry.
 */
async function requireIntakeWorkflowActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: Permission,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission,
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

/**
 * PHASE 1 — member read gate. Reads use `evidence.read` (the base
 * evidence-domain read every member holds; intake links are an evidence-intake
 * surface with no dedicated read permission).
 */
async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission: "evidence.read",
    antiEnumeration: true,
  });
  return outcome ? { userId: outcome.actorUserId } : null;
}

function bigintFromOptional(
  value: number | string | null | undefined,
): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
}

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export async function workflowIntakeLinksRoutes(app: FastifyInstance) {
  // -- Create -----------------------------------------------------------

  app.post(
    "/v1/workflow/intake-links",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const body = CreateBody.parse(req.body ?? {});
      const ok = await requireIntakeWorkflowActor(req, reply, body.teamId, "workflow.intake_link.create");
      if (!ok) return;

      // Secure-intake plan gate (2026-07-15) — intake links are excluded
      // from FREE per the Pricing contract. Enforced before any DB write;
      // a known plan restriction surfaced as a stable code.
      {
        // §9.7 — explicit subject: workspace when the request targets one,
        // else the requester's personal account.
        const scope = body.teamId
          ? (
              await resolveCommercialContext({
                type: "WORKSPACE",
                teamId: body.teamId,
                requesterUserId: ok.userId,
              })
            ).scope
          : (
              await resolveCommercialContext({
                type: "PERSONAL_ACCOUNT",
                userId: ok.userId,
              })
            ).scope;
        try {
          await assertWorkspaceAllowsIntake(scope);
        } catch (err) {
          const e = err as { statusCode?: number; code?: string; message?: string };
          if (e?.code === "INTAKE_NOT_INCLUDED") {
            return reply
              .code(e.statusCode ?? 409)
              .send({ error: { code: e.code, message: e.message } });
          }
          throw err;
        }
      }

      // Intake-links-e2e Phase 7 — per-user-per-workspace create
      // rate limit. 30/min for a single admin is generous for normal
      // SMB use and stops a runaway script (or a misbehaving form
      // re-submit loop) from spawning hundreds of links per minute.
      const createLimit = await enforceRateLimit({
        key: `intake-link:create:${body.teamId}:${ok.userId}`,
        max: 30,
        windowSec: 60,
      });
      if (!createLimit.allowed) {
        return reply
          .code(429)
          .send({ error: { code: "rate_limited", message: "Too many intake links — try again in a minute." } });
      }

      // Phase 9 — governance gate. Workspace policy can restrict
      // external / anonymous intake. Additive: workspaces without a
      // policy row continue to allow both.
      {
        const { canCreateIntakeLink, loadWorkspaceGovernancePolicy } =
          await import("../services/governance.service.js");
        const policy = await loadWorkspaceGovernancePolicy(body.teamId);
        const membership = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: body.teamId, userId: ok.userId } },
        });
        const decision = canCreateIntakeLink({
          role: membership?.role,
          intakeMode: body.intakeMode,
          policy,
        });
        if (!decision.allowed) {
          return reply.code(403).send({
            error: { code: decision.reason },
          });
        }
      }

      try {
        const result = await createWorkflowIntakeLink(
          {
            teamId: body.teamId,
            workflowTemplateSlug: body.workflowTemplateSlug,
            intakeMode: body.intakeMode,
            caseId: body.caseId ?? null,
            recipientLabel: body.recipientLabel ?? null,
            recipientEmail: body.recipientEmail ?? null,
            recipientPhone: body.recipientPhone ?? null,
            customerId: body.customerId ?? null,
            maxUses: body.maxUses,
            maxFileCountPerSession: body.maxFileCountPerSession ?? null,
            maxBytesPerSession: bigintFromOptional(body.maxBytesPerSession),
            allowedAcceptedKinds: body.allowedAcceptedKinds,
            consentPolicyVersion: body.consentPolicyVersion ?? null,
            consentDisclosureText: body.consentDisclosureText ?? null,
            expiresAtUtc: new Date(body.expiresAtUtc),
            ipAllowlistCidrs: body.ipAllowlistCidrs,
            senderDisplayMode: body.senderDisplayMode,
            senderDisplayName: body.senderDisplayName ?? null,
            locationPolicy: body.locationPolicy,
          },
          { actorUserId: ok.userId },
        );

        // Intake-links-e2e (Phase 7) — audit the create. Fire-and-
        // forget; a failure to log MUST NOT break the create.
        void emitTenantAudit({
          action: "intake.link.created",
          outcome: "success",
          sourceApp: "API",
          actorUserId: ok.userId,
          workspaceId: body.teamId,
          resourceType: "workflow_intake_link",
          resourceId: result.link.id,
          correlationId: req.id ?? null,
          metadata: {
            teamId: body.teamId,
            workflowTemplateSlug: body.workflowTemplateSlug,
            intakeMode: body.intakeMode,
            deliveryMethod: body.deliveryMethod,
            // Never log raw email / phone — both helpers already
            // hash + mask. We pass booleans so audit can confirm
            // which channel was attempted without leaking PII.
            hasRecipientEmail: Boolean(body.recipientEmail),
            hasRecipientPhone: Boolean(body.recipientPhone),
          },
        }).catch(() => {});

        // Intake-links-e2e (Phase 4) — on-create delivery dispatch.
        // The link is already persisted; if delivery fails, the link
        // still exists and the caller can retry via the existing
        // POST /:id/send endpoint. We always include a `delivery`
        // envelope so the UI can render a Sent / Failed chip
        // immediately after create.
        type DeliveryResult =
          | { method: "MANUAL"; status: "skipped" }
          | {
              method: "EMAIL" | "SMS";
              status: "sent";
              communicationMessageId: string;
            }
          | {
              method: "EMAIL" | "SMS";
              status: "failed";
              reason: string;
              communicationMessageId?: string;
            };
        let delivery: DeliveryResult = { method: "MANUAL", status: "skipped" };
        if (body.deliveryMethod !== "MANUAL" && body.intakeUrlBase) {
          // Compose the public intake URL the contributor opens.
          // `intakeUrlBase` is the operator's origin (e.g.
          // "https://app.proovra.com") + the page expects the token
          // appended as a path segment under /intake/<token>.
          const intakeUrl = `${body.intakeUrlBase.replace(/\/$/, "")}/intake/${result.rawToken}`;
          const team = await prisma.team.findUnique({
            where: { id: body.teamId },
            select: { name: true, evidenceWorkspaceLabel: true },
          });
          const workspaceName =
            team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace";
          // Intake-links-e2e Phase 5 — dispatcher with idempotency.
          // A double-click that re-submits the same form (and so the
          // same idempotencyKey) returns the prior message ID without
          // making a second provider call. When the caller omits the
          // key (older clients) we synthesise one from the link ID +
          // timestamp so this single attempt is still atomic but
          // double-clicks won't be caught.
          const idempotencyKey =
            body.idempotencyKey ?? `auto:${result.link.id}`;
          const dispatched: DispatchIntakeDeliveryResult =
            await dispatchIntakeLinkDelivery({
              teamId: body.teamId,
              intakeLinkId: result.link.id,
              rawToken: result.rawToken,
              intakeUrl,
              channel: body.deliveryMethod as "EMAIL" | "SMS",
              actorUserId: ok.userId,
              workspaceName,
              idempotencyKey,
            });
          if (dispatched.ok) {
            delivery = {
              method: body.deliveryMethod as "EMAIL" | "SMS",
              status: "sent",
              communicationMessageId: dispatched.communicationMessageId,
            };
          } else {
            delivery = {
              method: body.deliveryMethod as "EMAIL" | "SMS",
              status: "failed",
              reason: dispatched.reason,
              communicationMessageId: dispatched.communicationMessageId,
            };
          }
          // Audit the send attempt.
          void emitTenantAudit({
            action:
              delivery.status === "sent"
                ? "intake.link.sent"
                : "intake.link.delivery_failed",
            outcome: delivery.status === "sent" ? "success" : "error",
            severity: delivery.status === "sent" ? "info" : "warning",
            sourceApp: "API",
            actorUserId: ok.userId,
            workspaceId: body.teamId,
            resourceType: "workflow_intake_link",
            resourceId: result.link.id,
            correlationId: req.id ?? null,
            metadata: {
              teamId: body.teamId,
              method: delivery.method,
              status: delivery.status,
              communicationMessageId:
                "communicationMessageId" in delivery
                  ? delivery.communicationMessageId
                  : null,
              reason:
                delivery.status === "failed" ? delivery.reason : null,
            },
          }).catch(() => {});
        }

        return reply.code(201).send({
          link: projectWorkflowIntakeLink(
            result.link,
            // Even the caller who just typed the address gets it back masked.
            // The create response is a projection like any other, and the one
            // place a raw value leaves this service is the reveal route.
            await resolveRecipientContactDisclosure(req, {
              teamId: body.teamId,
            }),
          ),
          rawToken: result.rawToken,
          warning:
            "The raw token is shown exactly once. Capture it now — it is not retrievable later.",
          delivery,
        });
      } catch (err) {
        if (err instanceof WorkflowIntakeLinkError) {
          const status =
            err.code === "feature_disabled"
              ? 503
              : err.code === "invalid_sender_display_name"
                ? 400
                : 400;
          return reply.code(status).send({
            error: { code: err.code, message: err.message },
          });
        }
        const message =
          err instanceof Error ? err.message : "Failed to create intake link";
        return reply.code(400).send({ message });
      }
    },
  );

  // -- List -------------------------------------------------------------

  app.get(
    "/v1/workflow/intake-links",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const query = ListQuery.parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;

      // ONE decision for the request, resolved BEFORE the query because it
      // governs what may be matched as well as what may be shown.
      const disclosure = await resolveRecipientContactDisclosure(req, {
        teamId: query.teamId,
      });

      const rows = await listWorkflowIntakeLinks({
        teamId: query.teamId,
        status: query.status,
        workflowTemplateSlug: query.workflowTemplateSlug,
        caseId: query.caseId,
        limit: query.limit,
        archiveScope: query.archiveScope,
        search: query.search ?? null,
        // The same authority that decides whether the address is SHOWN
        // decides whether it can be searched for.
        searchRecipientContact: disclosure === "REVEALED",
      });

      // Intake-links-e2e Phase 1 — enrich the list with delivery +
      // activity aggregates + computed lifecycle. The old shape is
      // preserved as `legacyLinks` for any caller that still expects
      // the bare row projection.

      const items = await projectIntakeLinkList({
        links: rows,
        recipientContactDisclosure: disclosure,
        // Provider IDs are admin-only — controlled by the
        // ?_debug=intake-delivery URL flag the web client respects.
        includeProviderMessageId:
          typeof (req.query as Record<string, unknown>)?._debug === "string" &&
          (req.query as Record<string, string>)._debug === "intake-delivery",
      });

      return reply.code(200).send({
        items,
        // Back-compat for the prior frontend. It is a second projection of
        // the same rows, and it obeys the same decision — a legacy shape is
        // not a licence to disclose more.
        links: rows.map((row) => projectWorkflowIntakeLink(row, disclosure)),
      });
    },
  );

  // -- Get --------------------------------------------------------------

  app.get(
    "/v1/workflow/intake-links/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const { id } = ParamsId.parse(req.params);
      const link = await getWorkflowIntakeLink(id);
      if (!link) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      const ok = await requireMember(req, reply, link.teamId);
      if (!ok) return;

      const disclosure = await resolveRecipientContactDisclosure(req, {
        teamId: link.teamId,
      });

      const item = await projectIntakeLinkListItem(link, {
        includeProviderMessageId:
          typeof (req.query as Record<string, unknown>)?._debug === "string" &&
          (req.query as Record<string, string>)._debug === "intake-delivery",
        recipientContactDisclosure: disclosure,
      });

      return reply
        .code(200)
        .send({ link: projectWorkflowIntakeLink(link, disclosure), item });
    },
  );

  // -- Recipient contact reveal ----------------------------------------

  /*
   * THE ONLY PLACE A RAW RECIPIENT ADDRESS LEAVES THE API.
   *
   * Every projection ships the masked form and nothing else, for everybody.
   * A caller who genuinely needs the address — to phone the person, to
   * confirm a delivery went to the right place — asks here, holds
   * `workflow.intake_recipient_contact.reveal`, and the disclosure is
   * recorded.
   *
   * POST, not GET: this is an act with a consequence, not a cacheable read,
   * and a GET would end up in browser history, proxy logs and prefetchers.
   *
   * Both surfaces that show recipient provenance use this one route — the
   * intake-links administration screen and the Evidence Detail intake card —
   * so there is one gate, one audit record, and one behaviour to reason
   * about.
   */
  app.post(
    "/v1/workflow/intake-links/:id/recipient-contact",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const { id } = ParamsId.parse(req.params);
      const link = await getWorkflowIntakeLink(id);
      if (!link) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      /*
       * Two gates, in this order. First the resource: a caller who cannot
       * read this workspace's links gets the same 404 a missing link gets,
       * so the route cannot be used to probe for ids. Only then the
       * disclosure authority, which answers 403 — by that point the caller
       * has already proven they may see the record, so telling them the
       * difference between "no such link" and "not yours to reveal" costs
       * nothing and saves them guessing.
       */
      const member = await requireMember(req, reply, link.teamId);
      if (!member) return;

      const disclosure = await resolveRecipientContactDisclosure(req, {
        teamId: link.teamId,
      });
      if (disclosure !== "REVEALED") {
        return reply.code(403).send({
          error: {
            code: "FORBIDDEN",
            message:
              "You do not have permission to view the full recipient contact for this intake link.",
          },
        });
      }

      const revealed = revealRecipientContact(link, disclosure);

      /*
       * Recorded on the platform's existing sensitive-reveal convention, the
       * same one that covers a re-revealed reviewer token. WARNING severity
       * because it is worth seeing in a trail, not because anything failed.
       *
       * The address is NOT in the record. Writing the value into an audit
       * log to prove it was disclosed copies it into a second, longer-lived
       * place — which is the opposite of the point. What is recorded is who
       * asked, for which link, which channels came back, and when.
       */
      safeEmitSecurityEvent({
        teamId: link.teamId,
        eventType: "workflow_intake_recipient_contact_revealed",
        severity: "WARNING",
        details: {
          actorUserId: member.userId,
          intakeLinkId: link.id,
          disclosureType: "recipient_contact",
          revealedEmail: Boolean(revealed.recipientEmail),
          revealedPhone: Boolean(revealed.recipientPhone),
        },
      });

      return reply.code(200).send({
        recipientContact: {
          recipientEmail: revealed.recipientEmail,
          recipientPhone: revealed.recipientPhone,
        },
      });
    },
  );

  // -- Sender identity preview -----------------------------------------
  //
  // Intake-link enterprise messaging — returns the safe transport
  // identity the recipient will see, with secret material redacted.
  // Used by the Message Preview Studio in the create modal so the
  // operator can confirm WHO the message will appear from BEFORE
  // they click Create & Send. Never leaks API keys, Twilio SIDs, or
  // messaging-service SIDs.
  app.get(
    "/v1/workflow/intake-links/sender-identity",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, q.teamId);
      if (!ok) return;

      // Resolve the channel identities from env. EVERYTHING is
      // presented as a safe preview — no raw API keys ever cross the
      // wire. `configured=false` channels render with "Not
      // configured" and disable themselves in the modal.
      const emailFromName = (process.env.EMAIL_FROM_NAME ?? "PROOVRA").slice(0, 80);
      const emailFromAddress = (() => {
        const explicit = process.env.EMAIL_FROM ?? "";
        const match = explicit.match(/<([^>]+)>/);
        if (match) return match[1];
        if (/@/.test(explicit)) return explicit.trim();
        return "no-reply@proovra.com";
      })();
      const emailConfigured = Boolean(process.env.RESEND_API_KEY);

      const smsFromNumber = (process.env.TWILIO_SMS_FROM_NUMBER ?? "").trim();
      const smsConfigured =
        Boolean(process.env.TWILIO_ACCOUNT_SID) &&
        (smsFromNumber.length > 0 ||
          Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID));

      /*
       * WhatsApp is gone from this preview because it is gone as an option.
       * The block that stood here reported whether a Twilio Content Template
       * SID was configured so the modal could say "Setup required" instead of
       * silently disabling the choice — a useful thing to say about a channel
       * a user can pick, and a misleading one about a channel that no longer
       * appears. Its env vars are left unread rather than deleted from the
       * deployment: a retired product option is not a reason to break an
       * operator's existing configuration.
       */

      // Reuse the existing phone masker so the operator sees the
      // same shape they're used to elsewhere in the app.
      const { maskPhonePreview } = await import("@proovra/shared");
      const fromNumberPreview = (raw: string): string | null => {
        if (!raw) return null;
        return maskPhonePreview(raw);
      };

      return reply.code(200).send({
        email: {
          configured: emailConfigured,
          fromName: emailFromName,
          fromAddressPreview: emailFromAddress,
        },
        sms: {
          configured: smsConfigured,
          fromNumberPreview: fromNumberPreview(smsFromNumber),
        },
      });
    },
  );

  // -- Submissions ------------------------------------------------------
  //
  // Intake-links-e2e Phase 3 — owner/team-scoped view of every session
  // a contributor opened against the link, with timestamps + the
  // produced Evidence ID. Hard contract: ANONYMOUS / PSEUDONYMOUS
  // intake modes redact contributor email/phone even if the row
  // somehow carries them (defense in depth at the projection layer).
  app.get(
    "/v1/workflow/intake-links/:id/submissions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const { id } = ParamsId.parse(req.params);
      const link = await getWorkflowIntakeLink(id);
      if (!link) {
        return reply.code(404).send({ message: "Intake link not found" });
      }
      const ok = await requireMember(req, reply, link.teamId);
      if (!ok) return;

      const payload = await loadIntakeLinkSubmissions(link);
      return reply.code(200).send(payload);
    },
  );

  // -- Revoke -----------------------------------------------------------

  app.post(
    "/v1/workflow/intake-links/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }

      const { id } = ParamsId.parse(req.params);
      const body = (RevokeBody.parse(req.body ?? {}) ?? {}) as {
        reason?: string | null;
      };

      const existing = await getWorkflowIntakeLink(id);
      if (!existing) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      const ok = await requireIntakeWorkflowActor(req, reply, existing.teamId, "workflow.intake_link.revoke");
      if (!ok) return;

      const updated = await revokeWorkflowIntakeLink({
        id,
        teamId: existing.teamId,
        actorUserId: ok.userId,
        reason: body.reason ?? null,
      });
      if (!updated) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      // Phase 7 — audit the revoke. Fire-and-forget; never block
      // the user-visible response on the audit row.
      void emitTenantAudit({
        action: "intake.link.revoked",
        outcome: "success",
        severity: "warning",
        sourceApp: "API",
        actorUserId: ok.userId,
        workspaceId: existing.teamId,
        resourceType: "workflow_intake_link",
        resourceId: id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: existing.teamId,
          // Reason is operator-supplied free text capped at 400 chars
          // by RevokeBody. Safe to include in audit.
          reason: body.reason ?? null,
          // Pre-state for the audit row so a reader can see what the
          // operator was looking at when they pressed Revoke.
          priorStatus: existing.status,
          priorUsedCount: existing.usedCount,
        },
      }).catch(() => {});

      return reply
        .code(200)
        .send({
          link: projectWorkflowIntakeLink(
            updated,
            await resolveRecipientContactDisclosure(req, {
              teamId: updated.teamId,
            }),
          ),
        });
    },
  );

  // -- Archive / unarchive ---------------------------------------------
  //
  // Operations Console — operator-facing declutter. Distinct from
  // revoke: archive does NOT close public access, it only hides the
  // row from the default Active view. Reversible via /unarchive.
  // Admin-only (same authority as revoke) and fully audited.
  app.post(
    "/v1/workflow/intake-links/:id/archive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const { id } = ParamsId.parse(req.params);
      const existing = await getWorkflowIntakeLink(id);
      if (!existing) {
        return reply.code(404).send({ message: "Intake link not found" });
      }
      const ok = await requireIntakeWorkflowActor(req, reply, existing.teamId, "workflow.intake_link.revoke");
      if (!ok) return;

      const updated = await archiveWorkflowIntakeLink({
        id,
        teamId: existing.teamId,
        actorUserId: ok.userId,
      });
      if (!updated) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      void emitTenantAudit({
        action: "intake.link.archived",
        outcome: "success",
        sourceApp: "API",
        actorUserId: ok.userId,
        workspaceId: existing.teamId,
        resourceType: "workflow_intake_link",
        resourceId: id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: existing.teamId,
          priorStatus: existing.status,
        },
      }).catch(() => {});

      return reply
        .code(200)
        .send({
          link: projectWorkflowIntakeLink(
            updated,
            await resolveRecipientContactDisclosure(req, {
              teamId: updated.teamId,
            }),
          ),
        });
    },
  );

  app.post(
    "/v1/workflow/intake-links/:id/unarchive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const { id } = ParamsId.parse(req.params);
      const existing = await getWorkflowIntakeLink(id);
      if (!existing) {
        return reply.code(404).send({ message: "Intake link not found" });
      }
      const ok = await requireIntakeWorkflowActor(req, reply, existing.teamId, "workflow.intake_link.create");
      if (!ok) return;

      const updated = await unarchiveWorkflowIntakeLink({
        id,
        teamId: existing.teamId,
        actorUserId: ok.userId,
      });
      if (!updated) {
        return reply.code(404).send({ message: "Intake link not found" });
      }

      void emitTenantAudit({
        action: "intake.link.unarchived",
        outcome: "success",
        sourceApp: "API",
        actorUserId: ok.userId,
        workspaceId: existing.teamId,
        resourceType: "workflow_intake_link",
        resourceId: id,
        correlationId: req.id ?? null,
        metadata: { teamId: existing.teamId },
      }).catch(() => {});

      return reply
        .code(200)
        .send({
          link: projectWorkflowIntakeLink(
            updated,
            await resolveRecipientContactDisclosure(req, {
              teamId: updated.teamId,
            }),
          ),
        });
    },
  );

  // -- Phase 18: send via SMS / WhatsApp -------------------------------
  //
  // Operator-initiated delivery. Requires the rawToken from the initial
  // create call (we never persist it) and the public intakeUrl. The
  // service refuses to send for revoked/expired links and surfaces the
  // CommunicationMessage id on success.
  app.post(
    "/v1/workflow/intake-links/:id/send",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (workflowIntakeFeatureDisabledReason()) {
        return sendFeatureDisabled(reply);
      }
      const { id } = ParamsId.parse(req.params);
      // Resend, on the two channels that remain. A request naming the
      // retired one is refused here rather than reaching a provider path that
      // no longer exists.
      const body = z
        .object({
          channel: z.enum(["SMS", "EMAIL"]).default("SMS"),
          rawToken: z.string().min(8).max(512),
          intakeUrl: z.string().url().max(1000),
          // Phase 5 idempotency nonce — same role as create. A
          // user clicking Resend twice with the same nonce won't
          // produce two real provider calls.
          idempotencyKey: z.string().min(1).max(120).optional(),
        })
        .parse(req.body ?? {});
      const existing = await getWorkflowIntakeLink(id);
      if (!existing) {
        return reply.code(404).send({ message: "Intake link not found" });
      }
      const ok = await requireIntakeWorkflowActor(req, reply, existing.teamId, "workflow.intake_link.create");
      if (!ok) return;

      // Phase 7 — per-link resend rate limit. 10/min per
      // (link, user) protects against a UI bug or impatient
      // operator hammering the Resend button.
      const sendLimit = await enforceRateLimit({
        key: `intake-link:send:${id}:${ok.userId}`,
        max: 10,
        windowSec: 60,
      });
      if (!sendLimit.allowed) {
        return reply
          .code(429)
          .send({ error: { code: "rate_limited", message: "Too many resend attempts — wait a minute." } });
      }

      const team = await prisma.team.findUnique({
        where: { id: existing.teamId },
        select: { name: true, evidenceWorkspaceLabel: true },
      });
      const workspaceName =
        team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace";

      // Phase 5 — route resend through the dispatcher so it
      // honours the same idempotency contract as create.
      const idempotencyKey = body.idempotencyKey ?? `resend:${id}:${Date.now()}`;
      const dispatched = await dispatchIntakeLinkDelivery({
        teamId: existing.teamId,
        intakeLinkId: id,
        rawToken: body.rawToken,
        intakeUrl: body.intakeUrl,
        channel: body.channel,
        actorUserId: ok.userId,
        workspaceName,
        idempotencyKey,
      });
      const sendResult = dispatched.ok
        ? {
            ok: true as const,
            communicationMessageId: dispatched.communicationMessageId,
          }
        : { ok: false as const, reason: dispatched.reason };

      // Audit the resend attempt regardless of channel.
      void emitTenantAudit({
        action: sendResult.ok
          ? "intake.link.sent"
          : "intake.link.delivery_failed",
        outcome: sendResult.ok ? "success" : "error",
        severity: sendResult.ok ? "info" : "warning",
        sourceApp: "API",
        actorUserId: ok.userId,
        workspaceId: existing.teamId,
        resourceType: "workflow_intake_link",
        resourceId: id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: existing.teamId,
          method: body.channel,
          status: sendResult.ok ? "sent" : "failed",
          reason: sendResult.ok ? null : sendResult.reason,
          resend: true,
        },
      }).catch(() => {});

      if (!sendResult.ok) {
        const status =
          sendResult.reason === "link_not_found"
            ? 404
            : sendResult.reason === "link_revoked" ||
                sendResult.reason === "link_expired"
              ? 409
              : sendResult.reason === "link_missing_phone" ||
                  sendResult.reason === "link_missing_email"
                ? 400
                : sendResult.reason === "provider_unconfigured"
                  ? 503
                  : sendResult.reason === "max_attempts_exceeded"
                    ? 429
                    : 502;
        return reply
          .code(status)
          .send({ error: { code: sendResult.reason } });
      }
      return reply.code(200).send({
        communicationMessageId: sendResult.communicationMessageId,
      });
    },
  );
}
