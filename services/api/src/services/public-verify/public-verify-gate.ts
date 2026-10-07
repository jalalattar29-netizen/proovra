/**
 * THE PUBLIC VERIFY GATE — the bounded, anonymous admission every Public Verify
 * read goes through: the record page (`/public/verify/:id`) and PROOVRA's
 * public package record (`/public/verification-packages/...`).
 *
 * One limiter configuration, one bucket family, one 429 envelope, one logging
 * rule, so the package record is an extension of Public Verify — not a second
 * verify product with its own budget an attacker could add to the first.
 *
 *   Layer 1 (per client): defends against scraping an identifier space. Keyed
 *     on the canonical resolved client, never raw `req.ip` (PHASE 13 §1), and
 *     SHARED by every Public Verify read: a client's record lookups and package
 *     lookups draw on the same budget.
 *   Layer 2 (per target): DISTINCT CLIENTS per window for one record or one
 *     package (ET-PKG-17) — a rotating-IP enumeration of one target is bounded
 *     without letting two clients lock legitimate viewers out.
 *
 * Both budgets are global across replicas (UC-SEC-006). Logs carry the bucket
 * and timing only — never the client address (the span rule of Public Verify).
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { trustedClientIpKey } from "../../middleware/client-ip.js";
import { enforceDistinctClientLimit, enforceRateLimit } from "../rate-limit.js";

function readPositiveIntEnv(name: string, fallback: number): number {
  const n = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-client limit. Phase 1 — tightened defaults: 30/min sustained,
 * configurable (VERIFY_RATE_LIMIT_MAX / _WINDOW_SEC).
 */
export function getPublicVerifyClientLimit() {
  return {
    max: readPositiveIntEnv("VERIFY_RATE_LIMIT_MAX", 30),
    windowSec: readPositiveIntEnv("VERIFY_RATE_LIMIT_WINDOW_SEC", 60),
  };
}

/** Per-target distinct-client limit (VERIFY_RATE_LIMIT_PER_EVIDENCE_*). */
export function getPublicVerifyTargetLimit() {
  return {
    max: readPositiveIntEnv("VERIFY_RATE_LIMIT_PER_EVIDENCE_MAX", 60),
    windowSec: readPositiveIntEnv("VERIFY_RATE_LIMIT_PER_EVIDENCE_WINDOW_SEC", 60),
  };
}

/** The Public Verify 429 envelope. */
export const PUBLIC_VERIFY_RATE_LIMITED = { code: "RATE_LIMITED", message: "Rate limit exceeded" } as const;

function refuse(req: FastifyRequest, reply: FastifyReply, bucket: string, resetAtMs: number, extra: Record<string, unknown> = {}) {
  const retryAfter = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
  req.log.warn({ bucket, remaining: 0, resetAtMs, retryAfterSec: retryAfter, ...extra }, "public_verify.rate_limited");
  reply.header("Retry-After", String(retryAfter));
  void reply.code(429).send(PUBLIC_VERIFY_RATE_LIMITED);
}

/**
 * Layer 1. Returns false (and has sent the 429) when the client is over its
 * shared Public Verify budget. Runs BEFORE the identifier is parsed, so a
 * scraper of malformed identifiers spends the same budget.
 */
export async function admitPublicVerifyClient(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const limit = getPublicVerifyClientLimit();
  const r = await enforceRateLimit({
    key: `ratelimit:verify:ip:${trustedClientIpKey(req)}`,
    max: limit.max,
    windowSec: limit.windowSec,
    bound: "global",
  });
  if (r.allowed) return true;
  refuse(req, reply, "ip", r.resetAtMs);
  return false;
}

/**
 * Layer 2. Returns false (and has sent the 429) when too many distinct clients
 * asked for this one target in the window. Runs AFTER validation, so
 * unparseable input never consumes a target slot.
 */
export async function admitPublicVerifyTarget(
  req: FastifyRequest,
  reply: FastifyReply,
  target: { kind: "evidence" | "package"; id: string },
): Promise<boolean> {
  const limit = getPublicVerifyTargetLimit();
  const r = await enforceDistinctClientLimit({
    key:
      target.kind === "evidence"
        ? `ratelimit:verify:evidence-clients:${target.id}`
        : `ratelimit:verify:package-clients:${target.id}`,
    member: trustedClientIpKey(req),
    max: limit.max,
    windowSec: limit.windowSec,
    bound: "global",
  });
  if (r.allowed) return true;
  refuse(req, reply, target.kind, r.resetAtMs, target.kind === "evidence" ? { evidenceId: target.id } : {});
  return false;
}
