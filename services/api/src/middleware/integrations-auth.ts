/**
 * Phase 10 / 10.5 — Integration API authentication + audit + rate limiting.
 *
 * Public enterprise API routes authenticate by Bearer API key
 * (`Authorization: Bearer pwk_v1_...`). The credential's `teamId`
 * defines the workspace scope; the caller does NOT pass `teamId` in
 * the request body / query.
 *
 * Pipeline for every authenticated route:
 *   1. `requireApiKey`     — feature flag check; resolve credential.
 *   2. `requireApiScope`   — per-route canonical permission check.
 *   3. `runWithApiAudit`   — wrap the handler so success/failure status
 *      codes get recorded in api_credential_usage_logs (Phase 10.5)
 *      and rate-limit headers are set on success.
 *
 * Privacy: NEVER log the raw key, the Authorization header value, the
 * request body, or evidence-internal data. The audit row stores only
 * route/method/action + status + failure reason.
 *
 * Service-account actor clarity: `req.apiCredential` is the source of
 * truth for "actorType = service_account" — see uses of
 * `serviceAccountActor()` in route code.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  integrationsFeatureDisabledReason,
  scopesGrantPermission,
  verifyApiKeyDetailed,
} from "../services/integrations/api-keys.service.js";
import {
  safeRecordApiCredentialUsage,
  type ServiceAccountFailureReason,
} from "../services/integrations/api-key-usage.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
import { isIpAddressAllowed, type Permission } from "@proovra/shared";

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 120;

function readRateLimitConfig(): { windowSec: number; max: number } {
  const rawWindow = process.env.INTEGRATION_API_RATE_LIMIT_WINDOW_MS;
  const rawMax = process.env.INTEGRATION_API_RATE_LIMIT_MAX;
  const windowMs = (() => {
    const n = rawWindow ? Number.parseInt(rawWindow, 10) : NaN;
    if (!Number.isFinite(n) || n < 1_000) return DEFAULT_RATE_LIMIT_WINDOW_MS;
    return Math.min(n, 60 * 60 * 1000); // cap at 1h
  })();
  const max = (() => {
    const n = rawMax ? Number.parseInt(rawMax, 10) : NaN;
    if (!Number.isFinite(n) || n < 1) return DEFAULT_RATE_LIMIT_MAX;
    return Math.min(n, 100_000);
  })();
  return { windowSec: Math.max(1, Math.floor(windowMs / 1000)), max };
}

function readBearerToken(req: FastifyRequest): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("Bearer ")) return null;
  const tok = raw.slice(7).trim();
  return tok.length > 0 ? tok : null;
}

/**
 * Verify the inbound Bearer API key, enforce the per-credential rate
 * limit, and populate `req.apiCredential`. Returns true on success
 * (handler may continue); returns false after writing 401/429/503.
 *
 * Failed verifications (missing bearer, invalid key, scope denial)
 * cannot be safely audited because we don't know which credential
 * was being attempted. Successful verifications populate
 * `req.apiCredential` so downstream `runWithApiAudit` can log the
 * outcome.
 */
