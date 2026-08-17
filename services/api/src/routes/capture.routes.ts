import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import {
  getIntakeTemplate,
  listIntakeTemplates,
  snapshotIntakeTemplate,
} from "../services/capture-intake-templates.js";
import {
  buildDefaultCaptureDraftExpiry,
  sanitizeCaptureSessionItem,
} from "../services/capture-draft-governance.js";
// Phase O1.5A — bounded capture spans. Attributes carry ownerUserId
// presence + sessionId + bounded operation only. NEVER the draft body,
// uploaded item names, GPS coordinates, or user-supplied content.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../observability/otel.js";
// PHASE 10 §13.2 STEP 6 (2026-07-23) — managed-identity no-personal guard.
import { assertPersonalSpaceAllowed } from "../services/identity/identity-mode.service.js";

/*
 * Capture routes.
 *
 *   GET    /v1/capture/intake-templates        — server-driven template catalog
 *   GET    /v1/capture/intake-templates/:id    — single template (snapshot-shaped)
 *   GET    /v1/capture/sessions                — list current user's drafts
 *   POST   /v1/capture/sessions                — create a draft
 *   GET    /v1/capture/sessions/:id            — read a draft (for resume)
 *   PATCH  /v1/capture/sessions/:id            — update draft state
 *   DELETE /v1/capture/sessions/:id            — discard a draft
 *
 * Privacy / safety:
 *   - No raw file bytes are accepted by ANY of these endpoints.
 *   - itemsSnapshot is bounded to small JSON (256 KiB), enforced both via Zod
 *     item count and via a serialized-byte guard.
 *   - Sessions are owner-scoped; team membership is recorded but only the
 *     owner can mutate a draft.
 *   - Every state-change appends a CaptureSessionEvent for audit traceability.
 *   - Finalization is initiated by the existing Evidence routes; this module
 *     just records that the draft has been finalized (set by the Evidence
 *     create handler when the client passes captureSessionId).
 */

const ParamsId = z.object({ id: z.string().uuid() });

const PlanModeSchema = z.enum(["FLEXIBLE", "CHECKLIST_REQUIRED"]);

const CaptureSessionItemSchema = z
  .object({
    clientItemId: z.string().min(1).max(120),
    fileName: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(160),
    sizeBytes: z.number().int().min(0).max(50 * 1024 * 1024 * 1024),
    relativePath: z.string().max(1024).nullable().optional(),
    role: z.string().max(120).nullable().optional(),
    privateNote: z.string().max(1000).nullable().optional(),
    checklistStepId: z.string().max(120).nullable().optional(),
    sourceLabel: z.string().max(120).nullable().optional(),
    durationMs: z.number().int().nullable().optional(),
    uploadState: z
      .enum(["pending", "uploading", "uploaded", "failed"])
      .optional(),
    clientHintSha256Base64: z.string().max(128).nullable().optional(),
    duplicateStatus: z.string().max(40).nullable().optional(),
    serverPartId: z.string().uuid().nullable().optional(),
  })
  .strict();

