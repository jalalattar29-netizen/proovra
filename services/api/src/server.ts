import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { prisma } from "./db.js";
import { usersRoutes } from "./routes/users.routes.js";
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
import analyticsRoutes from "./routes/analytics.routes.js";
import { adminAuditRoutes } from "./routes/admin-audit.routes.js";
import {
  AppError,
  ErrorCode,
  createErrorResponse,
  isAppError,
} from "./errors.js";

const REQUIRED_ORIGINS = [
  "https://www.proovra.com",
  "https://proovra.com",
  "https://app.proovra.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:8081",
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
  return (
    value === "https://proovra.com" ||
    value === "https://www.proovra.com" ||
    value === "https://app.proovra.com" ||
    value.endsWith(".proovra.com") ||
    value.endsWith(".vercel.app")
  );
}

type GeoContext = {
  country?: string;
  city?: string;
  region?: string;
  colo?: string;
};

function extractGeoContext(req: {
  headers: Record<string, string | string[] | undefined>;
}): GeoContext {
  const getHeader = (name: string) => {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  const country = getHeader("cf-ipcountry");
  const city = getHeader("cf-ipcity");
  const region =
    getHeader("cf-region") ??
    getHeader("cf-region-code") ??
    getHeader("x-vercel-ip-country-region");
  const colo = getHeader("cf-ray");

  const geo: GeoContext = {};

  if (country) geo.country = country;
  if (city) geo.city = city;
  if (region) geo.region = region;
  if (colo) geo.colo = colo;

  return geo;
}

function buildRequestContext(req: {
  id: string;
  method: string;
  url: string;
  user?: { sub?: string };
  evidenceId?: string;
  geo?: GeoContext;
}) {
  const context: Record<string, unknown> = {
    requestId: req.id,
    method: req.method,
    url: req.url,
  };

  if (req.user?.sub) context.userId = req.user.sub;
  if (req.evidenceId) context.evidenceId = req.evidenceId;
  if (req.geo && Object.keys(req.geo).length > 0) context.geo = req.geo;

  return context;
}

function emitOperationalAlert(
  logger: FastifyBaseLogger,
  params: {
    requestId: string;
    reason: string;
    err?: unknown;
    context?: Record<string, unknown>;
  }
) {
  logger.error(
    {
      alert: true,
      severity: "critical",
      requestId: params.requestId,
      reason: params.reason,
      ...(params.context ?? {}),
      ...(params.err ? { err: params.err } : {}),
    },
    "operational.alert"
  );
}

function normalizeUnknownError(err: unknown): AppError | null {
  if (isAppError(err)) {
    return err;
  }

  if (err instanceof ZodError) {
    const firstIssue = err.issues[0];
    return new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Request validation failed",
      firstIssue
        ? {
            field: firstIssue.path.join(".") || undefined,
            reason: firstIssue.message,
            value: "received",
          }
        : undefined
    );
  }

  return null;
}

export async function buildServer() {
  initSentry();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: "api" },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "headers.authorization",
          "headers.cookie",
          "authorization",
          "cookie",
          "token",
          "accessToken",
          "refreshToken",
          "password",
          "secret",
        ],
        censor: "[REDACTED]",
      },
    },
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
  });

  const allowlist = parseCorsOrigins();
  const isProd = process.env.NODE_ENV === "production";
  const allowedWebOrigins = [
    "https://www.proovra.com",
    "https://proovra.com",
    "https://app.proovra.com",
  ];

  await app.register(cors, {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-web-client"],
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);

      const normalized = normalizeOrigin(origin);

      if (allowedWebOrigins.includes(normalized)) return cb(null, true);
      if (isProovraOrigin(normalized)) return cb(null, true);
      if (allowlist.length > 0 && allowlist.includes(normalized)) {
        return cb(null, true);
      }
      if (!isProd) return cb(null, true);

      return cb(null, false);
    },
  });

  await app.register(cookie);

app.addHook("onRequest", async (req, reply) => {
  const requestWithMeta = req as typeof req & {
    startTimeMs?: number;
    geo?: GeoContext;
  };

  requestWithMeta.startTimeMs = Date.now();
  requestWithMeta.geo = extractGeoContext({
    headers: req.headers as Record<string, string | string[] | undefined>,
  });

  const childContext: Record<string, unknown> = { requestId: req.id };
  if (requestWithMeta.geo && Object.keys(requestWithMeta.geo).length > 0) {
    childContext.geo = requestWithMeta.geo;
  }

  req.log = req.log.child(childContext);

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

  app.addHook("onRequest", auditMiddleware);

  app.addHook("onResponse", async (req, reply) => {
    const requestWithMeta = req as typeof req & {
      startTimeMs?: number;
      evidenceId?: string;
      geo?: GeoContext;
    };

    const start = requestWithMeta.startTimeMs;
    const durationMs = typeof start === "number" ? Date.now() - start : null;

    const logContext: Record<string, unknown> = {
      requestId: req.id,
      statusCode: reply.statusCode,
      method: req.method,
      url: req.url,
      durationMs,
    };

    if (req.user?.sub) logContext.userId = req.user.sub;
    if (requestWithMeta.evidenceId) {
      logContext.evidenceId = requestWithMeta.evidenceId;
    }
    if (requestWithMeta.geo && Object.keys(requestWithMeta.geo).length > 0) {
      logContext.geo = requestWithMeta.geo;
    }

    if (reply.statusCode >= 500) {
      req.log.error(logContext, "request.completed.infrastructure_error");
      emitOperationalAlert(req.log, {
        requestId: req.id,
        reason: "api_5xx_response",
        context: logContext,
      });
      return;
    }

    if (reply.statusCode >= 400) {
      req.log.warn(logContext, "request.completed.business_error");
      return;
    }

    req.log.info(logContext, "request.completed");
  });

  app.setErrorHandler((err, req, reply) => {
    const requestWithMeta = req as typeof req & {
      evidenceId?: string;
      geo?: GeoContext;
    };

    const requestContext = buildRequestContext(requestWithMeta);

    const appError = normalizeUnknownError(err);

    if (appError) {
      req.log.warn(
        {
          ...requestContext,
          errorCode: appError.code,
          statusCode: appError.statusCode,
          details: appError.details,
        },
        "request.failed.business"
      );

      const errorResponse = createErrorResponse(
        appError.code,
        req.id,
        appError.details,
        appError.message
      );

      return reply.code(appError.statusCode).send(errorResponse);
    }

    req.log.error(
      {
        ...requestContext,
        err,
      },
      "request.failed.infrastructure"
    );

    captureException(err, requestContext);
    emitOperationalAlert(req.log, {
      requestId: req.id,
      reason: "unhandled_api_error",
      err,
      context: requestContext,
    });

    const errorResponse = createErrorResponse(
      ErrorCode.INTERNAL_SERVER_ERROR,
      req.id
    );

    return reply.code(500).send(errorResponse);
  });

  app.get("/health", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.code(200).send({ ok: true, db: "up" });
    } catch {
      return reply.code(503).send({ ok: false, db: "down" });
    }
  });

  await app.register(authRoutes);
  await app.register(usersRoutes);
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
  await app.register(analyticsRoutes);
  await app.register(adminAuditRoutes);

  return app;
}