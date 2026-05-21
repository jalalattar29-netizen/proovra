/**
 * Phase 28-F — Runtime validation enterprise test suite.
 *
 * Proves:
 *   1. The readiness aggregator exposes 10 subsystems and rolls them
 *      up correctly.
 *   2. Each subsystem check is bounded (never throws, never leaks
 *      secret values).
 *   3. Migration drift detection covers disk_only / db_only /
 *      rolled_back / in_progress cases.
 *   4. New endpoints are registered + gated.
 *   5. Metrics counters exist for every new instrumentation point.
 *   6. Enterprise empty-state component contracts (5 presets +
 *      degraded/unknown variants).
 *   7. Fail-closed UI behavior — empty-state codes are stable + no
 *      preset implies success when data is missing.
 *   8. No private notes / secrets surface in any runtime check.
 *
 * Pure-helper + source-contract assertions. No DB.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Part 1 — Readiness aggregator source contract
// =============================================================================

describe("Runtime readiness aggregator [structure]", () => {
  const src = readSource("../src/runtime/runtime-readiness.ts");

  it("exports 10 typed subsystem ids", () => {
    const required = [
      "schema",
      "migrations",
      "database",
      "redis",
      "s3_object_lock",
      "queues",
      "workers",
      "metrics",
      "sentry",
      "cron_secrets",
    ];
    for (const id of required) {
      expect(src).toContain(`"${id}"`);
    }
  });

  it("delegates schema validation to runSchemaValidation (no re-implementation)", () => {
    expect(src).toContain('from "./schema-validation.js"');
    expect(src).toContain("runSchemaValidation");
  });

  it("every check is bounded by a 2-second timeout helper", () => {
    expect(src).toContain("CHECK_TIMEOUT_MS = 2_000");
    expect(src).toContain("withTimeout");
  });

  it("rollUpStatus precedence: CRITICAL > DEGRADED > HEALTHY > UNKNOWN", () => {
    expect(src).toMatch(
      /if \(subsystems\.some\(\(s\) => s\.status === "CRITICAL"\)\) return "CRITICAL"/,
    );
    expect(src).toMatch(
      /if \(subsystems\.some\(\(s\) => s\.status === "DEGRADED"\)\) return "DEGRADED"/,
    );
    expect(src).toMatch(
      /if \(subsystems\.every\(\(s\) => s\.status === "HEALTHY"\)\) return "HEALTHY"/,
    );
  });

  it("S3 Object Lock missing → CRITICAL (governance-sensitive paths fail closed)", () => {
    expect(src).toMatch(/s3_env_missing[\s\S]*?CRITICAL/);
  });

  it("Object Lock not enabled → DEGRADED (downgrade, not fail-fast)", () => {
    expect(src).toMatch(/object_lock_disabled[\s\S]*?DEGRADED/);
  });

  it("Sentry not configured → DEGRADED, never CRITICAL", () => {
    expect(src).toMatch(/sentry_disabled[\s\S]*?DEGRADED/);
    // The sentry check function body must not set status to CRITICAL.
    const fnIdx = src.indexOf("function checkSentry");
    const fnSlice = src.slice(fnIdx, fnIdx + 800);
    expect(fnSlice).not.toContain('"CRITICAL"');
  });

  it("no secret env values are surfaced in subsystem detail", () => {
    // Each subsystem returns operator-readable detail. The check
    // explicitly NEVER includes process.env values directly.
    expect(src).not.toMatch(/process\.env\.\w+\.slice/);
    expect(src).not.toMatch(/details:\s*process\.env/);
  });

  it("worker check uses recent audit trail age (no direct heartbeat dependency)", () => {
    // Phase 32.6.5 — the reader was previously querying
    // adminAuditLog.action = "reviewer_reconcile_run" but the writer
    // (reviewer-operations-engine.service.ts) writes via
    // safeEmitSecurityEvent({ eventType: "reviewer_reconcile_run" })
    // — which targets the security_events table, not
    // admin_audit_logs. The check now reads SecurityEvent.eventType
    // to align the reader with the existing writer.
    // Phase 32.7 — the literal `"reviewer_reconcile_run"` is no longer
    // inlined in the reader. It is resolved through
    // `wireStringFor("WORKER_HEARTBEAT")` from shared-runtime and bound
    // to `heartbeatWireString` before flowing into the findFirst
    // where-clause. The wire-string value is preserved (audit-chain
    // continuity), only the call site is canonicalized.
    expect(src).toContain('wireStringFor("WORKER_HEARTBEAT")');
    expect(src).toContain("prisma.securityEvent.findFirst");
    expect(src).toContain("REVIEWER_OPS_RECONCILIATION_INTERVAL_MS");
  });

  it("queue check derives signal from OperationalIncident WORKER category", () => {
    expect(src).toContain('category: "WORKER"');
  });
});

// =============================================================================
// Part 1 — Pure helper invocations
// =============================================================================

describe("Runtime readiness aggregator [pure helpers]", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("checkRedis returns CRITICAL when REDIS_URL is set but the host is unreachable (Phase 32.6.1 live ping)", async () => {
    // Phase 32.6.1 — checkRedis is now a LIVE PING, not just an env
    // presence check. The previous version returned HEALTHY for any
    // configured REDIS_URL, which hid 30-second outages. The live
    // ping uses a 1s timeout, so this test runs quickly even
    // against an unreachable host.
    //
    // In CI / unit-test environments there is no Redis listening at
    // localhost:6379, so the ping correctly fails and reports
    // CRITICAL with `reasonCode: "redis_unreachable"`. The HEALTHY
    // path is covered by the integration suite in production-like
    // environments.
    process.env.REDIS_URL = "redis://127.0.0.1:1"; // bounded unreachable port
    const { runReadinessCheck } = await import(
      "../src/runtime/runtime-readiness.js"
    );
    const fakePrisma = {
      $queryRawUnsafe: async () => [{ ok: 1 }],
      operationalIncident: { count: async () => 0 },
      adminAuditLog: {
        findFirst: async () => ({ createdAt: new Date() }),
      },
    } as unknown as Parameters<typeof runReadinessCheck>[0];
    const report = await runReadinessCheck(fakePrisma);
    const redis = report.subsystems.find((s) => s.id === "redis");
    expect(redis?.status).toBe("CRITICAL");
    expect(redis?.reasonCode).toBe("redis_unreachable");
  });

  it("checkRedis returns DEGRADED when REDIS_URL is unset", async () => {
    delete process.env.REDIS_URL;
    const { runReadinessCheck } = await import("../src/runtime/runtime-readiness.js");
    const fakePrisma = {
      $queryRawUnsafe: async () => [{ ok: 1 }],
      operationalIncident: { count: async () => 0 },
      adminAuditLog: {
        findFirst: async () => ({ createdAt: new Date() }),
      },
    } as unknown as Parameters<typeof runReadinessCheck>[0];
    const report = await runReadinessCheck(fakePrisma);
    const redis = report.subsystems.find((s) => s.id === "redis");
    expect(redis?.status).toBe("DEGRADED");
    expect(redis?.reasonCode).toBe("redis_not_configured");
  });
});

// =============================================================================
// Part 2 — Migration drift detector
// =============================================================================

describe("Migration drift detector [source contract]", () => {
  const src = readSource("../src/runtime/migration-drift.ts");

  it("compares disk migrations against _prisma_migrations table", () => {
    expect(src).toContain("_prisma_migrations");
    expect(src).toContain("listDiskMigrations");
    expect(src).toContain("fetchDbMigrations");
  });

  it("classifies drift into disk_only / db_only / rolled_back / in_progress", () => {
    expect(src).toContain('"disk_only"');
    expect(src).toContain('"db_only"');
    expect(src).toContain('"rolled_back"');
    expect(src).toContain('"in_progress"');
  });

  it("never auto-runs migrations (read-only)", () => {
    expect(src).not.toMatch(/prisma migrate deploy|migrateDeploy|executeMigration/);
    // No write operations on _prisma_migrations.
    expect(src).not.toMatch(/INSERT INTO "_prisma_migrations"/);
    expect(src).not.toMatch(/UPDATE "_prisma_migrations"/);
  });

  it("rolled_back or in_progress → CRITICAL status", () => {
    expect(src).toMatch(/hasRolledBack \|\| hasInProgress[\s\S]*?CRITICAL/);
  });

  it("exposes a stable fingerprint over the disk list", () => {
    expect(src).toContain("fingerprintDisk");
    expect(src).toMatch(/0x811c9dc5/); // FNV-1a marker
  });
});

// =============================================================================
// Part 3 — Endpoints
// =============================================================================

describe("Runtime readiness routes [registration]", () => {
  const src = readSource("../src/routes/runtime-readiness.routes.ts");

  it("registers all four endpoints", () => {
    expect(src).toContain('"/admin/runtime/readiness"');
    expect(src).toContain('"/admin/runtime/queues"');
    expect(src).toContain('"/admin/runtime/workers"');
    expect(src).toContain('"/admin/runtime/migrations"');
  });

  it("every endpoint requires audit.read", () => {
    expect(src).toMatch(/permission:\s*"audit\.read"/);
  });

  it("server.ts registers runtime-readiness routes", () => {
    const serverSrc = readSource("../src/server.ts");
    expect(serverSrc).toContain("runtimeReadinessRoutes");
    expect(serverSrc).toContain("./routes/runtime-readiness.routes.js");
  });

  it("bumps appropriate metrics on each endpoint hit", () => {
    expect(src).toMatch(/bump\("runtime_readiness_check_total"\)/);
    expect(src).toMatch(/bump\("runtime_queue_health_check_total"\)/);
    expect(src).toMatch(/bump\("runtime_migration_drift_detected_total"\)/);
  });

  it("returns DEGRADED/CRITICAL bumps in addition to total", () => {
    expect(src).toContain("runtime_readiness_degraded_total");
    expect(src).toContain("runtime_readiness_critical_total");
  });

  it("anti-enum 404 on non-member tenants", () => {
    expect(src).toMatch(/reply\.code\(404\)/);
    expect(src).toMatch(/code:\s*"not_found"/);
  });
});

// =============================================================================
// Part 4 — Metrics catalog
// =============================================================================

describe("Phase 28-F [metrics catalog]", () => {
  const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");

  const required = [
    "runtime_readiness_check_total",
    "runtime_readiness_degraded_total",
    "runtime_readiness_critical_total",
    "runtime_queue_health_check_total",
    "runtime_migration_drift_detected_total",
    "enterprise_empty_state_rendered_total",
    "governance_snapshot_ui_loaded_total",
    "operational_timeline_ui_loaded_total",
  ];

  for (const counter of required) {
    it(`registers ${counter}`, () => {
      expect(src).toContain(`"${counter}"`);
    });
  }
});

// =============================================================================
// Part 5 — Enterprise empty-state components
// =============================================================================

describe("Enterprise empty-state components", () => {
  const src = readSource(
    "../../../apps/web/components/operational/OperationalEmptyState.tsx",
  );

  it("exports the five canonical empty-state presets", () => {
    expect(src).toContain("export function NoEscalationsEmptyState");
    expect(src).toContain("export function NoWorkloadSnapshotsEmptyState");
    expect(src).toContain("export function NoGovernanceIncidentsEmptyState");
    expect(src).toContain("export function NoSlaBreachesEmptyState");
    expect(src).toContain("export function NoOperationalTimelineEmptyState");
  });

  it("exports the two fail-closed variants (degraded + unknown)", () => {
    expect(src).toContain("export function RuntimeDegradedNotice");
    expect(src).toContain("export function GovernanceSnapshotUnavailableNotice");
  });

  it("each preset includes runtime dependency explanation", () => {
    const presets = [
      "NoEscalationsEmptyState",
      "NoWorkloadSnapshotsEmptyState",
      "NoGovernanceIncidentsEmptyState",
      "NoSlaBreachesEmptyState",
    ];
    for (const preset of presets) {
      const idx = src.indexOf(`function ${preset}`);
      const slice = src.slice(idx, idx + 1500);
      // Match `runtimeDependency=` (JSX prop) OR `runtimeDependency:` (object literal).
      expect(slice).toMatch(/runtimeDependency[=:]/);
    }
  });

  it("empty-state codes are stable + bounded", () => {
    const expectedCodes = [
      "no_escalations",
      "no_workload_snapshots",
      "no_governance_incidents",
      "no_sla_breaches",
      "no_operational_timeline",
      "runtime_degraded",
      "governance_snapshot_unavailable",
    ];
    for (const code of expectedCodes) {
      expect(src).toContain(`"${code}"`);
    }
  });

  it("no preset implies success when data is missing", () => {
    // The brief: "do not show false success" / "do not show 'all clear'".
    // We assert the language doesn't contain misleading phrases.
    expect(src).not.toMatch(/all clear/i);
    expect(src).not.toMatch(/everything is healthy/i);
    expect(src).not.toMatch(/no issues detected — system is verified/i);
  });

  it("fail-closed variants use appropriate severity tones", () => {
    expect(src).toMatch(/RuntimeDegradedNotice[\s\S]+?variant="degraded"/);
    expect(src).toMatch(
      /GovernanceSnapshotUnavailableNotice[\s\S]+?variant="unknown"/,
    );
  });

  it("no marketing copy / playful design tokens", () => {
    // Bounded-vocabulary check: no rocket emojis, no "amazing",
    // no "🎉", no "Welcome to...".
    expect(src).not.toMatch(/🎉|amazing|welcome to|let's go/i);
  });
});

// =============================================================================
// Part 6 — Fail-closed UI behavior
// =============================================================================

describe("Phase 28-F [fail-closed UI behavior]", () => {
  const src = readSource(
    "../../../apps/web/components/operational/OperationalEmptyState.tsx",
  );

  it("GovernanceSnapshotUnavailableNotice tells the operator to treat the record as BLOCKED", () => {
    const idx = src.indexOf("function GovernanceSnapshotUnavailableNotice");
    const slice = src.slice(idx, idx + 1500);
    expect(slice).toMatch(/failing closed/i);
    expect(slice).toMatch(/blocked|treat as blocked/i);
  });

  it("RuntimeDegradedNotice exposes the failing subsystem list (operator-visible)", () => {
    const idx = src.indexOf("function RuntimeDegradedNotice");
    const slice = src.slice(idx, idx + 1500);
    expect(slice).toMatch(/failingSubsystems/);
    expect(slice).toMatch(/Failing subsystems:/);
  });

  it("Unknown variant uses the 'unknown' severity tone", () => {
    // Phase 28-I refactored the inline rgba tones to a shared token
    // module (`./tokens.ts`). The unknown variant now delegates to
    // `OPS_TONES.unknown` (red-50 background, red-900 ink). Assert the
    // shared-token contract rather than the literal rgba string.
    expect(src).toMatch(/variant === "unknown"/);
    expect(src).toMatch(/OPS_TONES\.unknown/);
  });
});

// =============================================================================
// Part 7 — Privacy / no-secret-leak invariants
// =============================================================================

describe("Phase 28-F [privacy invariants]", () => {
  const readinessSrc = readSource("../src/runtime/runtime-readiness.ts");
  const driftSrc = readSource("../src/runtime/migration-drift.ts");

  it("readiness subsystem metadata does NOT contain secret values", () => {
    // Forbidden string contents on the safe-metadata path.
    expect(readinessSrc).not.toMatch(/process\.env\.OPERATIONAL_SEEDING_SECRET/);
    expect(readinessSrc).not.toMatch(/process\.env\.REVIEWER_OPS_CRON_SECRET\s*[^.]/);
    // We may check envPresent() for these but never include their values.
  });

  it("migration drift does NOT include migration body / SQL contents", () => {
    expect(driftSrc).not.toMatch(/readFileSync.*\.sql/);
    expect(driftSrc).not.toMatch(/SQL content/);
  });

  it("readiness output is bounded — every subsystem returns enumerated fields only", () => {
    // The SubsystemReadiness type declares { id, status, reasonCode,
    // detail, remediationHint, metadata }. Any other property would
    // be a TS error; this test asserts the type contract is the
    // explicit one.
    expect(readinessSrc).toContain("export type SubsystemReadiness = {");
    expect(readinessSrc).toContain("id: SubsystemId");
    expect(readinessSrc).toContain("status: ReadinessStatus");
    expect(readinessSrc).toContain("reasonCode: string");
    expect(readinessSrc).toContain("detail: string");
    expect(readinessSrc).toContain("remediationHint: string | null");
  });
});

// =============================================================================
// Part 8 — Phase 28-F doesn't start anything banned
// =============================================================================

describe("Phase 28-F [scope guards]", () => {
  it("no enterprise-search engine added", () => {
    // Sanity: no new `search-engine.service.ts` / Elasticsearch /
    // OpenSearch imports show up in this phase's new files.
    for (const file of [
      "../src/runtime/runtime-readiness.ts",
      "../src/runtime/migration-drift.ts",
      "../src/routes/runtime-readiness.routes.ts",
    ]) {
      const src = readSource(file);
      expect(src).not.toMatch(/elasticsearch|opensearch|meilisearch|typesense/i);
      expect(src).not.toMatch(/ai-ranker|semantic-search/i);
    }
  });
});