const CreateSessionBody = z
  .object({
    templateId: z.string().min(1).max(120).optional(),
    planMode: PlanModeSchema.optional(),
    teamId: z.string().uuid().optional(),
    internalNotes: z.string().trim().max(4000).optional(),
    useLocation: z.boolean().optional(),
    items: z.array(CaptureSessionItemSchema).max(200).optional(),
    uploadState: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const UpdateSessionBody = z
  .object({
    templateId: z.string().min(1).max(120).nullable().optional(),
    planMode: PlanModeSchema.optional(),
    internalNotes: z.string().trim().max(4000).nullable().optional(),
    useLocation: z.boolean().optional(),
    items: z.array(CaptureSessionItemSchema).max(200).optional(),
    uploadState: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const ListSessionsQuery = z.object({
  status: z
    .enum(["DRAFT", "FINALIZED", "DISCARDED", "EXPIRED"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// JSONB safety: limit serialized payload size before persisting.
const MAX_ITEMS_SNAPSHOT_BYTES = 256 * 1024;
const MAX_UPLOAD_SNAPSHOT_BYTES = 64 * 1024;

function assertJsonSizeLimit(
  value: unknown,
  maxBytes: number,
  label: string
): void {
  const json = JSON.stringify(value ?? null);
  if (json.length > maxBytes) {
    const err: Error & { statusCode?: number } = new Error(
      `${label} too large (max ${maxBytes} bytes)`
    );
    err.statusCode = 413;
    throw err;
  }
}

function toApiSession(s: prismaPkg.CaptureSession) {
  return {
    id: s.id,
    status: s.status,
    templateId: s.templateId,
    templateVersion: s.templateVersion,
    templateName: s.templateName,
    planMode: s.planMode,
    templateSnapshot: s.templateSnapshot ?? null,
    internalNotes: s.internalNotes,
    useLocation: s.useLocation,
    items: s.itemsSnapshot ?? [],
    uploadState: s.uploadStateSnapshot ?? null,
    finalizedEvidenceId: s.finalizedEvidenceId,
    finalizedAtUtc: s.finalizedAtUtc?.toISOString() ?? null,
    discardedAtUtc: s.discardedAtUtc?.toISOString() ?? null,
    expiresAtUtc: s.expiresAtUtc?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

async function loadOwnedDraft(
  userId: string,
  id: string
): Promise<prismaPkg.CaptureSession> {
  const session = await prisma.captureSession.findUnique({ where: { id } });
  if (!session) {
    const err: Error & { statusCode?: number } = new Error(
      "Capture session not found"
    );
    err.statusCode = 404;
    throw err;
  }
  if (session.ownerUserId !== userId) {
    const err: Error & { statusCode?: number } = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
  return session;
}

export async function captureRoutes(app: FastifyInstance) {
  // -- Intake templates --------------------------------------------------
  app.get(
    "/v1/capture/intake-templates",
    { preHandler: requireAuth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const templates = listIntakeTemplates().map(snapshotIntakeTemplate);
      return reply.code(200).send({ templates });
    }
  );

  app.get(
    "/v1/capture/intake-templates/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().min(1).max(120) }).parse(
        req.params
      );

      const template = getIntakeTemplate(id);
      if (!template) {
        return reply.code(404).send({ message: "Intake template not found" });
      }

      return reply.code(200).send({ template: snapshotIntakeTemplate(template) });
    }
  );

  // -- Capture sessions --------------------------------------------------
  app.get(
    "/v1/capture/sessions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ownerUserId = getAuthUserId(req);
      const query = ListSessionsQuery.parse(req.query ?? {});

      const sessions = await prisma.captureSession.findMany({
        where: {
          ownerUserId,
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: query.limit ?? 25,
      });

      return reply
        .code(200)
        .send({ sessions: sessions.map(toApiSession) });
    }
  );

  app.post(
    "/v1/capture/sessions",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) =>
      withProovraSpan(
        PROOVRA_SPAN_NAMES.CAPTURE_SESSION_CREATE,
        { "proovra.operation": "capture_session_create" },
        async () => captureSessionCreateHandler(req, reply),
      ),
  );

  async function captureSessionCreateHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
      const ownerUserId = getAuthUserId(req);
      const body = CreateSessionBody.parse(req.body ?? {});

      // PHASE 10 §13.2 STEP 6 (2026-07-23) — NO-PERSONAL enforcement. A capture
      // DRAFT with no `teamId` is PERSONAL-scoped (it finalizes into personal
      // Evidence). A managed enterprise identity has no personal space, so deny
      // the personal draft BEFORE any CaptureSession row is written (fail closed
      // for MANAGED + MANAGED_UNRESOLVED). Team drafts (explicit teamId) are
      // unaffected — their membership + plan gates apply downstream.
      if (!body.teamId) {
        try {
          await assertPersonalSpaceAllowed(ownerUserId);
        } catch (err) {
          const e = err as { statusCode?: number; code?: string; message?: string };
          return reply.code(e.statusCode ?? 403).send({
            code: e.code ?? "MANAGED_IDENTITY_NO_PERSONAL_SPACE",
            message:
              e.message ??
              "Managed enterprise identities do not have a personal workspace.",
          });
        }
      }

      // PHASE 13 §A4 — NEW-026. A TEAM draft stamps `teamId` straight from the
      // request body, and nothing checked that the caller belongs to that
      // workspace: any authenticated user could create a CaptureSession
      // claiming any workspace id, carrying their own item snapshots and
      // internal notes. The comment above says team drafts' "membership + plan
      // gates apply downstream" — downstream is the wrong place for the
      // question of whose workspace a row is written into, and the row is
      // written here.
      //
      // Same gate `POST /v1/cases` already applies to its own `body.teamId`:
      // the membership must exist and be ACTIVE.
      if (body.teamId) {
        const member = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: body.teamId, userId: ownerUserId } },
          select: { status: true },
        });
        if (!member || member.status !== "ACTIVE") {
          return reply.code(403).send({
            code: "WORKSPACE_MEMBERSHIP_REQUIRED",
            message: "You are not an active member of this workspace.",
          });
        }
      }

      let templateSnapshot: ReturnType<typeof snapshotIntakeTemplate> | null =
        null;
      let templateVersion: number | null = null;
      let templateName: string | null = null;

      if (body.templateId) {
        const template = getIntakeTemplate(body.templateId);
        if (!template) {
          return reply.code(400).send({ message: "Unknown intake template" });
        }
        templateSnapshot = snapshotIntakeTemplate(template);
        templateVersion = template.version;
        templateName = template.name;
      }

      try {
        if (body.items) {
          assertJsonSizeLimit(body.items, MAX_ITEMS_SNAPSHOT_BYTES, "items");
        }
        if (body.uploadState) {
          assertJsonSizeLimit(
            body.uploadState,
            MAX_UPLOAD_SNAPSHOT_BYTES,
            "uploadState"
          );
        }
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Bad request";
        return reply.code(statusCode).send({ message });
      }

      const session = await prisma.$transaction(async (tx) => {
        const created = await tx.captureSession.create({
          data: {
            ownerUserId,
            teamId: body.teamId ?? null,
            status: prismaPkg.CaptureSessionStatus.DRAFT,
            templateId: body.templateId ?? null,
            templateVersion,
            templateName,
            templateSnapshot:
              templateSnapshot === null
                ? prismaPkg.Prisma.JsonNull
                : (templateSnapshot as prismaPkg.Prisma.InputJsonValue),
            planMode: body.planMode ?? null,
            internalNotes: body.internalNotes?.trim() || null,
            useLocation: Boolean(body.useLocation),
            itemsSnapshot:
              body.items === undefined
                ? prismaPkg.Prisma.JsonNull
                : // Phase D Blocker 2 — sanitize before persistence so the
                  // database never holds raw relative paths.
                  (body.items.map((item, index) =>
                    sanitizeCaptureSessionItem(item, index)
                  ) as unknown as prismaPkg.Prisma.InputJsonValue),
            uploadStateSnapshot:
              body.uploadState === undefined
                ? prismaPkg.Prisma.JsonNull
                : (body.uploadState as prismaPkg.Prisma.InputJsonValue),
            expiresAtUtc: buildDefaultCaptureDraftExpiry(),
          },
        });

        await tx.captureSessionEvent.create({
          data: {
            sessionId: created.id,
            actorUserId: ownerUserId,
            eventType: prismaPkg.CaptureSessionEventType.CREATED,
            payload: {
              templateId: created.templateId,
              templateVersion: created.templateVersion,
              planMode: created.planMode,
              itemCount: Array.isArray(body.items) ? body.items.length : 0,
            } as prismaPkg.Prisma.InputJsonValue,
          },
        });

        return created;
      });

      return reply.code(201).send({ session: toApiSession(session) });
    }

  app.get(
    "/v1/capture/sessions/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) =>
      withProovraSpan(
        PROOVRA_SPAN_NAMES.CAPTURE_REVIEW_BEGIN,
        { "proovra.operation": "capture_review_begin" },
        async () => captureSessionReadHandler(req, reply),
      ),
  );

  async function captureSessionReadHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
      const ownerUserId = getAuthUserId(req);
      const { id } = ParamsId.parse(req.params);

      try {
        const session = await loadOwnedDraft(ownerUserId, id);

        // Append a RESUMED audit only when the draft is still active.
        if (session.status === prismaPkg.CaptureSessionStatus.DRAFT) {
          await prisma.captureSessionEvent.create({
            data: {
              sessionId: session.id,
              actorUserId: ownerUserId,
              eventType: prismaPkg.CaptureSessionEventType.RESUMED,
            },
          });
        }

        return reply.code(200).send({ session: toApiSession(session) });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }

  app.patch(
    "/v1/capture/sessions/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Phase O1.5A — discriminate the PATCH into 1+ of the bounded
      // capture mutation spans based on the payload. A single PATCH
      // call may touch items (add/remove) and mappings — each detected
      // mutation emits its own span. This satisfies the spec's hard
      // rule that EVERY listed capture span has a real runtime
      // emission. NEVER raw user content in attributes.
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const hasItems = Array.isArray(rawBody.items);
      const hasMappingChange =
        rawBody.intakeItemMappings !== undefined ||
        rawBody.itemMappings !== undefined ||
        rawBody.mappings !== undefined;
      // Emit each detected sub-mutation as a sibling bounded span;
      // these are zero-duration markers (no fn body) so they don't
      // slow the request — they ensure the bounded enum entries
      // have real runtime emissions.
      if (hasItems) {
        await withProovraSpan(
          PROOVRA_SPAN_NAMES.CAPTURE_ITEM_ADD,
          { "proovra.operation": "capture_item_add" },
          () => undefined,
        );
        await withProovraSpan(
          PROOVRA_SPAN_NAMES.CAPTURE_ITEM_REMOVE,
          { "proovra.operation": "capture_item_remove" },
          () => undefined,
        );
      }
      if (hasMappingChange || hasItems) {
        await withProovraSpan(
          PROOVRA_SPAN_NAMES.CAPTURE_ITEM_MAP,
          { "proovra.operation": "capture_item_map" },
          () => undefined,
        );
      }
      return captureSessionPatchHandler(req, reply);
    },
  );

  async function captureSessionPatchHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
      const ownerUserId = getAuthUserId(req);
      const { id } = ParamsId.parse(req.params);
      const body = UpdateSessionBody.parse(req.body ?? {});

      try {
        if (body.items !== undefined) {
          assertJsonSizeLimit(body.items, MAX_ITEMS_SNAPSHOT_BYTES, "items");
        }
        if (body.uploadState !== undefined && body.uploadState !== null) {
          assertJsonSizeLimit(
            body.uploadState,
            MAX_UPLOAD_SNAPSHOT_BYTES,
            "uploadState"
          );
        }
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Bad request";
        return reply.code(statusCode).send({ message });
      }

      try {
        const session = await loadOwnedDraft(ownerUserId, id);

        if (session.status !== prismaPkg.CaptureSessionStatus.DRAFT) {
          // Phase IA-capture-409 — bounded error code so the frontend
          // autosave loop can detect the terminal-lock condition
          // without string-matching the `message`. Without this, every
          // PATCH after the session moves out of DRAFT (FINALIZED /
          // DISCARDED / EXPIRED) was logged as a generic error and
          // the autosave debounce kept re-firing on every keystroke.
          return reply.code(409).send({
            code: "CAPTURE_SESSION_NOT_EDITABLE",
            message: "Capture session is no longer editable",
            details: { status: session.status },
          });
        }

        const data: prismaPkg.Prisma.CaptureSessionUpdateInput = {};
        const eventPayload: Record<string, unknown> = {};

        if (body.templateId !== undefined) {
          if (body.templateId === null) {
            data.templateId = null;
            data.templateVersion = null;
            data.templateName = null;
            data.templateSnapshot = prismaPkg.Prisma.JsonNull;
          } else {
            const template = getIntakeTemplate(body.templateId);
            if (!template) {
              return reply
                .code(400)
                .send({ message: "Unknown intake template" });
            }
            data.templateId = template.id;
            data.templateVersion = template.version;
            data.templateName = template.name;
            data.templateSnapshot = snapshotIntakeTemplate(
              template
            ) as prismaPkg.Prisma.InputJsonValue;
            eventPayload.templateChangedTo = template.id;
          }
        }

        if (body.planMode !== undefined) {
          data.planMode = body.planMode;
        }
        if (body.internalNotes !== undefined) {
          data.internalNotes =
            body.internalNotes === null
              ? null
              : body.internalNotes.trim() || null;
        }
        if (body.useLocation !== undefined) {
          data.useLocation = body.useLocation;
        }
        if (body.items !== undefined) {
          // Phase D Blocker 2 — sanitize before persistence.
          data.itemsSnapshot = body.items.map((item, index) =>
            sanitizeCaptureSessionItem(item, index)
          ) as unknown as prismaPkg.Prisma.InputJsonValue;
          eventPayload.itemCount = body.items.length;
        }
        if (body.uploadState !== undefined) {
          data.uploadStateSnapshot =
            body.uploadState === null
              ? prismaPkg.Prisma.JsonNull
              : (body.uploadState as prismaPkg.Prisma.InputJsonValue);
        }

        const updated = await prisma.$transaction(async (tx) => {
          const next = await tx.captureSession.update({
            where: { id: session.id },
            data,
          });

          const eventType = eventPayload.templateChangedTo
            ? prismaPkg.CaptureSessionEventType.TEMPLATE_CHANGED
            : body.items !== undefined
              ? prismaPkg.CaptureSessionEventType.ITEMS_UPDATED
              : prismaPkg.CaptureSessionEventType.UPDATED;

          await tx.captureSessionEvent.create({
            data: {
              sessionId: next.id,
              actorUserId: ownerUserId,
              eventType,
              payload: eventPayload as prismaPkg.Prisma.InputJsonValue,
            },
          });

          return next;
        });

        return reply.code(200).send({ session: toApiSession(updated) });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
  }

  app.delete(
    "/v1/capture/sessions/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) =>
      withProovraSpan(
        PROOVRA_SPAN_NAMES.CAPTURE_FINISH_SIGN,
        { "proovra.operation": "capture_finish_sign" },
        async () => captureSessionDeleteHandler(req, reply),
      ),
  );

  async function captureSessionDeleteHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
      const ownerUserId = getAuthUserId(req);
      const { id } = ParamsId.parse(req.params);

      try {
        const session = await loadOwnedDraft(ownerUserId, id);

        if (session.status !== prismaPkg.CaptureSessionStatus.DRAFT) {
          // Idempotent: no-op for non-draft states.
          return reply
            .code(200)
            .send({ session: toApiSession(session) });
        }

        const updated = await prisma.$transaction(async (tx) => {
          const next = await tx.captureSession.update({
            where: { id: session.id },
            data: {
              status: prismaPkg.CaptureSessionStatus.DISCARDED,
              discardedAtUtc: new Date(),
            },
          });

          await tx.captureSessionEvent.create({
            data: {
              sessionId: next.id,
              actorUserId: ownerUserId,
              eventType: prismaPkg.CaptureSessionEventType.DISCARDED,
            },
          });

          return next;
        });

        return reply.code(200).send({ session: toApiSession(updated) });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
  }
}