export async function requireApiKey(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const disabledReason = integrationsFeatureDisabledReason();
  if (disabledReason) {
    reply.code(503).send({
      error: { code: "INTEGRATIONS_DISABLED", reason: disabledReason },
    });
    return false;
  }

  const token = readBearerToken(req);
  if (!token) {
    reply.code(401).send({
      error: { code: "UNAUTHORIZED", message: "Missing Bearer token." },
    });
    return false;
  }

  const verified = await verifyApiKeyDetailed(token);
  if (!verified.ok) {
    // Phase 17 — surface precise reasons in audit while keeping the
    // public response generic (no oracle for "this key existed but was
    // disabled" vs "this key was never valid"). Only 401 is ever
    // emitted; the reason goes to the security event log.
    if (verified.reason === "disabled" || verified.reason === "expired" || verified.reason === "revoked") {
      safeEmitSecurityEvent({
        teamId: null,
        eventType: "permission_denied",
        severity: "WARNING",
        details: {
          source: "integrations_auth",
          reason: verified.reason,
        },
      });
    }
    reply.code(401).send({
      error: { code: "UNAUTHORIZED", message: "Invalid API key." },
    });
    return false;
  }
  const credential = verified.credential;

  // Phase 17 — per-credential CIDR allowlist enforcement. Empty list
  // means no restriction (existing behavior). Failures fail closed and
  // are audited.
  if (credential.ipAllowlist.length > 0) {
    const clientIp = (req.ip ?? "").trim();
    if (!isIpAddressAllowed(clientIp, credential.ipAllowlist)) {
      safeEmitSecurityEvent({
        teamId: credential.teamId,
        eventType: "permission_denied",
        severity: "HIGH",
        apiCredentialId: credential.credentialId,
        details: {
          source: "integrations_auth",
          reason: "ip_not_allowed",
          ip: clientIp || null,
        },
      });
      // Phase 19 — IP allowlist violations are high-weight risk signals
      // on the service account itself. Recorded best-effort; failures
      // never break the deny path. Dynamic import keeps the
      // dependency graph linear (this middleware does NOT import the
      // identity-security service at module-load time).
      void (async () => {
        try {
          const { recordRiskSignal } = await import(
            "../services/identity-security/risk.service.js"
          );
          await recordRiskSignal({
            teamId: credential.teamId,
            subjectKind: "SERVICE_ACCOUNT",
            subjectApiCredentialId: credential.credentialId,
            signalKind: "SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION",
            reason: `API request from IP outside per-credential allowlist (${clientIp || "unknown"}).`,
            ip: clientIp || null,
          });
        } catch {
          /* best-effort */
        }
      })();
      safeRecordApiCredentialUsage({
        apiCredentialId: credential.credentialId,
        teamId: credential.teamId,
        routePath: req.routeOptions?.url ?? req.url,
        method: req.method,
        action: "ip_denied",
        statusCode: 403,
        success: false,
        failureReason: "governance_blocked",
        requestId: req.id ?? null,
      });
      reply.code(403).send({
        error: { code: "FORBIDDEN", message: "Client IP not allowed." },
      });
      return false;
    }
  }

  // Per-credential rate limit. Key is namespaced so it cannot collide
  // with auth-route or user-route limits elsewhere.
  const { windowSec, max } = readRateLimitConfig();
  let allowed = true;
  let resetAtMs = Date.now() + windowSec * 1000;
  try {
    const result = await enforceRateLimit({
      key: `integration_api:credential:${credential.credentialId}`,
      max,
      windowSec,
    });
    allowed = result.allowed;
    resetAtMs = result.resetAtMs;
    reply.header("x-ratelimit-limit", String(max));
    reply.header(
      "x-ratelimit-remaining",
      String(Math.max(0, result.remaining)),
    );
    reply.header(
      "x-ratelimit-reset",
      String(Math.floor(resetAtMs / 1000)),
    );
  } catch {
    // Fail open on rate-limiter outage — better to serve traffic than
    // wedge the whole integration surface. Internal monitoring should
    // surface persistent Redis errors via the existing helper.
  }

  if (!allowed) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((resetAtMs - Date.now()) / 1000),
    );
    reply.header("retry-after", String(retryAfterSec));
    reply.code(429).send({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests for this API key.",
      },
    });
    // Audit the rate-limited rejection — caller IS known.
    safeRecordApiCredentialUsage({
      apiCredentialId: credential.credentialId,
      teamId: credential.teamId,
      routePath: req.routeOptions?.url ?? req.url,
      method: req.method,
      action: "rate_limited",
      statusCode: 429,
      success: false,
      failureReason: "rate_limited",
      requestId: req.id ?? null,
    });
    return false;
  }

  req.apiCredential = {
    credentialId: credential.credentialId,
    teamId: credential.teamId,
    scopes: credential.scopes,
    ipAllowlist: credential.ipAllowlist,
    rotationRequired: credential.rotationRequired,
    environment: credential.environment,
    expiresAtUtc: credential.expiresAtUtc,
  };
  if (credential.rotationRequired) {
    // Surface the rotation hint to the caller; never blocks the request.
    reply.header("x-proovra-rotation-required", "true");
  }
  req.log = req.log.child({
    apiCredentialId: credential.credentialId,
    teamId: credential.teamId,
    actorType: "service_account",
  });
  return true;
}

