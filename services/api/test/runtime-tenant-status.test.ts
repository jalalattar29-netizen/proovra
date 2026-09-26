/**
 * THE TENANT RUNTIME PROJECTION — capabilities, not subsystems.
 *
 * `GET /v1/runtime/status` used to roll every readiness subsystem into one
 * tenant "DEGRADED", and the Evidence page rendered that as "the data on this
 * page may be partial or stale". A missing Sentry DSN, Object Lock posture, a
 * stale reviewer-reconcile sweep or search-index lag each did it.
 *
 * Each case below drives a real subsystem state through the real projection
 * and asserts which CAPABILITY moves — and which do not.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  OPERATOR_ONLY_SUBSYSTEMS,
  TENANT_CAPABILITY_DEPENDENCIES,
  TENANT_RUNTIME_CACHE_TTL_MS,
  TENANT_RUNTIME_FAILURE_TTL_MS,
  getTenantRuntimeProjection,
  projectTenantCapabilities,
  resetTenantRuntimeCacheForTests,
  type ReadinessStatus,
  type SubsystemId,
  type SubsystemReadiness,
} from "../src/runtime/runtime-readiness.js";

const ALL: SubsystemId[] = [
  "schema",
  "migrations",
  "database",
  "redis",
  "s3_object_lock",
  "queues",
  "workers",
  "job_worker",
  "metrics",
  "sentry",
  "cron_secrets",
  "search_indexing",
  "multipart_storage",
  "media_intelligence",
  "investigation_graph",
];

type Override = ReadinessStatus | { status: ReadinessStatus; reasonCode: string };

function report(overrides: Partial<Record<SubsystemId, Override>>, omit: SubsystemId[] = []) {
  const subsystems: SubsystemReadiness[] = ALL.filter((id) => !omit.includes(id)).map((id) => {
    const o = overrides[id];
    const status = typeof o === "string" ? o : (o?.status ?? "HEALTHY");
    const reasonCode = typeof o === "object" ? o.reasonCode : status === "HEALTHY" ? "ok" : "test";
    return { id, status, reasonCode, detail: "test", remediationHint: null, metadata: {} };
  });
  return { subsystems, ranAtUtc: "2026-09-26T00:00:00.000Z" };
}

const caps = (o: Partial<Record<SubsystemId, Override>>, omit?: SubsystemId[]) =>
  projectTenantCapabilities(report(o, omit));

describe("capability mapping", () => {
  it("all healthy: every capability HEALTHY, legacy status HEALTHY, checkedAt carried", () => {
    const p = caps({});
    expect(p.status).toBe("HEALTHY");
    expect(p.capabilities).toEqual({
      uploads: "HEALTHY",
      artifactGeneration: "HEALTHY",
      downloads: "HEALTHY",
      search: "HEALTHY",
      reviewAutomation: "HEALTHY",
    });
    expect(p.checkedAt).toBe("2026-09-26T00:00:00.000Z");
  });

  it("missing Sentry / metrics / cron secrets / pending migrations change nothing a tenant can do", () => {
    const p = caps({
      sentry: { status: "DEGRADED", reasonCode: "sentry_disabled" },
      cron_secrets: { status: "DEGRADED", reasonCode: "no_cron_secret" },
      metrics: "DEGRADED",
      migrations: { status: "DEGRADED", reasonCode: "migration_pending" },
    });
    expect(p.status).toBe("HEALTHY");
    expect(Object.values(p.capabilities).every((v) => v === "HEALTHY")).toBe(true);
  });

  it("Object Lock disabled is posture, not a download or upload outage", () => {
    const p = caps({ s3_object_lock: { status: "DEGRADED", reasonCode: "object_lock_disabled" } });
    expect(p.capabilities.downloads).toBe("HEALTHY");
    expect(p.capabilities.uploads).toBe("HEALTHY");
    expect(p.status).toBe("HEALTHY");
  });

  it("…but missing storage configuration IS an outage of every storage-backed capability", () => {
    const p = caps({ s3_object_lock: { status: "CRITICAL", reasonCode: "s3_env_missing" } });
    expect(p.capabilities.downloads).toBe("UNAVAILABLE");
    expect(p.capabilities.uploads).toBe("UNAVAILABLE");
    expect(p.capabilities.artifactGeneration).toBe("UNAVAILABLE");
    expect(p.capabilities.search).toBe("HEALTHY");
    expect(p.status).toBe("DEGRADED");
  });

  it("a stale reviewer reconcile sweep is review automation — not artifact generation, not the rollup", () => {
    const p = caps({ workers: { status: "DEGRADED", reasonCode: "stale_reconcile" } });
    expect(p.capabilities.reviewAutomation).toBe("DEGRADED");
    expect(p.capabilities.artifactGeneration).toBe("HEALTHY");
    expect(p.status).toBe("HEALTHY");
  });

  it("a stale JOB worker fleet delays artifact generation, and only that", () => {
    const p = caps({ job_worker: { status: "DEGRADED", reasonCode: "fleet_stale" } });
    expect(p.capabilities).toEqual({
      uploads: "HEALTHY",
      artifactGeneration: "DEGRADED",
      downloads: "HEALTHY",
      search: "HEALTHY",
      reviewAutomation: "HEALTHY",
    });
  });

  it("search-index lag affects search, never downloads or records", () => {
    const p = caps({ search_indexing: { status: "CRITICAL", reasonCode: "indexing_lag_critical" } });
    expect(p.capabilities.search).toBe("UNAVAILABLE");
    expect(p.capabilities.downloads).toBe("HEALTHY");
    expect(p.capabilities.uploads).toBe("HEALTHY");
    expect(p.capabilities.artifactGeneration).toBe("HEALTHY");
  });

  it("a database outage is represented everywhere", () => {
    const p = caps({ database: { status: "CRITICAL", reasonCode: "database_unreachable" } });
    expect(Object.values(p.capabilities).every((v) => v === "UNAVAILABLE")).toBe(true);
    expect(p.status).toBe("DEGRADED");
  });

  it("Redis down makes generation unavailable; a platform worker incident degrades it", () => {
    expect(caps({ redis: { status: "CRITICAL", reasonCode: "redis_unreachable" } }).capabilities.artifactGeneration).toBe(
      "UNAVAILABLE",
    );
    expect(caps({ queues: { status: "DEGRADED", reasonCode: "open_worker_incident" } }).capabilities.artifactGeneration).toBe(
      "DEGRADED",
    );
  });

  it("the multipart abort backlog is housekeeping; a missing bucket is not", () => {
    expect(caps({ multipart_storage: { status: "DEGRADED", reasonCode: "abort_backlog_high" } }).capabilities.uploads).toBe("HEALTHY");
    expect(caps({ multipart_storage: { status: "CRITICAL", reasonCode: "s3_bucket_missing" } }).capabilities.uploads).toBe("UNAVAILABLE");
  });

  it("UNKNOWN is never silently HEALTHY — neither an UNKNOWN check nor a missing one", () => {
    const unknown = caps({ job_worker: { status: "UNKNOWN", reasonCode: "fleet_not_measured" } });
    expect(unknown.capabilities.artifactGeneration).toBe("UNKNOWN");
    expect(unknown.status).toBe("UNAVAILABLE");
    const missing = caps({}, ["search_indexing"]);
    expect(missing.capabilities.search).toBe("UNKNOWN");
    // A confirmed failure outranks not knowing.
    const both = caps({ job_worker: "UNKNOWN", redis: "CRITICAL" });
    expect(both.capabilities.artifactGeneration).toBe("UNAVAILABLE");
  });

  it("no operator-only subsystem is a dependency of any capability", () => {
    for (const deps of Object.values(TENANT_CAPABILITY_DEPENDENCIES)) {
      for (const d of deps) expect(OPERATOR_ONLY_SUBSYSTEMS.has(d.id)).toBe(false);
    }
    for (const id of ["sentry", "metrics", "cron_secrets", "migrations"] as const) {
      expect(OPERATOR_ONLY_SUBSYSTEMS.has(id)).toBe(true);
    }
  });

  it("the projection carries no subsystem identifier, reason or detail", () => {
    const body = JSON.stringify(caps({ redis: "CRITICAL", s3_object_lock: { status: "CRITICAL", reasonCode: "s3_env_missing" } }));
    for (const leak of ["redis", "s3", "reasonCode", "detail", "worker", "queue", "incident"]) {
      expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe("the cache", () => {
  beforeEach(() => resetTenantRuntimeCacheForTests());

  it("reuses a projection for the TTL, then re-measures", async () => {
    let now = 1_000_000;
    let runs = 0;
    const run = async () => {
      runs += 1;
      return report(runs === 1 ? {} : { database: "CRITICAL" });
    };
    const a = await getTenantRuntimeProjection(run, () => now);
    now += TENANT_RUNTIME_CACHE_TTL_MS - 1;
    const b = await getTenantRuntimeProjection(run, () => now);
    expect(runs).toBe(1);
    expect(b).toBe(a);
    now += 2;
    const c = await getTenantRuntimeProjection(run, () => now);
    expect(runs).toBe(2);
    expect(c.capabilities.downloads).toBe("UNAVAILABLE");
  });

  it("concurrent misses share one readiness run", async () => {
    let runs = 0;
    const run = () =>
      new Promise<ReturnType<typeof report>>((resolve) => {
        runs += 1;
        setTimeout(() => resolve(report({})), 5);
      });
    await Promise.all([1, 2, 3, 4].map(() => getTenantRuntimeProjection(run)));
    expect(runs).toBe(1);
  });

  it("a failed readiness run answers UNKNOWN (never HEALTHY) and is retried after the short failure TTL", async () => {
    let now = 5_000_000;
    let fail = true;
    const run = async () => {
      if (fail) throw new Error("probe exploded");
      return report({});
    };
    const failed = await getTenantRuntimeProjection(run, () => now);
    expect(failed.status).toBe("UNAVAILABLE");
    expect(Object.values(failed.capabilities).every((v) => v === "UNKNOWN")).toBe(true);
    fail = false;
    now += TENANT_RUNTIME_FAILURE_TTL_MS + 1;
    expect((await getTenantRuntimeProjection(run, () => now)).status).toBe("HEALTHY");
  });
});
