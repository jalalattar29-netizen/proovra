import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { AppError, ErrorCode } from "../errors.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { createAiProvider } from "../services/ai/ai-provider.js";
import { AiCostGuard } from "../services/ai/ai-cost-guard.js";
import { AiChatService } from "../services/ai/ai-chat.service.js";
import { AiCaptureService } from "../services/ai/ai-capture.service.js";

const aiProvider = createAiProvider();
const aiCostGuard = new AiCostGuard();
const aiChatService = new AiChatService(aiProvider, aiCostGuard);
const aiCaptureService = new AiCaptureService(aiProvider, aiCostGuard);

type AuthUser = {
  sub: string;
};

function getAuthUserId(req: FastifyRequest): string {
  const user = (req as FastifyRequest & { user?: AuthUser }).user;

  if (!user?.sub) {
    throw new AppError(ErrorCode.UNAUTHORIZED, "Authentication required");
  }

  return user.sub;
}

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

function auditAiAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "ai",
    severity: params.severity ?? "info",
    source: "api_ai",
    outcome: params.outcome ?? "success",
    resourceType: "evidence_ai",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireAiAnalytics(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: "evidence_ai",
    entityId: params.entityId ?? null,
    severity: "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

const ChatRequestBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(5000),
      })
    )
    .min(1)
    .max(20),
  pageContext: z
    .object({
      path: z.string().trim().max(256).optional(),
      title: z.string().trim().max(256).optional(),
    })
    .optional(),
});

const CaptureSessionItemSchema = z.object({
  id: z.string().min(1).max(120),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(128),
  sizeBytes: z.number().int().min(0).max(5 * 1024 * 1024 * 1024),
  checklistStepId: z.string().trim().min(1).max(120).nullable().optional(),
  role: z.string().trim().max(120).optional(),
  sourceLabel: z.string().trim().max(120).optional(),
  clientSignals: z
    .object({
      duplicateStatus: z.enum(["none", "warning", "duplicate"]).optional(),
      screenshotLike: z.boolean().optional(),
      genericMime: z.boolean().optional(),
      oldLastModified: z.boolean().optional(),
      folderPathPresent: z.boolean().optional(),
      locationIncluded: z.boolean().optional(),
    })
    .optional(),
});

const CapturePlanStepSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1000),
  purposeLabel: z
    .string()
    .max(300)
    .optional()
    .transform((value) =>
      typeof value === "string" && value.trim()
        ? value.trim()
        : "Evidence requirement"
    ),
  required: z.boolean(),
  acceptedKinds: z.array(z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"])).optional(),
});

const CaptureCollectionPlanSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1000),
  locationRequirement: z.enum(["optional", "recommended", "required"]),
  steps: z.array(CapturePlanStepSchema).min(1).max(20),
});

const CaptureSessionReviewBody = z.object({
  collectionPlan: CaptureCollectionPlanSchema,
  planMode: z.enum(["FLEXIBLE", "CHECKLIST_REQUIRED"]),
  useLocation: z.boolean(),
  items: z.array(CaptureSessionItemSchema).max(100),
});

const CaptureItemReviewBody = z.object({
  collectionPlan: CaptureCollectionPlanSchema,
  planMode: z.enum(["FLEXIBLE", "CHECKLIST_REQUIRED"]),
  useLocation: z.boolean(),
  item: CaptureSessionItemSchema,
  selectedStep: CapturePlanStepSchema,
});

export async function aiRoutes(app: FastifyInstance) {
  app.post(
    "/v1/ai/chat",
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);
      const body = ChatRequestBody.parse(req.body);

      const result = await aiChatService.analyzeChat(userId, body);

      auditAiAction(req, {
        userId,
        action: "ai.chat_request",
        outcome:
          result.status === "ok"
            ? "success"
            : result.status === "blocked"
              ? "blocked"
              : "failure",
        severity:
          result.status === "error" || result.status === "blocked"
            ? "warning"
            : "info",
        metadata: {
          messageCount: body.messages.length,
          pageContext: body.pageContext ?? null,
          status: result.status,
        },
      });

      fireAiAnalytics({
        eventType: "ai_chat_request",
        userId,
        req,
        metadata: { status: result.status },
      });

      return { data: result };
    }
  );

  app.post(
    "/v1/ai/capture/analyze-session",
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);
      const body = CaptureSessionReviewBody.parse(req.body);

      const result = await aiCaptureService.analyzeSession(userId, body);

      auditAiAction(req, {
        userId,
        action: "ai.capture_session_review",
        outcome:
          result.status === "ok"
            ? "success"
            : result.status === "blocked"
              ? "blocked"
              : "failure",
        severity: result.status === "blocked" ? "warning" : "info",
        resourceId: body.collectionPlan.id,
        metadata: {
          itemCount: body.items.length,
          status: result.status,
        },
      });

      fireAiAnalytics({
        eventType: "ai_capture_session_review",
        userId,
        req,
        entityId: body.collectionPlan.id,
        metadata: { status: result.status },
      });

      return { data: result };
    }
  );

  app.post(
    "/v1/ai/capture/analyze-item",
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);
      const body = CaptureItemReviewBody.parse(req.body);

      const result = await aiCaptureService.analyzeItem(userId, body);

      auditAiAction(req, {
        userId,
        action: "ai.capture_item_review",
        outcome:
          result.status === "ok"
            ? "success"
            : result.status === "blocked"
              ? "blocked"
              : "failure",
        severity: result.status === "blocked" ? "warning" : "info",
        resourceId: body.collectionPlan.id,
        metadata: {
          itemId: body.item.id,
          status: result.status,
        },
      });

      fireAiAnalytics({
        eventType: "ai_capture_item_review",
        userId,
        req,
        entityId: body.collectionPlan.id,
        metadata: { status: result.status },
      });

      return { data: result };
    }
  );
}