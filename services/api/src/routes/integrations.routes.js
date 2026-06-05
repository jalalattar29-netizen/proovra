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
 *   GET    /v1/integrations/webhooks/:id/deliveries
 *
 *   POST   /v1/integrations/process-webhook-retries     (cron-protected)
 *   POST   /v1/integrations/webhooks/cleanup-deliveries  (cron-protected; Phase 10.5)
 *   POST   /v1/integrations/process-secret-cleanup       (cron-protected; PHASE 5 closure)
 *
 * All endpoint-mutating routes require workspace membership AND the
 * canonical `integration.api_key.manage` / `integration.webhook.manage`
 * permission. Every route additionally gates on
 * `isIntegrationsFeatureEnabled()` — disabled deployments respond 503.
 */
import { z } from "zod";
import { PERMISSIONS, WEBHOOK_EVENT_TYPES } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import { ApiCredentialError, createApiCredential, getIntegrationsRuntimeDiagnostics, integrationsFeatureDisabledReason, listApiCredentials, projectApiCredential, revokeApiCredential, rotateApiCredential, updateApiCredentialHardening, MAX_ROTATION_GRACE_MINUTES, } from "../services/integrations/api-keys.service.js";
import { getEnvSourceHint } from "../env.js";
// Phase 19 — API key create/revoke require step-up.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { listApiCredentialUsage, projectApiCredentialUsage, } from "../services/integrations/api-key-usage.service.js";
import { MAX_WEBHOOK_ROTATION_GRACE_MINUTES, WebhookEndpointError, createWebhookEndpoint, disableWebhookEndpoint, getWebhookEndpoint, listWebhookEndpoints, projectWebhookEndpoint, rotateWebhookSecret, updateWebhookEndpoint, } from "../services/integrations/webhooks.service.js";
// PHASE 5 — admin health dashboard. Service computes every value from
// real DB rows; route only handles auth + projection.
import { computeIntegrationsHealthSnapshot } from "../services/integrations/integration-health.service.js";
import { processDueWebhookRetries } from "../services/integrations/webhook-retry-processor.js";
import { sweepExpiredPreviousIntegrationSecrets } from "../services/integrations/secret-cleanup.service.js";
import { WebhookDeliveryOpError, cancelWebhookDelivery, cleanupOldWebhookDeliveries, getWebhookDelivery, manuallyRetryWebhookDelivery, projectWebhookDeliveryDetail, } from "../services/integrations/webhook-deliveries.service.js";
import { dispatchTestEventToEndpoint, TEST_EVENT_MAX_PAYLOAD_BYTES, TEST_EVENT_TYPE, } from "../services/integrations/webhook-dispatcher.js";
import { requirePermission } from "../services/governance.service.js";
const ParamsId = z.object({ id: z.string().uuid() });
async function requireMember(req, reply, teamId) {
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
function denyByPermission(reply, reason) {
    reply.code(403).send({
        error: { code: "permission_denied", reason },
    });
}
function gateFeatureOrReply(reply) {
    const reason = integrationsFeatureDisabledReason();
    if (reason) {
        reply.code(503).send({
            error: { code: "INTEGRATIONS_DISABLED", reason },
        });
        return false;
    }
    return true;
}
// Phase 2 — API credential audit event emitter; see .ts sibling for contract.
async function emitApiKeyAudit(input) {
    try {
        await prisma.teamActivity.create({
            data: {
                teamId: input.teamId,
                actorUserId: input.actorUserId,
                eventType: input.eventType,
                targetType: "api_credential",
                targetId: input.credentialId,
                metadata: input.metadata ?? {},
            },
        });
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to log integration.api_key activity:", err);
    }
}
// Phase 3 — Webhook lifecycle audit emitter; see .ts sibling for contract.
async function emitWebhookAudit(input) {
    try {
        await prisma.teamActivity.create({
            data: {
                teamId: input.teamId,
                actorUserId: input.actorUserId,
                eventType: input.eventType,
                targetType: "webhook_endpoint",
                targetId: input.endpointId,
                metadata: input.metadata ?? {},
            },
        });
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to log integration.webhook activity:", err);
    }
}
function projectIntegrationDelivery(d) {
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
export async function integrationsRoutes(app) {
    // ---------------------------------------------------------------------------
    // API keys
    // ---------------------------------------------------------------------------
    app.get("/v1/integrations/api-keys", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const query = z
            .object({
            teamId: z.string().uuid(),
            status: z.enum(["ACTIVE", "REVOKED"]).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
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
    });
    app.post("/v1/integrations/api-keys", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
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
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.api_key.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "SERVICE_ACCOUNT_CREATE",
            resourceKind: "team",
            resourceId: body.teamId,
        });
        if (gate.sent)
            return;
        try {
            const { credential, rawKey } = await createApiCredential({
                teamId: body.teamId,
                name: body.name,
                description: body.description ?? null,
                scopes: body.scopes,
                actorUserId: ok.userId,
            });
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
        }
        catch (err) {
            if (err instanceof ApiCredentialError) {
                const status = err.code === "feature_disabled" || err.code === "secret_missing"
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
    });
    app.post("/v1/integrations/api-keys/:id/revoke", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            reason: z.string().max(400).nullable().optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.api_key.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "SERVICE_ACCOUNT_REVOKE",
            resourceKind: "api_credential",
            resourceId: id,
        });
        if (gate.sent)
            return;
        try {
            const revoked = await revokeApiCredential({
                id,
                teamId: body.teamId,
                actorUserId: ok.userId,
                reason: body.reason ?? null,
            });
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
        }
        catch (err) {
            if (err instanceof ApiCredentialError) {
                const status = err.code === "credential_not_found" ? 404 : 400;
                return reply.code(status).send({ error: { code: err.code } });
            }
            throw err;
        }
    });
    // ---------------------------------------------------------------------------
    // POST /v1/integrations/api-keys/:id/rotate — PHASE 2 dual-active rotation.
    // ---------------------------------------------------------------------------
    app.post("/v1/integrations/api-keys/:id/rotate", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
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
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.api_key.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        const gate = await requireStepUpForSensitiveAction({
            req, reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "SERVICE_ACCOUNT_REVOKE",
            resourceKind: "api_credential",
            resourceId: id,
        });
        if (gate.sent)
            return;
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
        }
        catch (err) {
            if (err instanceof ApiCredentialError) {
                const status = err.code === "credential_not_found"
                    ? 404
                    : err.code === "feature_disabled" || err.code === "secret_missing"
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
    });
    // ---------------------------------------------------------------------------
    // PATCH /v1/integrations/api-keys/:id — PHASE 2 expiry management.
    // ---------------------------------------------------------------------------
    app.patch("/v1/integrations/api-keys/:id", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
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
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.api_key.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        try {
            const expiresAtUtc = Object.prototype.hasOwnProperty.call(body, "expiresAtUtc")
                ? body.expiresAtUtc === null
                    ? null
                    : new Date(body.expiresAtUtc)
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
        }
        catch (err) {
            if (err instanceof ApiCredentialError) {
                const status = err.code === "credential_not_found"
                    ? 404
                    : err.code === "credential_already_revoked"
                        ? 409
                        : 400;
                return reply.code(status).send({ error: { code: err.code } });
            }
            throw err;
        }
    });
    // ---------------------------------------------------------------------------
    // GET /v1/integrations/api-keys/:id/usage
    //
    // Phase 10.5 — returns the recent usage audit trail for a credential.
    // Limited to admins of the owning workspace. Projection never echoes
    // raw key bytes, Authorization headers, or request bodies.
    // ---------------------------------------------------------------------------
    app.get("/v1/integrations/api-keys/:id/usage", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
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
    });
    // ---------------------------------------------------------------------------
    // Webhook endpoints
    // ---------------------------------------------------------------------------
    app.get("/v1/integrations/webhooks", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const query = z
            .object({
            teamId: z.string().uuid(),
            status: z.enum(["ACTIVE", "DISABLED"]).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
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
    });
    app.post("/v1/integrations/webhooks", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const body = z
            .object({
            teamId: z.string().uuid(),
            url: z.string().url().max(2048),
            description: z.string().max(400).nullable().optional(),
            eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.webhook.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
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
        }
        catch (err) {
            if (err instanceof WebhookEndpointError) {
                const status = err.code === "feature_disabled" || err.code === "secret_missing"
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
    });
    app.put("/v1/integrations/webhooks/:id", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
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
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.webhook.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
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
        }
        catch (err) {
            if (err instanceof WebhookEndpointError) {
                const status = err.code === "endpoint_not_found" ? 404 :
                    err.code === "invalid_event_types" ? 400 : 500;
                return reply.code(status).send({ error: { code: err.code } });
            }
            throw err;
        }
    });
    // Phase 4 — dual-signing rotation.
    app.post("/v1/integrations/webhooks/:id/rotate-secret", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
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
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.webhook.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        const gate = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "SERVICE_ACCOUNT_HARDENING_UPDATE",
            resourceKind: "webhook_endpoint",
            resourceId: id,
        });
        if (gate.sent)
            return;
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
                    newSecretPrefix: result.endpoint.secretPrefix,
                    previousSecretPrefix: result.previousSecretPrefix,
                    previousSecretValidUntilUtc: result.previousSecretValidUntilUtc.toISOString(),
                    graceMinutes: body.graceMinutes ?? null,
                },
            });
            return reply.code(200).send({
                webhook: projectWebhookEndpoint(result.endpoint),
                rawSecret: result.rawSecret,
                previousSecretPrefix: result.previousSecretPrefix,
                previousSecretValidUntilUtc: result.previousSecretValidUntilUtc.toISOString(),
            });
        }
        catch (err) {
            if (err instanceof WebhookEndpointError) {
                const status = err.code === "endpoint_not_found"
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
    });
    app.post("/v1/integrations/webhooks/:id/disable", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.webhook.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        try {
            const disabled = await disableWebhookEndpoint({
                id,
                teamId: body.teamId,
            });
            return reply
                .code(200)
                .send({ webhook: projectWebhookEndpoint(disabled) });
        }
        catch (err) {
            if (err instanceof WebhookEndpointError) {
                const status = err.code === "endpoint_not_found" ? 404 : 500;
                return reply.code(status).send({ error: { code: err.code } });
            }
            throw err;
        }
    });
    // Phase 3 — POST /v1/integrations/webhooks/:id/test
    app.post("/v1/integrations/webhooks/:id/test", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            eventType: z.literal(TEST_EVENT_TYPE).optional(),
            payload: z.record(z.string(), z.unknown()).optional(),
        })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.webhook.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        const gate = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: body.teamId,
            userId: ok.userId,
            purpose: "SERVICE_ACCOUNT_HARDENING_UPDATE",
            resourceKind: "webhook_endpoint",
            resourceId: id,
        });
        if (gate.sent)
            return;
        const result = await dispatchTestEventToEndpoint({
            endpointId: id,
            teamId: body.teamId,
            payload: body.payload,
        });
        if (!result) {
            return reply
                .code(404)
                .send({ error: { code: "endpoint_not_found_or_inactive" } });
        }
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
    });
    // Expose payload cap reference (mirrors .ts).
    void TEST_EVENT_MAX_PAYLOAD_BYTES;
    app.get("/v1/integrations/webhooks/:id/deliveries", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
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
        if (!ok)
            return;
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
    });
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
    app.get("/v1/integrations/webhook-deliveries/:id", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const { id } = ParamsId.parse(req.params);
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
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
    });
    app.post("/v1/integrations/webhook-deliveries/:id/retry", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
        const perm = requirePermission(ok.role, "integration.webhook.manage");
        if (!perm.allowed) {
            denyByPermission(reply, perm.reason);
            return;
        }
        try {
            const updated = await manuallyRetryWebhookDelivery({
                id,
                teamId: body.teamId,
            });
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
        }
        catch (err) {
            if (err instanceof WebhookDeliveryOpError) {
                const status = err.code === "delivery_not_found" ||
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
    });
    app.post("/v1/integrations/webhook-deliveries/:id/cancel", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const ok = await requireMember(req, reply, body.teamId);
        if (!ok)
            return;
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
        }
        catch (err) {
            if (err instanceof WebhookDeliveryOpError) {
                const status = err.code === "delivery_not_found"
                    ? 404
                    : err.code === "delivery_not_cancellable"
                        ? 409
                        : 500;
                return reply.code(status).send({ error: { code: err.code } });
            }
            throw err;
        }
    });
    // ---------------------------------------------------------------------------
    // GET /v1/integrations/diagnostics — admin-only safe diagnostics.
    // ---------------------------------------------------------------------------
    app.get("/v1/integrations/diagnostics", { preHandler: requireAuth }, async (req, reply) => {
        const query = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
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
    });
    // ---------------------------------------------------------------------------
    // PHASE 5 — GET /v1/integrations/health
    //
    // Team-scoped admin health snapshot. Every value is derived from real
    // DB rows. Returns 503 with the canonical disabled-reason payload
    // when the integrations feature is off, 403 for non-admin members.
    // ---------------------------------------------------------------------------
    app.get("/v1/integrations/health", { preHandler: requireAuth }, async (req, reply) => {
        if (!gateFeatureOrReply(reply))
            return;
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireMember(req, reply, query.teamId);
        if (!ok)
            return;
        if (ok.role !== "OWNER" && ok.role !== "ADMIN") {
            denyByPermission(reply, `role_${ok.role}_lacks_integration.health.read`);
            return;
        }
        const snapshot = await computeIntegrationsHealthSnapshot(query.teamId);
        return reply.code(200).send({ health: snapshot });
    });
    // ---------------------------------------------------------------------------
    // Cron-driven sweepers
    // ---------------------------------------------------------------------------
    app.post("/v1/integrations/process-webhook-retries", async (req, reply) => {
        const ok = await requireIntegrationCronSecret(req, reply);
        if (!ok)
            return;
        const body = z
            .object({ batchSize: z.number().int().min(1).max(500).optional() })
            .parse(req.body ?? {});
        const summary = await processDueWebhookRetries({
            batchSize: body.batchSize,
        });
        return reply.code(200).send({ summary });
    });
    // Phase 10.5 — POST /v1/integrations/webhooks/cleanup-deliveries
    //
    // Deletes terminal deliveries (SENT/FAILED/CANCELLED) older than the
    // configured retention window. Active rows (PENDING / RETRY_SCHEDULED)
    // are never deleted regardless of age. Protected by the same
    // INTEGRATION_CRON_SECRET as the retry sweeper.
    app.post("/v1/integrations/webhooks/cleanup-deliveries", async (req, reply) => {
        const ok = await requireIntegrationCronSecret(req, reply);
        if (!ok)
            return;
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
    });
    // PHASE 5 closure — POST /v1/integrations/process-secret-cleanup
    //
    // Sweeps expired `previous_*` secret material from ApiCredential +
    // WebhookEndpoint once the rotation grace window has closed.
    app.post("/v1/integrations/process-secret-cleanup", async (req, reply) => {
        const ok = await requireIntegrationCronSecret(req, reply);
        if (!ok)
            return;
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
    });
}
