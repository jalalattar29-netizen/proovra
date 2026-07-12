/**
 * Phase A8 — Canonical AI endpoint rate limiting + deduplication.
 *
 * One helper for every AI endpoint beyond chat (which already has its own
 * limiter): per-user + per-IP minute-scale burst caps plus a short-window
 * dedup on a stable request fingerprint (double-submit, page-refresh, retry
 * storm, unchanged-object reanalysis). Backed by the existing Redis/in-memory
 * rate limiter so it is multi-instance-safe where Redis is configured.
 */
import { createHash } from "node:crypto";

import { enforceRateLimit } from "../rate-limit.js";

export type AiRateDecision =
  | { allowed: true }
  | {
      allowed: false;
      scope: "user" | "ip" | "duplicate";
      code: "AI_RATE_LIMITED" | "AI_DUPLICATE_REQUEST";
      retryAfterSec: number;
    };

function retryAfter(resetAtMs: number): number {
  return Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
}

export async function enforceAiEndpointGuard(input: {
  feature: string; // e.g. "capture-session", "capture-item", "categorization"
  userId: string;
  ip: string;
  userPerMin?: number;
  ipPerMin?: number;
  /** Stable fingerprint (e.g. evidenceId + object version) enabling dedup. */
  dedupeKey?: string | null;
  dedupeWindowSec?: number;
}): Promise<AiRateDecision> {
  const userPerMin = input.userPerMin ?? 12;
  const ipPerMin = input.ipPerMin ?? 40;

  const user = await enforceRateLimit({
    key: `ratelimit:ai-${input.feature}:user:${input.userId}`,
    max: userPerMin,
    windowSec: 60,
  });
  if (!user.allowed) {
    return { allowed: false, scope: "user", code: "AI_RATE_LIMITED", retryAfterSec: retryAfter(user.resetAtMs) };
  }

  const ip = await enforceRateLimit({
    key: `ratelimit:ai-${input.feature}:ip:${input.ip}`,
    max: ipPerMin,
    windowSec: 60,
  });
  if (!ip.allowed) {
    return { allowed: false, scope: "ip", code: "AI_RATE_LIMITED", retryAfterSec: retryAfter(ip.resetAtMs) };
  }

  if (input.dedupeKey) {
    const fp = createHash("sha256")
      .update(`${input.userId}|${input.feature}|${input.dedupeKey}`)
      .digest("hex")
      .slice(0, 32);
    const dupe = await enforceRateLimit({
      key: `dedupe:ai-${input.feature}:${fp}`,
      max: 1,
      windowSec: input.dedupeWindowSec ?? 10,
    });
    if (!dupe.allowed) {
      return {
        allowed: false,
        scope: "duplicate",
        code: "AI_DUPLICATE_REQUEST",
        retryAfterSec: retryAfter(dupe.resetAtMs),
      };
    }
  }

  return { allowed: true };
}
