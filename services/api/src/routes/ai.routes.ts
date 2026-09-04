import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AI_CHAT_LIMITS, type AiChatAbuseReason } from "@proovra/shared";
import { requireAuth } from "../middleware/auth.js";
import { trustedClientIpKey } from "../middleware/client-ip.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { AppError, ErrorCode } from "../errors.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { createAiProvider } from "../services/ai/ai-provider.js";
import { AiCostGuard } from "../services/ai/ai-cost-guard.js";
import { AiChatService } from "../services/ai/ai-chat.service.js";
import { AiCaptureService } from "../services/ai/ai-capture.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
import {
  answerProductKnowledge,
  listGroundedTopicIds,
} from "../services/ai/proovra-product-knowledge.js";
import {
  evaluateWorkspaceAiPolicy,
  isOperatorCapabilityGap,
} from "../services/ai/workspace-ai-policy.service.js";
import { enforceAiEndpointGuard } from "../services/ai/ai-rate-limit.service.js";
import {
  buildPrismaLedgerStore,
  reconcileAiUsage,
  releaseAiReservation,
  tryReserveAiBudget,
} from "../services/ai/ai-usage-ledger.service.js";
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
    /** The authoritative Workspace (teamId) this AI action ran under —
     * from the resolved commercial-context scope, never the request. */
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  const outcome =
    params.outcome === "blocked"
      ? "denied"
      : params.outcome === "failure"
        ? "error"
        : "success";

  const denialReason =
    outcome !== "success"
      ? (typeof params.metadata?.status === "string" ? params.metadata.status : params.action)
      : null;

  void emitTenantAudit({
    action: params.action,
    outcome,
    denialReason,
    sourceApp: "API",
    actorUserId: params.userId,
    workspaceId: params.workspaceId ?? null,
    resourceType: "evidence_ai",
    resourceId: params.resourceId ?? null,
    correlationId: req.id ?? null,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
      ipAddress: req.ip,
      userAgent: readUserAgent(req),
    },
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

// Phase B2 — CaptureItemReviewBody removed with the analyze-item endpoint.

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
  /*
   * WHAT THE ASSISTANT CAN DO, ASKED BEFORE ANYTHING IS TYPED.
   *
   * Until this existed the panel had exactly one way to discover its own
   * state: send a question and interpret the failure. A workspace that had
   * deliberately turned the assistant off looked identical to an outage,
   * because both arrived as a rejected POST — which is how a policy decision
   * came to be reported to users as "AI assistant currently unavailable".
   *
   * This endpoint answers the question directly. It is a read of state the
   * caller is already subject to: the same evaluator the chat route runs,
   * for the same workspace, so the panel cannot describe itself as available
   * and then be refused, or describe itself as dead while still answering.
   *
   * It deliberately returns the DECISION, not the reason string. The decision
   * is a bounded enum the UI can map to its own copy in the user's language;
   * the reason is operator prose and belongs in logs.
   */
  app.get(
    "/v1/ai/availability",
    { preHandler: [requireAuthAndLegal] },
    async (req) => {
      const userId = getAuthUserId(req);
      const aiScope = (await resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId })).scope;
      const policy = await evaluateWorkspaceAiPolicy({
        teamId: aiScope.teamId,
        feature: "SUPPORT_CHAT",
        dataClass: "METADATA",
      });

      /*
       * Grounded topics survive an operator capability gap but not a workspace
       * opt-out — the same rule the chat route applies, stated once here so the
       * panel's promise and the route's behaviour cannot drift apart.
       */

      return {
        data: {
          available: policy.allowed,
          decision: policy.decision,
          /** True when questions about the product are still answerable. */
          groundedAnswersAvailable:
            policy.allowed || isOperatorCapabilityGap(policy.decision),
          groundedTopics: listGroundedTopicIds(),
          policyVersion: policy.policyVersion,
        },
      };
    },
  );

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
        // PHASE 13 §1 (NEW-022) — SECURITY_BOUND: key on the canonical resolved
        // client, not raw `req.ip`, so a forwarded header cannot mint buckets.
        key: `ratelimit:ai-chat:ip:${trustedClientIpKey(req)}`,
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
      // §9.7 — explicit PERSONAL_ACCOUNT subject via the canonical envelope.
      const aiScope = (await resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId })).scope;
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

      // Phase A2 — canonical workspace AI policy gate (fail-closed).
      // A workspace master/feature disable prevents the provider call here,
      // in the backend, before any AI runs. UI-only disabling is not relied on.
      const chatPolicy = await evaluateWorkspaceAiPolicy({
        teamId: aiScope.teamId,
        feature: "SUPPORT_CHAT",
        dataClass: "METADATA",
      });
      if (!chatPolicy.allowed) {
        /*
         * A DENIAL IS NOT ONE THING, and the difference matters here.
         *
         * Two of these decisions say the OPERATOR has not configured provider
         * AI: the platform flag is off (GLOBAL_DISABLED) or no key is present
         * (PROVIDER_NOT_CONFIGURED). The rest say something about THIS
         * workspace, plan or role — the customer turned the assistant off, or
         * is not entitled to it, or this data class may not be sent.
         *
         * The deterministic answers below are product documentation compiled
         * into this build. They call no model and send nothing outbound, so an
         * operator not having configured OpenAI is no reason to withhold them:
         * refusing to say "Capture stages an item, then Review & Sign finalizes
         * it" because a provider key is absent tells the user the product has
         * no documentation, which is false.
         *
         * A workspace opt-out is the opposite case and is honoured completely.
         * If a customer disabled the assistant, or their plan does not include
         * it, or their role may not use it, they get the denial — never a
         * consolation answer that makes an opt-out look partially ignored.
         */
        const grounded = isOperatorCapabilityGap(chatPolicy.decision)
          ? answerProductKnowledge(body.messages)
          : null;

        if (grounded) {
          auditAiAction(req, {
            userId,
            action: "ai.chat_request",
            outcome: "success",
            severity: "info",
            workspaceId: aiScope.teamId ?? null,
            metadata: {
              messageCount: body.messages.length,
              pageContext: body.pageContext ?? null,
              status: grounded.status,
              // The distinguishing fact: answered from the compiled bundle
              // with no provider involved. Without this an operator reading
              // the log could not tell these apart from model answers.
              source: "product_knowledge",
              policyDecision: chatPolicy.decision,
            },
          });
          return { data: grounded };
        }

        return reply.code(403).send({
          code: "AI_WORKSPACE_POLICY_DENIED",
          message: chatPolicy.reason,
          decision: chatPolicy.decision,
          // Repeated under `details` because that is the only part of a flat
          // (unnested) error body the web transport preserves. The top-level
          // field stays for existing consumers; without this copy the UI
          // receives the denial with no way to tell WHICH denial it was, and
          // every policy decision collapses into one generic message — which
          // is precisely how an opt-out came to be shown as an outage.
          details: { decision: chatPolicy.decision },
        });
      }

      // Phase F-1 — deterministic short-circuits (burst guard / product
      // knowledge / domain refusal) never reach the provider and therefore
      // never reserve durable budget. Only the provider path goes through
      // the canonical ledger: reserve → provider → reconcile (release on
      // failure) — the exact flow the Copilots use.
      let result: Awaited<ReturnType<typeof aiChatService.analyzeChat>>;
      const preflight = aiChatService.preflight(userId, body);
      if (preflight) {
        result = preflight;
      } else {
        const ledger = await tryReserveAiBudget({
          teamId: aiScope.teamId,
          userId,
          feature: "SUPPORT_CHAT",
          model: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
          requestId: `chat:${userId}:${Date.now()}`,
          estimatedCostUsdMicros: 100_000n,
        });
        if (ledger.decision && !ledger.decision.allowed && ledger.decision.code !== "DUPLICATE_REQUEST") {
          return reply.code(429).send({
            code: `AI_BUDGET_${ledger.decision.code}`,
            message: "The workspace AI budget or operation limit has been reached.",
          });
        }
        try {
          result = await withAiTimeout(
            aiChatService.runProviderChat(userId, body),
            AI_CHAT_LIMITS.REQUEST_TIMEOUT_MS,
          );
        } catch (err) {
          if (ledger.reservationId) {
            await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
          }
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
        if (ledger.reservationId) {
          await reconcileAiUsage(buildPrismaLedgerStore(), ledger.reservationId, null).catch(() => undefined);
        }
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
        workspaceId: aiScope.teamId ?? null,
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

      /*
       * Only a real PROVIDER operation counts toward the monthly plan cap.
       *
       * Failure and block paths never consumed, but deterministic
       * short-circuits did: a grounded product answer returns status "ok", so
       * "how do I capture evidence?" — answered from knowledge compiled into
       * this build, with no outbound call — spent one of the month's AI
       * operations.
       *
       * The durable cost ledger already excludes these by design; the Phase
       * F-1 note above says deterministic short-circuits "never reserve
       * durable budget". Two counters existed, one honouring that intent and
       * one not. This is the second one catching up, not a policy change.
       */
      if (result.status === "ok" && !preflight) {
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

      // Phase A8 — rate limit + dedup before any expensive work.
      const sGuard = await enforceAiEndpointGuard({
        feature: "capture-session",
        userId,
        ip: req.ip,
        dedupeKey: body.collectionPlan.id,
      });
      if (!sGuard.allowed) {
        reply.header("Retry-After", String(sGuard.retryAfterSec));
        return reply.code(429).send({ code: sGuard.code, message: "Too many AI requests; please slow down." });
      }

      // Pricing-hardening: plan-aware monthly AI cap.
      // §9.7 — explicit PERSONAL_ACCOUNT subject via the canonical envelope.
      const aiScope = (await resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId })).scope;
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

      // Phase A2 — canonical workspace AI policy gate (fail-closed).
      const sessionPolicy = await evaluateWorkspaceAiPolicy({
        teamId: aiScope.teamId,
        feature: "CAPTURE_ASSISTANCE",
        dataClass: "METADATA",
      });
      if (!sessionPolicy.allowed) {
        return reply.code(403).send({
          code: "AI_WORKSPACE_POLICY_DENIED",
          message: sessionPolicy.reason,
          decision: sessionPolicy.decision,
        });
      }

      // Phase F-1 — canonical durable ledger around the provider call
      // (reserve → provider → reconcile; release on failure/blocked).
      const ledger = await tryReserveAiBudget({
        teamId: aiScope.teamId,
        userId,
        feature: "CAPTURE_ASSISTANCE",
        model: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
        requestId: `capture:${body.collectionPlan.id}:${Date.now()}`,
        estimatedCostUsdMicros: 100_000n,
      });
      if (ledger.decision && !ledger.decision.allowed && ledger.decision.code !== "DUPLICATE_REQUEST") {
        return reply.code(429).send({
          code: `AI_BUDGET_${ledger.decision.code}`,
          message: "The workspace AI budget or operation limit has been reached.",
        });
      }
      let result: Awaited<ReturnType<typeof aiCaptureService.analyzeSession>>;
      try {
        result = await aiCaptureService.analyzeSession(userId, body);
      } catch (err) {
        if (ledger.reservationId) {
          await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
        }
        throw err;
      }
      if (ledger.reservationId) {
        // A "blocked" result short-circuited before the provider — release
        // the reservation instead of charging it.
        if (result.status === "blocked") {
          await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
        } else {
          await reconcileAiUsage(buildPrismaLedgerStore(), ledger.reservationId, null).catch(() => undefined);
        }
      }
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
        workspaceId: aiScope.teamId ?? null,
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

  // Phase B2 — the per-item review endpoint (`POST /v1/ai/capture/analyze-item`)
  // was fully implemented but had NO frontend caller and no test coverage, and
  // its value is already covered by analyze-session (which flags every item in
  // the session). Per the B2 decision it is removed rather than left as an
  // unreachable authenticated surface. The service method + its item-only
  // helpers are removed from ai-capture.service.ts in the same change.
}