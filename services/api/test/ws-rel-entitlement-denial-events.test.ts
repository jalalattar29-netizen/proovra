/**
 * WS-REL / PRO-BL2-08 — an unentitled feature check is not a policy violation
 * on every request: a READ writes nothing, and a refused WRITE records one
 * event per (workspace, key, actor) per window.
 *
 * The real assertFeatureEntitlement over an empty entitlement store (the
 * catalogue default: not entitled); the lifecycle event sink is a double.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));

vi.mock("../src/services/intelligence/intelligence-activity.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/intelligence/intelligence-activity.service.js")>()),
  emitLifecycleEvent: async (e: Record<string, unknown>) => {
    H.events.push(e);
  },
}));

import { assertFeatureEntitlement } from "../src/services/packaging/entitlement.service.js";
import { clearAllRateLimitBuckets } from "../src/services/rate-limit.js";

const prisma = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) }) as never;
const team = () => `team-${Math.random().toString(36).slice(2)}`;

beforeEach(async () => {
  H.events.length = 0;
  await clearAllRateLimitBuckets();
});

describe("PRO-BL2-08 entitlement denial events", () => {
  it("an unentitled READ (record: false) refuses and writes nothing", async () => {
    const teamId = team();
    for (let i = 0; i < 5; i += 1) {
      const r = await assertFeatureEntitlement({ prisma, teamId, key: "FEATURE_LIFECYCLE_DASHBOARD", actorUserId: "u1", record: false });
      expect(r.ok).toBe(false);
    }
    expect(H.events).toHaveLength(0);
  });

  it("repeated refused WRITES by one actor record one event per window; another actor is its own", async () => {
    const teamId = team();
    for (let i = 0; i < 10; i += 1) {
      await assertFeatureEntitlement({ prisma, teamId, key: "FEATURE_WEBHOOKS", actorUserId: "u1" });
    }
    await assertFeatureEntitlement({ prisma, teamId, key: "FEATURE_WEBHOOKS", actorUserId: "u2" });
    expect(H.events).toHaveLength(2);
    expect(H.events[0]).toMatchObject({ teamId, code: "POLICY_VIOLATION_ENTITLEMENT" });
  });
});
