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
 *  2. Secret NOT configured:
 *       - In production → 503 CONFIGURATION_ERROR (fail closed).
 *       - In non-production → allow authenticated OWNER/ADMIN only.
 *
 * Never log the secret. Constant-time compare on the hex/bytes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";

export const NOTIFICATION_CRON_HEADER = "x-proovra-cron-secret";
export const INTEGRATION_CRON_HEADER = "x-proovra-integration-cron-secret";

const NOTIFICATION_SECRET_ENV = "NOTIFICATION_CRON_SECRET";
const INTEGRATION_SECRET_ENV = "INTEGRATION_CRON_SECRET";

function readSecret(env: string): string | null {
  const v = process.env[env];
  return v && v.trim().length >= 16 ? v.trim() : null;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
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

async function fallbackAdminCheck(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  // Only used in non-production. Requires authenticated OWNER/ADMIN on
  // ANY workspace — cron routes are workspace-agnostic.
  try {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findFirst({
      where: { userId, role: { in: ["OWNER", "ADMIN"] } },
    });
    if (!membership) {
      reply.code(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Cron secret not configured; non-production fallback requires OWNER/ADMIN.",
        },
      });
      return false;
    }
    return true;
  } catch {
    reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required.",
      },
    });
    return false;
  }
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

  // No secret configured.
  if (isProduction()) {
    reply.code(503).send({
      error: {
        code: "CONFIGURATION_ERROR",
        message: `Cron secret (${envName}) is required in production.`,
      },
    });
    return false;
  }

  return fallbackAdminCheck(req, reply);
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
