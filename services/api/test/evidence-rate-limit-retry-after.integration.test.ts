/**
 * F-21 (Free-user audit, capacity) — a throttled evidence create / complete
 * says when to come back. Live PostgreSQL 16, real HTTP.
 *
 * On 2c84cad83 both 429s were `{ message: "Rate limit exceeded" }` with no
 * Retry-After, although the limiter had already computed its window reset, and
 * each refusal held the reply until the platform-wide audit-chain append had
 * committed. The refusal is still audited (blocked outcome, bounded reason).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const PLANS = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const;
const LARGEST_TIER_MAX = 120;

describe("evidence create/complete 429 carries Retry-After (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let enforceRateLimit: (typeof import("../src/services/rate-limit.js"))["enforceRateLimit"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ enforceRateLimit } = await import("../src/services/rate-limit.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  /** Exhaust the route's bucket whatever plan sizes it (every tier max is ≤ 120). */
  async function exhaust(action: "create" | "complete", userId: string) {
    for (const plan of PLANS) {
      for (let i = 0; i < LARGEST_TIER_MAX; i += 1) {
        await enforceRateLimit({ key: `ratelimit:evidence:${action}:${plan}:${userId}`, max: LARGEST_TIER_MAX, windowSec: 60 });
      }
    }
  }

  async function blockedAuditRows(userId: string, action: string): Promise<number> {
    return prisma.adminAuditLog.count({ where: { userId, action, outcome: { not: "success" } } });
  }

  async function eventually(read: () => Promise<number>, atLeast: number): Promise<number> {
    let n = await read();
    for (let i = 0; i < 50 && n < atLeast; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      n = await read();
    }
    return n;
  }

  it("POST /v1/evidence throttled: 429 + Retry-After within the window, nothing created, refusal audited", async () => {
    const P = h.fixtures.personal;
    await exhaust("create", P.userId);
    const rowsBefore = await prisma.evidence.count({ where: { ownerUserId: P.userId } });
    const auditBefore = await blockedAuditRows(P.userId, "evidence.create");

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${P.token}` },
      payload: { type: "PHOTO", mimeType: "image/jpeg" },
    });
    expect(res.statusCode, res.body).toBe(429);
    const retryAfter = Number(res.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.json()).toEqual({ message: "Rate limit exceeded" });
    expect(await prisma.evidence.count({ where: { ownerUserId: P.userId } })).toBe(rowsBefore);
    expect(await eventually(() => blockedAuditRows(P.userId, "evidence.create"), auditBefore + 1)).toBe(auditBefore + 1);
  });

  it("POST /v1/evidence/:id/complete throttled: 429 + Retry-After, the record is not sealed, refusal audited", async () => {
    const P = h.fixtures.personal;
    await exhaust("complete", P.userId);
    const auditBefore = await blockedAuditRows(P.userId, "evidence.complete");
    const before = await prisma.evidence.findUniqueOrThrow({ where: { id: P.evidenceId }, select: { status: true } });

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${P.evidenceId}/complete`,
      headers: { authorization: `Bearer ${P.token}` },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(429);
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id: P.evidenceId }, select: { status: true } });
    expect(after.status).toBe(before.status);
    expect(await eventually(() => blockedAuditRows(P.userId, "evidence.complete"), auditBefore + 1)).toBe(auditBefore + 1);
  });
});
