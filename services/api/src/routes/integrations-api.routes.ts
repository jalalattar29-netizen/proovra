/**
 * Phase 10 — Public enterprise integration API.
 *
 * Authentication: Bearer API key (`Authorization: Bearer pwk_v1_...`).
 * The credential's `teamId` defines the workspace scope; the caller
 * does not pass `teamId` in the request body / query.
 *
 *   GET   /v1/integrations/api/evidence              — list (safe projection)
 *   GET   /v1/integrations/api/evidence/:id          — fetch one
 *   POST  /v1/integrations/api/intake-links          — create intake link
 *   POST  /v1/integrations/api/evidence-requests     — create evidence request
 *
 * Privacy: no internal notes, no legal-hold reasons, no raw tokens,
 * no IP/UA. Workspace-internal review state is summarised, never
 * surfaced verbatim.
 *
 * Every handler:
 *   1. `requireApiKey` (sets req.apiCredential, gates feature flag).
 *   2. `requireApiScope` for the action-specific permission.
 *   3. Operates only on the workspace from req.apiCredential.teamId.
 */

import { caseClosedTo, evidenceClosedTo } from "../services/access/record-reach.js";
import { evidenceVisibleThroughCasesWhere } from "../services/cases/case-visibility.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { maskEmail } from "@proovra/shared";

import { prisma } from "../db.js";
import {
  requireApiKey,
  requireApiScope,
  runWithApiAudit,
} from "../middleware/integrations-auth.js";
import { createEvidenceRequest, EvidenceRequestError } from "../services/evidence-request.service.js";
import { projectRecipientContact } from "../services/privacy/recipient-contact-disclosure.js";
import { createWorkflowIntakeLink, WorkflowIntakeLinkError } from "../services/workflow-intake-link.service.js";
import {
  prepareKeyedIntakeCreate,
  resolvePriorKeyedIntakeCreate,
  runKeyedIntakeCreate,
  type KeyedIntakeCreateDecision,
} from "../services/intake-link-create-idempotency.service.js";
import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
import { assertWorkspaceAllowsIntake } from "../services/billing-enforcement.service.js";
import {
  decodeKeysetCursor,
  keysetAfter,
  keysetPage,
  type KeysetKey,
} from "../services/pagination/keyset-cursor.js";

/** PRO-G1-03 — a bare record id: the pre-keyset cursor format, still accepted. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ET-INT-10 — the API credential is not a User. Rows these routes write carry
 * a User FK (createdByUserId / actor), and the credential id failed it (P2003,
 * surfaced as a 400 with the raw Prisma message). The acting user is the
 * credential's creator; the credential itself is recorded by runWithApiAudit.
 * The same secure-intake plan gate the user routes run applies here too.
 */
async function integrationActorAndIntakeGate(
  reply: FastifyReply,
  cred: { credentialId: string; teamId: string },
): Promise<{ actorUserId: string } | null> {
  const row = await prisma.apiCredential.findUnique({
    where: { id: cred.credentialId },
    select: { createdByUserId: true },
  });
  if (!row) {
    reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid API key." } });
    return null;
  }
  const { scope } = await resolveCommercialContext({
    type: "WORKSPACE",
    teamId: cred.teamId,
    requesterUserId: row.createdByUserId,
  });
  try {
    await assertWorkspaceAllowsIntake(scope);
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e?.code === "INTAKE_NOT_INCLUDED" || e?.code?.startsWith("COMMERCIAL_")) {
      reply.code(e.statusCode ?? 409).send({ error: { code: e.code, message: e.message } });
      return null;
    }
    throw err;
  }
  return { actorUserId: row.createdByUserId };
}

