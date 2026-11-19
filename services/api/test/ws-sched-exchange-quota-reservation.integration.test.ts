/**
 * WS-SCHED / PRO-BL2-02 — the monthly export-package allowance is RESERVED at
 * admission, through the REAL routes against a disposable PostgreSQL.
 *
 * At base the route only READ `entitlement_usage` and the worker wrote it at
 * READY, so ten concurrent requests at `limit - 1` all answered 201 and the
 * month overshot by nine. Now: exactly one 201 and nine 429; the READY step
 * does not meter a reserved package a second time; a failed build gives its
 * unit back and "Build again" re-reserves; a legacy (unreserved) package is
 * still metered once at READY.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const upload = vi.hoisted(() => ({ fail: false, puts: 0 }));
vi.mock("../../worker/src/storage.js", () => ({
  putObjectBuffer: async () => {
    upload.puts += 1;
    if (upload.fail) throw new Error("simulated storage outage");
    return { versionId: null };
  },
  deleteObjectVersions: async () => ({ deleted: true, retainedVersions: 0, failed: 0 }),
}));
vi.mock("../../worker/src/config.js", () => ({
  env: { S3_BUCKET: "test-bucket" },
}));
vi.mock("../../worker/src/db.js", () => ({ prisma: {} }));

import { entitlementPeriodStart } from "@proovra/shared-runtime";

const LIMIT = 3;

describe("PRO-BL2-02 export-package allowance reservation (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let buildExchangePackage: (typeof import("../../worker/src/exchange-package-builder.js"))["buildExchangePackage"];
  let revokePackage: (typeof import("../src/services/exchange/evidence-exchange.service.js"))["revokePackage"];

  const consumed = async (teamId: string) => {
    const row = await prisma.entitlementUsage.findUnique({
      where: {
        teamId_key_periodStartUtc: {
          teamId,
          key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
          periodStartUtc: entitlementPeriodStart("MONTH"),
        },
      },
      select: { consumed: true },
    });
    return row ? Number(row.consumed) : 0;
  };
  const setConsumed = (teamId: string, value: number) =>
    prisma.entitlementUsage.upsert({
      where: {
        teamId_key_periodStartUtc: {
          teamId,
          key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
          periodStartUtc: entitlementPeriodStart("MONTH"),
        },
      },
      create: {
        teamId,
        key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
        periodStartUtc: entitlementPeriodStart("MONTH"),
        consumed: BigInt(value),
      },
      update: { consumed: BigInt(value) },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    ({ buildExchangePackage } = await import("../../worker/src/exchange-package-builder.js"));
    ({ revokePackage } = await import("../src/services/exchange/evidence-exchange.service.js"));
    const { teamA } = h.fixtures;
    await prisma.user.update({ where: { id: teamA.ownerUserId }, data: { currentWorkspaceId: teamA.teamId } });
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({
      teamId: teamA.teamId,
      key: "FEATURE_EVIDENCE_EXCHANGE",
      value: true,
      kind: "FEATURE",
      source: "CUSTOM",
      grantedByUserId: teamA.ownerUserId,
    });
    await upsertEntitlementGrant({
      teamId: teamA.teamId,
      key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
      value: LIMIT,
      kind: "QUOTA",
      source: "CUSTOM",
      grantedByUserId: teamA.ownerUserId,
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const where = { teamId: h.fixtures.teamA.teamId };
      await prisma.evidenceExchangePackageBuild.deleteMany({ where }).catch(() => undefined);
      await prisma.evidenceExchangePackage.deleteMany({ where }).catch(() => undefined);
      await prisma.entitlementUsage.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  const create = () =>
    h.app.inject({
      method: "POST",
      url: "/v1/exchange/packages",
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
      payload: { kind: "EVIDENCE", evidenceIds: [h.fixtures.teamA.evidenceId] },
    });

  it("ten concurrent requests at limit-1 admit exactly one", async () => {
    const { teamA } = h.fixtures;
    await setConsumed(teamA.teamId, LIMIT - 1);
    const results = await Promise.all(Array.from({ length: 10 }, () => create()));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201), JSON.stringify(results.map((r) => r.body))).toHaveLength(1);
    expect(codes.filter((c) => c === 429)).toHaveLength(9);
    for (const r of results.filter((x) => x.statusCode === 429)) {
      expect(r.json()).toEqual({ denial: "QUOTA_EXCEEDED", key: "QUOTA_EXPORT_PACKAGES_PER_MONTH" });
    }
    expect(await consumed(teamA.teamId)).toBe(LIMIT);
    expect(await prisma.evidenceExchangePackage.count({ where: { teamId: teamA.teamId } })).toBe(1);
  });

  it("READY does not meter a reserved package again; a failed build gives the unit back; Build again re-reserves", async () => {
    const { teamA } = h.fixtures;
    await prisma.evidenceExchangePackage.deleteMany({ where: { teamId: teamA.teamId } });
    await setConsumed(teamA.teamId, 0);
    const res = await create();
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { packageId: string }).packageId;
    expect(await consumed(teamA.teamId)).toBe(1);

    upload.fail = true;
    await buildExchangePackage(id, prisma as never);
    upload.fail = false;
    const failed = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id } });
    expect(failed.state).toBe("DRAFT");
    expect(failed.quotaReservedPeriodStartUtc).toBeNull();
    expect(await consumed(teamA.teamId)).toBe(0);

    const again = await h.app.inject({
      method: "POST",
      url: `/v1/exchange/packages/${id}/build`,
      headers: { authorization: `Bearer ${teamA.ownerToken}` },
    });
    expect(again.statusCode, again.body).toBe(202);
    expect(await consumed(teamA.teamId)).toBe(1);

    await buildExchangePackage(id, prisma as never);
    const ready = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id } });
    expect(ready.state).toBe("READY");
    expect(await consumed(teamA.teamId)).toBe(1);
  });

  it("Build again at the limit is refused and nothing moves", async () => {
    const { teamA } = h.fixtures;
    const draft = await prisma.evidenceExchangePackage.create({
      data: {
        teamId: teamA.teamId,
        kind: "EVIDENCE",
        state: "DRAFT",
        evidenceIds: [teamA.evidenceId] as never,
        createdByUserId: teamA.ownerUserId,
      },
      select: { id: true },
    });
    await setConsumed(teamA.teamId, LIMIT);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/exchange/packages/${draft.id}/build`,
      headers: { authorization: `Bearer ${teamA.ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(429);
    expect((await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: draft.id } })).state).toBe("DRAFT");
    expect(await consumed(teamA.teamId)).toBe(LIMIT);
  });

  it("a legacy package with no reservation is still metered exactly once at READY", async () => {
    const { teamA } = h.fixtures;
    await setConsumed(teamA.teamId, 0);
    const legacy = await prisma.evidenceExchangePackage.create({
      data: {
        teamId: teamA.teamId,
        kind: "EVIDENCE",
        state: "BUILDING",
        evidenceIds: [teamA.evidenceId] as never,
        createdByUserId: teamA.ownerUserId,
      },
      select: { id: true },
    });
    await buildExchangePackage(legacy.id, prisma as never);
    expect((await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: legacy.id } })).state).toBe("READY");
    expect(await consumed(teamA.teamId)).toBe(1);
  });

  it("revoking a BUILDING package gives its reserved unit back once", async () => {
    const { teamA } = h.fixtures;
    await setConsumed(teamA.teamId, 0);
    const res = await create();
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { packageId: string }).packageId;
    expect(await consumed(teamA.teamId)).toBe(1);
    const first = await revokePackage({ teamId: teamA.teamId, packageId: id, actorUserId: teamA.ownerUserId });
    const second = await revokePackage({ teamId: teamA.teamId, packageId: id, actorUserId: teamA.ownerUserId });
    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(false);
    expect(await consumed(teamA.teamId)).toBe(0);
  });

  // WS-SCHED / PRO-W1-07 (DEC-04) — the builder asks the workspace AGAIN when
  // it claims a build. At base it trusted the BUILDING row: all three packages
  // below were built and went READY.
  it("PRO-W1-07: a build claimed after the entitlement lapsed, the organization was suspended, or the workspace closed is refused — DRAFT, unit returned, nothing uploaded", async () => {
    const { teamA } = h.fixtures;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } });
    const grantWhere = { teamId_key: { teamId: teamA.teamId, key: "FEATURE_EVIDENCE_EXCHANGE" } };
    const admitted = async () => {
      await setConsumed(teamA.teamId, 0);
      const res = await create();
      expect(res.statusCode, res.body).toBe(201);
      expect(await consumed(teamA.teamId)).toBe(1);
      return (res.json() as { packageId: string }).packageId;
    };
    const refused = async (id: string, reason: string) => {
      const row = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id } });
      expect(row.state, reason).toBe("DRAFT");
      expect(row.storageKey, reason).toBeNull();
      expect(row.packageSizeBytes, reason).toBeNull();
      expect(row.quotaReservedPeriodStartUtc, reason).toBeNull();
      expect(await consumed(teamA.teamId), reason).toBe(0);
      const build = await prisma.evidenceExchangePackageBuild.findFirstOrThrow({ where: { packageId: id } });
      expect(build.state).toBe("FAILED");
      expect(build.failureReason).toBe(`exchange_build_refused:${reason}`);
    };
    const putsBefore = upload.puts;

    // 1. The entitlement expired between the request and the claim.
    let id = await admitted();
    await prisma.entitlementGrant.update({ where: grantWhere, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
    await buildExchangePackage(id, prisma as never);
    await refused(id, "exchange_not_entitled");
    await prisma.entitlementGrant.update({ where: grantWhere, data: { expiresAtUtc: null } });

    // 2. The organization was suspended.
    id = await admitted();
    await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "SUSPENDED" } as never });
    await buildExchangePackage(id, prisma as never);
    await refused(id, "organization_not_active");
    await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "ACTIVE" } as never });

    // 3. The workspace was closed.
    id = await admitted();
    await prisma.team.update({ where: { id: teamA.teamId }, data: { closedAtUtc: new Date() } });
    await buildExchangePackage(id, prisma as never);
    await refused(id, "workspace_closed");
    await prisma.team.update({ where: { id: teamA.teamId }, data: { closedAtUtc: null } });
    expect(upload.puts, "no refused build reached object storage").toBe(putsBefore);

    // Live and entitled again: the same package builds (Build again re-reserves).
    const again = await h.app.inject({
      method: "POST",
      url: `/v1/exchange/packages/${id}/build`,
      headers: { authorization: `Bearer ${teamA.ownerToken}` },
    });
    expect(again.statusCode, again.body).toBe(202);
    await buildExchangePackage(id, prisma as never);
    const ready = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id } });
    expect(ready.state).toBe("READY");
    expect(ready.packageSizeBytes).not.toBeNull();
  });
});
