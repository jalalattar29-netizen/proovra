/**
 * Independent forward audit closure — F-16 (2026-10-21), the user-scoped
 * Reports list (GET /v1/reports) over real HTTP against live PostgreSQL 16.
 *
 * The list re-derived the output state on its own: a package the governance
 * gate BLOCKED (verificationPackageMetadata.blocked, written by the worker on a
 * PackageGateDeniedError) was described from the report's request state, so
 * the row offered a package that the gate refuses. It now reads the same block
 * the workspace aggregator reads.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("F-16 — GET /v1/reports states a gate-blocked package as BLOCKED (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  async function signedRecord(verificationPackageMetadata: unknown) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: `F-16 ${randomUUID().slice(0, 8)}`,
        type: "DOCUMENT",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        signedAtUtc: new Date(),
        verificationPackageMetadata: verificationPackageMetadata as never,
      },
      select: { id: true },
    });
    created.push(row.id);
    return row.id;
  }

  async function listRow(id: string) {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports?teamId=${h.fixtures.teamA.teamId}&limit=100`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: Array<{ evidenceId: string; reportLifecycle: string; packageLifecycle: string }> }).items;
    const row = items.find((i) => i.evidenceId === id);
    expect(row, `record ${id} is listed`).toBeDefined();
    return row!;
  }

  it("a package the governance gate blocked is BLOCKED, whatever the report request says", async () => {
    const id = await signedRecord({
      blocked: true,
      outcome: "BLOCKED_BY_HOLD",
      reason: "Legal hold",
      label: "Blocked",
      blockedAtUtc: new Date().toISOString(),
    });
    const row = await listRow(id);
    expect(row.packageLifecycle).toBe("BLOCKED");
    expect(row.reportLifecycle).not.toBe("BLOCKED");
  });

  it("without a gate block the package follows its own request state", async () => {
    const id = await signedRecord(null);
    const row = await listRow(id);
    expect(row.packageLifecycle).not.toBe("BLOCKED");
  });
});