/**
 * Enforce that the verified credential carries `permission` in its
 * scope list. Writes 403 on failure (and audits) and returns false.
 */
export function requireApiScope(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): boolean {
  const cred = req.apiCredential;
  if (!cred) {
    reply.code(401).send({
      error: { code: "UNAUTHORIZED", message: "API key required." },
    });
    return false;
  }
  if (!scopesGrantPermission(cred.scopes, permission)) {
    reply.code(403).send({
      error: { code: "INSUFFICIENT_SCOPE", requiredScope: permission },
    });
    safeRecordApiCredentialUsage({
      apiCredentialId: cred.credentialId,
      teamId: cred.teamId,
      routePath: req.routeOptions?.url ?? req.url,
      method: req.method,
      action: `scope:${permission}`,
      statusCode: 403,
      success: false,
      failureReason: "scope_denied",
      requestId: req.id ?? null,
    });
    return false;
  }
  return true;
}

/**
 * Wrap a route handler so its final HTTP status is recorded in
 * api_credential_usage_logs. Call it ONCE per route. The action label
 * is a short canonical identifier ("evidence.list", "intake_link.create"
 * etc.) — keep it stable so operators can filter by it.
 *
 * If `req.apiCredential` is not populated (auth never ran), the wrap
 * still calls the handler but records nothing.
 */
export async function runWithApiAudit(
  req: FastifyRequest,
  reply: FastifyReply,
  action: string,
  handler: () => Promise<unknown> | unknown,
): Promise<unknown> {
  const before = Date.now();
  try {
    const result = await handler();
    const cred = req.apiCredential;
    if (cred) {
      // Fastify writes the status when the reply is sent; if the
      // handler returned without sending, statusCode may still be 200.
      const code = reply.statusCode || 200;
      safeRecordApiCredentialUsage({
        apiCredentialId: cred.credentialId,
        teamId: cred.teamId,
        routePath: req.routeOptions?.url ?? req.url,
        method: req.method,
        action,
        statusCode: code,
        success: code >= 200 && code < 400,
        failureReason:
          code >= 400 ? classifyStatusFailure(code) : null,
        requestId: req.id ?? null,
      });
    }
    return result;
  } catch (err) {
    const cred = req.apiCredential;
    const code = reply.statusCode && reply.statusCode >= 400
      ? reply.statusCode
      : 500;
    if (cred) {
      safeRecordApiCredentialUsage({
        apiCredentialId: cred.credentialId,
        teamId: cred.teamId,
        routePath: req.routeOptions?.url ?? req.url,
        method: req.method,
        action,
        statusCode: code,
        success: false,
        failureReason: "internal_error",
        requestId: req.id ?? null,
      });
    }
    throw err;
  } finally {
    // Latency observation goes nowhere for now — kept to make
    // future histogram wiring trivial.
    void before;
  }
}

function classifyStatusFailure(
  status: number,
): ServiceAccountFailureReason | null {
  if (status === 404) return "not_found";
  if (status === 422 || status === 400) return "validation_failed";
  if (status === 403) return "governance_blocked";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal_error";
  return null;
}

/**
 * Build a structured actor descriptor for log lines / audit metadata
 * so service-account actions are never confused with human users.
 */
export function serviceAccountActor(req: FastifyRequest): {
  actorType: "service_account";
  apiCredentialId: string;
  teamId: string;
} | null {
  const cred = req.apiCredential;
  if (!cred) return null;
  return {
    actorType: "service_account",
    apiCredentialId: cred.credentialId,
    teamId: cred.teamId,
  };
}
