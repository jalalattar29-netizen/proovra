/**
 * Webhook Management Routes
 * Endpoints for managing webhooks and webhook events
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { AppError, ErrorCode } from "../errors.js";
import {
  getWebhookService,
  WebhookEventType,
} from "../services/webhook.service.js";
import {
  teamManagementService,
  TeamRole,
} from "../services/team-management.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function auditWebhookMgmtAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceType?: string | null;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "webhook_management",
    severity: params.severity ?? "info",
    source: "api_webhook_management",
    outcome: params.outcome ?? "success",
    resourceType: params.resourceType ?? "webhook",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireWebhookMgmtAnalytics(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: params.entityType ?? "webhook",
    entityId: params.entityId ?? null,
    severity: "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string };
    Body: { url: string; events: string[] };
  }>(
    "/v1/organizations/:id/webhooks",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;
      const { url, events } = req.body;

      const org = await teamManagementService.getOrganization(orgId);
      if (!org) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.create",
          outcome: "failure",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "organization_not_found" },
        });
        throw new AppError(ErrorCode.NOT_FOUND, "Organization not found");
      }

      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.create",
          outcome: "blocked",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "forbidden" },
        });
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "You do not have permission to manage webhooks"
        );
      }

      if (!url || !events || events.length === 0) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.create",
          outcome: "failure",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "invalid_input" },
        });
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "URL and at least one event type are required"
        );
      }

      try {
        const webhookService = getWebhookService();
        const webhook = webhookService.createWebhook(orgId, url, events);

        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.create",
          outcome: "success",
          resourceId: webhook.id,
          metadata: {
            orgId,
            eventCount: webhook.events.length,
          },
        });

        fireWebhookMgmtAnalytics({
          eventType: "webhook_created",
          userId,
          req,
          entityId: webhook.id,
          metadata: { orgId, eventCount: webhook.events.length },
        });

        return {
          data: {
            id: webhook.id,
            url: webhook.url,
            events: webhook.events,
            secret: webhook.secret,
            isActive: webhook.isActive,
            createdAt: webhook.createdAt,
          },
          message: "Webhook created successfully",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.create",
          outcome: "failure",
          severity: "critical",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "create_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to create webhook"
        );
      }
    }
  );

  app.get<{
    Params: { id: string };
  }>(
    "/v1/organizations/:id/webhooks",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;

      const isMember = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.VIEWER
      );
      if (!isMember) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.list",
          outcome: "blocked",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "forbidden" },
        });
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "You do not have access to this organization"
        );
      }

      const webhookService = getWebhookService();
      const webhooks = webhookService.listWebhooks(orgId);

      auditWebhookMgmtAction(req, {
        userId,
        action: "webhook.list",
        outcome: "success",
        resourceType: "organization",
        resourceId: orgId,
        metadata: { count: webhooks.length },
      });

      return {
        data: webhooks.map((w) => ({
          id: w.id,
          url: w.url,
          events: w.events,
          isActive: w.isActive,
          failureCount: w.failureCount,
          lastTriggeredAt: w.lastTriggeredAt,
          createdAt: w.createdAt,
        })),
        total: webhooks.length,
      };
    }
  );

  app.get<{
    Params: { id: string; webhookId: string };
  }>(
    "/v1/organizations/:id/webhooks/:webhookId",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;

      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.view",
          outcome: "blocked",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "forbidden", webhookId },
        });
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "You do not have permission to view webhooks"
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.view",
          outcome: "failure",
          severity: "warning",
          resourceId: webhookId,
          metadata: { reason: "not_found", orgId },
        });
        throw new AppError(ErrorCode.NOT_FOUND, "Webhook not found");
      }

      auditWebhookMgmtAction(req, {
        userId,
        action: "webhook.view",
        outcome: "success",
        resourceId: webhookId,
        metadata: { orgId },
      });

      return {
        data: {
          id: webhook.id,
          url: webhook.url,
          events: webhook.events,
          isActive: webhook.isActive,
          failureCount: webhook.failureCount,
          lastTriggeredAt: webhook.lastTriggeredAt,
          createdAt: webhook.createdAt,
          updatedAt: webhook.updatedAt,
        },
      };
    }
  );

  app.patch<{
    Params: { id: string; webhookId: string };
    Body: { url?: string; events?: string[]; isActive?: boolean };
  }>(
    "/v1/organizations/:id/webhooks/:webhookId",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;
      const { url, events, isActive } = req.body;

      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.update",
          outcome: "blocked",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "forbidden", webhookId },
        });
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "You do not have permission to manage webhooks"
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.update",
          outcome: "failure",
          severity: "warning",
          resourceId: webhookId,
          metadata: { reason: "not_found", orgId },
        });
        throw new AppError(ErrorCode.NOT_FOUND, "Webhook not found");
      }

      try {
        const updates: Record<string, unknown> = {};
        if (url !== undefined) updates.url = url;
        if (events !== undefined) updates.events = events;
        if (isActive !== undefined) updates.isActive = isActive;

        const updated = webhookService.updateWebhook(webhookId, updates);

        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.update",
          outcome: "success",
          resourceId: webhookId,
          metadata: {
            orgId,
            updatedFields: Object.keys(updates),
          },
        });

        fireWebhookMgmtAnalytics({
          eventType: "webhook_updated",
          userId,
          req,
          entityId: webhookId,
          metadata: { orgId, updatedFields: Object.keys(updates) },
        });

        return {
          data: {
            id: updated.id,
            url: updated.url,
            events: updated.events,
            isActive: updated.isActive,
            updatedAt: updated.updatedAt,
          },
          message: "Webhook updated successfully",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.update",
          outcome: "failure",
          severity: "critical",
          resourceId: webhookId,
          metadata: { reason: "update_failed", orgId },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to update webhook"
        );
      }
    }
  );

  app.delete<{
    Params: { id: string; webhookId: string };
  }>(
    "/v1/organizations/:id/webhooks/:webhookId",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;

      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.delete",
          outcome: "blocked",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "forbidden", webhookId },
        });
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "You do not have permission to manage webhooks"
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.delete",
          outcome: "failure",
          severity: "warning",
          resourceId: webhookId,
          metadata: { reason: "not_found", orgId },
        });
        throw new AppError(ErrorCode.NOT_FOUND, "Webhook not found");
      }

      webhookService.deleteWebhook(webhookId);

      auditWebhookMgmtAction(req, {
        userId,
        action: "webhook.delete",
        outcome: "success",
        resourceId: webhookId,
        metadata: { orgId },
      });

      fireWebhookMgmtAnalytics({
        eventType: "webhook_deleted",
        userId,
        req,
        entityId: webhookId,
        metadata: { orgId },
      });

      return {
        message: "Webhook deleted successfully",
      };
    }
  );

  app.get<{
    Params: { id: string; webhookId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/v1/organizations/:id/webhooks/:webhookId/logs",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;
      const { limit = "50" } = req.query;

      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.logs_list",
          outcome: "blocked",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "forbidden", webhookId },
        });
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "You do not have permission to view webhook logs"
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.logs_list",
          outcome: "failure",
          severity: "warning",
          resourceId: webhookId,
          metadata: { reason: "not_found", orgId },
        });
        throw new AppError(ErrorCode.NOT_FOUND, "Webhook not found");
      }

      const events = webhookService.getWebhookEvents(webhookId, parseInt(limit, 10));

      auditWebhookMgmtAction(req, {
        userId,
        action: "webhook.logs_list",
        outcome: "success",
        resourceId: webhookId,
        metadata: { orgId, count: events.length },
      });

      return {
        data: events.map((e) => ({
          id: e.id,
          type: e.type,
          status: e.status,
          attempt: e.attempt,
          httpStatus: e.httpStatus,
          errorMessage: e.errorMessage,
          createdAt: e.createdAt,
        })),
        total: events.length,
      };
    }
  );

  app.post<{
    Params: { id: string; webhookId: string };
  }>(
    "/v1/organizations/:id/webhooks/:webhookId/test",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;

      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.test",
          outcome: "blocked",
          severity: "warning",
          resourceType: "organization",
          resourceId: orgId,
          metadata: { reason: "forbidden", webhookId },
        });
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "You do not have permission to test webhooks"
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.test",
          outcome: "failure",
          severity: "warning",
          resourceId: webhookId,
          metadata: { reason: "not_found", orgId },
        });
        throw new AppError(ErrorCode.NOT_FOUND, "Webhook not found");
      }

      try {
        await webhookService.testWebhook(webhookId);

        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.test",
          outcome: "success",
          resourceId: webhookId,
          metadata: { orgId },
        });

        fireWebhookMgmtAnalytics({
          eventType: "webhook_test_sent",
          userId,
          req,
          entityId: webhookId,
          metadata: { orgId },
        });

        return {
          message: "Test webhook sent. Check your webhook logs for results.",
        };
      } catch {
        auditWebhookMgmtAction(req, {
          userId,
          action: "webhook.test",
          outcome: "failure",
          severity: "critical",
          resourceId: webhookId,
          metadata: { reason: "test_failed", orgId },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to send test webhook"
        );
      }
    }
  );
}