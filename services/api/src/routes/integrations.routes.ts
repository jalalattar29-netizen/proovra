/**
 * Phase 10 — Admin integration routes.
 *
 *   GET    /v1/integrations/api-keys?teamId
 *   POST   /v1/integrations/api-keys
 *   POST   /v1/integrations/api-keys/:id/revoke
 *
 *   GET    /v1/integrations/webhooks?teamId
 *   POST   /v1/integrations/webhooks
 *   PUT    /v1/integrations/webhooks/:id
 *   POST   /v1/integrations/webhooks/:id/rotate-secret    (Phase 4 — dual-signing)
 *   POST   /v1/integrations/webhooks/:id/disable
 *   POST   /v1/integrations/webhooks/:id/test           (Phase 3)
 *   GET    /v1/integrations/webhooks/:id/deliveries
 *
 *   POST   /v1/integrations/process-webhook-retries     (cron-protected)
 *   POST   /v1/integrations/webhooks/cleanup-deliveries  (cron-protected; Phase 10.5)
 *   POST   /v1/integrations/process-secret-cleanup       (cron-protected; PHASE 5 closure)
 *     — sweeps expired `previous_*` triples on ApiCredential +
 *       WebhookEndpoint after rotation grace windows close.
 *
 * All endpoint-mutating routes require workspace membership AND the
 * canonical `integration.api_key.manage` / `integration.webhook.manage`
 * permission. Every route additionally gates on
 * `isIntegrationsFeatureEnabled()` — disabled deployments respond 503.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { PERMISSIONS, WEBHOOK_EVENT_TYPES } from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import {
  ApiCredentialError,
  createApiCredential,
  getIntegrationsRuntimeDiagnostics,
  integrationsFeatureDisabledReason,
  listApiCredentials,
  projectApiCredential,
  revokeApiCredential,
  rotateApiCredential,
  updateApiCredentialHardening,
  MAX_ROTATION_GRACE_MINUTES,
} from "../services/integrations/api-keys.service.js";
import { getEnvSourceHint } from "../env.js";
// Phase 19 — API key create/revoke require step-up.
// Phase 4 closure — each integration action has its own dedicated
// step-up purpose (INTEGRATION_API_KEY_* / INTEGRATION_WEBHOOK_*).
// Legacy SERVICE_ACCOUNT_* approvals remain accepted for the
// corresponding new canonical purpose via the alias map in
// @proovra/shared (legacyAliasesForStoredPurpose / purposeSatisfies).
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  listApiCredentialUsage,
  projectApiCredentialUsage,
} from "../services/integrations/api-key-usage.service.js";
import {
  MAX_WEBHOOK_ROTATION_GRACE_MINUTES,
  WebhookEndpointError,
  createWebhookEndpoint,
  disableWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  projectWebhookEndpoint,
  rotateWebhookSecret,
  updateWebhookEndpoint,
} from "../services/integrations/webhooks.service.js";
// PHASE 5 — admin health dashboard. Service computes every value from
// real DB rows; route only handles auth + projection.
import { computeIntegrationsHealthSnapshot } from "../services/integrations/integration-health.service.js";
import { processDueWebhookRetries } from "../services/integrations/webhook-retry-processor.js";
// PHASE 5 closure — cron sweeper for expired previous_* integration
// secret material on ApiCredential + WebhookEndpoint.
import { sweepExpiredPreviousIntegrationSecrets } from "../services/integrations/secret-cleanup.service.js";
import {
  WebhookDeliveryOpError,
  cancelWebhookDelivery,
  cleanupOldWebhookDeliveries,
  getWebhookDelivery,
  manuallyRetryWebhookDelivery,
  projectWebhookDeliveryDetail,
} from "../services/integrations/webhook-deliveries.service.js";
import {
  dispatchTestEventToEndpoint,
  TEST_EVENT_MAX_PAYLOAD_BYTES,
  TEST_EVENT_TYPE,
} from "../services/integrations/webhook-dispatcher.js";
import { requirePermission } from "../services/governance.service.js";

const ParamsId = z.object({ id: z.string().uuid() });

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) {
    reply.code(403).send({ message: "Not a member of the workspace" });
    return null;
  }
  return { userId, role: membership.role };
}

function denyByPermission(reply: FastifyReply, reason: string): void {
  reply.code(403).send({
    error: { code: "permission_denied", reason },
  });
}

function gateFeatureOrReply(reply: FastifyReply): boolean {
  const reason = integrationsFeatureDisabledReason();
  if (reason) {
    reply.code(503).send({
      error: { code: "INTEGRATIONS_DISABLED", reason },
    });
    return false;
  }
  return true;
}

// Phase 2 — API credential audit event emitter.
//
// Emits a TeamActivity row for each create/rotate/revoke/expiry/scope action
// so operators can audit credential lifecycle from the workspace activity
// surface. The helper SWALLOWS errors: the credential mutation itself is
// the source of truth, and an audit-write failure must never roll back the
// caller's request. The metadata object is bounded — we never persist the
// raw key, the keyHash, the previous_keyHash, or the request body. Only
// short operator-visible fields (prefix, scope identifiers, reason).
async function emitApiKeyAudit(input: {
  teamId: string;
  actorUserId: string | null;
  credentialId: string;
  eventType:
    | "integration.api_key.created"
    | "integration.api_key.rotated"
    | "integration.api_key.revoked"
    | "integration.api_key.expiry_changed"
    | "integration.api_key.scope_changed"
    | "integration.api_key.failed_scope_check";
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.teamActivity.create({
      data: {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        eventType: input.eventType,
        targetType: "api_credential",
        targetId: input.credentialId,
        metadata: input.metadata ?? ({} as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // Best-effort: an audit-log failure must never break the calling
    // mutation. Log to stderr so the failure is visible in operator
    // tooling but do not surface it to the caller.
    // eslint-disable-next-line no-console
    console.error("Failed to log integration.api_key activity:", err);
  }
}

// Phase 3 — Webhook lifecycle audit emitter.
//
// Same posture as `emitApiKeyAudit`: bounded metadata, best-effort
// emission, NEVER persists the raw signing secret or its ciphertext.
// The endpoint URL is allowed in the metadata because it is already a
// stored, projected field on the endpoint row (not a secret).
async function emitWebhookAudit(input: {
  teamId: string;
  actorUserId: string | null;
  endpointId: string;
  eventType:
    | "integration.webhook.test_sent"
    | "integration.webhook.delivery_retried"
    | "integration.webhook.secret_rotated";
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.teamActivity.create({
      data: {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        eventType: input.eventType,
        targetType: "webhook_endpoint",
        targetId: input.endpointId,
        metadata: input.metadata ?? ({} as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to log integration.webhook activity:", err);
  }
}

function projectIntegrationDelivery(d: {
  id: string;
  endpointId: string;
  teamId: string;
  eventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  nextAttemptAtUtc: Date | null;
  responseStatus: number | null;
  responseBodyPreview: string | null;
  errorMessage: string | null;
  sentAtUtc: Date | null;
  failedAtUtc: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: d.id,
    endpointId: d.endpointId,
    teamId: d.teamId,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attemptCount: d.attemptCount,
    nextAttemptAtUtc: d.nextAttemptAtUtc?.toISOString() ?? null,
    responseStatus: d.responseStatus,
    responseBodyPreview: d.responseBodyPreview,
    errorMessage: d.errorMessage,
    sentAtUtc: d.sentAtUtc?.toISOString() ?? null,
    failedAtUtc: d.failedAtUtc?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    // Deliberately NOT projected: payloadJson (may echo workspace data).
  };
}

export async function integrationsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // API keys
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api-keys",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum(["ACTIVE", "REVOKED"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.api_key.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const rows = await listApiCredentials({
        teamId: query.teamId,
        status: query.status,
        limit: query.limit,
      });
      return reply.code(200).send({
        apiKeys: rows.map(projectApiCredential),
      });
    },
  );

  app.post(
    "/v1/integrations/api-keys",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const body = z
        .object({
          teamId: z.string().uuid(),
          name: z.string().min(1).max(180),
          description: z.string().max(2000).nullable().optional(),
          scopes: z
            .array(z.enum(PERMISSIONS))
            .min(1)
            .max(PERMISSIONS.length),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.api_key.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — dedicated integration step-up purpose.
      // Previously this route reused SERVICE_ACCOUNT_CREATE (an
      // identity-surface purpose); a row carrying the legacy purpose
      // is still accepted via LEGACY_STEP_UP_PURPOSE_ALIASES in
      // @proovra/shared so already-issued challenges keep working.
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_API_KEY_CREATE",
        resourceKind: "team",
        resourceId: body.teamId,
      });
      if (gate.sent) return;
      try {
        const { credential, rawKey } = await createApiCredential({
          teamId: body.teamId,
          name: body.name,
          description: body.description ?? null,
          scopes: body.scopes,
          actorUserId: ok.userId,
        });
        // Audit: PHASE 2 — credential lifecycle is workspace-visible.
        // Never persist the raw key or hash, only the operator-visible prefix.
        await emitApiKeyAudit({
          teamId: body.teamId,
          actorUserId: ok.userId,
          credentialId: credential.id,
          eventType: "integration.api_key.created",
          metadata: {
            keyPrefix: credential.keyPrefix,
            scopes: credential.scopes,
            name: credential.name,
          },
        });
        return reply.code(201).send({
          apiKey: projectApiCredential(credential),
          // Shown ONCE: caller MUST store this client-side immediately.
          rawKey,
        });
      } catch (err) {
        if (err instanceof ApiCredentialError) {
          const status =
            err.code === "feature_disabled" || err.code === "secret_missing"
              ? 503
              : err.code === "invalid_scopes"
                ? 400
                : 500;
          return reply
            .code(status)
            .send({ error: { code: err.code, details: err.details ?? null } });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/integrations/api-keys/:id/revoke",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.api_key.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — dedicated INTEGRATION_API_KEY_REVOKE
      // purpose. Legacy SERVICE_ACCOUNT_REVOKE rows are still
      // accepted via the canonical alias map.
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_API_KEY_REVOKE",
        resourceKind: "api_credential",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const revoked = await revokeApiCredential({
          id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          reason: body.reason ?? null,
        });
        // Audit: revoke event includes the persisted reason (already
        // bounded to 400 chars in the service) so the activity surface
        // shows operators why the key was revoked.
        await emitApiKeyAudit({
          teamId: body.teamId,
          actorUserId: ok.userId,
          credentialId: revoked.id,
          eventType: "integration.api_key.revoked",
          metadata: {
            keyPrefix: revoked.keyPrefix,
            reason: revoked.revokedReason,
          },
        });
        return reply.code(200).send({ apiKey: projectApiCredential(revoked) });
      } catch (err) {
        if (err instanceof ApiCredentialError) {
          const status = err.code === "credential_not_found" ? 404 : 400;
          return reply.code(status).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/integrations/api-keys/:id/rotate
  //
  // PHASE 2 — true dual-active rotation. Generates a brand-new raw key and
  // moves the OLD hash/prefix into the credential's `previous_*` columns
  // with a grace cutoff of `now + graceMinutes`. The auth path accepts
  // both the new AND the previous key until the cutoff, then only the new
  // key. Response surfaces the new raw key EXACTLY ONCE — same security
  // posture as the create endpoint.
  //
  // graceMinutes default: 60 minutes. Bounded to [1, 1440] (1 day).
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/integrations/api-keys/:id/rotate",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          graceMinutes: z
            .number()
            .int()
            .min(1)
            .max(MAX_ROTATION_GRACE_MINUTES)
            .optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.api_key.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — rotation now has its own dedicated purpose
      // (INTEGRATION_API_KEY_ROTATE). Previously this reused
      // SERVICE_ACCOUNT_REVOKE which conflated revoke-step-up
      // approvals with rotate-step-up approvals; that legacy purpose
      // is still accepted on already-issued rows via the alias map
      // for revoke ONLY (it intentionally does NOT alias to ROTATE,
      // so a stale SERVICE_ACCOUNT_REVOKE row cannot be re-used here
      // without an operator explicitly requesting the rotate purpose).
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_API_KEY_ROTATE",
        resourceKind: "api_credential",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const result = await rotateApiCredential({
          id,
          teamId: body.teamId,
          actorUserId: ok.userId,
          graceMinutes: body.graceMinutes,
        });
        await emitApiKeyAudit({
          teamId: body.teamId,
          actorUserId: ok.userId,
          credentialId: result.credential.id,
          eventType: "integration.api_key.rotated",
          metadata: {
            // Operator-visible prefix of the NEW key (the prior prefix is
            // surfaced via projectApiCredential.previousKeyPrefix).
            newKeyPrefix: result.credential.keyPrefix,
            previousKeyPrefix: result.previousKeyPrefix,
            previousValidUntilUtc: result.previousValidUntilUtc.toISOString(),
            graceMinutes: body.graceMinutes ?? null,
          },
        });
        return reply.code(200).send({
          apiKey: projectApiCredential(result.credential),
          rawKey: result.rawKey,
          previousKeyPrefix: result.previousKeyPrefix,
          previousValidUntilUtc: result.previousValidUntilUtc.toISOString(),
        });
      } catch (err) {
        if (err instanceof ApiCredentialError) {
          const status =
            err.code === "credential_not_found"
              ? 404
              : err.code === "feature_disabled" ||
                  err.code === "secret_missing"
                ? 503
                : err.code === "invalid_grace_minutes"
                  ? 400
                  : err.code === "credential_already_revoked" ||
                      err.code === "credential_not_active"
                    ? 409
                    : 500;
          return reply
            .code(status)
            .send({ error: { code: err.code, details: err.details ?? null } });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /v1/integrations/api-keys/:id
  //
  // PHASE 2 — operator-managed credential lifecycle updates. Today this
  // surface only exposes `expiresAtUtc` (set or clear) because scope edits
  // are a strictly destructive change to integration behavior and are
  // deferred to a deliberate "edit scopes" surface. Body shape:
  //   { teamId, expiresAtUtc: ISO8601 string | null }
  // Passing the field as `null` clears expiry. Omitting it leaves expiry
  // unchanged.
  // ---------------------------------------------------------------------------
  app.patch(
    "/v1/integrations/api-keys/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          expiresAtUtc: z
            .union([z.string().datetime(), z.null()])
            .optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.api_key.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — expiry change is now gated by a dedicated
      // step-up purpose. Setting or clearing an expiry mutates the
      // credential's lifecycle window and may extend a key that was
      // about to retire, so we treat it with the same posture as the
      // other api-key mutations.
      const expiresProvided = Object.prototype.hasOwnProperty.call(
        body,
        "expiresAtUtc",
      );
      if (expiresProvided) {
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: body.teamId,
          userId: ok.userId,
          purpose: "INTEGRATION_API_KEY_EXPIRY_UPDATE",
          resourceKind: "api_credential",
          resourceId: id,
        });
        if (gate.sent) return;
      }
      try {
        const expiresAtUtc = expiresProvided
          ? body.expiresAtUtc === null
            ? null
            : new Date(body.expiresAtUtc!)
          : undefined;
        if (expiresAtUtc instanceof Date && Number.isNaN(expiresAtUtc.getTime())) {
          return reply
            .code(400)
            .send({ error: { code: "invalid_expires_at_utc" } });
        }
        const updated = await updateApiCredentialHardening({
          id,
          teamId: body.teamId,
          ...(expiresAtUtc !== undefined ? { expiresAtUtc } : {}),
        });
        if (expiresAtUtc !== undefined) {
          await emitApiKeyAudit({
            teamId: body.teamId,
            actorUserId: ok.userId,
            credentialId: updated.id,
            eventType: "integration.api_key.expiry_changed",
            metadata: {
              keyPrefix: updated.keyPrefix,
              expiresAtUtc: expiresAtUtc?.toISOString() ?? null,
              cleared: expiresAtUtc === null,
            },
          });
        }
        return reply
          .code(200)
          .send({ apiKey: projectApiCredential(updated) });
      } catch (err) {
        if (err instanceof ApiCredentialError) {
          const status =
            err.code === "credential_not_found"
              ? 404
              : err.code === "credential_already_revoked"
                ? 409
                : 400;
          return reply.code(status).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/integrations/api-keys/:id/usage
  //
  // Phase 10.5 — returns the recent usage audit trail for a credential.
  // Limited to admins of the owning workspace. Projection never echoes
  // raw key bytes, Authorization headers, or request bodies.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/api-keys/:id/usage",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.api_key.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Verify the credential belongs to the caller's workspace before
      // returning any audit rows. Without this check, a caller could
      // probe credential ids belonging to other workspaces.
      const credential = await prisma.apiCredential.findFirst({
        where: { id, teamId: query.teamId },
        select: { id: true },
      });
      if (!credential) {
        return reply
          .code(404)
          .send({ error: { code: "credential_not_found" } });
      }
      const rows = await listApiCredentialUsage({
        apiCredentialId: id,
        teamId: query.teamId,
        limit: query.limit,
      });
      return reply
        .code(200)
        .send({ usage: rows.map(projectApiCredentialUsage) });
    },
  );

  // ---------------------------------------------------------------------------
  // Webhook endpoints
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/webhooks",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum(["ACTIVE", "DISABLED"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const rows = await listWebhookEndpoints({
        teamId: query.teamId,
        status: query.status,
        limit: query.limit,
      });
      return reply.code(200).send({
        webhooks: rows.map(projectWebhookEndpoint),
      });
    },
  );

  app.post(
    "/v1/integrations/webhooks",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const body = z
        .object({
          teamId: z.string().uuid(),
          url: z.string().url().max(2048),
          description: z.string().max(400).nullable().optional(),
          eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — creating a webhook endpoint provisions a
      // signing secret and registers a destination URL that the
      // dispatcher will sign + POST to on every matching event. It is
      // a new outbound network capability for the workspace, so we
      // gate the create on a dedicated step-up purpose.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_WEBHOOK_CREATE",
        resourceKind: "team",
        resourceId: body.teamId,
      });
      if (gate.sent) return;
      try {
        const { endpoint, rawSecret } = await createWebhookEndpoint({
          teamId: body.teamId,
          url: body.url,
          description: body.description ?? null,
          eventTypes: body.eventTypes ?? [],
          actorUserId: ok.userId,
        });
        return reply.code(201).send({
          webhook: projectWebhookEndpoint(endpoint),
          rawSecret,
        });
      } catch (err) {
        if (err instanceof WebhookEndpointError) {
          const status =
            err.code === "feature_disabled" || err.code === "secret_missing"
              ? 503
              : err.code === "invalid_url" ||
                  err.code === "invalid_event_types"
                ? 400
                : 500;
          return reply
            .code(status)
            .send({ error: { code: err.code, details: err.details ?? null } });
        }
        throw err;
      }
    },
  );

  app.put(
    "/v1/integrations/webhooks/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          description: z.string().max(400).nullable().optional(),
          eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).optional(),
          status: z.enum(["ACTIVE", "DISABLED"]).optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — status transitions on the endpoint are
      // sensitive: re-enabling resumes outbound signed deliveries on
      // a workspace-configured URL, disabling pauses an active
      // integration. Each direction gets its own dedicated step-up
      // purpose. Description / eventTypes-only updates (no status
      // change) do NOT require step-up; that posture matches the
      // existing PUT route's surface area.
      if (body.status === "ACTIVE") {
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: body.teamId,
          userId: ok.userId,
          purpose: "INTEGRATION_WEBHOOK_ENABLE",
          resourceKind: "webhook_endpoint",
          resourceId: id,
        });
        if (gate.sent) return;
      } else if (body.status === "DISABLED") {
        const gate = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: body.teamId,
          userId: ok.userId,
          purpose: "INTEGRATION_WEBHOOK_DISABLE",
          resourceKind: "webhook_endpoint",
          resourceId: id,
        });
        if (gate.sent) return;
      }
      try {
        const updated = await updateWebhookEndpoint({
          id,
          teamId: body.teamId,
          description: body.description,
          eventTypes: body.eventTypes,
          status: body.status,
        });
        return reply
          .code(200)
          .send({ webhook: projectWebhookEndpoint(updated) });
      } catch (err) {
        if (err instanceof WebhookEndpointError) {
          const status =
            err.code === "endpoint_not_found" ? 404 :
            err.code === "invalid_event_types" ? 400 : 500;
          return reply.code(status).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/integrations/webhooks/:id/rotate-secret
  //
  // PHASE 4 — dual-signing rotation. Issues a brand-new raw signing
  // secret AND copies the prior signing material into the endpoint's
  // `previous_*` columns with a cutoff of `now + graceMinutes`. While
  // the cutoff is open the dispatcher emits BOTH signatures in the
  // `X-Proovra-Signature` header (Stripe-style `v1=<new>,v1=<old>`)
  // so receivers can switch over without dropping events.
  //
  // graceMinutes default: 60 minutes. Bounded to
  // [1, MAX_WEBHOOK_ROTATION_GRACE_MINUTES] (1 day).
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/integrations/webhooks/:id/rotate-secret",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          graceMinutes: z
            .number()
            .int()
            .min(1)
            .max(MAX_WEBHOOK_ROTATION_GRACE_MINUTES)
            .optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — secret rotation now has its own dedicated
      // purpose (INTEGRATION_WEBHOOK_SECRET_ROTATE). Previously this
      // reused SERVICE_ACCOUNT_HARDENING_UPDATE; that legacy purpose
      // is still accepted on already-issued challenge rows via the
      // alias map in @proovra/shared.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_WEBHOOK_SECRET_ROTATE",
        resourceKind: "webhook_endpoint",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const result = await rotateWebhookSecret({
          id,
          teamId: body.teamId,
          graceMinutes: body.graceMinutes,
        });
        await emitWebhookAudit({
          teamId: body.teamId,
          actorUserId: ok.userId,
          endpointId: result.endpoint.id,
          eventType: "integration.webhook.secret_rotated",
          metadata: {
            // Operator-visible prefix of the NEW secret (prior prefix
            // is surfaced via projectWebhookEndpoint.previousSecretPrefix).
            newSecretPrefix: result.endpoint.secretPrefix,
            previousSecretPrefix: result.previousSecretPrefix,
            previousSecretValidUntilUtc:
              result.previousSecretValidUntilUtc.toISOString(),
            graceMinutes: body.graceMinutes ?? null,
          },
        });
        return reply.code(200).send({
          webhook: projectWebhookEndpoint(result.endpoint),
          rawSecret: result.rawSecret,
          previousSecretPrefix: result.previousSecretPrefix,
          previousSecretValidUntilUtc:
            result.previousSecretValidUntilUtc.toISOString(),
        });
      } catch (err) {
        if (err instanceof WebhookEndpointError) {
          const status =
            err.code === "endpoint_not_found"
              ? 404
              : err.code === "feature_disabled" || err.code === "secret_missing"
                ? 503
                : err.code === "invalid_grace_minutes"
                  ? 400
                  : 500;
          return reply.code(status).send({
            error: { code: err.code, details: err.details ?? null },
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/integrations/webhooks/:id/disable",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — disabling an endpoint stops outbound
      // deliveries to a workspace-configured URL. Gated on its own
      // dedicated step-up purpose; the equivalent PUT
      // /webhooks/:id?status=DISABLED branch is gated identically.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_WEBHOOK_DISABLE",
        resourceKind: "webhook_endpoint",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const disabled = await disableWebhookEndpoint({
          id,
          teamId: body.teamId,
        });
        return reply
          .code(200)
          .send({ webhook: projectWebhookEndpoint(disabled) });
      } catch (err) {
        if (err instanceof WebhookEndpointError) {
          const status = err.code === "endpoint_not_found" ? 404 : 500;
          return reply.code(status).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/integrations/webhooks/:id/test
  //
  // Phase 3 — Operator-initiated test event. Synthesises a single
  // delivery for the targeted endpoint that goes through the SAME
  // signing + delivery + retry path as a real production event. The
  // synthetic delivery is marked with `eventType="webhook.test"` and
  // `payloadJson.kind="test"` so receivers and the deliveries panel
  // can distinguish it from a production event.
  //
  // Subscription matching is BYPASSED — the test goes to the one
  // endpoint by id even if it does not subscribe to `webhook.test`.
  // The endpoint MUST still be ACTIVE (disabled endpoints reject).
  //
  // Same security posture as the other webhook admin mutations:
  // `requireMember` + `integration.webhook.manage` + step-up.
  //
  // Body: optional `eventType` (rejected if provided as a non-test
  // value — operators must use the canonical producers to emit real
  // events) and an OPTIONAL small `payload` (bounded server-side to
  // TEST_EVENT_MAX_PAYLOAD_BYTES; oversize is replaced with a
  // sentinel so the connectivity signal is preserved).
  //
  // Returns 202 with { deliveryId, eventId } so the caller can poll
  // the deliveries list. Returns 404 when the endpoint is missing /
  // disabled / wrong team, 503 when integrations are disabled.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/integrations/webhooks/:id/test",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          // Optional `eventType` is locked to the canonical test
          // literal — operators MUST NOT spoof a real event type
          // through this route.
          eventType: z.literal(TEST_EVENT_TYPE).optional(),
          // Bounded JSON object. We additionally bound the
          // serialised size server-side; the schema bound is just a
          // first line of defence so we never `JSON.parse` a giant
          // string and then need to discard it.
          payload: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — sending a test event now has its own
      // dedicated purpose (INTEGRATION_WEBHOOK_TEST). Test-send and
      // secret-rotation are now distinct on the audit trail (they
      // previously both reused SERVICE_ACCOUNT_HARDENING_UPDATE).
      //
      // Back-compat note: SERVICE_ACCOUNT_HARDENING_UPDATE aliases to
      // INTEGRATION_WEBHOOK_SECRET_ROTATE (not TEST) — the alias map
      // does NOT broaden the legacy gate to two distinct actions.
      // Operators with stale `SERVICE_ACCOUNT_HARDENING_UPDATE`
      // approvals can still rotate-secret without re-challenging,
      // but a new test-send requires a fresh challenge with the
      // dedicated purpose. This is intentional: silently aliasing
      // hardening->TEST would weaken the gate.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_WEBHOOK_TEST",
        resourceKind: "webhook_endpoint",
        resourceId: id,
      });
      if (gate.sent) return;

      const result = await dispatchTestEventToEndpoint({
        endpointId: id,
        teamId: body.teamId,
        payload: body.payload,
      });
      if (!result) {
        // Endpoint missing, wrong team, or not ACTIVE. We respond 404
        // because the resource is not addressable by the caller. The
        // body deliberately uses a stable, operator-readable error
        // code; the reason is logged on the server.
        return reply
          .code(404)
          .send({ error: { code: "endpoint_not_found_or_inactive" } });
      }
      // Best-effort audit — emit the operator-visible identifiers
      // only. NEVER include the payload (workspace-scoped) or the
      // signing secret.
      await emitWebhookAudit({
        teamId: body.teamId,
        actorUserId: ok.userId,
        endpointId: id,
        eventType: "integration.webhook.test_sent",
        metadata: {
          deliveryId: result.deliveryId,
          eventId: result.eventId,
          outcome: result.outcome,
        },
      });
      return reply.code(202).send({
        deliveryId: result.deliveryId,
        eventId: result.eventId,
      });
    },
  );

  // Expose the server-side payload cap so callers / tests can pin it.
  void TEST_EVENT_MAX_PAYLOAD_BYTES;

  app.get(
    "/v1/integrations/webhooks/:id/deliveries",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z
            .enum(["PENDING", "SENT", "FAILED", "RETRY_SCHEDULED", "CANCELLED"])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const endpoint = await getWebhookEndpoint({ id, teamId: query.teamId });
      if (!endpoint) {
        return reply.code(404).send({ error: { code: "endpoint_not_found" } });
      }
      const rows = await prisma.integrationWebhookDelivery.findMany({
        where: {
          endpointId: id,
          teamId: query.teamId,
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(query.limit ?? 50, 1), 200),
      });
      return reply.code(200).send({
        deliveries: rows.map(projectIntegrationDelivery),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 10.5 — Webhook delivery operations.
  //
  //   GET   /v1/integrations/webhook-deliveries/:id
  //   POST  /v1/integrations/webhook-deliveries/:id/retry
  //   POST  /v1/integrations/webhook-deliveries/:id/cancel
  //
  // All require `integration.webhook.manage`. Workspace scope is
  // enforced at the service layer — the row is fetched with `teamId`
  // bound to the caller's workspace.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/webhook-deliveries/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      const row = await getWebhookDelivery({ id, teamId: query.teamId });
      if (!row) {
        return reply.code(404).send({ error: { code: "delivery_not_found" } });
      }
      return reply
        .code(200)
        .send({ delivery: projectWebhookDeliveryDetail(row) });
    },
  );

  app.post(
    "/v1/integrations/webhook-deliveries/:id/retry",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      // Phase 4 closure — operator-initiated retry emits a signed
      // outbound POST to the endpoint URL outside the normal retry
      // schedule. The action is bounded but sensitive enough to gate
      // on its own dedicated step-up purpose so an operator approval
      // for an unrelated webhook action cannot satisfy it.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.userId,
        purpose: "INTEGRATION_WEBHOOK_RETRY",
        resourceKind: "webhook_delivery",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await manuallyRetryWebhookDelivery({
          id,
          teamId: body.teamId,
        });
        // Phase 3 — operator-initiated retry is a workspace-visible
        // action. Audit emit is best-effort and bounded: we surface
        // the delivery id, the endpoint id (so the activity surface
        // can link back), the eventType, and the post-attempt
        // status. NEVER the payload, signature, or response body.
        await emitWebhookAudit({
          teamId: body.teamId,
          actorUserId: ok.userId,
          endpointId: updated.endpointId,
          eventType: "integration.webhook.delivery_retried",
          metadata: {
            deliveryId: updated.id,
            eventType: updated.eventType,
            status: updated.status,
            attemptCount: updated.attemptCount,
          },
        });
        return reply
          .code(200)
          .send({ delivery: projectWebhookDeliveryDetail(updated) });
      } catch (err) {
        if (err instanceof WebhookDeliveryOpError) {
          const status =
            err.code === "delivery_not_found" ||
            err.code === "endpoint_not_found"
              ? 404
              : err.code === "endpoint_inactive" ||
                  err.code === "delivery_not_retryable"
                ? 409
                : 500;
          return reply.code(status).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/integrations/webhook-deliveries/:id/cancel",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId);
      if (!ok) return;
      const perm = requirePermission(ok.role, "integration.webhook.manage");
      if (!perm.allowed) {
        denyByPermission(reply, perm.reason);
        return;
      }
      try {
        const updated = await cancelWebhookDelivery({
          id,
          teamId: body.teamId,
        });
        return reply
          .code(200)
          .send({ delivery: projectWebhookDeliveryDetail(updated) });
      } catch (err) {
        if (err instanceof WebhookDeliveryOpError) {
          const status =
            err.code === "delivery_not_found"
              ? 404
              : err.code === "delivery_not_cancellable"
                ? 409
                : 500;
          return reply.code(status).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/integrations/diagnostics
  //
  // Admin-only safe runtime diagnostics. Returns booleans describing whether
  // INTEGRATIONS_ENABLED is on, whether API_KEY_SECRET is bound and meets the
  // 32-char minimum, whether INTEGRATION_CRON_SECRET is bound, and a hint at
  // which .env file(s) contributed. NEVER returns the secret values or their
  // actual length — operators sometimes screenshot this surface, so the
  // payload must be safe to share.
  //
  // Auth: workspace OWNER/ADMIN role on the requested teamId. Does NOT gate
  // on `gateFeatureOrReply` — the entire purpose of the endpoint is to
  // explain WHY integrations are disabled when they are.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/diagnostics",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      if (ok.role !== "OWNER" && ok.role !== "ADMIN") {
        denyByPermission(reply, `role_${ok.role}_lacks_integration.diagnostics.read`);
        return;
      }
      const diag = getIntegrationsRuntimeDiagnostics();
      return reply.code(200).send({
        diagnostics: {
          enabled: diag.enabled,
          apiKeySecretBound: diag.apiKeySecretBound,
          apiKeySecretLengthValid: diag.apiKeySecretLengthValid,
          cronSecretBound: diag.cronSecretBound,
          reason: diag.reason,
          envSourceHint: getEnvSourceHint(),
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // PHASE 5 — GET /v1/integrations/health
  //
  // Team-scoped admin health snapshot. Every value is derived from real
  // DB rows (api_credentials, api_credential_usage_logs,
  // integration_webhook_endpoints, integration_webhook_deliveries) —
  // there are NO fabricated counters, NO synthesised success rates,
  // and NO latency field (the deliveries table has no latency column
  // and the brief explicitly forbids adding one in this phase).
  //
  // Gate: workspace OWNER/ADMIN on the requested teamId AND the
  // integrations feature must be ENABLED. The route returns 503 with
  // the canonical disabled-reason payload when the feature is off,
  // matching the rest of the integrations surface.
  // ---------------------------------------------------------------------------

  app.get(
    "/v1/integrations/health",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!gateFeatureOrReply(reply)) return;
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId);
      if (!ok) return;
      if (ok.role !== "OWNER" && ok.role !== "ADMIN") {
        denyByPermission(
          reply,
          `role_${ok.role}_lacks_integration.health.read`,
        );
        return;
      }
      const snapshot = await computeIntegrationsHealthSnapshot(query.teamId);
      return reply.code(200).send({ health: snapshot });
    },
  );

  // ---------------------------------------------------------------------------
  // Cron-driven sweepers
  // ---------------------------------------------------------------------------

  app.post(
    "/v1/integrations/process-webhook-retries",
    async (req, reply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({ batchSize: z.number().int().min(1).max(500).optional() })
        .parse(req.body ?? {});
      const summary = await processDueWebhookRetries({
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ summary });
    },
  );

  // Phase 10.5 — POST /v1/integrations/webhooks/cleanup-deliveries
  //
  // Deletes terminal deliveries (SENT/FAILED/CANCELLED) older than the
  // configured retention window. Active rows (PENDING / RETRY_SCHEDULED)
  // are never deleted regardless of age. Protected by the same
  // INTEGRATION_CRON_SECRET as the retry sweeper.
  app.post(
    "/v1/integrations/webhooks/cleanup-deliveries",
    async (req, reply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({
          retentionDays: z.number().int().min(7).max(3650).optional(),
          batchSize: z.number().int().min(1).max(10_000).optional(),
        })
        .parse(req.body ?? {});
      const summary = await cleanupOldWebhookDeliveries({
        retentionDays: body.retentionDays,
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ summary });
    },
  );

  // PHASE 5 closure — POST /v1/integrations/process-secret-cleanup
  //
  // Sweeps expired `previous_*` secret material from ApiCredential
  // (previousKeyHash / previousKeyPrefix / previousValidUntilUtc) and
  // WebhookEndpoint (previousSecretCiphertext / previousSecretPrefix /
  // previousSecretValidUntilUtc) once the rotation grace window has
  // closed. The dispatcher + verify path already clear opportunistically
  // when traffic flows; this sweeper covers credentials and endpoints
  // that have gone quiet during their grace window.
  //
  // Idempotent — a follow-up invocation returns zero counts because
  // the WHERE clause requires `previous*ValidUntilUtc < now()` AND
  // `IS NOT NULL`. Same INTEGRATION_CRON_SECRET as the other sweepers.
  app.post(
    "/v1/integrations/process-secret-cleanup",
    async (req, reply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({
          batchSize: z.number().int().min(1).max(5_000).optional(),
          dryRun: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      const summary = await sweepExpiredPreviousIntegrationSecrets({
        batchSize: body.batchSize,
        dryRun: body.dryRun,
      });
      return reply.code(200).send(summary);
    },
  );
}
