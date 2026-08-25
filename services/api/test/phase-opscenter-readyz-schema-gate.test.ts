/**
 * Operations-Center migration ordering — /readyz required-schema gate.
 *
 * Migrations 20270916000000_operations_center_history_and_schedule and
 * 20270917000000_org_notification_policy_and_resolution_provenance add
 * tables that schema-dependent paths (notification-preferences routes,
 * digest scheduler) need. The deploy contract for this repo applies
 * migrations via the safe-migrate wrapper (`pnpm prisma:migrate`) as an
 * explicit pipeline step — NOT automatically at container start — so
 * the readiness surface is the ordering guarantee:
 *
 *   1. /readyz probes `notification_schedule_settings` (cheap SELECT 1)
 *      and reports 503 `required_schema_missing` until the migration
 *      has been applied. The process itself keeps running.
 *   2. The worker's startup probe (services/worker/src/api-readiness.ts)
 *      polls /readyz before its startup-triggered api calls, so those
 *      hold off until the schema is present.
 *   3. Startup schema validation registers the new objects at
 *      `important` severity so /admin/runtime/readiness (schema
 *      subsystem) reports DEGRADED — without fail-fasting the boot.
 *
 * Inject tests below pin (1); source-contract tests pin (3).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  dbUnreachable: false,
  scheduleTableMissing: false,
  /**
   * The Operations writer schema contract, simulated.
   *
   * `/readyz` now also refuses when the incident writer's tables disagree with
   * the deployed model — because a production workspace recorded zero
   * operational conditions for as long as it did while this endpoint answered
   * ok. The three flags below are the three ways that contract can fail.
   */
  writerLegacyColumns: false,
  writerDedupeIndexMissing: false,
}));

vi.mock("../src/db.js", () => {
  const genericModel = {
    findMany: async () => [],
    findUnique: async () => null,
    findFirst: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
    createMany: async () => ({ count: 0 }),
  };
  const overrides: Record<string, unknown> = {
    // Template-tag raw query double. `SELECT 1` is the connectivity
    // probe; the notification_schedule_settings probe simulates
    // Prisma's P2021 ("table does not exist") when the migration has
    // not been applied.
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (H.dbUnreachable) throw new Error("connect ECONNREFUSED");
      if (sql.includes("notification_schedule_settings")) {
        if (H.scheduleTableMissing) throw { code: "P2021" };
        return [{ ok: 1 }];
      }
      return [{ ok: 1 }];
    },
    // The writer-contract probes. Each is parameterless SQL, so they are
    // told apart by the column they select — which is also how the real
    // contract distinguishes them.
    $queryRawUnsafe: async (sql: string) => {
      if (H.dbUnreachable) throw new Error("connect ECONNREFUSED");
      if (typeof sql === "string" && sql.includes("missing_column")) return [];
      if (typeof sql === "string" && sql.includes("legacy_column")) {
        return H.writerLegacyColumns && sql.includes("operational_incidents'")
          ? [{ legacy_column: "safeSummary" }]
          : [];
      }
      if (typeof sql === "string" && sql.includes("indisunique")) {
        // An empty answer means NO unique index covers (team_id, fingerprint).
        return H.writerDedupeIndexMissing ? [] : [{ ok: 1 }];
      }
      return [];
    },
  };
  const prisma = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in overrides) return overrides[prop];
        return genericModel;
      },
    },
  ) as Record<string, unknown>;
  return { prisma };
});
vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => undefined }));
vi.mock("../src/auth.js", () => ({ getAuthUserId: () => "user-1" }));
vi.mock("../src/middleware/cron-secret.js", () => ({
  requireIntegrationCronSecret: async () => true,
}));

import { opsRoutes } from "../src/routes/ops.routes.js";

async function buildApp() {
  const app = Fastify();
  await app.register(opsRoutes);
  await app.ready();
  return app;
}

