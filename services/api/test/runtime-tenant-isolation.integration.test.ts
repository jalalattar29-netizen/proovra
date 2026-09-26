/**
 * TENANT RUNTIME STATUS — CROSS-TENANT ISOLATION, PROVEN AGAINST POSTGRES.
 *
 * The readiness `queues` check counted every OPEN WORKER incident on the
 * platform — per-record OTS exhaustion, a workspace's stale review workflows —
 * and read the total as "queues may be stuck". One workspace's record could
 * therefore turn every other workspace's status DEGRADED.
 *
 * These write real incident rows and read the real readiness check and the
 * real route. No mock decides a count.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("tenant runtime status isolation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let readiness: typeof import("../src/runtime/runtime-readiness.js");
  const created: string[] = [];

  async function incident(scope: "WORKSPACE" | "PLATFORM", teamId: string | null, severity: "HIGH" | "CRITICAL" = "HIGH") {
    const row = await prisma.operationalIncident.create({
      data: {
        scope,
        teamId,
        category: "WORKER",
        severity,
        status: "OPEN",
        fingerprint: `isolation-test:${randomUUID()}`,
        title: "Isolation test incident",
        safeSummary: "Written by runtime-tenant-isolation.integration.test.ts",
      },
      select: { id: true },
    });
    created.push(row.id);
    return row.id;
  }

  async function queuesStatus() {
    const report = await readiness.runReadinessCheck(prisma as never, null);
    return report.subsystems.find((s) => s.id === "queues")!;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    readiness = await import("../src/runtime/runtime-readiness.js");
  }, 180_000);

  beforeEach(async () => {
    readiness.resetTenantRuntimeCacheForTests();
    if (created.length) {
      await prisma.operationalIncident.deleteMany({ where: { id: { in: created.splice(0) } } });
    }
  });

  afterAll(async () => {
    if (created.length) {
      await prisma?.operationalIncident.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  it("a WORKER incident in workspace B does not degrade the queue signal, nor anyone's generation", async () => {
    expect((await queuesStatus()).status).toBe("HEALTHY");
    await incident("WORKSPACE", harness.fixtures.teamB.teamId, "CRITICAL");
    const q = await queuesStatus();
    expect(q.status).toBe("HEALTHY");
    const projection = readiness.projectTenantCapabilities(
      await readiness.runReadinessCheck(prisma as never, null),
    );
    // Whatever else the fixture environment reports, the queue check did not
    // move artifact generation to DEGRADED.
    expect(projection.capabilities.artifactGeneration).not.toBe("DEGRADED");
  });

  it("an explicitly PLATFORM-scoped worker incident is platform-wide and is represented", async () => {
    await incident("PLATFORM", null);
    const q = await queuesStatus();
    expect(q.status).toBe("DEGRADED");
    const projection = readiness.projectTenantCapabilities(
      await readiness.runReadinessCheck(prisma as never, null),
    );
    expect(["DEGRADED", "UNAVAILABLE"]).toContain(projection.capabilities.artifactGeneration);
  });

  it("the route answers every tenant identically — B's incidents change nothing A reads, and nothing about B is disclosed", async () => {
    const read = async (token: string, url = "/v1/runtime/status") =>
      harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

    const before = await read(harness.fixtures.teamA.ownerToken);
    expect(before.statusCode).toBe(200);
    await incident("WORKSPACE", harness.fixtures.teamB.teamId, "CRITICAL");
    readiness.resetTenantRuntimeCacheForTests();
    const a = JSON.parse((await read(harness.fixtures.teamA.ownerToken)).body);
    const b = JSON.parse((await read(harness.fixtures.teamB.ownerToken)).body);
    const aWithB = JSON.parse(
      (await read(harness.fixtures.teamA.ownerToken, `/v1/runtime/status?teamId=${harness.fixtures.teamB.teamId}`)).body,
    );
    // Everything but the measurement time must be identical.
    const stable = (body: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(body).filter(([k]) => k !== "checkedAt"));
    expect(stable(a)).toEqual(stable(JSON.parse(before.body)));
    expect(stable(b)).toEqual(stable(a));
    expect(stable(aWithB)).toEqual(stable(a));
    expect(JSON.stringify(a)).not.toContain(harness.fixtures.teamB.teamId);
  });

  it("the cache is caller-independent and still requires authentication", async () => {
    const first = await harness.app.inject({
      method: "GET",
      url: "/v1/runtime/status",
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    expect(first.statusCode).toBe(200);
    // A warm cache does not answer an anonymous caller.
    const anon = await harness.app.inject({ method: "GET", url: "/v1/runtime/status" });
    expect(anon.statusCode).toBe(401);
    // …and the cached answer another tenant receives is the same projection.
    const other = await harness.app.inject({
      method: "GET",
      url: "/v1/runtime/status",
      headers: { authorization: `Bearer ${harness.fixtures.personal.token}` },
    });
    expect(JSON.parse(other.body)).toEqual(JSON.parse(first.body));
  });
});
