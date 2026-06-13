// Phase P2.0B — OTEL must initialise BEFORE Fastify / Prisma /
// BullMQ load so HTTP / pg / ioredis are auto-instrumented. This
// side-effect import is a no-op when OTEL_ENABLED is not "true".
import "./observability/otel-bootstrap.js";
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
import { platformContextRoutes } from "./routes/platform-context.routes.js";
import { workspacePersonaRoutes } from "./routes/workspace-persona.routes.js";
import { captureException, initSentry } from "./observability/sentry.js";
// CR1 Phase D — legacy `auditMiddleware` removed. The canonical audit
// chain is wired into each route via `appendPlatformAuditLog()` from
// `services/platform-audit-log.service.ts` (hash-chained, DB-backed).
import { evidenceRoutes } from "./routes/evidence.routes.js";
import { captureRoutes } from "./routes/capture.routes.js";
// Phase 1B — Citizen PWA capture ingest (Class B provenance, anonymous
// Ed25519 signing). Registered alongside the operator capture routes.
import { citizenCaptureRoutes } from "./routes/citizen-capture.routes.js";
// Phase 1B — Capture Trust routes (device attestation + Ed25519 signature
// + provenance projection). Real route module already exists on disk; this
// import + registration below closes the gap that left the routes
// unwired in production builds.
import { captureTrustRoutes } from "./routes/capture-trust.routes.js";
// Phase 2A — Reviewer Workspace routes (coding schemas, disagreements,
// QC samples, reviewer metrics). Canonical module; same wire-up gap.
import { reviewerWorkspaceRoutes } from "./routes/reviewer-workspace.routes.js";
// Phase 2B — External Reviewer Portal routes (token sessions, dashboard,
// per-evidence review, decisions, comments, watermark).
import { externalPortalRoutes } from "./routes/external-portal.routes.js";
// Phase 3A — Redaction Platform routes (projects/versions/regions/
// detections/decisions/approvals/derivatives).
import { redactionRoutes } from "./routes/redaction.routes.js";
// Phase 3B — Intelligence Platform routes (intelligence records,
// reviewer corrections, cost controls, executive metrics, audit
// transparency).
import { intelligencePlatformRoutes } from "./routes/intelligence-platform.routes.js";
// Phase 4A — Trust Center + Organization Governance surface. Auth-gated,
// workspace-scoped. Exposes trust articles, subprocessors, status-page
// probes, org departments, delegated admin, policy engine, access reviews,
// and cross-org collaboration endpoints.
import { trustAndGovernanceRoutes } from "./routes/trust-and-governance.routes.js";
import { bootstrapObjectLockVerification } from "./bootstrap/object-lock-verification.js";
import { authRoutes } from "./routes/auth.routes.js";
import { teamsRoutes } from "./routes/teams.routes.js";
import { collaborationTeamsRoutes } from "./routes/collaboration-teams.routes.js";
import { collaborationCompletionRoutes } from "./routes/collaboration-completion.routes.js";
// Phase B0 — Workspace URL alias. Rewrites `/v1/workspaces/*` to
// `/v1/teams/*` at the onRequest hook so the existing 2,497-line
// `teams.routes.ts` handlers are exposed under the new canonical
// product vocabulary without duplication.
import { workspaceAliasPlugin } from "./routes/workspace-alias.plugin.js";
// Phase 2.7X Stage 3 — Organization runtime endpoints (read-only dual-read).
import { organizationsRoutes } from "./routes/organizations.routes.js";
// Phase B0 — Organization governance write surfaces (retention
// template publishing + billing rollup). Narrow, audited, and
// scope-gated; does NOT replace the workspace operational layer.
import { organizationsGovernanceRoutes } from "./routes/organizations-governance.routes.js";
// Phase A.1C — Account-level operational priorities (above-workspace surface).
import { meOperationalPrioritiesRoutes } from "./routes/me-operational-priorities.routes.js";
// Phase C — Operational Inbox (caller-scoped unified attention stream).
import { meInboxRoutes } from "./routes/me-inbox.routes.js";
import { presenceRoutes } from "./routes/presence.routes.js";
import { notificationPreferencesRoutes } from "./routes/notification-preferences.routes.js";
// Phase 2.7Z+ — E2E-only rate-limit reset endpoint (404 in production).
import { testRateLimitRoutes } from "./routes/_test-rate-limit.routes.js";
import { billingRoutes } from "./routes/billing.routes.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { casesRoutes } from "./routes/cases.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { reviewerOpsRoutes } from "./routes/reviewer-ops.routes.js";
// Phase C0 — Reviewer Console aggregator. Composes the existing
// reviewer-ops services into one bounded envelope for the canonical
// /review page (Queue · Mine · Escalations · SLA · Workload).
import { reviewerConsoleRoutes } from "./routes/reviewer-console.routes.js";
import { externalReviewRoutes } from "./routes/external-review.routes.js";
import { uploadSessionsRoutes } from "./routes/upload-sessions.routes.js";
import { integrationsUploadsRoutes } from "./routes/integrations-uploads.routes.js";
import { mediaIntelligenceRoutes } from "./routes/media-intelligence.routes.js";
// Wave 5 — Internal worker→API callback for automatic provider extraction.
// Guarded by `requireInternalServiceAuth` (X-Internal-Service-Token).
// Exists ONLY so services/worker/src/media-intelligence.processor.ts can
// invoke runProviderOperation + runExtractionInline without cross-importing
// API source into the worker Docker image. NEVER reachable from a
// public/user-authenticated session.
import { internalMediaIntelligenceExtractRoutes } from "./routes/internal-media-intelligence-extract.routes.js";
// Wave 3 Phase 7B — Producer-mode probe bootstrap. Side-effect import
// that registers the four producer-mode probes against the shared-runtime
// probe-registry seam. MUST be imported before any route handler runs.
// See services/media-intelligence/probe-bootstrap.ts.
import "./services/media-intelligence/probe-bootstrap.js";
import { intelligenceCapabilitiesRoutes } from "./routes/intelligence-capabilities.routes.js";
import { investigationDiagnosticsRoutes } from "./routes/investigation-diagnostics.routes.js";
import { graphRoutes } from "./routes/graph.routes.js";
import {
  adminIdentityRoutes,
  adminIdentityRuntimeRoutes,
} from "./routes/admin-identity.routes.js";
import { scimRoutes } from "./routes/scim.routes.js";
import { ssoAuthRoutes } from "./routes/sso-auth.routes.js";
// R8.2 — Real SAML SP routes (HTTP-Redirect + HTTP-POST ACS + SP metadata).
// Registered separately from sso-auth.routes.ts which handles OIDC.
import { samlAuthRoutes } from "./routes/saml-auth.routes.js";
import { aiRoutes } from "./routes/ai.routes.js";
import { enterpriseRoutes } from "./routes/enterprise.routes.js";
import { teamManagementRoutes } from "./routes/team-management.routes.js";
// CR1 Phase B — legacy `webhookRoutes` (per-org in-memory webhooks) deleted.
// Canonical webhook management lives in `integrations.routes.ts` +
// `services/integrations/webhooks.service.ts`.
import analyticsRoutes from "./routes/analytics.routes.js";
import { adminAuditRoutes } from "./routes/admin-audit.routes.js";
import { workflowRoutes } from "./routes/workflow.routes.js";
import { workflowIntakeLinksRoutes } from "./routes/workflow-intake-links.routes.js";
import { externalIntakeRoutes } from "./routes/external-intake.routes.js";
import { evidenceRequestsRoutes } from "./routes/evidence-requests.routes.js";
import { notificationsRoutes } from "./routes/notifications.routes.js";
import { automationRoutes } from "./routes/automation.routes.js";
import { automationWebhooksRoutes } from "./routes/automation-webhooks.routes.js";
// Phase E4 — bounded operational analytics. Team-scoped, capability-gated
// (ANALYTICS_VIEW). Read-only surface, no mutations, no fake metrics —
// every value is source-traceable to a real Prisma model.
import { analyticsOperationsRoutes } from "./routes/analytics-operations.routes.js";
import { governanceRoutes } from "./routes/governance.routes.js";
import { governanceLifecycleRoutes } from "./routes/governance-lifecycle.routes.js";
import { governanceOperationsRoutes } from "./routes/governance-operations.routes.js";
import { productAndLifecycleRoutes } from "./routes/product-and-lifecycle.routes.js";
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
// R8.1.1 — MFA REST surface (TOTP enroll/verify, factors, recovery
// codes, challenge). Sub-domain of the canonical identity surface;
// not a parallel auth system.
import { mfaRoutes } from "./routes/mfa.routes.js";
// R8.1.4 — admin MFA lifecycle + lost-factor recovery routes. Same
// canonical session model as the rest of the identity surface; the
// service layer enforces org-scoped admin authorization.
import { mfaAdminRoutes } from "./routes/mfa-admin.routes.js";
import { identityOperationsCompletionRoutes } from "./routes/identity-operations-completion.routes.js";
// Phase P2.1 — WORM export operations routes (list / detail / manifest /
// reproducibility verify / Object Lock status). Mounted alongside the
// existing `opsRoutes` cluster; these handle immutable export surfacing.
import { operationsExportsRoutes } from "./routes/operations-exports.routes.js";
// P2.3 — queue operations (inventory, failed-jobs, replay safety matrix,
// retry/replay/cancel, worker health). P2.5 — DR recovery (backup +
// restore validation, recovery reports).
import { operationsQueuesRoutes } from "./routes/operations-queues.routes.js";
import { operationsRecoveryRoutes } from "./routes/operations-recovery.routes.js";
// Phase M2.1 — C2PA operations (provider status, backfill, generation
// readiness). Routes are auth + step-up gated identically to other
// operations console surfaces.
import { operationsC2paRoutes } from "./routes/operations-c2pa.routes.js";
// Phase M3 — Insurance SIU bundle (profile + checklist + indicators +
// follow-ups + export bundle). Workspace-scoped and step-up gated on
// the export action.
import { siuRoutes } from "./routes/siu.routes.js";
// P3.1 — signer governance + detached custody attestations.
import { operationsSignersRoutes } from "./routes/operations-signers.routes.js";
import { opsRoutes } from "./routes/ops.routes.js";
import { opsSeedRoutes } from "./routes/ops-seed.routes.js";
import { governanceSnapshotRoutes } from "./routes/governance-snapshot.routes.js";
import { runtimeReadinessRoutes } from "./routes/runtime-readiness.routes.js";
import { workflowInstancesRoutes } from "./routes/workflow-instances.routes.js";
import { dashboardRoutes } from "./routes/dashboard.routes.js";
import { caseWorkspaceRoutes } from "./routes/case-workspace.routes.js";
// Phase IA-self-serve-regression-fix — user-scoped reports list
// (`GET /v1/reports`). Complements the workspace-scoped
// `/v1/reports/artifacts` so self-serve PERSONAL users whose
// workspace bootstrap missed the TeamMember row still see their
// own generated reports.
import registerReportsRoutes from "./routes/reports.routes.js";
import { devLoginRoutes, devAuthEnabled } from "./dev/dev-login.js";
import { enterpriseAggregatorsRoutes } from "./routes/enterprise-aggregators.routes.js";
import { runStartupConfigValidation } from "./config/index.js";
// Phase P2.0 — AWS Secrets Manager hydration + runtime health route.
// Both are no-ops when AWS_SECRETS_ENABLED is not "true" — the call
// is safe to leave in place for local dev / Docker.
import { initSecretsManager } from "./config/secrets-manager.js";
import { runtimeSecretsHealthRoutes } from "./routes/runtime-secrets-health.routes.js";
// Phase O1.1 — dedicated OTEL runtime health endpoint so operators can
// verify the bootstrap fired without parsing container logs.
import { runtimeOtelHealthRoutes } from "./routes/runtime-otel-health.routes.js";
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

