import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { demoRequestsRoutes } from "./routes/demo-requests.routes.js";
import { adminDemoRequestsRoutes } from "./routes/admin-demo-requests.routes.js";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { prisma } from "./db.js";
import { usersRoutes } from "./routes/users.routes.js";
import { captureException, initSentry } from "./observability/sentry.js";
import { auditMiddleware } from "./middleware/audit.middleware.js";
import { evidenceRoutes } from "./routes/evidence.routes.js";
import { captureRoutes } from "./routes/capture.routes.js";
import { bootstrapObjectLockVerification } from "./bootstrap/object-lock-verification.js";
import { authRoutes } from "./routes/auth.routes.js";
import { teamsRoutes } from "./routes/teams.routes.js";
import { billingRoutes } from "./routes/billing.routes.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { casesRoutes } from "./routes/cases.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { reviewerOpsRoutes } from "./routes/reviewer-ops.routes.js";
import { externalReviewRoutes } from "./routes/external-review.routes.js";
import { uploadSessionsRoutes } from "./routes/upload-sessions.routes.js";
import { integrationsUploadsRoutes } from "./routes/integrations-uploads.routes.js";
import { mediaIntelligenceRoutes } from "./routes/media-intelligence.routes.js";
import { graphRoutes } from "./routes/graph.routes.js";
import {
  adminIdentityRoutes,
  adminIdentityRuntimeRoutes,
} from "./routes/admin-identity.routes.js";
import { scimRoutes } from "./routes/scim.routes.js";
import { ssoAuthRoutes } from "./routes/sso-auth.routes.js";
import { aiRoutes } from "./routes/ai.routes.js";
import { enterpriseRoutes } from "./routes/enterprise.routes.js";
import { teamManagementRoutes } from "./routes/team-management.routes.js";
import { webhookRoutes } from "./routes/webhook.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import { adminAuditRoutes } from "./routes/admin-audit.routes.js";
import { workflowRoutes } from "./routes/workflow.routes.js";
import { workflowIntakeLinksRoutes } from "./routes/workflow-intake-links.routes.js";
import { externalIntakeRoutes } from "./routes/external-intake.routes.js";
import { evidenceRequestsRoutes } from "./routes/evidence-requests.routes.js";
import { notificationsRoutes } from "./routes/notifications.routes.js";
import { governanceRoutes } from "./routes/governance.routes.js";
import { governanceLifecycleRoutes } from "./routes/governance-lifecycle.routes.js";
import { governanceOperationsRoutes } from "./routes/governance-operations.routes.js";
import { integrationsRoutes } from "./routes/integrations.routes.js";
import { integrationsApiRoutes } from "./routes/integrations-api.routes.js";
import { securityRoutes } from "./routes/security.routes.js";
import { reliabilityRoutes } from "./routes/reliability.routes.js";
import { reviewOperationsRoutes } from "./routes/review-operations.routes.js";
import { intelligenceRoutes } from "./routes/intelligence.routes.js";
import { collaborationRoutes } from "./routes/collaboration.routes.js";
import { identityRoutes } from "./routes/identity.routes.js";
import { communicationsRoutes } from "./routes/communications.routes.js";
import { identitySecurityRoutes } from "./routes/identity-security.routes.js";
import { opsRoutes } from "./routes/ops.routes.js";
import { opsSeedRoutes } from "./routes/ops-seed.routes.js";
import { governanceSnapshotRoutes } from "./routes/governance-snapshot.routes.js";
import { runtimeReadinessRoutes } from "./routes/runtime-readiness.routes.js";
import { workflowInstancesRoutes } from "./routes/workflow-instances.routes.js";
import { dashboardRoutes } from "./routes/dashboard.routes.js";
import { runStartupConfigValidation } from "./config/index.js";
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
allowedHeaders: [
  "content-type",
  "authorization",
  "x-web-client",
  "x-internal-key",
],
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

  // Phase 18 — Twilio webhook payloads are application/x-www-form-urlencoded.
  // We parse them into a flat object so the webhook routes can read
  // req.body[key] without pulling in @fastify/formbody. The parser is
  // strict: 64 KiB max, percent-decoded, no nested keys.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (_req, body, done) => {
      try {
        const text = typeof body === "string" ? body : body.toString("utf8");
        const out: Record<string, string> = {};
        const parsed = new URLSearchParams(text);
        for (const [k, v] of parsed.entries()) {
          out[k] = v;
        }
        done(null, out);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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

    // Phase 11 — CSP for the API surface. We serve JSON / signed
    // redirects, never HTML, so a strict "default-src 'none'" is the
    // correct posture. `frame-ancestors 'none'` doubles up the
    // x-frame-options protection for browsers that respect CSP only.
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    // Phase 11 — prevent cross-origin pages from embedding API
    // responses in resource contexts (img/script/etc.). Belt + braces
    // with CORS.
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("cross-origin-opener-policy", "same-origin");

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

  // Phase 20 — kept for back-compat. The new canonical endpoints are
  // /healthz (liveness), /readyz (readiness), and /v1/ops/health
  // (authenticated detail). See routes/ops.routes.ts.
  app.get("/health", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.code(200).send({ ok: true, db: "up" });
    } catch {
      return reply.code(503).send({ ok: false, db: "down" });
    }
  });

  // Phase 20 — startup config validation. Logs the safe feature
  // snapshot and throws in production when critical config is
  // missing. Non-prod downgrades to a warning so local dev still
  // works.
  runStartupConfigValidation({
    info: (obj, msg) => app.log.info(obj as Record<string, unknown>, msg),
    warn: (obj, msg) => app.log.warn(obj as Record<string, unknown>, msg),
    error: (obj, msg) => app.log.error(obj as Record<string, unknown>, msg),
  });

  // Phase 20 — ops endpoints (/healthz, /readyz, /v1/ops/health,
  // /v1/ops/metrics, /v1/ops/reconcile). Registered FIRST so they're
  // available even if a later route module fails to load.
  await app.register(opsRoutes);
  await app.register(opsSeedRoutes);
  await app.register(governanceSnapshotRoutes);
  await app.register(runtimeReadinessRoutes);

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(teamsRoutes);
  await app.register(billingRoutes);
  await app.register(webhooksRoutes, { prefix: "/webhooks" });
  await app.register(casesRoutes);
  await app.register(evidenceRoutes);
  await app.register(captureRoutes);
  await app.register(searchRoutes);
  await app.register(reviewerOpsRoutes);
  await app.register(externalReviewRoutes);
  // Phase 30.5 — Resumable multipart upload session REST surface.
  // Wraps the Phase 30 upload-session service in authorizeOrFail-
  // gated routes. NO storage keys / signed URLs are projected; this
  // is metadata + lifecycle only. The actual byte transfer continues
  // through the existing per-part presigned URL path.
  await app.register(uploadSessionsRoutes);
  // Phase 30.6 — API-key resumable upload surface. Bearer API key,
  // scope `integration.evidence.upload`. Governance + legal-hold gate
  // enforced on session creation; idempotency key required.
  await app.register(integrationsUploadsRoutes);
  // Phase 31 — Media intelligence read API + analyzer trigger.
  // Read-only against EvidencePart / clientSignals; never blocks
  // evidence lifecycle on analyzer failure.
  await app.register(mediaIntelligenceRoutes);
  // Phase 32 — Investigation graph routes (read subgraph + manual
  // relationship CRUD). Read-only / write-side authorizeOrFail
  // gated; bounded traversal depth + node/edge caps.
  await app.register(graphRoutes);
  await app.register(adminIdentityRoutes);
  await app.register(adminIdentityRuntimeRoutes);
  await app.register(scimRoutes);
  await app.register(ssoAuthRoutes);
  await app.register(aiRoutes);
  await app.register(enterpriseRoutes);
  await app.register(teamManagementRoutes);
  await app.register(webhookRoutes);
  await app.register(analyticsRoutes);
  await app.register(demoRequestsRoutes);
  await app.register(adminDemoRequestsRoutes);
  await app.register(adminAuditRoutes);
  // Phase 2 Workflow Engine — additive routes under /v1/workflow/*. The
  // capture page does not consume these yet; that is Phase 3.
  await app.register(workflowRoutes);
  // Phase 4 Workflow Engine — external intake. Authenticated CRUD for
  // intake links plus the public-facing token redemption surface. Each
  // route file performs its own feature-flag check on every request, so
  // mounting them is always safe; if WORKFLOW_INTAKE_LINKS_ENABLED is not
  // "true" or WORKFLOW_INTAKE_TOKEN_SECRET is unset, every endpoint
  // returns 503 immediately without touching the DB.
  await app.register(workflowIntakeLinksRoutes);
  await app.register(externalIntakeRoutes);
  // Phase 7 — Evidence Request domain (authenticated only).
  await app.register(evidenceRequestsRoutes);
  // Phase 8.5 — Notification admin surface (authenticated only).
  await app.register(notificationsRoutes);
  // Phase 9 — Governance routes (policy + legal holds; authenticated only).
  await app.register(governanceRoutes);
  // Phase 27 — Governance lifecycle (retention policies, destruction
  // queue, lifecycle events, export gate, dashboard).
  await app.register(governanceLifecycleRoutes);
  // Phase 27.5 — Governance operationalization (analytics, notifications,
  // export lineage snapshots, reconciliation run + execution listings).
  await app.register(governanceOperationsRoutes);
  // Phase 32.8C — Enterprise dashboard command-center aggregator.
  // Read-only `/v1/dashboard/command-center`. Workspace-scoped,
  // bounded, partial-failure tolerant. No audit emissions.
  await app.register(dashboardRoutes);
  // Phase 10 — Integration platform. Two route trees:
  //   * `integrationsRoutes` — workspace-authenticated admin surface
  //     for managing API keys and webhook endpoints.
  //   * `integrationsApiRoutes` — the public enterprise API consumed
  //     by service accounts via Bearer API keys. Every route inside
  //     guards on `isIntegrationsFeatureEnabled()`, so mounting them
  //     while the feature is off returns 503 from each endpoint without
  //     touching the DB.
  await app.register(integrationsRoutes);
  await app.register(integrationsApiRoutes);
  // Phase 11 — Security operations (admin-only). Mounting is always safe:
  // every route inside requires authenticated OWNER/ADMIN membership and
  // 404s on non-members so non-admin users cannot enumerate.
  await app.register(securityRoutes);
  // Phase 12 — Reliability operations (admin-only) + cron-protected
  // reconciliation sweeper. Same 404-on-non-admin posture.
  await app.register(reliabilityRoutes);
  // Phase 13 — Review operations. Workflow assignment, stage
  // transitions, decisions, SLA, escalation, bulk operations,
  // queue 2.0 + cron-protected SLA sweep.
  await app.register(reviewOperationsRoutes);
  // Phase 15 — Intelligence platform. OCR + transcript extraction
  // foundation, entity extraction, similarity hints, keyword search,
  // semantic search foundation, AI assistance wrapper. Provider
  // abstractions; defaults are no-op so deployments without an
  // engine still return safe responses.
  await app.register(intelligenceRoutes);
  // Phase 16 — Collaboration platform. Discussion threads + messages
  // + mentions + contributor-scoped access. Workspace-internal; never
  // surfaces on public verify.
  await app.register(collaborationRoutes);
  // Phase 17 — Identity & access platform. Member lifecycle, capability
  // grants, delegated admin scopes, service-account hardening,
  // contributor session governance, org security policy, access reviews,
  // and SSO/SCIM readiness. Workspace-internal; never surfaces on
  // public verify. All routes use the access-policy engine and 404 for
  // non-members (anti-enumeration).
  await app.register(identityRoutes);
  // Phase 18 — Enterprise communications & external outreach. Twilio
  // SMS/WhatsApp/Verify OTP behind a provider abstraction; outbound
  // dispatch with retry; inbound delivery + STOP/START webhooks
  // protected by signature validation; operator ops UI. Workspace-
  // internal; public verify NEVER touches these tables. Provider
  // disabled / unconfigured → all sends fail closed as CANCELLED rows.
  await app.register(communicationsRoutes);
  // Phase 22 — Evidence Workflow Engine runtime layer. Reuses the
  // existing Phase 1-4 template + intake-link + intake-session
  // surface; adds the workflow-instance + step-instance + visibility-
  // decision routes on top. Workspace-internal; public verify never
  // touches these tables.
  await app.register(workflowInstancesRoutes);

  // Phase 19 — Enterprise identity security & adaptive access control.
  // MFA policy engine, step-up authentication (via Phase 18 Verify),
  // trusted device tracking, session revocation registry, adaptive
  // risk scoring. requireAuth now consults the revocation registry on
  // every request. Sensitive routes wrap their mutations with
  // requireStepUpForSensitiveAction. Workspace-internal; public
  // verify NEVER touches these tables.
  await app.register(identitySecurityRoutes);

  // Phase C #1: Object Lock startup verification.
  // Throws in production-shaped envs when S3_OBJECT_LOCK_ENABLED=true but the
  // bucket cannot accept retention writes. Set OBJECT_LOCK_VERIFICATION_BYPASS=true
  // to opt out (and accept that EVIDENCE_LOCKED claims will be downgraded
  // per-record by the Phase A truth gate).
  await bootstrapObjectLockVerification({
    info: (obj, msg) => app.log.info(obj as Record<string, unknown>, msg),
    warn: (obj, msg) => app.log.warn(obj as Record<string, unknown>, msg),
    error: (obj, msg) => app.log.error(obj as Record<string, unknown>, msg),
  });

  // Runtime schema validation. Inspects the live database against the
  // expected-schema catalog and refuses to boot when a CRITICAL
  // reviewer-ops / governance object is missing — that's a P2022 about
  // to happen. Set SCHEMA_VALIDATION_FAIL_FAST=false (or omit env in
  // dev) to log + continue instead of aborting; recommended only for
  // local development. Production should always fail-fast.
  const schemaValidationFailFast =
    (process.env.SCHEMA_VALIDATION_FAIL_FAST ?? "true").toLowerCase() !== "false";
  try {
    const { validateAtStartup } = await import("./runtime/schema-validation.js");
    await validateAtStartup({
      logger: {
        info: (obj, msg) => app.log.info(obj as Record<string, unknown>, msg),
        warn: (obj, msg) => app.log.warn(obj as Record<string, unknown>, msg),
        error: (obj, msg) => app.log.error(obj as Record<string, unknown>, msg),
      },
      sentryHook: ({ fingerprint, status, failingSubsystems, summary }) => {
        const err = new Error(summary);
        (err as Error & { code?: string }).code =
          status === "critical"
            ? "SCHEMA_DRIFT_CRITICAL"
            : "SCHEMA_DRIFT_DEGRADED";
        captureException(err, {
          schemaDriftFingerprint: fingerprint,
          schemaDriftStatus: status,
          failingSubsystems: failingSubsystems.join(","),
        });
      },
      failFastOnCritical: schemaValidationFailFast,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === "SCHEMA_DRIFT_CRITICAL"
    ) {
      // Re-throw so the process exits with non-zero status and the
      // orchestrator restarts/halts. Don't capture again — already
      // tagged by the sentryHook above.
      throw err;
    }
    // Any unexpected validation error: log + continue. We never let
    // an instrumentation bug take the API down.
    app.log.error({ err }, "runtime.schema_validation.unexpected_error");
  }

  return app;
}