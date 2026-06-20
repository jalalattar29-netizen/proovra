import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AI_CHAT_LIMITS, type AiChatAbuseReason } from "@proovra/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { AppError, ErrorCode } from "../errors.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { createAiProvider } from "../services/ai/ai-provider.js";
import { AiCostGuard } from "../services/ai/ai-cost-guard.js";
import { AiChatService } from "../services/ai/ai-chat.service.js";
import { AiCaptureService } from "../services/ai/ai-capture.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { getPersonalWorkspaceScope } from "../services/workspace-billing.service.js";
import {
  assertWorkspaceAllowsAiOperation,
  recordWorkspaceAiOperation,
} from "../services/billing-enforcement.service.js";

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

/**
 * Phase A3 — Hardened AI chat abuse-resistance helpers.
 */
async function bumpAiChatMetric(
  name:
    | "ai_chat_rate_limited_total"
    | "ai_chat_rejected_total"
    | "ai_chat_timeout_total",
): Promise<void> {
  try {
    const mod = await import("@proovra/shared-runtime/ops");
    mod.bump(name);
  } catch {
    /* metrics are best-effort */
  }
}

function emitAiChatAbuseSignal(
  req: FastifyRequest,
  userId: string,
  reason: AiChatAbuseReason,
): void {
  // Bounded; never the prompt text.
  safeEmitSecurityEvent({
    teamId: null,
    eventType: "ai_chat_abuse_signal",
    severity: reason === "cost_guard_exceeded" ? "WARNING" : "INFO",
    details: {
      reason,
      userId,
      ipPrefix: req.ip ? req.ip.split(".").slice(0, 3).join(".") + ".x" : null,
    },
  });
}

/**
 * Phase A3 — Hard timeout wrapper for the upstream AI call. Returns
 * a rejected promise on timeout so the route handler can translate
 * it into a typed 504 + ai_chat_timeout_total bump. Never lets a
 * hung provider turn the AI surface into an operational dependency
 * for capture / report / verify.
 */