// =============================================================================
// Phase O Stage 4 — additive central error mappings
// =============================================================================
//
// The legacy handler above continues to own:
//   - AppError (every route's structured business error)
//   - ZodError → VALIDATION_ERROR via createErrorResponse
//   - everything else → INTERNAL_SERVER_ERROR via createErrorResponse
//
// Stage 4 adds three NEW wire-shapes that the legacy handler cannot emit
// (its createErrorResponse path is fixed to ErrorCode + canonical message).
// These mappings are TRIED FIRST inside setErrorHandler so the legacy
// path is preserved verbatim for anything that doesn't match.
//
//   1. ZodError                              → 400 INVALID_INPUT with bounded fields[]
//   2. Prisma P2022 / P2021                  → 503 SCHEMA_NOT_READY
//   3. Prisma other known-request errors     → 500 DATABASE_ERROR
//
// All three honour the same anti-leak invariants the legacy handler
// uses: no stack traces, no env names, no SQL fragments, no raw Prisma
// `message` body in the client response. Internal logging emits the
// full structured diagnostic so operators can triage.

const ZOD_FIELD_LIMIT = 5;
const ZOD_MESSAGE_LIMIT = 200;
const ZOD_FIELD_PATH_LIMIT = 120;
const ZOD_FIELD_MESSAGE_LIMIT = 200;

