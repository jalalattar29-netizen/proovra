/**
 * THE TENANT RUNTIME STATUS — only what can affect a tenant.
 *
 * `GET /v1/runtime/status` rolled up all fourteen readiness subsystems, so a
 * deployment without SENTRY_DSN (Sentry reports DEGRADED when absent) told
 * every customer, on every page that mounts the banner, that the platform was
 * degraded. Observability configuration is an operator concern; a failing
 * database, storage, queue or worker is not, and must still surface.
 */

import { describe, expect, it } from "vitest";

import {
  OPERATOR_ONLY_SUBSYSTEMS,
  projectTenantRuntimeStatus,
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
  "metrics",
  "sentry",
  "cron_secrets",
  "search_indexing",
  "multipart_storage",
  "media_intelligence",
  "investigation_graph",
];

function report(overrides: Partial<Record<SubsystemId, ReadinessStatus>>) {
  const subsystems: SubsystemReadiness[] = ALL.map((id) => ({
    id,
    status: overrides[id] ?? "HEALTHY",
    reasonCode: "test",
    detail: "test",
    remediationHint: null,
    metadata: {},
  }));
  return { subsystems };
}

describe("projectTenantRuntimeStatus", () => {
  it("missing observability configuration alone is HEALTHY for a tenant", () => {
    expect(projectTenantRuntimeStatus(report({ sentry: "DEGRADED" }))).toBe("HEALTHY");
    expect(projectTenantRuntimeStatus(report({ cron_secrets: "DEGRADED" }))).toBe("HEALTHY");
    expect(
      projectTenantRuntimeStatus(report({ sentry: "DEGRADED", cron_secrets: "DEGRADED", metrics: "DEGRADED" })),
    ).toBe("HEALTHY");
  });

  it("a genuine tenant-impacting failure is surfaced, even beside missing observability", () => {
    for (const id of ["database", "s3_object_lock", "multipart_storage", "queues", "workers", "redis", "schema"] as const) {
      expect(projectTenantRuntimeStatus(report({ [id]: "DEGRADED", sentry: "DEGRADED" }))).toBe("DEGRADED");
      expect(projectTenantRuntimeStatus(report({ [id]: "CRITICAL" }))).toBe("DEGRADED");
    }
  });

  it("an unmeasured subsystem is UNAVAILABLE, never HEALTHY", () => {
    expect(projectTenantRuntimeStatus(report({ queues: "UNKNOWN" }))).toBe("UNAVAILABLE");
    // …but a real failure outranks not knowing.
    expect(projectTenantRuntimeStatus(report({ queues: "UNKNOWN", workers: "DEGRADED" }))).toBe("DEGRADED");
    expect(projectTenantRuntimeStatus({ subsystems: [] })).toBe("UNAVAILABLE");
  });

  it("everything healthy is HEALTHY", () => {
    expect(projectTenantRuntimeStatus(report({}))).toBe("HEALTHY");
  });

  it("excludes exactly the operator-only subsystems — nothing that stores, queues or serves tenant work", () => {
    expect([...OPERATOR_ONLY_SUBSYSTEMS].sort()).toEqual(["cron_secrets", "metrics", "sentry"]);
  });
});
