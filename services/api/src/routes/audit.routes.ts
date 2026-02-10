/**
 * Audit Logging Routes
 * Endpoints for viewing audit logs and activity
 */

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { AppError, ErrorCode } from '../errors.js';
import { getAuditService, AuditAction } from '../services/audit.service.js';
import { teamManagementService, TeamRole } from '../services/team-management.service.js';

export async function auditRoutes(app: FastifyInstance) {
  /**
   * Get audit logs for organization
   * GET /v1/organizations/:id/audit-logs
   */
  app.get<{
    Params: { id: string };
    Querystring: {
      action?: string;
      resourceType?: string;
      resourceId?: string;
      status?: string;
      userId?: string;
      limit?: string;
      offset?: string;
      dateFrom?: string;
      dateTo?: string;
    };
  }>(
    '/v1/organizations/:id/audit-logs',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;
      const {
        action,
        resourceType,
        resourceId,
        status,
        userId: filterUserId,
        limit = '50',
        offset = '0',
        dateFrom,
        dateTo,
      } = req.query;

      // Verify user is admin of organization
      const canView = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canView) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'You do not have permission to view audit logs'
        );
      }

      const auditService = getAuditService();

      try {
        const result = auditService.getLogs({
          organizationId: orgId,
          action: action ? (action as AuditAction) : undefined,
          resourceType,
          resourceId,
          status: status as 'success' | 'failure' | undefined,
          userId: filterUserId,
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
        });

        return {
          data: result.logs.map((log) => ({
            id: log.id,
            timestamp: log.createdAt,
            userId: log.userId,
            action: log.action,
            resourceType: log.resourceType,
            resourceId: log.resourceId,
            status: log.status,
            errorMessage: log.errorMessage,
            ipAddress: log.ipAddress,
            changes: log.changes,
          })),
          pagination: {
            total: result.total,
            limit: result.limit,
            offset: result.offset,
          },
        };
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          'Failed to retrieve audit logs'
        );
      }
    }
  );

  /**
   * Get user activity summary
   * GET /v1/organizations/:id/activity/user/:userId
   */
  app.get<{
    Params: { id: string; userId: string };
    Querystring: { days?: string };
  }>(
    '/v1/organizations/:id/activity/user/:userId',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const currentUserId = req.user!.sub;
      const { id: orgId, userId } = req.params;
      const { days = '7' } = req.query;

      // Verify user is member of organization
      const isMember = await teamManagementService.hasPermission(
        orgId,
        currentUserId,
        TeamRole.VIEWER
      );
      if (!isMember) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'You do not have access to this organization'
        );
      }

      const auditService = getAuditService();
      const summary = auditService.getUserActivitySummary(
        userId,
        parseInt(days, 10)
      );

      return {
        data: {
          userId,
          days: parseInt(days, 10),
          totalActions: summary.totalActions,
          actionsByType: summary.actionsByType,
          successRate: summary.successRate,
          lastAction: summary.lastAction,
        },
      };
    }
  );

  /**
   * Get organization activity summary
   * GET /v1/organizations/:id/activity
   */
  app.get<{
    Params: { id: string };
  }>(
    '/v1/organizations/:id/activity',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;

      // Verify user is admin of organization
      const canView = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canView) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'You do not have permission to view activity'
        );
      }

      const auditService = getAuditService();
      const summary = auditService.getOrganizationActivitySummary(orgId);

      return {
        data: {
          totalActions: summary.totalActions,
          actionsByType: summary.actionsByType,
          topUsers: summary.topUsers,
          failureRate: summary.failureRate,
        },
      };
    }
  );

  /**
   * Get audit statistics
   * GET /v1/organizations/:id/audit-stats
   */
  app.get<{
    Params: { id: string };
    Querystring: { days?: string };
  }>(
    '/v1/organizations/:id/audit-stats',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;
      const { days = '30' } = req.query;

      // Verify user is admin of organization
      const canView = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canView) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'You do not have permission to view statistics'
        );
      }

      const auditService = getAuditService();
      const stats = auditService.getStatistics(parseInt(days, 10));

      return {
        data: {
          days: parseInt(days, 10),
          totalLogs: stats.totalLogs,
          logsPerDay: stats.logsPerDay,
          successRate: stats.successRate,
          topActions: stats.topActions,
        },
      };
    }
  );

  /**
   * Export audit logs as CSV
   * GET /v1/organizations/:id/audit-logs/export
   */
  app.get<{
    Params: { id: string };
    Querystring: {
      action?: string;
      resourceType?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
    };
  }>(
    '/v1/organizations/:id/audit-logs/export',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id: orgId } = req.params;
      const {
        action,
        resourceType,
        status,
        dateFrom,
        dateTo,
      } = req.query;

      // Verify user is admin of organization
      const canView = await teamManagementService.hasPermission(
        orgId,
        userId,
        TeamRole.ADMIN
      );
      if (!canView) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'You do not have permission to export audit logs'
        );
      }

      const auditService = getAuditService();

      try {
        const csv = auditService.exportAsCSV({
          organizationId: orgId,
          action: action ? (action as AuditAction) : undefined,
          resourceType,
          status: status as 'success' | 'failure' | undefined,
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
        });

        // Return as CSV file
        req.reply.header('Content-Type', 'text/csv');
        req.reply.header(
          'Content-Disposition',
          `attachment; filename="audit-logs-${new Date().toISOString()}.csv"`
        );
        return csv;
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          'Failed to export audit logs'
        );
      }
    }
  );

  /**
   * Get audit log detail
   * GET /v1/audit-logs/:logId
   */
  app.get<{
    Params: { logId: string };
  }>(
    '/v1/audit-logs/:logId',
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { logId } = req.params;

      const auditService = getAuditService();
      const result = auditService.getLogs({
        limit: 1,
        offset: 0,
      });

      const log = result.logs.find((l) => l.id === logId);
      if (!log) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Audit log not found');
      }

      // Verify user is admin of the organization (if specified)
      if (log.organizationId) {
        const canView = await teamManagementService.hasPermission(
          log.organizationId,
          userId,
          TeamRole.ADMIN
        );
        if (!canView) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            'You do not have permission to view this log'
          );
        }
      }

      return {
        data: {
          id: log.id,
          timestamp: log.createdAt,
          userId: log.userId,
          action: log.action,
          resourceType: log.resourceType,
          resourceId: log.resourceId,
          organizationId: log.organizationId,
          status: log.status,
          errorMessage: log.errorMessage,
          ipAddress: log.ipAddress,
          userAgent: log.userAgent,
          changes: log.changes,
          metadata: log.metadata,
        },
      };
    }
  );
}