type ZodFieldSummary = {
  path: string;
  code: string;
  message: string;
};

type ZodWirePayload = {
  status: 400;
  body: {
    error: {
      code: "INVALID_INPUT";
      message: string;
      fields: ZodFieldSummary[];
      requestId: string | null;
    };
  };
  log: {
    issueCount: number;
    fields: ZodFieldSummary[];
  };
};

function buildZodWirePayload(
  err: ZodError,
  requestId: string | null,
): ZodWirePayload {
  const issues = Array.isArray(err.issues) ? err.issues : [];
  const fields: ZodFieldSummary[] = issues.slice(0, ZOD_FIELD_LIMIT).map((issue) => {
    const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
    return {
      path: typeof path === "string" ? path.slice(0, ZOD_FIELD_PATH_LIMIT) : "",
      code: typeof issue.code === "string" ? issue.code : "invalid",
      message:
        typeof issue.message === "string"
          ? issue.message.slice(0, ZOD_FIELD_MESSAGE_LIMIT)
          : "Invalid value",
    };
  });

  const firstField = fields[0];
  const overflow = issues.length > ZOD_FIELD_LIMIT;
  const baseSummary = firstField
    ? `Invalid input: ${firstField.path || "<root>"} — ${firstField.message}`
    : "Invalid input.";
  const summary = (
    overflow ? `${baseSummary} (+${issues.length - ZOD_FIELD_LIMIT} more)` : baseSummary
  ).slice(0, ZOD_MESSAGE_LIMIT);

  return {
    status: 400,
    body: {
      error: {
        code: "INVALID_INPUT",
        message: summary,
        fields,
        requestId,
      },
    },
    log: {
      issueCount: issues.length,
      fields,
    },
  };
}

