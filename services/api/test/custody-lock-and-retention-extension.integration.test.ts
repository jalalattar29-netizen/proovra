/**
 * ET-CUS-08 / ET-CUS-10 — Live PostgreSQL 16, the real routes and the Worker's
 * real retention sweep.
 *
 * On a40ca76f:
 *   - unlocking wrote no custody event (the timeline kept saying "locked"),
 *     and a repeated lock wrote a second EVIDENCE_LOCKED;
 *   - a policy's auto-extension fired on ANY recent custody event — including
 *     an anonymous public VERIFY_VIEWED, so anyone holding the link could keep
 *     a record from ever reaching retention — and the extension itself was not
 *     recorded in custody.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("lock/unlock and retention extension on the custody chain (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let retention: typeof import("../../worker/src/governance/retention-reconciliation.worker.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    retention = await import("../../worker/src/governance/retention-reconciliation.worker.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(extra: Record<string, unknown> = {}) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `lock ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, ...extra } as never,
        select: { id: true },
      })
    ).id;
  }
  const types = async (evidenceId: string) =>
    (await prisma.custodyEvent.findMany({ where: { evidenceId }, orderBy: { sequence: "asc" }, select: { eventType: true } })).map((e) =>
      String(e.eventType),
    );
  const post = (url: string, payload: unknown) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });

  it("ET-CUS-08: lock, a repeated lock, and unlock each record exactly what changed", async () => {
    const id = await record();
    expect((await post(`/v1/evidence/${id}/lock`, { locked: true })).statusCode).toBe(200);
    expect((await post(`/v1/evidence/${id}/lock`, { locked: true })).statusCode).toBe(200);
    const unlock = await post(`/v1/evidence/${id}/unlock`, { reason: "correction" });
    expect(unlock.statusCode, unlock.body).toBe(200);
    expect(await types(id)).toEqual(["EVIDENCE_LOCKED", "EVIDENCE_UNLOCKED"]);
  });

  async function autoExtendingPolicyVersion(): Promise<string> {
    const A = h.fixtures.teamA;
    const policy = await prisma.evidenceRetentionPolicy.create({
      data: { teamId: A.teamId, displayName: `auto ${randomUUID().slice(0, 6)}`, scope: "WORKSPACE", createdByUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    const version = await prisma.evidenceRetentionPolicyVersion.create({
      data: {
        retentionPolicyId: policy.id,
        version: 1,
        authoredByUserId: A.ownerUserId,
        autoExtensionEnabled: true,
        autoExtensionDays: 30,
        immutable: false,
      } as never,
      select: { id: true },
    });
    return version.id;
  }

  it("ET-CUS-10: only workspace activity extends retention, and the extension is on the chain", async () => {
    const versionId = await autoExtendingPolicyVersion();
    const expired = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const viewedPublicly = await record({ lifecycleState: "ACTIVE", retentionUntilUtc: expired, retentionPolicyVersionId: versionId });
    const usedInWorkspace = await record({ lifecycleState: "ACTIVE", retentionUntilUtc: expired, retentionPolicyVersionId: versionId });
    const append = (evidenceId: string, eventType: string) =>
      prisma.$transaction((tx) => runtime.appendCustodyEventTx(tx, { evidenceId, eventType: eventType as never, payload: {} }));
    await append(viewedPublicly, "VERIFY_VIEWED");
    await append(usedInWorkspace, "EVIDENCE_VIEWED");

    await retention.runRetentionReconciliation({ teamId: h.fixtures.teamA.teamId, trigger: "cus10-proof" });

    const after = async (id: string) =>
      prisma.evidence.findUniqueOrThrow({ where: { id }, select: { retentionUntilUtc: true } });
    expect((await after(viewedPublicly)).retentionUntilUtc!.getTime()).toBe(expired.getTime());
    expect(await types(viewedPublicly)).not.toContain("RETENTION_AUTO_EXTENDED");
    expect((await after(usedInWorkspace)).retentionUntilUtc!.getTime()).toBeGreaterThan(Date.now());
    expect(await types(usedInWorkspace)).toContain("RETENTION_AUTO_EXTENDED");
  });
});
