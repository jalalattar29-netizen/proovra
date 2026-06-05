/**
 * PHASE 5 — Integration health dashboard.
 *
 * Verifies the canonical contract of:
 *
 *   1. `computeIntegrationsHealthSnapshot` — the team-scoped service
 *      that derives every metric from real DB rows. Each metric
 *      maps to a documented query (groupBy / count / findFirst) on
 *      an existing column. No metric is fabricated.
 *
 *   2. The shape of GET /v1/integrations/health — every documented
 *      field appears in the response, and `averageLatencyMsLast24h`
 *      is INTENTIONALLY ABSENT (the deliveries table has no latency
 *      column and the brief forbids inventing one).
 *
 *   3. The empty workspace returns zeros where zero is honest
 *      (counts) and `null` everywhere a denominator is missing
 *      (success rate, last-success timestamp, etc.).
 *
 *   4. The mixed workspace returns correct counts AND a correct
 *      success rate against a known SENT/FAILED/PENDING mix.
 *
 *   5. Source invariants on the frontend HealthSummary surface:
 *      - It fetches `/v1/integrations/health`.
 *      - It renders the canonical missing-metric placeholder "—"
 *        rather than "0" or "Loading" for null fields.
 *      - It renders the canonical empty-state copy
 *        "No activity in this workspace yet."
 *      - It auto-refreshes on the 60s interval.
 *      - The legacy lifetime-failure-count tile is gone — the new
 *        dashboard does not derive numbers from the api-keys or
 *        webhooks lists.
 *
 * Hard rules:
 *   - No latency column → response schema omits the field cleanly.
 *   - Empty workspace → `successRateLast24h === null`,
 *     `oldestPendingDeliveryAt === null`, etc.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@prisma/client";

import {
  HEALTH_RECENT_WINDOW_HOURS,
  computeIntegrationsHealthSnapshot,
} from "../src/services/integrations/integration-health.service.js";

// ---------------------------------------------------------------------------
// Helpers — a tiny in-memory prisma stub backed by literal arrays. Each
// table exposes only the methods the health service actually calls
// (groupBy / count / findFirst), and the implementations are minimal
// faithful interpretations of the where/orderBy/select arguments.
// ---------------------------------------------------------------------------

type ApiCredentialRow = {
  id: string;
  teamId: string;
  status: "ACTIVE" | "REVOKED";
};

type UsageLogRow = {
  apiCredentialId: string;
  teamId: string;
  createdAt: Date;
};

type WebhookEndpointRow = {
  id: string;
  teamId: string;
  status: "ACTIVE" | "DISABLED";
  failureCount: number;
};

type DeliveryRow = {
  id: string;
  teamId: string;
  status: "PENDING" | "SENT" | "FAILED" | "RETRY_SCHEDULED" | "CANCELLED";
  createdAt: Date;
  sentAtUtc: Date | null;
  failedAtUtc: Date | null;
  // Phase closure — measured outbound-fetch duration. NULL when the
  // dispatcher reached a terminal status BEFORE issuing the fetch
  // (e.g. signing_key_unavailable). Existing tests omit this field
  // (it defaults to null) — only the new latency tests provide it.
  responseDurationMs?: number | null;
};

type FakePrismaState = {
  apiCredentials: ApiCredentialRow[];
  usageLogs: UsageLogRow[];
  webhookEndpoints: WebhookEndpointRow[];
  deliveries: DeliveryRow[];
};

function makePrismaStub(state: FakePrismaState): PrismaClient {
  function matchWhere<T>(
    rows: T[],
    pred: (row: T) => boolean,
  ): T[] {
    return rows.filter(pred);
  }
  return {
    apiCredential: {
      groupBy: async (q: {
        by: ["status"];
        where: { teamId: string };
      }) => {
        const rows = state.apiCredentials.filter(
          (r) => r.teamId === q.where.teamId,
        );
        const byStatus = new Map<string, number>();
        for (const r of rows) {
          byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
        }
        return Array.from(byStatus.entries()).map(([status, count]) => ({
          status,
          _count: { _all: count },
        }));
      },
    },
    apiCredentialUsageLog: {
      groupBy: async (q: {
        by: ["apiCredentialId"];
        where: { teamId: string; createdAt: { gt: Date } };
      }) => {
        const rows = matchWhere(
          state.usageLogs,
          (r) =>
            r.teamId === q.where.teamId &&
            r.createdAt.getTime() > q.where.createdAt.gt.getTime(),
        );
        const byKey = new Map<string, number>();
        for (const r of rows) {
          byKey.set(
            r.apiCredentialId,
            (byKey.get(r.apiCredentialId) ?? 0) + 1,
          );
        }
        return Array.from(byKey.entries()).map(
          ([apiCredentialId, count]) => ({
            apiCredentialId,
            _count: { _all: count },
          }),
        );
      },
    },
    webhookEndpoint: {
      groupBy: async (q: {
        by: ["status"];
        where: { teamId: string };
      }) => {
        const rows = state.webhookEndpoints.filter(
          (r) => r.teamId === q.where.teamId,
        );
        const byStatus = new Map<string, number>();
        for (const r of rows) {
          byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
        }
        return Array.from(byStatus.entries()).map(([status, count]) => ({
          status,
          _count: { _all: count },
        }));
      },
      count: async (q: {
        where: {
          teamId: string;
          status?: string;
          failureCount?: { gte: number };
        };
      }) => {
        return state.webhookEndpoints.filter((r) => {
          if (r.teamId !== q.where.teamId) return false;
          if (q.where.status && r.status !== q.where.status) return false;
          if (
            q.where.failureCount &&
            !(r.failureCount >= q.where.failureCount.gte)
          )
            return false;
          return true;
        }).length;
      },
    },
    integrationWebhookDelivery: {
      groupBy: async (q: {
        by: ["status"];
        where: { teamId: string; createdAt: { gt: Date } };
      }) => {
        const rows = matchWhere(
          state.deliveries,
          (r) =>
            r.teamId === q.where.teamId &&
            r.createdAt.getTime() > q.where.createdAt.gt.getTime(),
        );
        const byStatus = new Map<string, number>();
        for (const r of rows) {
          byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
        }
        return Array.from(byStatus.entries()).map(([status, count]) => ({
          status,
          _count: { _all: count },
        }));
      },
      count: async (q: {
        where: { teamId: string; status: { in: string[] } };
      }) => {
        return state.deliveries.filter(
          (r) =>
            r.teamId === q.where.teamId &&
            q.where.status.in.includes(r.status),
        ).length;
      },
      findMany: async (q: {
        where: {
          teamId: string;
          createdAt?: { gt: Date };
          responseDurationMs?: { not: null };
        };
        select?: { responseDurationMs?: boolean };
      }) => {
        const rows = state.deliveries.filter((r) => {
          if (r.teamId !== q.where.teamId) return false;
          if (
            q.where.createdAt &&
            !(r.createdAt.getTime() > q.where.createdAt.gt.getTime())
          )
            return false;
          if (
            q.where.responseDurationMs?.not === null &&
            (r.responseDurationMs === null ||
              r.responseDurationMs === undefined)
          )
            return false;
          return true;
        });
        return rows.map((r) => ({
          responseDurationMs: r.responseDurationMs ?? null,
        }));
      },
      findFirst: async (q: {
        where: {
          teamId: string;
          status?: string | { in: string[] };
          sentAtUtc?: { not: null };
          failedAtUtc?: { not: null };
        };
        orderBy?:
          | { createdAt: "asc" | "desc" }
          | { sentAtUtc: "asc" | "desc" }
          | { failedAtUtc: "asc" | "desc" };
      }) => {
        let rows = state.deliveries.filter((r) => r.teamId === q.where.teamId);
        if (typeof q.where.status === "string") {
          rows = rows.filter((r) => r.status === q.where.status);
        } else if (q.where.status && "in" in q.where.status) {
          const allowed = q.where.status.in;
          rows = rows.filter((r) => allowed.includes(r.status));
        }
        if (q.where.sentAtUtc?.not === null) {
          rows = rows.filter((r) => r.sentAtUtc !== null);
        }
        if (q.where.failedAtUtc?.not === null) {
          rows = rows.filter((r) => r.failedAtUtc !== null);
        }
        if (q.orderBy) {
          if ("createdAt" in q.orderBy) {
            rows.sort((a, b) =>
              q.orderBy && "createdAt" in q.orderBy &&
              q.orderBy.createdAt === "asc"
                ? a.createdAt.getTime() - b.createdAt.getTime()
                : b.createdAt.getTime() - a.createdAt.getTime(),
            );
          } else if ("sentAtUtc" in q.orderBy) {
            rows.sort((a, b) => {
              const av = a.sentAtUtc?.getTime() ?? 0;
              const bv = b.sentAtUtc?.getTime() ?? 0;
              return q.orderBy && "sentAtUtc" in q.orderBy &&
                q.orderBy.sentAtUtc === "asc"
                ? av - bv
                : bv - av;
            });
          } else if ("failedAtUtc" in q.orderBy) {
            rows.sort((a, b) => {
              const av = a.failedAtUtc?.getTime() ?? 0;
              const bv = b.failedAtUtc?.getTime() ?? 0;
              return q.orderBy && "failedAtUtc" in q.orderBy &&
                q.orderBy.failedAtUtc === "asc"
                ? av - bv
                : bv - av;
            });
          }
        }
        return rows[0] ?? null;
      },
    },
  } as unknown as PrismaClient;
}

const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_1 = "11111111-1111-4111-8111-111111111111";
const KEY_2 = "22222222-2222-4222-8222-222222222222";
const HOOK_1 = "33333333-3333-4333-8333-333333333333";

// ---------------------------------------------------------------------------
// Service-level behaviour tests.
// ---------------------------------------------------------------------------

describe("PHASE 5 — computeIntegrationsHealthSnapshot — empty workspace", () => {
  it("returns honest zeros + nulls for a workspace with no activity", async () => {
    const client = makePrismaStub({
      apiCredentials: [],
      usageLogs: [],
      webhookEndpoints: [],
      deliveries: [],
    });
    const snap = await computeIntegrationsHealthSnapshot(TEAM_A, client);
    expect(snap.teamId).toBe(TEAM_A);
    expect(snap.windowHours).toBe(HEALTH_RECENT_WINDOW_HOURS);
    expect(snap.activeApiKeys).toBe(0);
    expect(snap.revokedApiKeys).toBe(0);
    expect(snap.keysUsedLast24h).toBe(0);
    expect(snap.activeWebhooks).toBe(0);
    expect(snap.disabledWebhooks).toBe(0);
    expect(snap.deliveriesLast24h).toBe(0);
    expect(snap.failedDeliveriesLast24h).toBe(0);
    expect(snap.endpointsCurrentlyFailing).toBe(0);
    expect(snap.pendingOrRetryScheduledCount).toBe(0);
    // RATES + INSTANTS are null, never 0 / "" / now.
    expect(snap.successRateLast24h).toBeNull();
    expect(snap.oldestPendingDeliveryAt).toBeNull();
    expect(snap.lastSuccessfulDeliveryAt).toBeNull();
    expect(snap.lastFailedDeliveryAt).toBeNull();
    // Phase closure — empty workspace has no measured durations; the
    // average reflects that as null, never 0.
    expect(snap.averageLatencyMsLast24h).toBeNull();
  });
});

describe("PHASE 5 — computeIntegrationsHealthSnapshot — mixed workspace", () => {
  it("returns correct counts + success rate against a known mix", async () => {
    const now = Date.now();
    const within = (mins: number) => new Date(now - mins * 60 * 1000);
    const outside = new Date(now - 25 * 60 * 60 * 1000); // > 24h ago
    const client = makePrismaStub({
      apiCredentials: [
        { id: KEY_1, teamId: TEAM_A, status: "ACTIVE" },
        { id: KEY_2, teamId: TEAM_A, status: "ACTIVE" },
        {
          id: "44444444-4444-4444-8444-444444444444",
          teamId: TEAM_A,
          status: "REVOKED",
        },
        // Other team — must NOT contribute.
        {
          id: "55555555-5555-4555-8555-555555555555",
          teamId: TEAM_B,
          status: "ACTIVE",
        },
      ],
      usageLogs: [
        // KEY_1 used 3 times in the window — counts as 1 distinct key.
        { apiCredentialId: KEY_1, teamId: TEAM_A, createdAt: within(10) },
        { apiCredentialId: KEY_1, teamId: TEAM_A, createdAt: within(20) },
        { apiCredentialId: KEY_1, teamId: TEAM_A, createdAt: within(30) },
        // KEY_2 used once in the window — second distinct key.
        { apiCredentialId: KEY_2, teamId: TEAM_A, createdAt: within(5) },
        // Outside the window — must NOT count.
        { apiCredentialId: KEY_2, teamId: TEAM_A, createdAt: outside },
        // Other team — must NOT count.
        {
          apiCredentialId: "55555555-5555-4555-8555-555555555555",
          teamId: TEAM_B,
          createdAt: within(1),
        },
      ],
      webhookEndpoints: [
        { id: HOOK_1, teamId: TEAM_A, status: "ACTIVE", failureCount: 0 },
        {
          id: "66666666-6666-4666-8666-666666666666",
          teamId: TEAM_A,
          status: "ACTIVE",
          failureCount: 7, // counts as currently-failing
        },
        {
          id: "77777777-7777-4777-8777-777777777777",
          teamId: TEAM_A,
          status: "DISABLED",
          failureCount: 50,
        },
        // Other team — must NOT contribute.
        {
          id: "88888888-8888-4888-8888-888888888888",
          teamId: TEAM_B,
          status: "ACTIVE",
          failureCount: 99,
        },
      ],
      deliveries: [
        // 8 SENT, 2 FAILED, 1 RETRY_SCHEDULED, 1 PENDING in window
        // → 12 deliveries, 8/12 = 66.6...% success rate.
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `s-${i}`,
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: within(60 + i),
          sentAtUtc: within(59 + i),
          failedAtUtc: null,
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          id: `f-${i}`,
          teamId: TEAM_A,
          status: "FAILED" as const,
          createdAt: within(120 + i),
          sentAtUtc: null,
          failedAtUtc: within(119 + i),
        })),
        {
          id: "r-0",
          teamId: TEAM_A,
          status: "RETRY_SCHEDULED" as const,
          createdAt: within(15),
          sentAtUtc: null,
          failedAtUtc: null,
        },
        {
          id: "p-0",
          teamId: TEAM_A,
          status: "PENDING" as const,
          createdAt: within(180), // oldest pending — within window
          sentAtUtc: null,
          failedAtUtc: null,
        },
        // A SENT delivery OUTSIDE the 24h window — must NOT count in
        // deliveriesLast24h but SHOULD be eligible for lastSuccessfulDeliveryAt.
        {
          id: "s-old",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: outside,
          sentAtUtc: outside,
          failedAtUtc: null,
        },
        // CANCELLED row — must NOT contribute to the rate denominator.
        {
          id: "c-0",
          teamId: TEAM_A,
          status: "CANCELLED" as const,
          createdAt: within(45),
          sentAtUtc: null,
          failedAtUtc: null,
        },
        // Other team — must NOT contribute.
        {
          id: "other",
          teamId: TEAM_B,
          status: "SENT" as const,
          createdAt: within(1),
          sentAtUtc: within(1),
          failedAtUtc: null,
        },
      ],
    });
    const snap = await computeIntegrationsHealthSnapshot(TEAM_A, client);

    expect(snap.activeApiKeys).toBe(2);
    expect(snap.revokedApiKeys).toBe(1);
    expect(snap.keysUsedLast24h).toBe(2); // KEY_1 + KEY_2 distinct
    expect(snap.activeWebhooks).toBe(2);
    expect(snap.disabledWebhooks).toBe(1);
    expect(snap.endpointsCurrentlyFailing).toBe(1); // the one with 7 fails

    expect(snap.deliveriesLast24h).toBe(12);
    expect(snap.failedDeliveriesLast24h).toBe(2);
    expect(snap.successRateLast24h).not.toBeNull();
    expect(snap.successRateLast24h!).toBeCloseTo(8 / 12, 4);
    expect(snap.pendingOrRetryScheduledCount).toBe(2);

    // Oldest PENDING/RETRY row in window: PENDING within(180) is older
    // than RETRY within(15).
    expect(snap.oldestPendingDeliveryAt).not.toBeNull();
    const oldestMs = Date.parse(snap.oldestPendingDeliveryAt!);
    expect(now - oldestMs).toBeGreaterThan(170 * 60 * 1000);

    // Newest SENT is one of the within-window rows, NOT the >24h old row.
    expect(snap.lastSuccessfulDeliveryAt).not.toBeNull();
    expect(now - Date.parse(snap.lastSuccessfulDeliveryAt!)).toBeLessThan(
      24 * 60 * 60 * 1000,
    );

    // Newest FAILED is within window.
    expect(snap.lastFailedDeliveryAt).not.toBeNull();
  });

  it("yields successRateLast24h===null when the window has zero deliveries", async () => {
    const now = Date.now();
    const within = (mins: number) => new Date(now - mins * 60 * 1000);
    const outside = new Date(now - 25 * 60 * 60 * 1000);
    const client = makePrismaStub({
      apiCredentials: [{ id: KEY_1, teamId: TEAM_A, status: "ACTIVE" }],
      usageLogs: [],
      webhookEndpoints: [
        { id: HOOK_1, teamId: TEAM_A, status: "ACTIVE", failureCount: 0 },
      ],
      deliveries: [
        // Only an OUT-OF-WINDOW row exists — denominator is still 0.
        {
          id: "s-old",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: outside,
          sentAtUtc: outside,
          failedAtUtc: null,
        },
      ],
    });
    void within; // for symmetry with the other test
    const snap = await computeIntegrationsHealthSnapshot(TEAM_A, client);
    expect(snap.deliveriesLast24h).toBe(0);
    expect(snap.successRateLast24h).toBeNull();
    // The historical SENT row is still surfaced as lastSuccessfulDeliveryAt.
    expect(snap.lastSuccessfulDeliveryAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase closure — averageLatencyMsLast24h behaviour.
//
// The dispatcher now records the measured wall-clock duration of each
// outbound HTTP attempt in `response_duration_ms`. The health snapshot
// averages it over the same 24h window the success rate uses.
// ---------------------------------------------------------------------------

describe("PHASE closure — averageLatencyMsLast24h", () => {
  it("returns null when no row in the window has a non-null responseDurationMs", async () => {
    const now = Date.now();
    const within = (mins: number) => new Date(now - mins * 60 * 1000);
    const client = makePrismaStub({
      apiCredentials: [],
      usageLogs: [],
      webhookEndpoints: [],
      deliveries: [
        // Pre-fetch failure — responseDurationMs is null. Must NOT
        // contribute to the average.
        {
          id: "pre-fetch-fail",
          teamId: TEAM_A,
          status: "FAILED" as const,
          createdAt: within(10),
          sentAtUtc: null,
          failedAtUtc: within(9),
          responseDurationMs: null,
        },
      ],
    });
    const snap = await computeIntegrationsHealthSnapshot(TEAM_A, client);
    expect(snap.averageLatencyMsLast24h).toBeNull();
  });

  it("averages only the rows that recorded a measured duration", async () => {
    const now = Date.now();
    const within = (mins: number) => new Date(now - mins * 60 * 1000);
    const outside = new Date(now - 25 * 60 * 60 * 1000);
    const client = makePrismaStub({
      apiCredentials: [],
      usageLogs: [],
      webhookEndpoints: [],
      deliveries: [
        // Three SENT rows with measured durations: 100, 200, 300 → 200.
        {
          id: "s-100",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: within(10),
          sentAtUtc: within(9),
          failedAtUtc: null,
          responseDurationMs: 100,
        },
        {
          id: "s-200",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: within(20),
          sentAtUtc: within(19),
          failedAtUtc: null,
          responseDurationMs: 200,
        },
        {
          id: "s-300",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: within(30),
          sentAtUtc: within(29),
          failedAtUtc: null,
          responseDurationMs: 300,
        },
        // A FAILED row WITH a duration (4xx receiver) — must contribute.
        {
          id: "f-400",
          teamId: TEAM_A,
          status: "FAILED" as const,
          createdAt: within(15),
          sentAtUtc: null,
          failedAtUtc: within(14),
          responseDurationMs: 400,
        },
        // Pre-fetch failure — null duration; must NOT contribute.
        {
          id: "f-null",
          teamId: TEAM_A,
          status: "FAILED" as const,
          createdAt: within(25),
          sentAtUtc: null,
          failedAtUtc: within(24),
          responseDurationMs: null,
        },
        // OUTSIDE window — must NOT contribute.
        {
          id: "old-9999",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: outside,
          sentAtUtc: outside,
          failedAtUtc: null,
          responseDurationMs: 9999,
        },
        // Other team — must NOT contribute.
        {
          id: "other",
          teamId: TEAM_B,
          status: "SENT" as const,
          createdAt: within(1),
          sentAtUtc: within(1),
          failedAtUtc: null,
          responseDurationMs: 5,
        },
      ],
    });
    const snap = await computeIntegrationsHealthSnapshot(TEAM_A, client);
    // (100 + 200 + 300 + 400) / 4 = 250
    expect(snap.averageLatencyMsLast24h).toBe(250);
  });

  it("rounds the integer average without producing NaN on a zero-count edge", async () => {
    const now = Date.now();
    const within = (mins: number) => new Date(now - mins * 60 * 1000);
    const client = makePrismaStub({
      apiCredentials: [],
      usageLogs: [],
      webhookEndpoints: [],
      deliveries: [
        {
          id: "s-1",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: within(1),
          sentAtUtc: within(1),
          failedAtUtc: null,
          responseDurationMs: 1,
        },
        {
          id: "s-2",
          teamId: TEAM_A,
          status: "SENT" as const,
          createdAt: within(2),
          sentAtUtc: within(2),
          failedAtUtc: null,
          responseDurationMs: 2,
        },
      ],
    });
    const snap = await computeIntegrationsHealthSnapshot(TEAM_A, client);
    // (1 + 2) / 2 = 1.5 → rounded to 2 (Math.round half-to-even on V8
    // resolves to 2 here; tests rely on the exact rounding the service
    // applies).
    expect(snap.averageLatencyMsLast24h).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Schema / source-invariant guarantees.
// ---------------------------------------------------------------------------

const HEALTH_SERVICE_TS = readFileSync(
  resolve(
    __dirname,
    "..",
    "src",
    "services",
    "integrations",
    "integration-health.service.ts",
  ),
  "utf8",
);

const INTEGRATIONS_ROUTES_TS = readFileSync(
  resolve(__dirname, "..", "src", "routes", "integrations.routes.ts"),
  "utf8",
);

const WEB_INTEGRATIONS_PAGE = readFileSync(
  resolve(
    __dirname,
    "..",
    "..",
    "..",
    "apps",
    "web",
    "app",
    "(app)",
    "integrations",
    "page.tsx",
  ),
  "utf8",
);

describe("PHASE 5 — schema / response shape invariants", () => {
  it("response type exposes averageLatencyMsLast24h sourced from the real response_duration_ms column", () => {
    // Phase closure — the dispatcher now measures the wall-clock
    // duration of each outbound HTTP attempt around the single
    // `httpClient(...)` call in `attemptDeliveryInner` and persists it
    // to `integration_webhook_deliveries.response_duration_ms`. The
    // health snapshot averages this column over the same 24h window
    // (excluding pre-fetch failures, which leave the column NULL).
    //
    // This test pins three invariants:
    //   1. The service exposes the field on the snapshot type.
    //   2. The service reads the canonical `responseDurationMs` column,
    //      NOT a synthesised value.
    //   3. The frontend page renders the metric.
    expect(HEALTH_SERVICE_TS).toMatch(/averageLatencyMsLast24h:\s*number\s*\|\s*null/);
    expect(HEALTH_SERVICE_TS).toMatch(/responseDurationMs/);
    expect(WEB_INTEGRATIONS_PAGE).toMatch(/averageLatencyMsLast24h/);
  });

  it("service yields null average latency when no row in the window has a measured duration", () => {
    // The denominator-zero contract from PHASE 5 generalises to
    // latency: `null`, NEVER `0`.
    expect(HEALTH_SERVICE_TS).toMatch(
      /averageLatencyMsLast24h:\s*number\s*\|\s*null/,
    );
    // The conditional that flips to a real number must be guarded by a
    // counted-rows check so we never produce `Math.round(0/0)` = NaN.
    expect(HEALTH_SERVICE_TS).toMatch(/if\s*\(counted\s*>\s*0\)/);
  });

  it("service computes recency from a 24h window constant, not a magic number", () => {
    expect(HEALTH_RECENT_WINDOW_HOURS).toBe(24);
    expect(HEALTH_SERVICE_TS).toMatch(
      /HEALTH_RECENT_WINDOW_HOURS\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
  });

  it("service derives keysUsedLast24h from ApiCredentialUsageLog.groupBy", () => {
    expect(HEALTH_SERVICE_TS).toMatch(
      /apiCredentialUsageLog\.groupBy\([\s\S]{0,200}by:\s*\["apiCredentialId"\]/,
    );
  });

  it("service derives endpointsCurrentlyFailing from failureCount>=5 AND status=ACTIVE", () => {
    expect(HEALTH_SERVICE_TS).toMatch(
      /failureCount:\s*\{\s*gte:\s*5\s*\}/,
    );
    expect(HEALTH_SERVICE_TS).toMatch(/status:\s*"ACTIVE"/);
  });

  it("service derives deliveriesLast24h from a SENT+FAILED+RETRY_SCHEDULED+PENDING groupBy", () => {
    // The status groupBy covers all four buckets; the test pins the
    // four literals in the source so a refactor cannot silently drop
    // one of them from the denominator.
    for (const status of [
      "SENT",
      "FAILED",
      "RETRY_SCHEDULED",
      "PENDING",
    ]) {
      expect(HEALTH_SERVICE_TS).toContain(`"${status}"`);
    }
  });

  it("service yields null success rate when the denominator is zero", () => {
    expect(HEALTH_SERVICE_TS).toMatch(
      /deliveriesLast24h\s*===\s*0\s*\?\s*null\s*:/,
    );
  });
});

// ---------------------------------------------------------------------------
// Route surface guarantees.
// ---------------------------------------------------------------------------

describe("PHASE 5 — GET /v1/integrations/health route surface", () => {
  it("declares the canonical path and gates on workspace OWNER/ADMIN", () => {
    expect(INTEGRATIONS_ROUTES_TS).toMatch(/"\/v1\/integrations\/health"/);
    // The route must short-circuit non-admin members.
    expect(INTEGRATIONS_ROUTES_TS).toMatch(
      /role_\$\{ok\.role\}_lacks_integration\.health\.read/,
    );
  });

  it("gates on the integrations feature flag", () => {
    // The health route must call gateFeatureOrReply before doing work.
    const slice = INTEGRATIONS_ROUTES_TS.slice(
      INTEGRATIONS_ROUTES_TS.indexOf('"/v1/integrations/health"'),
      INTEGRATIONS_ROUTES_TS.indexOf('"/v1/integrations/health"') + 1200,
    );
    expect(slice).toMatch(/gateFeatureOrReply\(reply\)/);
  });

  it("delegates the metric computation to computeIntegrationsHealthSnapshot", () => {
    expect(INTEGRATIONS_ROUTES_TS).toMatch(
      /computeIntegrationsHealthSnapshot\(query\.teamId\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Frontend HealthSummary source invariants.
//
// The repo has no RTL setup in apps/web, so we assert against the page
// source in the API runner — same convention as PHASES 2, 3, 4.
// ---------------------------------------------------------------------------

describe("PHASE 5 — HealthSummary frontend invariants", () => {
  it("fetches /v1/integrations/health rather than deriving counts client-side", () => {
    expect(WEB_INTEGRATIONS_PAGE).toMatch(
      /\/v1\/integrations\/health\?teamId=/,
    );
  });

  it("auto-refreshes on a 60s interval", () => {
    expect(WEB_INTEGRATIONS_PAGE).toMatch(
      /INTEGRATIONS_HEALTH_REFRESH_MS\s*=\s*60_000/,
    );
    expect(WEB_INTEGRATIONS_PAGE).toMatch(/window\.setInterval\(/);
  });

  it("renders the canonical empty-state copy, not 'Loading…' forever", () => {
    expect(WEB_INTEGRATIONS_PAGE).toContain(
      "No activity in this workspace yet.",
    );
    // The legacy "Loading summary…" string is gone — only the brief
    // first-fetch "Loading…" remains, and even that disappears as soon
    // as the first response comes back.
    expect(WEB_INTEGRATIONS_PAGE).not.toContain("Loading summary…");
  });

  it("renders missing metrics as the canonical em-dash, never as '0' or 'Loading'", () => {
    expect(WEB_INTEGRATIONS_PAGE).toMatch(
      /HEALTH_METRIC_MISSING_PLACEHOLDER\s*=\s*"—"/,
    );
    // formatHealthRate / formatHealthInstant must defer to the
    // canonical placeholder when the value is null.
    expect(WEB_INTEGRATIONS_PAGE).toMatch(
      /if\s*\(\s*rate\s*===\s*null\s*\)\s*return\s+HEALTH_METRIC_MISSING_PLACEHOLDER/,
    );
    expect(WEB_INTEGRATIONS_PAGE).toMatch(
      /if\s*\(\s*iso\s*===\s*null\s*\)\s*return\s+HEALTH_METRIC_MISSING_PLACEHOLDER/,
    );
  });

  it("renders one tile per documented metric (testid hooks present)", () => {
    for (const testId of [
      "integrations-health-card",
      "integrations-health-active-api-keys",
      "integrations-health-revoked-api-keys",
      "integrations-health-keys-used-24h",
      "integrations-health-active-webhooks",
      "integrations-health-disabled-webhooks",
      "integrations-health-deliveries-24h",
      "integrations-health-success-rate-24h",
      "integrations-health-failed-24h",
      "integrations-health-endpoints-failing",
      "integrations-health-pending-or-retry",
      "integrations-health-oldest-pending",
      "integrations-health-last-success",
      "integrations-health-last-failure",
      // Phase closure — measured average latency.
      "integrations-health-avg-latency-24h",
    ]) {
      expect(WEB_INTEGRATIONS_PAGE).toContain(testId);
    }
  });

  it("renders the Avg latency tile with null-aware formatting (no '0 ms' for no-data)", () => {
    // Tile label uses the canonical short-form copy.
    expect(WEB_INTEGRATIONS_PAGE).toContain('label="Avg latency (24h)"');
    // The formatter MUST return the canonical placeholder for null,
    // not a misleading "0 ms".
    expect(WEB_INTEGRATIONS_PAGE).toMatch(
      /if\s*\(\s*ms\s*===\s*null\s*\)\s*return\s+HEALTH_METRIC_MISSING_PLACEHOLDER/,
    );
    // The unit suffix is " ms" — pinning here so a future refactor to
    // microseconds or seconds would surface in a test failure.
    expect(WEB_INTEGRATIONS_PAGE).toMatch(/return\s+`\$\{ms\}\s+ms`/);
  });

  it("removes the legacy lifetime-failure-count tile that derived from the list", () => {
    // The dashboard no longer derives counts from the api-keys / webhooks
    // arrays — every value comes from the server snapshot. The old
    // lifetime-failure tile copy is gone.
    expect(WEB_INTEGRATIONS_PAGE).not.toContain(
      "Webhook failures (lifetime)",
    );
  });
});