type PrismaKnownDiagnostic = {
  code: string;
  meta: { column: string | null; table: string | null; modelName: string | null };
  message: string;
};

function isPrismaKnownRequestError(err: unknown): err is Error & {
  code: string;
  meta?: Record<string, unknown>;
} {
  if (!(err instanceof Error)) return false;
  if (err.name !== "PrismaClientKnownRequestError") return false;
  const candidate = err as { code?: unknown };
  return typeof candidate.code === "string";
}

function readPrismaDiagnostic(
  err: Error & { code: string; meta?: Record<string, unknown> },
): PrismaKnownDiagnostic {
  const meta = (err.meta ?? {}) as { column?: unknown; table?: unknown; modelName?: unknown };
  const readMetaString = (key: "column" | "table" | "modelName"): string | null => {
    const value = meta[key];
    return typeof value === "string" ? value.slice(0, 120) : null;
  };
  return {
    code: err.code,
    meta: {
      column: readMetaString("column"),
      table: readMetaString("table"),
      modelName: readMetaString("modelName"),
    },
    message: typeof err.message === "string" ? err.message.slice(0, 300) : "",
  };
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

  // CR1 Phase D — legacy `auditMiddleware` hook removed. It wrote to the
  // in-memory `services/audit.service.ts` tombstone on every state-
  // mutating request. Per-route canonical audit writes via
  // `appendPlatformAuditLog()` remain in place.

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
    const requestId = typeof req.id === "string" ? req.id : null;

    // -----------------------------------------------------------------
    // Phase O Stage 4 — additive central mappings (tried FIRST).
    //
    // We honour AppError above all other shapes. The legacy
    // `normalizeUnknownError` already returns an AppError for AppError
    // inputs, so we defer AppError handling to the legacy path below
    // and only intercept here for ZodError + Prisma known-request
    // errors that need wire shapes the legacy path cannot emit.
    //
    // Per-route handlers in Stage 3 remain the FIRST line of defence:
    // every route already converted `.parse()` → `.safeParse()` and
    // every Prisma call site has bounded try/catch. These central
    // mappings are belt-and-braces for any route that forgets.
    // -----------------------------------------------------------------
    if (!isAppError(err) && err instanceof ZodError) {
      const wire = buildZodWirePayload(err, requestId);
      req.log.warn(
        {
          ...requestContext,
          errorCode: "INVALID_INPUT",
          statusCode: 400,
          zodIssueCount: wire.log.issueCount,
          zodFields: wire.log.fields,
        },
        "request.failed.validation",
      );
      return reply.code(wire.status).send(wire.body);
    }

    if (!isAppError(err) && isPrismaKnownRequestError(err)) {
      const diag = readPrismaDiagnostic(err);

      if (diag.code === "P2022" || diag.code === "P2021") {
        req.log.warn(
          {
            ...requestContext,
            errorCode: "SCHEMA_NOT_READY",
            statusCode: 503,
            prismaCode: diag.code,
            prismaMissingColumn: diag.meta.column,
            prismaMissingTable: diag.meta.table,
            prismaModelName: diag.meta.modelName,
            prismaMessage: diag.message,
          },
          "request.failed.schema_not_ready",
        );
        return reply.code(503).send({
          error: {
            code: "SCHEMA_NOT_READY",
            message: "Resource temporarily unavailable.",
            requestId,
          },
        });
      }

      // Any other Prisma known-request error (P1xxx connection,
      // P2002 unique constraint, P2003 FK, P2025 not found, etc.) —
      // we map to DATABASE_ERROR 500 with a generic message. Route
      // handlers that need finer-grained mapping (e.g., 409 on a
      // unique violation) MUST catch the Prisma error themselves and
      // throw an AppError before this central handler runs. That
      // route-layer-first contract is preserved.
      req.log.error(
        {
          ...requestContext,
          errorCode: "DATABASE_ERROR",
          statusCode: 500,
          prismaCode: diag.code,
          prismaMissingColumn: diag.meta.column,
          prismaMissingTable: diag.meta.table,
          prismaModelName: diag.meta.modelName,
          prismaMessage: diag.message,
        },
        "request.failed.database_error",
      );
      captureException(err, requestContext);
      return reply.code(500).send({
        error: {
          code: "DATABASE_ERROR",
          message: "Request failed.",
          requestId,
        },
      });
    }

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

  // Phase P2.0 — AWS Secrets Manager hydration. Runs ONCE at boot.
  // No-op when AWS_SECRETS_ENABLED is not "true". On AWS failure we
  // log a bounded warning and continue — fallback to env keeps the
  // app booting. NEVER throws to the bootstrap.
  await initSecretsManager({
    info: (obj, msg) => app.log.info(obj as Record<string, unknown>, msg),
    warn: (obj, msg) => app.log.warn(obj as Record<string, unknown>, msg),
  });

  // Phase 20 — startup config validation. Logs the safe feature
  // snapshot and throws in production when critical config is
  // missing. Non-prod downgrades to a warning so local dev still
  // works.
  // NOTE: this runs AFTER `initSecretsManager` so future validators
  // that consult `getSecret()` see the populated cache.
  runStartupConfigValidation({
    info: (obj, msg) => app.log.info(obj as Record<string, unknown>, msg),
    warn: (obj, msg) => app.log.warn(obj as Record<string, unknown>, msg),
    error: (obj, msg) => app.log.error(obj as Record<string, unknown>, msg),
  });

  // Phase 20 — ops endpoints (/healthz, /readyz, /v1/ops/health,
  // /v1/ops/metrics, /v1/ops/reconcile). Registered FIRST so they're
  // available even if a later route module fails to load.
  await app.register(opsRoutes);
  // Phase P2.0 — runtime secrets-health route (/v1/runtime/secrets-health).
  // Operator-only view of AWS Secrets Manager hydration state. NEVER
  // returns secret values.
  await app.register(runtimeSecretsHealthRoutes);
  // Phase O1.1 — OTEL runtime health endpoint.
  await app.register(runtimeOtelHealthRoutes);
  // CR1 Phase F — env-guarded operational seeding registration.
  // Defense in depth: the route handlers already require
  // requireAuth + governance.policy.manage + a shared seed secret
  // header, but the registration itself is now gated so production
  // deployments do not even mount the surface unless explicitly opted
  // in via OPERATIONAL_SEEDING_ENABLED=true.
  if (process.env.OPERATIONAL_SEEDING_ENABLED === "true") {
    await app.register(opsSeedRoutes);
  }
  // Phase IA-home-acceptance — dev/staging-only impersonation login for
  // the Playwright Home acceptance suite. NEVER mounted in production
  // (devAuthEnabled() returns false when NODE_ENV==="production").
  if (devAuthEnabled()) {
    await app.register(devLoginRoutes);
  }
  await app.register(governanceSnapshotRoutes);
  await app.register(runtimeReadinessRoutes);

  // Phase B0 — Workspace URL alias plugin. MUST register before any
  // route plugin so the rewrite hook fires before routing match.
  await app.register(workspaceAliasPlugin);

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(platformContextRoutes);
  await app.register(workspacePersonaRoutes);
  await app.register(teamsRoutes);
  // Phase 5 — Collaboration Teams (the new Team Collaboration Platform).
  // Mounted under /v1/collaboration-teams; orthogonal to /v1/teams
  // which remains the runtime workspace administration API.
  await app.register(collaborationTeamsRoutes);
  // Phase 7 — Collaboration Completion endpoints (comments, mentions,
  // notifications, preferences, guests, access reviews, activity v2).
  await app.register(collaborationCompletionRoutes);
  // Phase 2.7X Stage 3 — Organization runtime endpoints. Read-only.
  // Team semantics remain operational authority; these endpoints
  // expose governance metadata only (no evidence/case/reviewer data).
  await app.register(organizationsRoutes);
  // Phase B0 — Org governance write surfaces. Registered AFTER the
  // read-only `organizationsRoutes` so the existing endpoints take
  // precedence on any path collision.
  await app.register(organizationsGovernanceRoutes);
  await app.register(meOperationalPrioritiesRoutes);
  await app.register(meInboxRoutes);
  // Phase G3 — bounded in-process presence routes
  // (heartbeat + here-now query). No persistence, no audit emission.
  await app.register(presenceRoutes);
  // Phase G3.1 — operator notification preferences (per-workspace toggles).
  await app.register(notificationPreferencesRoutes);
  // Phase 2.7Z+ — E2E rate-limit reset endpoint. Gated by the same
  // three-layer defense as auth-test-bypass; 404 in production.
  await app.register(testRateLimitRoutes);
  await app.register(billingRoutes);
  await app.register(webhooksRoutes, { prefix: "/webhooks" });
  await app.register(casesRoutes);
  await app.register(evidenceRoutes);
  await app.register(captureRoutes);
  // Phase 1B — Citizen PWA capture ingest (Class B provenance).
  await app.register(citizenCaptureRoutes);
  // Phase 1B — Capture Trust routes: device registration / mobile ingest /
  // session trust timeline / bounded ProvenanceChain projection. Real
  // module on disk; wired here so the routes are actually mounted at boot.
  await app.register(captureTrustRoutes);
  // Phase 4A — Trust Center + Organization Governance. Registered after
  // the core workspace routes so governance depends on team context.
  await app.register(trustAndGovernanceRoutes);
  await app.register(searchRoutes);
  await app.register(reviewerOpsRoutes);
  // Phase C0 — Reviewer Console aggregator. Read-only; composes
  // existing reviewer-ops services. Registered alongside the
  // per-domain endpoints so deep-drill paths continue to work.
  await app.register(reviewerConsoleRoutes);
  // Phase 2A — Reviewer Workspace routes (coding schemas, disagreements,
  // QC samples, reviewer metrics). Registered adjacent to reviewer-ops +
  // reviewer-console so reviewer surfaces share the same mount point.
  await app.register(reviewerWorkspaceRoutes);
  await app.register(externalReviewRoutes);
  // Phase 2B — External Reviewer Portal routes: token sessions + bounded
  // per-evidence review + decisions + comments + watermark. Mounted after
  // externalReviewRoutes (internal admin surface) so the portal layer
  // composes on top of the same canonical grant + invitation services.
  await app.register(externalPortalRoutes);
  // Phase 3A — Redaction Platform routes: projects/versions/regions/
  // detections/decisions/approvals/derivatives. Workspace-anchored.
  await app.register(redactionRoutes);
  // Phase 3B — Intelligence Platform routes: media intelligence records,
  // reviewer corrections + confidence scoring, cost controls, executive
  // metrics, audit transparency. Registered alongside the legacy
  // mediaIntelligenceRoutes for the new bounded routes.
  await app.register(intelligencePlatformRoutes);
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
  // Wave 5 — Internal worker→API callback for automatic provider extraction.
  // The route is registered here (after the public media-intelligence
  // surface) so its pre-handler order is deterministic. Auth is the
  // X-Internal-Service-Token bearer header; no end-user session reaches it.
  await app.register(internalMediaIntelligenceExtractRoutes);
  // Wave 1 Phase 3 — Producer-Mode Truth Resolver capability surface.
  // GET /v1/intelligence/capabilities returns the canonical 5-kind
  // producer status array. UI surfaces MUST consume this endpoint;
  // raw env reads (OCR_PRODUCER_MODE, TRANSCRIPT_PRODUCER_MODE,
  // OPENAI_API_KEY) in apps/web are forbidden.
  await app.register(intelligenceCapabilitiesRoutes);
  // Wave 1 Phase 5 — Investigation Diagnostics envelope. Composes
  // workspace counts + queue inventory + producer-mode statuses +
  // last errors into a single GET /v1/investigation/diagnostics
  // response. Read-only; ops-actor gated; anti-enumeration safe.
  await app.register(investigationDiagnosticsRoutes);
  // Phase 32 — Investigation graph routes (read subgraph + manual
  // relationship CRUD). Read-only / write-side authorizeOrFail
  // gated; bounded traversal depth + node/edge caps.
  await app.register(graphRoutes);
  await app.register(adminIdentityRoutes);
  await app.register(adminIdentityRuntimeRoutes);
  await app.register(scimRoutes);
  await app.register(ssoAuthRoutes);
  // R8.2 — SAML SP routes alongside the OIDC routes. Same canonical session
  // model; no parallel auth surface. SAML_ENABLED=false disables at runtime.
  await app.register(samlAuthRoutes);
  await app.register(aiRoutes);
  await app.register(enterpriseRoutes);
  await app.register(teamManagementRoutes);
  // CR1 Phase B — legacy `webhookRoutes` registration removed.
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
  // Phase E3 — Operational automation foundation (authenticated only).
  // Rules + runs management. Trigger dispatcher + worker execution
  // are deferred to E3.1 (DEF-021).
  await app.register(automationRoutes);
  // Phase E3.2 — Webhook destination + delivery routes (authenticated
  // only). HTTPS-only destinations, SSRF-checked, HMAC-signed delivery.
  await app.register(automationWebhooksRoutes);
  // Phase E4 — bounded operational analytics. Five GET endpoints under
  // /v1/analytics/{operations,reviewer,governance,automation,artifacts}.
  // Team-scoped + ANALYTICS_VIEW gated. Every metric is source-traceable.
  await app.register(analyticsOperationsRoutes);
  // Phase 9 — Governance routes (policy + legal holds; authenticated only).
  await app.register(governanceRoutes);
  // Phase 27 — Governance lifecycle (retention policies, destruction
  // queue, lifecycle events, export gate, dashboard).
  await app.register(governanceLifecycleRoutes);
  // Phase 4B — Product packaging + evidence lifecycle routes.
  await app.register(productAndLifecycleRoutes);
  // Phase 27.5 — Governance operationalization (analytics, notifications,
  // export lineage snapshots, reconciliation run + execution listings).
  await app.register(governanceOperationsRoutes);
  // Phase 32.8C — Enterprise dashboard command-center aggregator.
  // Read-only `/v1/dashboard/command-center`. Workspace-scoped,
  // bounded, partial-failure tolerant. No audit emissions.
  await app.register(dashboardRoutes);
  // Phase 32.8D — Cases workspace + Reports artifacts aggregators.
  // Read-only `/v1/cases/summary`, `/v1/cases/:id/workspace`,
  // `/v1/reports/artifacts`. Same partial-failure-tolerant envelope
  // pattern; no audit emissions; never triggers report/package
  // generation or signed-URL creation.
  await app.register(caseWorkspaceRoutes);
  // Phase IA-self-serve-regression-fix — user-scoped reports list.
  await app.register(registerReportsRoutes);
  // Phase 32.8E — Enterprise aggregators for Teams + Governance +
  // ReviewerOps:
  //   GET /v1/teams/workspace-admin
  //   GET /v1/governance/control-plane
  //   GET /v1/reviewer-ops/command
  // All read-only, workspace-scoped, no audit, no custody/billing
  // side effects, partial-failure tolerant.
  await app.register(enterpriseAggregatorsRoutes);
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
  // R8.1.1 — MFA endpoints registered alongside identity-security.
  // Same canonical session + auth model; no parallel auth surface.
  await app.register(mfaRoutes);
  // R8.1.4 — admin lifecycle + lost-factor recovery endpoints.
  await app.register(mfaAdminRoutes);
  // P1.1 — identity operations completion (SCIM drift + reconciliation,
  // SAML mapping preview/update, SSO health snapshot, bounded session
  // identity timeline). Reuses the existing auth + audit + step-up
  // infrastructure.
  await app.register(identityOperationsCompletionRoutes);
  // P2.1 — immutable export operations routes (`/v1/operations/exports/*`).
  // Deterministic manifest envelope + reproducibility verifier + honest
  // Object Lock surfacing.
  await app.register(operationsExportsRoutes);
  // P2.3 + P2.5 — queue operations + DR recovery routes.
  await app.register(operationsQueuesRoutes);
  await app.register(operationsRecoveryRoutes);
  // Phase M2.1 — C2PA operations + bulk backfill + generation
  // readiness routes. Auth + workspace-scoped + step-up gated.
  await app.register(operationsC2paRoutes);
  // Phase M3 — Insurance SIU bundle routes (profile, checklist,
  // indicators, follow-ups, export preflight + bundle). Auth +
  // workspace-scoped + step-up gated on export.
  await app.register(siuRoutes);
  // P3.1 — signer governance + detached custody attestations.
  await app.register(operationsSignersRoutes);

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

  // Phase CAPTURE-HARDENING — capture draft expiry sweeper. Runs every
  // 6 hours (configurable via CAPTURE_DRAFT_SWEEP_INTERVAL_MS) on
  // exactly one replica when `CAPTURE_DRAFT_SWEEP_INPROCESS=true`.
  // Multi-replica deploys should leave this off and run the
  // `scripts/sweep-capture-drafts.ts` CLI from a CronJob instead.
  //
  // The sweeper is wrapped in `runCaptureDraftExpirySweepSafe` which
  // swallows errors so a DB blip during a tick never crashes the API.
  if (process.env.CAPTURE_DRAFT_SWEEP_INPROCESS === "true") {
    const { runCaptureDraftExpirySweepSafe } = await import(
      "./jobs/capture-draft-expiry.job.js"
    );
    const intervalMs = Number.parseInt(
      process.env.CAPTURE_DRAFT_SWEEP_INTERVAL_MS ?? "21600000",
      10,
    );
    // Kick once at boot so freshly-deployed replicas catch up
    // immediately if a tick was missed during the rolling restart.
    runCaptureDraftExpirySweepSafe().catch(() => null);
    const handle = setInterval(() => {
      runCaptureDraftExpirySweepSafe().catch(() => null);
    }, intervalMs);
    // Prevent the timer from holding the process open during tests.
    if (typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref?: () => void }).unref!();
    }
    app.addHook("onClose", async () => {
      clearInterval(handle);
    });
    app.log.info(
      { intervalMs },
      "capture_draft_expiry.in_process_sweeper.started",
    );
  }

  return app;
}