async function withAiTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("AI_REQUEST_TIMEOUT"));
      }, ms);
      promise.then(
        (value) => resolve(value),
        (err) => reject(err),
      );
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function aiRoutes(app: FastifyInstance) {
  app.post(
    "/v1/ai/chat",
    { preHandler: [requireAuthAndLegal] },
    async (req, reply) => {
      const userId = getAuthUserId(req);

      // Phase A3 — Per-user rate limit BEFORE the cost guard. The
      // cost guard enforces a daily cap; this enforces a
      // minute-scale burst cap so a single user cannot exhaust the
      // daily quota in seconds. Per-IP is a defense-in-depth fallback
      // for credential stuffing across multiple compromised accounts.
      const userRate = await enforceRateLimit({
        key: `ratelimit:ai-chat:user:${userId}`,
        max: AI_CHAT_LIMITS.RATE_LIMIT_USER_PER_MIN,
        windowSec: 60,
      });
      if (!userRate.allowed) {
        await bumpAiChatMetric("ai_chat_rate_limited_total");
        emitAiChatAbuseSignal(req, userId, "rate_limited_user");
        const retryAfter = Math.max(
          1,
          Math.ceil((userRate.resetAtMs - Date.now()) / 1000),
        );
        reply.header("Retry-After", String(retryAfter));
        return reply
          .code(429)
          .send({
            code: "AI_CHAT_RATE_LIMITED",
            message: "Too many AI chat requests. Please slow down.",
          });
      }

      const ipRate = await enforceRateLimit({
        key: `ratelimit:ai-chat:ip:${req.ip}`,
        max: AI_CHAT_LIMITS.RATE_LIMIT_IP_PER_MIN,
        windowSec: 60,
      });
      if (!ipRate.allowed) {
        await bumpAiChatMetric("ai_chat_rate_limited_total");
        emitAiChatAbuseSignal(req, userId, "rate_limited_ip");
        const retryAfter = Math.max(
          1,
          Math.ceil((ipRate.resetAtMs - Date.now()) / 1000),
        );
        reply.header("Retry-After", String(retryAfter));
        return reply
          .code(429)
          .send({
            code: "AI_CHAT_RATE_LIMITED",
            message: "Too many AI chat requests. Please slow down.",
          });
      }

      let body: z.infer<typeof ChatRequestBody>;
      try {
        body = ChatRequestBody.parse(req.body);
      } catch (err) {
        await bumpAiChatMetric("ai_chat_rejected_total");
        emitAiChatAbuseSignal(req, userId, "payload_too_large");
        if (err instanceof z.ZodError) {
          throw err;
        }
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Invalid AI chat payload",
        );
      }

      // Phase A3 — bounded timeout. The cost guard cannot save us
      // from a provider that simply never responds; this does.
      // Pricing-hardening: plan-aware monthly AI cap. Throws
      // AI_MONTHLY_LIMIT_REACHED (429) when over cap. ENTERPRISE skips.
      const aiScope = await getPersonalWorkspaceScope(userId);
      try {
        await assertWorkspaceAllowsAiOperation(aiScope);
      } catch (err) {
        const code =
          (err as { code?: string }).code ?? "AI_MONTHLY_LIMIT_REACHED";
        const status = (err as { statusCode?: number }).statusCode ?? 429;
        return reply.code(status).send({
          code,
          message:
            (err as Error).message ??
            "Monthly AI advisory limit reached for current plan",
        });
      }

      let result: Awaited<ReturnType<typeof aiChatService.analyzeChat>>;
      try {
        result = await withAiTimeout(
          aiChatService.analyzeChat(userId, body),
          AI_CHAT_LIMITS.REQUEST_TIMEOUT_MS,
        );
      } catch (err) {
        const isTimeout =
          err instanceof Error && err.message === "AI_REQUEST_TIMEOUT";
        if (isTimeout) {
          await bumpAiChatMetric("ai_chat_timeout_total");
          emitAiChatAbuseSignal(req, userId, "timeout");
          // AI failure NEVER cascades into the rest of the system.
          // We return an advisory error and let the UI surface it as
          // "AI temporarily unavailable" — capture / report / verify
          // flows remain unaffected.
          return reply.code(504).send({
            code: "AI_CHAT_TIMEOUT",
            message:
              "AI assistant timed out. Try again in a moment. Evidence workflows are unaffected.",
          });
        }
        throw err;
      }

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

      if (result.status === "blocked") {
        // The cost guard refused — count it as an abuse signal at
        // INFO severity so dashboards can spot a user repeatedly
        // hitting the daily ceiling.
        emitAiChatAbuseSignal(req, userId, "cost_guard_exceeded");
      }

      // Pricing-hardening: only successful operations count toward the
      // plan's monthly cap. Failure / block paths do not consume.
      if (result.status === "ok") {
        try {
          await recordWorkspaceAiOperation(aiScope);
        } catch {
          // Counter failures must not surface to the user — log and
          // move on; over-charging a user is worse than under-counting.
        }
      }

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
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = CaptureSessionReviewBody.parse(req.body);

      // Pricing-hardening: plan-aware monthly AI cap.
      const aiScope = await getPersonalWorkspaceScope(userId);
      try {
        await assertWorkspaceAllowsAiOperation(aiScope);
      } catch (err) {
        const code =
          (err as { code?: string }).code ?? "AI_MONTHLY_LIMIT_REACHED";
        const status = (err as { statusCode?: number }).statusCode ?? 429;
        return reply.code(status).send({
          code,
          message:
            (err as Error).message ??
            "Monthly AI advisory limit reached for current plan",
        });
      }

      const result = await aiCaptureService.analyzeSession(userId, body);
      if (result.status === "ok") {
        try {
          await recordWorkspaceAiOperation(aiScope);
        } catch {
          /* see chat handler comment */
        }
      }

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
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = CaptureItemReviewBody.parse(req.body);

      // Pricing-hardening: plan-aware monthly AI cap.
      const aiScope = await getPersonalWorkspaceScope(userId);
      try {
        await assertWorkspaceAllowsAiOperation(aiScope);
      } catch (err) {
        const code =
          (err as { code?: string }).code ?? "AI_MONTHLY_LIMIT_REACHED";
        const status = (err as { statusCode?: number }).statusCode ?? 429;
        return reply.code(status).send({
          code,
          message:
            (err as Error).message ??
            "Monthly AI advisory limit reached for current plan",
        });
      }

      const result = await aiCaptureService.analyzeItem(userId, body);
      if (result.status === "ok") {
        try {
          await recordWorkspaceAiOperation(aiScope);
        } catch {
          /* see chat handler comment */
        }
      }

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