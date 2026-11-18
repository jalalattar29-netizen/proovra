/**
 * Phase 10 — Cron-secret middleware.
 *
 * Protects "operator/cron-driven" endpoints (retry sweepers, reminder
 * scheduler, webhook delivery sweeper) so they cannot be triggered by
 * an authenticated end-user in production.
 *
 * Two modes:
 *
 *  1. Secret configured: the request MUST present the matching header
 *     `x-proovra-cron-secret` (or `x-proovra-integration-cron-secret`
 *     for integration cron routes). Wrong/missing → 401.
 *
 *  2. Secret NOT configured → 503 CONFIGURATION_ERROR in EVERY environment
 *     (fail closed, retryable once the operator sets the secret).
 *
 *     WS-SCHED / PRO-W2-13: there used to be a non-production fallback that
 *     admitted any ACTIVE OWNER/ADMIN of ANY workspace when `req.user` was
 *     set. Every account owns a personal workspace, so that fallback bound a
 *     platform-wide machine sweep to "any signed-in person" — not to the swept
 *     scope. These entries are machine-only; a session is never a credential
 *     for them. Local development sets the secret (B7A-F-008).
 *
 * Never log the secret. Constant-time compare on the hex/bytes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

// OPS-006 — header names come from the ONE shared definition the worker
// callers import too. Re-exported so existing API importers keep working.
import { INTEGRATION_CRON_HEADER, NOTIFICATION_CRON_HEADER, REVIEWER_OPS_CRON_HEADER } from "@proovra/shared";
export { INTEGRATION_CRON_HEADER, NOTIFICATION_CRON_HEADER, REVIEWER_OPS_CRON_HEADER };
// Search-reindex production-safe internal endpoint
// (`POST /v1/internal/search/reindex`). Header + env-var pair follows
// the existing cron-secret pattern: same constant-time compare via
// `checkCronSecret`, same fail-closed posture (no session fallback).
export const SEARCH_REINDEX_HEADER = "x-internal-secret";

const NOTIFICATION_SECRET_ENV = "NOTIFICATION_CRON_SECRET";
const INTEGRATION_SECRET_ENV = "INTEGRATION_CRON_SECRET";
const SEARCH_REINDEX_SECRET_ENV = "SEARCH_REINDEX_SECRET";

function readSecret(env: string): string | null {
  const v = process.env[env];
  return v && v.trim().length >= 16 ? v.trim() : null;
}

/**
 * FINAL-003 (2026-08-15) — the shared-secret primitive, exported.
 *
 * Two reconcile entrypoints (`POST /v1/reviewer-ops/reconcile` and the dual-mode
 * sweeps in `admin-identity.routes.ts`) each grew their OWN `x-cron-secret`
 * check, both comparing with `!==` on the raw string and both accepting a
 * secret of any length. That is three implementations of one security decision:
 * the comparison leaked length and prefix through timing, and a two-character
 * `INTEGRATION_CRON_SECRET` that this module would have refused as too weak was
 * silently honoured there. They now call these two functions, so the constant-
 * time compare and the 16-character floor are properties of the SYSTEM rather
 * than of whichever call site was written most recently.
 */
export function readCronSecretFromEnvs(envNames: readonly string[]): string | null {
  for (const name of envNames) {
    const v = readSecret(name);
    if (v !== null) return v;
  }
  return null;
}

/** Constant-time equality for a shared cron/internal secret. */
export function cronSecretMatches(
  expected: string | null,
  provided: unknown,
): boolean {
  if (expected === null || expected.length === 0) return false;
  if (typeof provided !== "string") return false;
  const got = provided.trim();
  if (got.length === 0) return false;
  return constantTimeEqual(expected, got);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const ah = createHmac("sha256", "proovra-cron").update(a).digest();
    const bh = createHmac("sha256", "proovra-cron").update(b).digest();
    return timingSafeEqual(ah, bh);
  } catch {
    return false;
  }
}

function readHeader(
  req: FastifyRequest,
  name: string,
): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0]?.trim() ?? null;
  if (typeof raw === "string") return raw.trim();
  return null;
}

async function checkCronSecret(
  req: FastifyRequest,
  reply: FastifyReply,
  envName: string,
  headerName: string,
): Promise<boolean> {
  const expected = readSecret(envName);
  const provided = readHeader(req, headerName);

  if (expected) {
    if (!provided || !constantTimeEqual(expected, provided)) {
      reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid cron credential." },
      });
      return false;
    }
    return true;
  }

  // No secret configured: fail closed in every environment (PRO-W2-13).
  reply.code(503).send({
    error: {
      code: "CONFIGURATION_ERROR",
      message: `Cron secret (${envName}) is not configured.`,
    },
  });
  return false;
}

export function requireNotificationCronSecret(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  return checkCronSecret(
    req,
    reply,
    NOTIFICATION_SECRET_ENV,
    NOTIFICATION_CRON_HEADER,
  );
}

export function requireIntegrationCronSecret(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  return checkCronSecret(
    req,
    reply,
    INTEGRATION_SECRET_ENV,
    INTEGRATION_CRON_HEADER,
  );
}

/**
 * Search-reindex internal-only authentication gate.
 *
 * Used by `POST /v1/internal/search/reindex` — the no-user-auth
 * production-safe surface for forcibly populating
 * `evidence_search_documents` when an existing workspace has zero
 * indexed rows. Symmetrical guarantees to the other two cron-secret
 * checks:
 *
 *   - Constant-time HMAC comparison via `checkCronSecret`.
 *   - Fails closed in every environment when SEARCH_REINDEX_SECRET is
 *     unset (503 CONFIGURATION_ERROR), so a misconfigured deploy can
 *     never silently expose the surface; local dev sets the secret.
 *   - Header is `x-internal-secret`. Env var is
 *     `SEARCH_REINDEX_SECRET`.
 *
 * The endpoint itself is REGISTERED unconditionally — only this gate
 * decides whether a request can reach the handler.
 */
export function requireSearchReindexSecret(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  return checkCronSecret(
    req,
    reply,
    SEARCH_REINDEX_SECRET_ENV,
    SEARCH_REINDEX_HEADER,
  );
}