beforeEach(async () => {
  H.dbUnreachable = false;
  H.scheduleTableMissing = false;
  H.writerLegacyColumns = false;
  H.writerDedupeIndexMissing = false;
  // The contract result is cached per process; each case must start from a
  // fresh look or it would assert against the previous case's answer.
  const readiness = await import(
    "../src/services/operations/operations-writer-readiness.js"
  );
  readiness.resetWriterContractCache();
});

// =============================================================================
// Part 1 — /readyz required-schema gate (inject)
// =============================================================================

describe("/readyz — required-schema gate (Operations Center migrations)", () => {
  it("reports ready when the DB is reachable and notification_schedule_settings exists", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("reports NOT ready (503 required_schema_missing) when the schedule table probe raises P2021", async () => {
    H.scheduleTableMissing = true;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "degraded",
      reason: "required_schema_missing",
    });
    await app.close();
  });

  it("reports NOT ready when the incident writer's tables carry LEGACY duplicate columns", async () => {
    // THE CASE THIS ENDPOINT WAS MISSING.
    //
    // Nothing is unreachable, the canary table exists, and every column the
    // model declares is present — the exact state production was in while it
    // recorded zero operational conditions. An image that cannot record an
    // operational condition is not ready to receive traffic.
    H.writerLegacyColumns = true;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "degraded",
      reason: "operations_writer_schema_mismatch",
    });
    // The bounded reason only. The column name is a fact about the
    // deployment's history and belongs in the operator's logs, not in a load
    // balancer's response body.
    expect(res.body).not.toContain("safeSummary");
    await app.close();
  });

  it("reports NOT ready when no UNIQUE index covers (team_id, fingerprint)", async () => {
    // Deduplication that the database does not enforce is not deduplication,
    // and the writer's whole idempotency story rests on that index.
    H.writerDedupeIndexMissing = true;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "degraded",
      reason: "operations_writer_schema_mismatch",
    });
    await app.close();
  });

  it("still distinguishes db_unreachable (connectivity failure beats the schema probe)", async () => {
    H.dbUnreachable = true;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "degraded",
      reason: "db_unreachable",
    });
    await app.close();
  });

  it("/healthz stays a pure liveness probe — no schema dependency", async () => {
    H.scheduleTableMissing = true;
    H.dbUnreachable = true;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// =============================================================================
// Part 2 — startup schema catalog registers the new objects (source contract)
// =============================================================================

describe("EXPECTED_SCHEMA — Operations Center objects registered at `important`", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/runtime/schema-validation.ts", import.meta.url)),
    "utf8",
  );

  it.each([
    "notification_schedule_settings",
    "operations_inbox_snapshots",
    "organization_notification_policies",
  ])("registers table %s at important severity (never fail-fast)", (table) => {
    const entry = new RegExp(
      `kind:\\s*"table",\\s*name:\\s*"${table}",\\s*severity:\\s*"important"`,
    );
    expect(SRC).toMatch(entry);
    // The table must NOT be registered critical anywhere — critical
    // aborts startup, which this gate deliberately avoids.
    const critical = new RegExp(
      `kind:\\s*"table",\\s*name:\\s*"${table}",\\s*severity:\\s*"critical"`,
    );
    expect(SRC).not.toMatch(critical);
  });

  it("registers the workspace_notification_preferences.frequency column", () => {
    expect(SRC).toMatch(
      /kind:\s*"column",\s*table:\s*"workspace_notification_preferences",\s*column:\s*"frequency"/,
    );
  });

  it("registers the operations_inbox_snapshots resolution provenance columns", () => {
    expect(SRC).toMatch(
      /kind:\s*"column",\s*table:\s*"operations_inbox_snapshots",\s*column:\s*"resolution_source"/,
    );
    expect(SRC).toMatch(
      /kind:\s*"column",\s*table:\s*"operations_inbox_snapshots",\s*column:\s*"resolved_by_user_id"/,
    );
  });
});
