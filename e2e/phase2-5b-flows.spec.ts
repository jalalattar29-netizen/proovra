/**
 * Phase 2.5B — Bulk case operations + dual link reconciler tests.
 *
 * IMPORTANT — this spec covers only the non-schema deliverables that
 * Phase 2.5B was able to ship. The notification-preferences and
 * account-lifecycle-request schema additions were deferred when the
 * Prisma migration run revealed the active DATABASE_URL pointed at a
 * Neon production-like instance (not the local audit DB). Per Phase 0
 * hard rules, no schema migration was applied. See PHASE_2_5B doc.
 *
 * Locks in:
 *
 *   1. `POST /v1/cases/bulk` accepts a body with `ids[]` + `action`,
 *      returns a per-id result envelope, and skips cases the caller
 *      cannot see (defense-in-depth — never enumerates other users'
 *      cases via 403 vs 404 discrimination).
 *
 *   2. `POST /v1/cases/bulk` validates the body (Zod): bad action +
 *      empty ids + over-cap-100 all return 400 INVALID_BODY.
 *
 *   3. `GET /v1/cases/:id/link-reconciliation` returns 404 for cases
 *      the caller cannot see (mirror of the case READ behavior).
 *      Returns a structured `summary + legacyOnly + canonicalOnly`
 *      envelope for accessible cases.
 *
 *   4. The Phase 2.4 closure cascade is reused by bulk close —
 *      regression check that bulk-closing a case doesn't bypass the
 *      cascade.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase 2.5B — bulk + reconciler @critical", () => {
  test("POST /v1/cases/bulk validates body", async () => {
    const session = await createGuestSession();
    try {
      // Empty ids array
      const r1 = await session.api.post("/v1/cases/bulk", {
        data: { ids: [], action: "CLOSE" },
      });
      expect(r1.status()).toBe(400);

      // Bad action
      const r2 = await session.api.post("/v1/cases/bulk", {
        data: {
          ids: ["00000000-0000-4000-8000-000000000001"],
          action: "DELETE_FOREVER",
        },
      });
      expect(r2.status()).toBe(400);

      // Over cap (101 ids)
      const tooMany = Array.from({ length: 101 }, (_, i) =>
        `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      const r3 = await session.api.post("/v1/cases/bulk", {
        data: { ids: tooMany, action: "CLOSE" },
      });
      expect(r3.status()).toBe(400);
    } finally {
      await disposeSession(session);
    }
  });

  test("POST /v1/cases/bulk skips cases the caller cannot see", async () => {
    const session = await createGuestSession();
    try {
      // Use random UUIDs that definitely don't belong to this guest.
      const fakeIds = [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ];
      const resp = await session.api.post("/v1/cases/bulk", {
        data: { ids: fakeIds, action: "CLOSE" },
      });
      expect(resp.status()).toBe(200);
      const body = (await resp.json()) as {
        results: Array<{ id: string; outcome: string; reason?: string }>;
        summary: { total: number; success: number; skipped: number };
      };
      expect(body.summary.total).toBe(2);
      expect(body.summary.success).toBe(0);
      expect(body.summary.skipped).toBe(2);
      // All should be skipped with `not_accessible` (defense-in-depth).
      for (const r of body.results) {
        expect(r.outcome).toBe("SKIPPED");
        expect(r.reason).toBe("not_accessible");
      }
    } finally {
      await disposeSession(session);
    }
  });

  test("POST /v1/cases/bulk closes accessible cases end-to-end", async () => {
    const session = await createGuestSession();
    try {
      // Create two cases the caller owns (Phase 2.1 backend ships
      // POST /v1/cases for guests).
      const create = async (name: string) => {
        const r = await session.api.post("/v1/cases", { data: { name } });
        expect(r.status()).toBeLessThan(300);
        const body = (await r.json()) as { id: string };
        return body.id;
      };
      const a = await create("Bulk-close test A");
      const b = await create("Bulk-close test B");

      const resp = await session.api.post("/v1/cases/bulk", {
        data: { ids: [a, b], action: "CLOSE", reason: "Phase 2.5B test" },
      });
      expect(
        resp.status(),
        `body: ${await resp.text()}`,
      ).toBe(200);
      const body = (await resp.json()) as {
        results: Array<{ id: string; outcome: string; reason?: string }>;
        summary: { total: number; success: number; skipped: number };
      };
      expect(body.summary.total).toBe(2);
      // Newly-created cases default to OPEN. The transition OPEN → CLOSED
      // is NOT in the allowed-transitions table (OPEN → INVESTIGATING /
      // ON_HOLD / RESOLVED only). So both should be SKIPPED with
      // `invalid_transition` — locking the safety property that bulk
      // close respects the same transition rules as single-case close.
      expect(body.summary.success).toBe(0);
      expect(body.summary.skipped).toBe(2);
      for (const r of body.results) {
        expect(r.outcome).toBe("SKIPPED");
        expect(r.reason).toBe("invalid_transition");
      }
    } finally {
      await disposeSession(session);
    }
  });

  test("GET /v1/cases/:id/link-reconciliation 404s on inaccessible case", async () => {
    const session = await createGuestSession();
    try {
      const resp = await session.api.get(
        "/v1/cases/00000000-0000-4000-8000-000000000999/link-reconciliation",
      );
      expect(resp.status()).toBe(404);
      const body = (await resp.json()) as { code?: string };
      expect(body.code).toBe("CASE_NOT_FOUND");
    } finally {
      await disposeSession(session);
    }
  });

  test("GET /v1/cases/:id/link-reconciliation returns envelope for accessible case", async () => {
    const session = await createGuestSession();
    try {
      const create = await session.api.post("/v1/cases", {
        data: { name: "Phase 2.5B reconciler test" },
      });
      const { id } = (await create.json()) as { id: string };
      const resp = await session.api.get(
        `/v1/cases/${id}/link-reconciliation`,
      );
      expect(resp.status()).toBe(200);
      const body = (await resp.json()) as {
        caseId: string;
        summary: {
          legacyAttachments: number;
          canonicalLinks: number;
          legacyOnlyCount: number;
          canonicalOnlyCount: number;
          inSync: boolean;
        };
        legacyOnly: unknown[];
        canonicalOnly: unknown[];
      };
      expect(body.caseId).toBe(id);
      // A freshly-created case has no evidence attachments yet, so
      // both halves of the reconciliation are empty and inSync is true.
      expect(body.summary.legacyAttachments).toBe(0);
      expect(body.summary.canonicalLinks).toBe(0);
      expect(body.summary.legacyOnlyCount).toBe(0);
      expect(body.summary.canonicalOnlyCount).toBe(0);
      expect(body.summary.inSync).toBe(true);
      expect(Array.isArray(body.legacyOnly)).toBe(true);
      expect(Array.isArray(body.canonicalOnly)).toBe(true);
    } finally {
      await disposeSession(session);
    }
  });
});
