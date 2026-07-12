/**
 * Phase A8 — AI endpoint rate limiting + deduplication (behavioral).
 *
 * Uses the real limiter (in-memory fallback when Redis is absent) to prove the
 * per-user burst cap trips and that an identical fingerprint is deduped.
 */
import { describe, expect, it } from "vitest";

import { enforceAiEndpointGuard } from "../src/services/ai/ai-rate-limit.service.js";

// Unique feature/user per test so buckets don't collide across cases.
let seq = 0;
function uid(): string {
  seq += 1;
  return `u-${seq}-${Math.floor(performance.now())}`;
}

describe("Phase A8 — per-user burst rate limit", () => {
  it("allows up to the cap then returns 429 AI_RATE_LIMITED", async () => {
    const userId = uid();
    const feature = `t-${seq}`;
    const cap = 3;
    const results = [];
    for (let i = 0; i < cap + 2; i++) {
      results.push(
        await enforceAiEndpointGuard({
          feature,
          userId,
          ip: "10.0.0.1",
          userPerMin: cap,
          ipPerMin: 1000,
        }),
      );
    }
    const allowed = results.filter((r) => r.allowed).length;
    const blocked = results.filter((r) => !r.allowed);
    expect(allowed).toBe(cap);
    expect(blocked.length).toBe(2);
    expect(blocked[0]).toMatchObject({ allowed: false, scope: "user", code: "AI_RATE_LIMITED" });
    expect((blocked[0] as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
  });
});

describe("Phase A8 — deduplication", () => {
  it("collapses an identical fingerprint within the window", async () => {
    const userId = uid();
    const feature = `d-${seq}`;
    const first = await enforceAiEndpointGuard({
      feature,
      userId,
      ip: "10.0.0.2",
      userPerMin: 100,
      ipPerMin: 100,
      dedupeKey: "ev-1:v2",
      dedupeWindowSec: 30,
    });
    const second = await enforceAiEndpointGuard({
      feature,
      userId,
      ip: "10.0.0.2",
      userPerMin: 100,
      ipPerMin: 100,
      dedupeKey: "ev-1:v2",
      dedupeWindowSec: 30,
    });
    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({ allowed: false, scope: "duplicate", code: "AI_DUPLICATE_REQUEST" });
  });

  it("a different fingerprint is not deduped", async () => {
    const userId = uid();
    const feature = `d2-${seq}`;
    const a = await enforceAiEndpointGuard({ feature, userId, ip: "10.0.0.3", userPerMin: 100, ipPerMin: 100, dedupeKey: "ev-1:v2" });
    const b = await enforceAiEndpointGuard({ feature, userId, ip: "10.0.0.3", userPerMin: 100, ipPerMin: 100, dedupeKey: "ev-1:v3" });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});
