/**
 * Audit Logging Middleware
 * Automatically logs all state-changing requests (POST, PATCH, DELETE)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAuditService, AuditAction } from '../services/audit.service.js';

/**
 * Parse the route path to determine resource type and action
 */
function getAuditContext(method: string, path: string): { action: AuditAction; resourceType: string; resourceId?: string } | null {
  // Match patterns like /v1/organizations/:id/members/:memberId
  const patterns = [
    { pattern: /\/v1\/organizations\/([^/]+)$/, action: AuditAction.SETTINGS_CHANGED, resourceType: 'organization' },
    { pattern: /\/v1\/organizations\/([^/]+)\/members\/?$/, action: AuditAction.MEMBER_INVITED, resourceType: 'member' },
    { pattern: /\/v1\/organizations\/([^/]+)\/members\/([^/]+)$/, action: AuditAction.MEMBER_ROLE_CHANGED, resourceType: 'member' },
    { pattern: /\/v1\/api-keys\/?$/, action: AuditAction.API_KEY_GENERATED, resourceType: 'api_key' },
    { pattern: /\/v1\/api-keys\/([^/]+)$/, action: AuditAction.API_KEY_REVOKED, resourceType: 'api_key' },
    { pattern: /\/v1\/batch-analysis\/?$/, action: AuditAction.BATCH_CREATED, resourceType: 'batch_job' },
    { pattern: /\/v1\/batch-analysis\/([^/]+)$/, action: AuditAction.BATCH_PROCESSED, resourceType: 'batch_job' },
    { pattern: /\/v1\/evidence\/?$/, action: AuditAction.EVIDENCE_CREATED, resourceType: 'evidence' },
    { pattern: /\/v1\/evidence\/([^/]+)$/, action: AuditAction.EVIDENCE_UPDATED, resourceType: 'evidence' },
    { pattern: /\/v1\/organizations\/([^/]+)\/webhooks\/?$/, action: AuditAction.SETTINGS_CHANGED, resourceType: 'webhook' },
    { pattern: /\/v1\/organizations\/([^/]+)\/webhooks\/([^/]+)$/, action: AuditAction.SETTINGS_CHANGED, resourceType: 'webhook' },
  ];

  for (const { pattern, action, resourceType } of patterns) {
    const match = path.match(pattern);
    if (match) {
      const resourceId = match[1] || match[2];
      return { action, resourceType, resourceId };
    }
  }

  return null;
}

/**
 * Audit middleware for logging state-changing operations
 */
export async function auditMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Only audit state-changing methods
  const stateMethods = ['POST', 'PATCH', 'PUT', 'DELETE'];
  if (!stateMethods.includes(request.method)) {
    return;
  }

  const auditContext = getAuditContext(request.method, request.url);
  if (!auditContext) {
    return; // Skip non-matching routes
  }

  const userId = (request.user as any)?.sub;
  if (!userId) {
    return; // Skip unauthenticated requests
  }

  // Get the original reply.send to intercept the response
  const originalSend = reply.send.bind(reply);

  // Track if we've already sent the response
  let responseSent = false;

  reply.send = function (payload: unknown) {
    if (!responseSent) {
      responseSent = true;

      try {
        const auditService = getAuditService();
        let status = 'success';
        let errorMessage: string | undefined;

        // Check if the response indicates an error
        if (reply.statusCode >= 400) {
          status = 'failure';
          if (typeof payload === 'object' && payload !== null && 'message' in payload) {
            errorMessage = (payload as Record<string, any>).message;
          }
        }

        // Extract changes from request body for updates (as generic object)
        const changes: Record<string, { before: any; after: any }> | undefined = undefined;
        // TODO: Implement differential change tracking if needed

        // Log the audit event
        if (status === 'success') {
          auditService.logEvent(
            userId,
            auditContext.action,
            auditContext.resourceType,
            {
              resourceId: auditContext.resourceId,
              changes,
              ipAddress: request.ip,
              userAgent: request.headers['user-agent'],
              metadata: {
                method: request.method,
                path: request.url,
                statusCode: reply.statusCode,
              },
            }
          );
        } else {
          auditService.logFailure(
            userId,
            auditContext.action,
            auditContext.resourceType,
            errorMessage || 'Operation failed',
            {
              resourceId: auditContext.resourceId,
              ipAddress: request.ip,
              userAgent: request.headers['user-agent'],
              metadata: {
                method: request.method,
                path: request.url,
                statusCode: reply.statusCode,
              },
            }
          );
        }
      } catch (error) {
        // Don't let audit logging errors break the response
        console.error('Failed to log audit event:', error);
      }
    }

    // Call the original send
    return originalSend(payload);
  };
}