/** Domain errors carry a bounded code + status; anything else is a server fault (never a raw message). */
function sendIntegrationDomainError(reply: FastifyReply, err: unknown, fallbackCode: string) {
  const e = err as { code?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof e?.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500 && typeof e.code === "string" && /^[a-z_]+$/i.test(e.code)) {
    return reply.code(e.statusCode).send({ error: { code: e.code, message: typeof e.message === "string" ? e.message : fallbackCode } });
  }
  throw err;
}
import {
  EvidenceRequestInputSchema,
} from "@proovra/shared";
import {
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";

const ParamsId = z.object({ id: z.string().uuid() });

/**
 * A2-07 — an evidence request's recipient address, as an API key may see it:
 * masked, like the intake-link projection above. A key is no person and holds
 * an integration scope, not `workflow.intake_recipient_contact.reveal`, so the
 * raw value is null (present, not omitted) and the mask carries provenance.
 */
function integrationRecipientEmail(source: { recipientEmail: string | null }) {
  const contact = projectRecipientContact({ recipientEmail: source.recipientEmail, recipientPhone: null }, "MASKED");
  return {
    recipientEmail: contact.recipientEmail,
    recipientEmailMasked: contact.recipientEmailMasked,
    hasRecipientEmail: contact.hasRecipientEmail,
  };
}

function projectEvidenceForApi(e: {
  id: string;
  type: string;
  status: string;
  verificationStatus: string | null;
  title: string | null;
  mimeType: string | null;
  sizeBytes: bigint | null;
  fileSha256: string | null;
  originalFileName: string | null;
  displayFileName: string | null;
  capturedAtUtc: Date | null;
  createdAt: Date;
  updatedAt: Date;
  retentionUntilUtc: Date | null;
  archivedAt: Date | null;
  teamId: string | null;
}) {
  return {
    id: e.id,
    type: e.type,
    status: e.status,
    verificationStatus: e.verificationStatus,
    title: e.title,
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes ? e.sizeBytes.toString() : null,
    fileSha256: e.fileSha256,
    displayFileName: e.displayFileName ?? e.originalFileName,
    capturedAtUtc: e.capturedAtUtc?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    retentionUntilUtc: e.retentionUntilUtc?.toISOString() ?? null,
    archived: Boolean(e.archivedAt),
    // Deliberately NOT projected: internalNotes, intakePlanJson (may
    // contain workspace-internal context), capture-method telemetry,
    // submittedBy fields, lastAccessedBy, audit chain pointers.
  };
}

const EvidenceSelect = {
  id: true,
  type: true,
  status: true,
  verificationStatus: true,
  title: true,
  mimeType: true,
  sizeBytes: true,
  fileSha256: true,
  originalFileName: true,
  displayFileName: true,
  capturedAtUtc: true,
  createdAt: true,
  updatedAt: true,
  retentionUntilUtc: true,
  archivedAt: true,
  teamId: true,
} as const;

/**
 * The integration API's view of an intake link (create and keyed replay).
 * Masked, like every other projection of the recipient column: an API key
 * echoing back the address it just sent is still a disclosure surface, and
 * this credential holds an integration scope, not the recipient-contact reveal
 * authority. No tokenHash, no IP allowlist details, no consent text.
 */
function integrationIntakeLinkView(link: {
  id: string;
  teamId: string;
  workflowTemplateSlug: string;
  workflowTemplateVersion: number;
  intakeMode: string;
  recipientLabel: string | null;
  recipientEmail: string | null;
  maxUses: number;
  usedCount: number;
  expiresAtUtc: Date | null;
  createdAt: Date;
}) {
  return {
    id: link.id,
    teamId: link.teamId,
    workflowTemplateSlug: link.workflowTemplateSlug,
    workflowTemplateVersion: link.workflowTemplateVersion,
    intakeMode: link.intakeMode,
    recipientLabel: link.recipientLabel,
    recipientEmailMasked: maskEmail(link.recipientEmail),
    hasRecipientEmail: Boolean(link.recipientEmail),
    maxUses: link.maxUses,
    usedCount: link.usedCount,
    expiresAtUtc: link.expiresAtUtc?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}

export async function integrationsApiRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /v1/integrations/api/evidence
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api/evidence",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.evidence.read")) return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "evidence.list", async () => {
        const query = z
          .object({
            status: z.string().max(40).optional(),
            createdAfter: z.string().datetime().optional(),
            createdBefore: z.string().datetime().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().min(1).max(512).optional(),
          })
          .parse(req.query ?? {});

        const dateFilter: { gte?: Date; lte?: Date } = {};
        if (query.createdAfter) dateFilter.gte = new Date(query.createdAfter);
        if (query.createdBefore) dateFilter.lte = new Date(query.createdBefore);

        // PRO-G1-03 — keyset paging on the ORDER key. The list is ordered by
        // (createdAt desc, id desc) and the cursor names that pair, so a walk
        // returns every row exactly once. A bare-UUID cursor (the old format,
        // which paged by `id < cursor` under a createdAt order and skipped and
        // repeated rows) is upgraded by resolving that row's createdAt inside
        // this workspace; an unknown or malformed cursor is a 400, never a
        // silent restart from the top.
        let after: KeysetKey | undefined;
        if (query.cursor) {
          if (UUID_SHAPE.test(query.cursor)) {
            const anchor = await prisma.evidence.findFirst({
              where: { id: query.cursor, teamId: cred.teamId },
              select: { id: true, createdAt: true },
            });
            if (!anchor) return reply.code(400).send({ error: { code: "invalid_cursor" } });
            after = { at: anchor.createdAt, id: anchor.id };
          } else {
            const decoded = decodeKeysetCursor(query.cursor);
            if (!decoded) return reply.code(400).send({ error: { code: "invalid_cursor" } });
            after = decoded;
          }
        }
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);

        const fetched = await prisma.evidence.findMany({
          where: {
            // AZ-R04: an API key is no person, so it is on no access list and
            // sees only unrestricted records.
            AND: [
              await workspaceEvidenceWhere(cred.teamId, prisma),
              evidenceVisibleThroughCasesWhere(null),
              ...(after ? [keysetAfter("createdAt", after)] : []),
            ],
            ...(query.status ? { status: query.status as never } : {}),
            ...(Object.keys(dateFilter).length > 0
              ? { createdAt: dateFilter }
              : {}),
          },
          select: EvidenceSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        });
        const page = keysetPage(fetched, limit, (row) => ({ at: row.createdAt, id: row.id }));

        return reply.code(200).send({
          evidence: page.rows.map(projectEvidenceForApi),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/integrations/api/evidence/:id
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api/evidence/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.evidence.read")) return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "evidence.get", async () => {
        const { id } = ParamsId.parse(req.params);
        const row = await prisma.evidence.findUnique({
          where: { id },
          select: EvidenceSelect,
        });
        if (!row || row.teamId !== cred.teamId || (await evidenceClosedTo(id, null))) {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send({ evidence: projectEvidenceForApi(row) });
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/integrations/api/intake-links
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/integrations/api/intake-links",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.intake_link.create")) return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "intake_link.create", async () => {
        const body = z
          .object({
            workflowTemplateSlug: z.string().min(1).max(120),
            intakeMode: z.string().min(1).max(48),
            caseId: z.string().uuid().nullable().optional(),
            recipientLabel: z.string().max(180).nullable().optional(),
            recipientEmail: z.string().email().max(320).nullable().optional(),
            maxUses: z.number().int().min(1).max(10_000).optional(),
            expiresAtUtc: z.string().datetime(),
          })
          .parse(req.body ?? {});

        // Phase 10.5 — fail-closed governance gate; AUD-36 (2026-10-20) — decided
        // by the canonical mint gate below, on the creator's real role.
        const actor = await integrationActorAndIntakeGate(reply, cred);
        if (!actor) return reply;

        // B3B-F-102 (Free audit 0ea0, residual pass 2026-11-17) — the same
        // create idempotency the web and native create use: an optional
        // `Idempotency-Key` header. Scoped to (workspace, creator, THIS
        // credential, key); a retry with the same body answers the original
        // link (no token: a replay never reveals one), a different body is
        // 409 IDEMPOTENCY_KEY_REUSED. No header: unchanged, a new link each time.
        const rawKey = req.headers["idempotency-key"];
        const headerKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
        if (headerKey !== undefined && (typeof headerKey !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(headerKey))) {
          return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_INVALID" } });
        }
        const keyed = headerKey
          ? prepareKeyedIntakeCreate({
              teamId: cred.teamId,
              actorUserId: actor.actorUserId,
              idempotencyKey: `api:${cred.credentialId}:${headerKey}`,
              payload: body as unknown as Record<string, unknown>,
            })
          : null;
        const answerKeyed = async (decided: KeyedIntakeCreateDecision) => {
          if (decided.kind === "conflict") {
            return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
          }
          const prior = await prisma.workflowIntakeLink.findFirst({
            where: { id: decided.prior.linkId, teamId: cred.teamId },
          });
          if (!prior) return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
          return reply.code(200).send({
            intakeLink: integrationIntakeLinkView(prior),
            rawToken: null,
            tokenRevealed: false,
            replayed: true,
          });
        };
        if (keyed) {
          const decided = await resolvePriorKeyedIntakeCreate(prisma, keyed, new Date(body.expiresAtUtc));
          if (decided) return answerKeyed(decided);
        }
        // AUD-36 (2026-10-20) — the policy decides on the role the credential's
        // creator ACTUALLY holds (the canonical mint gate), not a hard-coded
        // ADMIN: a key minted by a member a policy does not let mint links can
        // no longer mint them.
        {
          const { intakeLinkMintRefusal } = await import("../services/intake/intake-link-mint-gate.js");
          let refusal: Awaited<ReturnType<typeof intakeLinkMintRefusal>>;
          try {
            refusal = await intakeLinkMintRefusal({ teamId: cred.teamId, actorUserId: actor.actorUserId, intakeMode: body.intakeMode });
          } catch {
            // The policy could not be read: the platform does not know the
            // answer, so it refuses without guessing (as before).
            return reply.code(503).send({
              error: { code: "GOVERNANCE_CHECK_FAILED", message: "policy_lookup_failed" },
            });
          }
          if (refusal?.kind === "policy") {
            return reply.code(403).send({ error: { code: "INTAKE_LINK_BLOCKED_BY_POLICY", reason: refusal.reason } });
          }
          if (refusal?.kind === "plan") {
            return reply.code(409).send({ error: { code: refusal.code, message: refusal.message } });
          }
        }
        // PRO-G1-06 — record reach, exactly as the sibling evidence-request
        // create asks it (AZ-R04: a key is no person, so it is on no access
        // list). The service below evaluates the key CREATOR's reach; without
        // this check a key could bind a link to a restricted case its creator
        // happens to see and use 201-vs-404 as an existence oracle. A
        // restricted case answers exactly like a foreign one. A keyed replay
        // of an earlier success was answered above and is unaffected.
        if (body.caseId && (await caseClosedTo(body.caseId, null))) {
          return reply.code(404).send({ error: { code: "case_not_in_workspace" } });
        }
        try {
          const createInput = {
            teamId: cred.teamId,
            workflowTemplateSlug: body.workflowTemplateSlug,
            intakeMode: body.intakeMode as never,
            caseId: body.caseId ?? null,
            recipientLabel: body.recipientLabel ?? null,
            recipientEmail: body.recipientEmail ?? null,
            maxUses: body.maxUses ?? 1,
            expiresAtUtc: new Date(body.expiresAtUtc),
          };
          let created: Awaited<ReturnType<typeof createWorkflowIntakeLink>>;
          if (keyed) {
            const outcome = await runKeyedIntakeCreate(prisma, keyed, {
              requestedExpiresAt: new Date(body.expiresAtUtc),
              create: (tx) =>
                createWorkflowIntakeLink(createInput, { actorUserId: actor.actorUserId }, tx as unknown as typeof prisma),
              auditMetadata: { source: "integrations_api", apiCredentialId: cred.credentialId },
              correlationId: req.id ?? null,
            });
            if (outcome.kind !== "created") return answerKeyed(outcome);
            created = outcome.created;
          } else {
            created = await createWorkflowIntakeLink(createInput, { actorUserId: actor.actorUserId });
          }
          const { link, rawToken } = created;
          return reply.code(201).send({
            intakeLink: integrationIntakeLinkView(link),
            // Returned ONCE so the caller can hand it to a recipient.
            rawToken,
          });
        } catch (err) {
          // ET-SEC-33 — a foreign caseId answers exactly like a missing one.
          if (err instanceof WorkflowIntakeLinkError) {
            return reply
              .code(err.code === "case_not_in_workspace" ? 404 : err.code === "feature_disabled" ? 503 : 400)
              .send({ error: { code: err.code } });
          }
          return sendIntegrationDomainError(reply, err, "intake_link_failed");
        }
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/integrations/api/evidence-requests
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/integrations/api/evidence-requests",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (
        !requireApiScope(req, reply, "integration.evidence_request.create")
      )
        return;
      const cred = req.apiCredential!;
      return runWithApiAudit(
        req,
        reply,
        "evidence_request.create",
        async () => {
          const body = EvidenceRequestInputSchema.omit({ teamId: true }).parse(
            req.body ?? {},
          );
          const actor = await integrationActorAndIntakeGate(reply, cred);
          if (!actor) return reply;
          // A2-17 — record reach, as the user route asks it (AZ-R04: a key is
          // no person, so only records and cases open to the workspace are in
          // its reach). A restricted record or case answers EXACTLY like one
          // outside the workspace (the service's own 404), so a key cannot use
          // create as an existence oracle. Scope and plan gates stay above.
          if (body.evidenceId && (await evidenceClosedTo(body.evidenceId, null))) {
            return sendIntegrationDomainError(reply, new EvidenceRequestError("evidence_not_in_workspace"), "evidence_request_failed");
          }
          if (body.caseId && (await caseClosedTo(body.caseId, null))) {
            return sendIntegrationDomainError(reply, new EvidenceRequestError("case_not_in_workspace"), "evidence_request_failed");
          }
          try {
            const { request } = await createEvidenceRequest(
              { ...body, teamId: cred.teamId },
              { actorUserId: actor.actorUserId },
            );
            return reply.code(201).send({
              evidenceRequest: {
                id: request.id,
                teamId: request.teamId,
                evidenceId: request.evidenceId,
                caseId: request.caseId,
                workflowTemplateSlug: request.workflowTemplateSlug,
                requestType: request.requestType,
                title: request.title,
                priority: request.priority,
                status: request.status,
                recipientMode: request.recipientMode,
                recipientLabel: request.recipientLabel,
                ...integrationRecipientEmail(request),
                dueAtUtc: request.dueAtUtc?.toISOString() ?? null,
                createdAt: request.createdAt.toISOString(),
                // Deliberately NOT projected: instructions, assignedReviewer,
                // internal event log, raw tokens.
              },
            });
          } catch (err) {
            return sendIntegrationDomainError(reply, err, "evidence_request_failed");
          }
        },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/integrations/api/evidence-requests/:id
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api/evidence-requests/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireApiKey(req, reply))) return;
      if (!requireApiScope(req, reply, "integration.evidence_request.read"))
        return;
      const cred = req.apiCredential!;
      return runWithApiAudit(req, reply, "evidence_request.get", async () => {
        const { id } = ParamsId.parse(req.params);
        const row = await prisma.evidenceRequest.findUnique({
          where: { id },
          select: {
            id: true,
            teamId: true,
            evidenceId: true,
            caseId: true,
            workflowTemplateSlug: true,
            requestType: true,
            title: true,
            priority: true,
            status: true,
            recipientMode: true,
            recipientLabel: true,
            recipientEmail: true,
            dueAtUtc: true,
            createdAt: true,
          },
        });
        // AZ-R04: an API key is no person, so a request on a restricted record or
        // case is closed to it, as the record itself is.
        if (
          !row ||
          row.teamId !== cred.teamId ||
          (row.evidenceId !== null && (await evidenceClosedTo(row.evidenceId, null))) ||
          (row.caseId !== null && (await caseClosedTo(row.caseId, null)))
        ) {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        const { recipientEmail, ...rest } = row;
        return reply.code(200).send({
          evidenceRequest: {
            ...rest,
            ...integrationRecipientEmail({ recipientEmail }),
            dueAtUtc: row.dueAtUtc?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          },
        });
      });
    },
  );
}
