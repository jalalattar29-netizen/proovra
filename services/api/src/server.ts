import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { prisma } from "./db.js";
import { captureException, initSentry } from "./observability/sentry.js";
import { auditMiddleware } from "./middleware/audit.middleware.js";
import { evidenceRoutes } from "./routes/evidence.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { teamsRoutes } from "./routes/teams.routes.js";
import { billingRoutes } from "./routes/billing.routes.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { casesRoutes } from "./routes/cases.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { aiRoutes } from "./routes/ai.routes.js";
import { enterpriseRoutes } from "./routes/enterprise.routes.js";
import { teamManagementRoutes } from "./routes/team-management.routes.js";
import { webhookRoutes } from "./routes/webhook.routes.js";
import { auditRoutes } from "./routes/audit.routes.js";
import { AppError, isAppError, createErrorResponse } from "./errors.js";

const REQUIRED_ORIGINS = [
  "https://www.proovra.com",
  "https://proovra.com",
  "https://app.proovra.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:8081"
];

function normalizeOrigin(origin: string) {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

function parseCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS ?? "";
  const parsed = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const merged = [...parsed, ...REQUIRED_ORIGINS];
  return Array.from(new Set(merged.map(normalizeOrigin)));
}

function isProovraOrigin(origin: string) {
  const value = normalizeOrigin(origin);
  // Allow all proovra.com domains + Vercel preview deployments
  return (
    value === "https://proovra.com" ||
    value.endsWith(".proovra.com") ||
    value.endsWith(".vercel.app")
  );
}

export async function buildServer() {
  initSentry();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
  });

  const allowlist = parseCorsOrigins();
  const isProd = process.env.NODE_ENV === "production";
  await app.register(cors, {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-web-client"],
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowlist.length === 0) {
        return cb(null, !isProd);
      }
      const normalized = normalizeOrigin(origin);
      if (isProovraOrigin(normalized)) return cb(null, true);
      return cb(null, allowlist.includes(normalized));
    },
  });

  await app.register(cookie);

  app.addHook("onRequest", async (req, reply) => {
    (req as typeof req & { startTimeMs?: number }).startTimeMs = Date.now();
    req.log = req.log.child({ requestId: req.id });
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header("permissions-policy", "geolocation=(self)");
    if (process.env.NODE_ENV === "production") {
      reply.header(
        "strict-transport-security",
        "max-age=63072000; includeSubDomains; preload"
      );
    }
  });

  // Add audit logging middleware for state-changing requests
  app.addHook("onRequest", auditMiddleware);

  app.addHook("onResponse", async (req, reply) => {
    const start = (req as typeof req & { startTimeMs?: number }).startTimeMs;
    const durationMs = typeof start === "number" ? Date.now() - start : null;
    const logContext: Record<string, unknown> = {
      requestId: req.id,
      statusCode: reply.statusCode,
      method: req.method,
      url: req.url,
      durationMs,
    };
    if (req.user?.sub) logContext.userId = req.user.sub;
    if ((req as typeof req & { evidenceId?: string }).evidenceId) {
      logContext.evidenceId = (req as typeof req & { evidenceId?: string })
        .evidenceId;
    }
    req.log.info(logContext, "request.completed");
  });

  app.setErrorHandler((err, req, reply) => {
    const context: Record<string, unknown> = {
      requestId: req.id,
      method: req.method,
      url: req.url,
    };
    if (req.user?.sub) context.userId = req.user.sub;
    if ((req as typeof req & { evidenceId?: string }).evidenceId) {
      context.evidenceId = (req as typeof req & { evidenceId?: string })
        .evidenceId;
    }

    // Handle AppError with structured response
    if (isAppError(err)) {
      captureException(err, { ...context, errorCode: err.code });
      req.log.warn({ ...context, errorCode: err.code }, "request.app_error");
      
      const errorResponse = createErrorResponse(
        err.code,
        req.id,
        err.details,
        err.message
      );
      
      reply.code(err.statusCode).send(errorResponse);
      return;
    }

    // Handle other errors
    captureException(err, context);
    req.log.error(context, "request.failed");

    // Send generic error response
    const errorResponse = createErrorResponse(
      "INTERNAL_SERVER_ERROR" as any,
      req.id
    );
    
    reply.code(500).send(errorResponse);
  });

  app.get("/health", async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: "up" };
    } catch {
      return { ok: true, db: "down" };
    }
  });

  await app.register(authRoutes);
  await app.register(teamsRoutes);
  await app.register(billingRoutes);
  await app.register(webhooksRoutes, { prefix: "/webhooks" });
  await app.register(casesRoutes);
  await app.register(evidenceRoutes);
  await app.register(searchRoutes);
  await app.register(aiRoutes);
  await app.register(enterpriseRoutes);
  await app.register(teamManagementRoutes);
  await app.register(webhookRoutes);
  await app.register(auditRoutes);

  return app;
}
