/**
 * Webhook Management Routes
 * Endpoints for managing webhooks and webhook events
 */

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { AppError, ErrorCode } from '../errors.js';
import {
  getWebhookService,
  WebhookEventType,
} from '../services/webhook.service.js';
import { teamManagementService, TeamRole } from '../services/team-management.service.js';

export async function webhookRoutes(app: FastifyInstance) {
  /**
   * Create webhook
   * POST /v1/organizations/:id/webhooks
   */
  app.post<{
    Params: { id: string };
    Body: { url: string; events: string[] };
  }>(
    '/v1/organizations/:id/webhooks',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;
      const { url, events } = req.body;

      // Verify user is admin/owner of organization
      const org = await teamManagementService.getOrganization(orgId);
      if (!org) {
        throw new AppError(
          'Organization not found',
          ErrorCode.NOT_FOUND,
          404
        );
      }

      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        throw new AppError(
          'You do not have permission to manage webhooks',
          ErrorCode.FORBIDDEN,
          403
        );
      }

      // Validate input
      if (!url || !events || events.length === 0) {
        throw new AppError(
          'URL and at least one event type are required',
          ErrorCode.VALIDATION_ERROR,
          400
        );
      }

      try {
        const webhookService = getWebhookService();
        const webhook = webhookService.createWebhook(orgId, url, events);

        return {
          data: {
            id: webhook.id,
            url: webhook.url,
            events: webhook.events,
            secret: webhook.secret, // Only shown once
            isActive: webhook.isActive,
            createdAt: webhook.createdAt,
          },
          message: 'Webhook created successfully',
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          'Failed to create webhook',
          ErrorCode.INTERNAL_SERVER_ERROR,
          500
        );
      }
    }
  );

  /**
   * List webhooks
   * GET /v1/organizations/:id/webhooks
   */
  app.get<{
    Params: { id: string };
  }>(
    '/v1/organizations/:id/webhooks',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;

      // Verify user is member of organization
      const isMember = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.VIEWER
      );
      if (!isMember) {
        throw new AppError(
          'You do not have access to this organization',
          ErrorCode.FORBIDDEN,
          403
        );
      }

      const webhookService = getWebhookService();
      const webhooks = webhookService.listWebhooks(orgId);

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

  /**
   * Get webhook details
   * GET /v1/organizations/:id/webhooks/:webhookId
   */
  app.get<{
    Params: { id: string; webhookId: string };
  }>(
    '/v1/organizations/:id/webhooks/:webhookId',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;

      // Verify user is admin/owner
      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        throw new AppError(
          'You do not have permission to view webhooks',
          ErrorCode.FORBIDDEN,
          403
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
      }

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

  /**
   * Update webhook
   * PATCH /v1/organizations/:id/webhooks/:webhookId
   */
  app.patch<{
    Params: { id: string; webhookId: string };
    Body: { url?: string; events?: string[]; isActive?: boolean };
  }>(
    '/v1/organizations/:id/webhooks/:webhookId',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;
      const { url, events, isActive } = req.body;

      // Verify user is admin/owner
      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        throw new AppError(
          'You do not have permission to manage webhooks',
          ErrorCode.FORBIDDEN,
          403
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
      }

      try {
        const updates: any = {};
        if (url !== undefined) updates.url = url;
        if (events !== undefined) updates.events = events;
        if (isActive !== undefined) updates.isActive = isActive;

        const updated = webhookService.updateWebhook(webhookId, updates);

        return {
          data: {
            id: updated.id,
            url: updated.url,
            events: updated.events,
            isActive: updated.isActive,
            updatedAt: updated.updatedAt,
          },
          message: 'Webhook updated successfully',
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          'Failed to update webhook',
          ErrorCode.INTERNAL_SERVER_ERROR,
          500
        );
      }
    }
  );

  /**
   * Delete webhook
   * DELETE /v1/organizations/:id/webhooks/:webhookId
   */
  app.delete<{
    Params: { id: string; webhookId: string };
  }>(
    '/v1/organizations/:id/webhooks/:webhookId',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;

      // Verify user is admin/owner
      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        throw new AppError(
          'You do not have permission to manage webhooks',
          ErrorCode.FORBIDDEN,
          403
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
      }

      webhookService.deleteWebhook(webhookId);

      return {
        message: 'Webhook deleted successfully',
      };
    }
  );

  /**
   * Get webhook event logs
   * GET /v1/organizations/:id/webhooks/:webhookId/logs
   */
  app.get<{
    Params: { id: string; webhookId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    '/v1/organizations/:id/webhooks/:webhookId/logs',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;
      const { limit = '50', offset = '0' } = req.query;

      // Verify user is admin/owner
      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        throw new AppError(
          'You do not have permission to view webhook logs',
          ErrorCode.FORBIDDEN,
          403
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
      }

      const events = webhookService.getWebhookEvents(
        webhookId,
        parseInt(limit, 10)
      );

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

  /**
   * Test webhook delivery
   * POST /v1/organizations/:id/webhooks/:webhookId/test
   */
  app.post<{
    Params: { id: string; webhookId: string };
  }>(
    '/v1/organizations/:id/webhooks/:webhookId/test',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId, webhookId } = req.params;

      // Verify user is admin/owner
      const canManage = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canManage) {
        throw new AppError(
          'You do not have permission to test webhooks',
          ErrorCode.FORBIDDEN,
          403
        );
      }

      const webhookService = getWebhookService();
      const webhook = webhookService.getWebhook(webhookId);
      if (!webhook || webhook.organizationId !== orgId) {
        throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
      }

      try {
        await webhookService.testWebhook(webhookId);
        return {
          message: 'Test webhook sent. Check your webhook logs for results.',
        };
      } catch (error) {
        throw new AppError(
          'Failed to send test webhook',
          ErrorCode.INTERNAL_SERVER_ERROR,
          500
        );
      }
    }
  );
}
