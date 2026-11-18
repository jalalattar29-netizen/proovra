/**
 * WS-REL — anonymous traffic no longer writes one durable row per request.
 *
 *  - PRO-O1-02 / B5B-F-505: an anonymous Public Verify audit is chained once
 *    per (record, outcome) window; concurrent first views claim exactly one.
 *  - PRO-N1-11: the analytics intake writes at most one rejection
 *    SecurityEvent per client and reason per window (the metric still counts
 *    every rejection).
 *
 * The real analytics route on a bare Fastify app; only the SecurityEvent sink
 * and the analytics writer are doubles. The limiter/lease store is the real
 * module (memory or the local test Redis).
 */
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ securityEvents: [] as Array<Record<string, unknown>> }));

vi.mock("../src/services/security/security-event.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/security/security-event.service.js")>();
  return {
    ...actual,
    safeEmitSecurityEvent: (e: Record<string, unknown>) => {
      H.securityEvents.push(e);
    },
  };
});
vi.mock("../src/db.js", () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) }),
}));

import analyticsRoutes from "../src/routes/analytics.routes.js";
import { claimPublicVerifyAuditSlot } from "../src/services/public-verify/public-verify-audit-coalescer.js";
import { clearAllRateLimitBuckets } from "../src/services/rate-limit.js";

beforeEach(async () => {
  H.securityEvents.length = 0;
  await clearAllRateLimitBuckets();
});
afterAll(async () => {
  await clearAllRateLimitBuckets();
});

describe("PRO-O1-02 anonymous Verify audits are coalesced per record and outcome", () => {
  it("100 views of one record in a window claim one chain slot", async () => {
    const resourceId = `rec-${Math.random().toString(36).slice(2)}`;
    let claimed = 0;
    for (let i = 0; i < 100; i += 1) {
      if (await claimPublicVerifyAuditSlot({ action: "verification.page_opened", outcome: "success", reason: null, resourceId })) {
        claimed += 1;
      }
    }
    expect(claimed).toBe(1);
  });

  it("concurrent first views claim exactly one slot", async () => {
    const resourceId = `rec-${Math.random().toString(36).slice(2)}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimPublicVerifyAuditSlot({ action: "verification.page_opened", outcome: "success", reason: null, resourceId }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a denial is still recorded once, independently of the record's successes", async () => {
    const resourceId = `rec-${Math.random().toString(36).slice(2)}`;
    expect(
      await claimPublicVerifyAuditSlot({ action: "verification.page_opened", outcome: "success", reason: null, resourceId }),
    ).toBe(true);
    expect(
      await claimPublicVerifyAuditSlot({ action: "verification.page_opened", outcome: "denied", reason: "share_link_gone", resourceId }),
    ).toBe(true);
    expect(
      await claimPublicVerifyAuditSlot({ action: "verification.page_opened", outcome: "denied", reason: "share_link_gone", resourceId }),
    ).toBe(false);
  });
});

describe("PRO-N1-11 analytics rejections write at most one SecurityEvent per client and reason", () => {
  it("40 invalid payloads from one address produce one rejection row", async () => {
    const app = Fastify();
    await app.register(analyticsRoutes);
    await app.ready();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/analytics/track",
        remoteAddress: "203.0.113.77",
        headers: { "content-type": "application/json" },
        payload: { eventType: "not_an_allowed_event", visitorId: `v-${i}` },
      });
      statuses.push(res.statusCode);
    }
    // 30/min per address: 30 invalid (422) then rate-limited (429).
    expect(statuses.filter((s) => s === 422).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const rejections = H.securityEvents.filter((e) => e.eventType === "analytics_request_rejected");
    const reasons = rejections.map((e) => (e.details as { reason: string }).reason);
    // One per reason (invalid payload class, rate_limited_ip), never one per request.
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(rejections.length).toBeLessThanOrEqual(2);
    await app.close();
  });
});
