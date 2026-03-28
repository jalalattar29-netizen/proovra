import type { FastifyReply, FastifyRequest } from "fastify";
import { getAuditService, AuditAction } from "../services/audit.service.js";

function getAuditContext(
  method: string,
  path: string
): { action: AuditAction; resourceType: string; resourceId?: string } | null {
  const patterns = [
    {
      pattern: /\/v1\/organizations\/([^/]+)$/,
      action: AuditAction.SETTINGS_CHANGED,
      resourceType: "organization",
    },
    {
      pattern: /\/v1\/organizations\/([^/]+)\/members\/?$/,
      action: AuditAction.MEMBER_INVITED,
      resourceType: "member",
    },
    {
      pattern: /\/v1\/organizations\/([^/]+)\/members\/([^/]+)$/,
      action: AuditAction.MEMBER_ROLE_CHANGED,
      resourceType: "member",
    },
    {
      pattern: /\/v1\/api-keys\/?$/,
      action: AuditAction.API_KEY_GENERATED,
      resourceType: "api_key",
    },
    {
      pattern: /\/v1\/api-keys\/([^/]+)$/,
      action: AuditAction.API_KEY_REVOKED,
      resourceType: "api_key",
    },
    {
      pattern: /\/v1\/batch-analysis\/?$/,
      action: AuditAction.BATCH_CREATED,
      resourceType: "batch_job",
    },
    {
      pattern: /\/v1\/batch-analysis\/([^/]+)$/,
      action: AuditAction.BATCH_PROCESSED,
      resourceType: "batch_job",
    },
    {
      pattern: /\/v1\/evidence\/?$/,
      action: AuditAction.EVIDENCE_CREATED,
      resourceType: "evidence",
    },
    {
      pattern: /\/v1\/evidence\/([^/]+)$/,
      action: AuditAction.EVIDENCE_UPDATED,
      resourceType: "evidence",
    },
    {
      pattern: /\/v1\/organizations\/([^/]+)\/webhooks\/?$/,
      action: AuditAction.SETTINGS_CHANGED,
      resourceType: "webhook",
    },
    {
      pattern: /\/v1\/organizations\/([^/]+)\/webhooks\/([^/]+)$/,
      action: AuditAction.SETTINGS_CHANGED,
      resourceType: "webhook",
    },
  ];

  for (const { pattern, action, resourceType } of patterns) {
    const match = path.match(pattern);
    if (match) {
      const resourceId = match[2] ?? match[1];
      return { action, resourceType, resourceId };
    }
  }

  return null;
}

export async function auditMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const stateMethods = ["POST", "PATCH", "PUT", "DELETE"];
  if (!stateMethods.includes(request.method)) {
    return;
  }

  const auditContext = getAuditContext(request.method, request.url);
  if (!auditContext) {
    return;
  }

  const userId = (request.user as { sub?: string } | undefined)?.sub;
  if (!userId) {
    return;
  }

  const originalSend = reply.send.bind(reply);
  let responseSent = false;

  reply.send = function (payload: unknown) {
    if (!responseSent) {
      responseSent = true;

      try {
        const auditService = getAuditService();
        const failed = reply.statusCode >= 400;
        const errorMessage =
          failed &&
          typeof payload === "object" &&
          payload !== null &&
          "message" in payload
            ? String((payload as Record<string, unknown>).message ?? "Operation failed")
            : undefined;

        if (!failed) {
          auditService.logEvent(
            userId,
            auditContext.action,
            auditContext.resourceType,
            {
              resourceId: auditContext.resourceId,
              ipAddress: request.ip,
              userAgent: request.headers["user-agent"],
              metadata: {
                method: request.method,
                path: request.url,
                statusCode: reply.statusCode,
                requestId: request.id,
              },
            }
          );
        } else {
          auditService.logFailure(
            userId,
            auditContext.action,
            auditContext.resourceType,
            errorMessage || "Operation failed",
            {
              resourceId: auditContext.resourceId,
              ipAddress: request.ip,
              userAgent: request.headers["user-agent"],
              metadata: {
                method: request.method,
                path: request.url,
                statusCode: reply.statusCode,
                requestId: request.id,
              },
            }
          );
        }
      } catch (error) {
        request.log.warn(
          {
            requestId: request.id,
            errorMessage:
              error instanceof Error ? error.message : "Audit logging failed",
          },
          "audit.log_failed"
        );
      }
    }

    return originalSend(payload);
  };
}