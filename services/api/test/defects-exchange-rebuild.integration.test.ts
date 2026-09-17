/**
 * D59 — "Build again" for an exchange package whose build failed, against a
 * disposable PostgreSQL + Redis through the REAL routes.
 *
 * A failed build returns the package to DRAFT (the worker's builder), and
 * before this nothing could hand it back to the builder: the only caller of
 * `requestExchangePackageBuild` was creation. POST /v1/exchange/packages/:id/build
 * is that request. It has creation's gates, moves DRAFT -> BUILDING
 * conditionally, answers any other state with a bounded 409, is audited, and
 * answers a package in another workspace exactly like a missing one.
 *
 * No provider is contacted; the worker's object-storage upload is replaced at
 * its module boundary so the rebuilt package can be driven to READY.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const upload = vi.hoisted(() => ({ fail: false }));
vi.mock("../../worker/src/storage.js", () => ({
  putObjectBuffer: async () => {
    if (upload.fail) throw new Error("simulated storage outage");
  },
}));
vi.mock("../../worker/src/config.js", () => ({
  env: { S3_BUCKET: "test-bucket" },
}));
vi.mock("../../worker/src/db.js", () => ({ prisma: {} }));

describe("D59 exchange package rebuild (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const call = (opts: { method: "GET" | "POST"; url: string; token: string }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: { authorization: `Bearer ${opts.token}` },
    });

  async function seedPackage(teamId: string, ownerUserId: string, state: string) {
    return prisma.evidenceExchangePackage.create({
      data: {
        teamId,
        kind: "EVIDENCE",
        state,
        evidenceIds: [randomUUID()] as never,
        createdByUserId: ownerUserId,
      },
      select: { id: true },
    });
  }

  const stateOf = async (id: string) =>
    (await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id }, select: { state: true } })).state;

  const buildAudit = (packageId: string) =>
    prisma.adminAuditLog.findMany({
      where: { action: "exchange.package.build_requested", resourceId: packageId } as never,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    const { teamA, teamB } = h.fixtures;
    for (const userId of [teamA.ownerUserId, teamA.viewerUserId]) {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamA.teamId } });
    }
    await prisma.user.update({ where: { id: teamB.ownerUserId }, data: { currentWorkspaceId: teamB.teamId } });
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    for (const t of [teamA, teamB]) {
      await upsertEntitlementGrant({
        teamId: t.teamId,
        key: "FEATURE_EVIDENCE_EXCHANGE",
        value: true,
        kind: "FEATURE",
        source: "CUSTOM",
        grantedByUserId: t.ownerUserId,
      });
      await upsertEntitlementGrant({
        teamId: t.teamId,
        key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
        value: 100,
        kind: "QUOTA",
        source: "CUSTOM",
        grantedByUserId: t.ownerUserId,
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const where = { teamId: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } };
      await prisma.evidenceExchangePackageBuild.deleteMany({ where }).catch(() => undefined);
      await prisma.evidenceExchangePackage.deleteMany({ where }).catch(() => undefined);
      await prisma.entitlementUsage.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  it("D59 a failed build is projected, and Build again hands the DRAFT package back to the builder", async () => {
    const { teamA } = h.fixtures;
    const pkg = await seedPackage(teamA.teamId, teamA.ownerUserId, "BUILDING");
    const { buildExchangePackage } = await import("../../worker/src/exchange-package-builder.js");

    // The real builder fails the build and returns the package to DRAFT.
    upload.fail = true;
    await buildExchangePackage(pkg.id, prisma as never);
    upload.fail = false;
    expect(await stateOf(pkg.id)).toBe("DRAFT");

    // The list says the last build failed, boundedly (no internal message).
    const listed = await call({ method: "GET", url: "/v1/exchange/packages", token: teamA.ownerToken });
    expect(listed.statusCode, listed.body).toBe(200);
    const row = (listed.json() as { packages: Array<Record<string, unknown>> }).packages.find((p) => p.id === pkg.id)!;
    expect(row.state).toBe("DRAFT");
    expect(row.lastBuild).toMatchObject({ state: "FAILED" });
    expect(typeof (row.lastBuild as { failedAtUtc: unknown }).failedAtUtc).toBe("string");
    expect(listed.body).not.toContain("simulated storage outage");

    const res = await call({ method: "POST", url: `/v1/exchange/packages/${pkg.id}/build`, token: teamA.ownerToken });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ packageId: pkg.id, state: "BUILDING" });
    expect(await stateOf(pkg.id)).toBe("BUILDING");

    const audit = await buildAudit(pkg.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId: teamA.ownerUserId,
      workspaceId: teamA.teamId,
      resourceType: "evidence_exchange_package",
      outcome: "success",
    });

    // The builder now picks it up and the rebuild completes.
    await buildExchangePackage(pkg.id, prisma as never);
    expect(await stateOf(pkg.id)).toBe("READY");
    const after = await call({ method: "GET", url: "/v1/exchange/packages", token: teamA.ownerToken });
    const rebuilt = (after.json() as { packages: Array<Record<string, unknown>> }).packages.find((p) => p.id === pkg.id)!;
    expect(rebuilt.lastBuild).toBeNull();
  });

  it("D59 a package that is not DRAFT is refused with a bounded 409 and left alone", async () => {
    const { teamA } = h.fixtures;
    for (const state of ["BUILDING", "READY", "REVOKED"]) {
      const pkg = await seedPackage(teamA.teamId, teamA.ownerUserId, state);
      const res = await call({ method: "POST", url: `/v1/exchange/packages/${pkg.id}/build`, token: teamA.ownerToken });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ code: "EXCHANGE_PACKAGE_NOT_DRAFT", denial: "EXCHANGE_PACKAGE_NOT_DRAFT", state });
      expect(await stateOf(pkg.id)).toBe(state);
      const audit = await buildAudit(pkg.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: "denied" });
    }
  });

  it("D59 a viewer cannot request a build", async () => {
    const { teamA } = h.fixtures;
    const pkg = await seedPackage(teamA.teamId, teamA.ownerUserId, "DRAFT");
    const res = await call({ method: "POST", url: `/v1/exchange/packages/${pkg.id}/build`, token: teamA.viewerToken });
    expect(res.statusCode, res.body).toBe(403);
    expect(await stateOf(pkg.id)).toBe("DRAFT");
    expect(await buildAudit(pkg.id)).toHaveLength(0);
  });

  it("D59 another workspace's package answers exactly like a missing one", async () => {
    const { teamA, teamB } = h.fixtures;
    const pkg = await seedPackage(teamA.teamId, teamA.ownerUserId, "DRAFT");
    const foreign = await call({ method: "POST", url: `/v1/exchange/packages/${pkg.id}/build`, token: teamB.ownerToken });
    const missing = await call({ method: "POST", url: `/v1/exchange/packages/${randomUUID()}/build`, token: teamB.ownerToken });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
    expect(await stateOf(pkg.id)).toBe("DRAFT");
    expect(await buildAudit(pkg.id)).toHaveLength(0);
  });
});
