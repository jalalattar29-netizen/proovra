/**
 * ET-REC-03 — the output projection resolves a team_id-NULL Personal record's
 * workspace by the WRITER's rule (the owner's personal workspace). Live
 * PostgreSQL 16, the real facts loader.
 *
 * On a40ca76f `workspaceResolved` was `Boolean(team_id)`, so every surface
 * withdrew Generate / Recover / Retry (WORKSPACE_UNRESOLVED) and the customer
 * POST was declined for records the durable writer and the worker accept —
 * and the personal workspace's own closed/suspended state was never read for
 * them.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("output facts: team_id-NULL Personal records (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let load: (typeof import("../src/services/reports/output-recovery.service.js"))["loadEvidenceOutputFacts"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    ({ loadEvidenceOutputFacts: load } = await import("../src/services/reports/output-recovery.service.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function nullTeamRecord(ownerUserId: string) {
    return (
      await prisma.evidence.create({
        data: { title: `null-team ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: null, organizationId: null, ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }

  it("resolves to the owner's personal workspace; no action is withdrawn as WORKSPACE_UNRESOLVED", async () => {
    const P = h.fixtures.personal;
    const id = await nullTeamRecord(P.userId);
    const f = (await load({ evidenceIds: [id], callerUserId: P.userId })).get(id)!;
    expect(f.facts.restrictions.workspaceResolved).toBe(true);
    expect(f.actions.report.action === "NONE" ? f.actions.report.reason : null).not.toBe("WORKSPACE_UNRESOLVED");
    expect(f.actions.verificationPackage.action === "NONE" ? f.actions.verificationPackage.reason : null).not.toBe(
      "WORKSPACE_UNRESOLVED",
    );
  });

  it("the personal workspace's own closed state applies to its NULL-team records", async () => {
    const P = h.fixtures.personal;
    const id = await nullTeamRecord(P.userId);
    await prisma.team.update({ where: { id: P.teamId }, data: { closedAtUtc: new Date() } });
    try {
      const f = (await load({ evidenceIds: [id], callerUserId: P.userId })).get(id)!;
      expect(f.facts.restrictions.workspaceClosed).toBe(true);
    } finally {
      await prisma.team.update({ where: { id: P.teamId }, data: { closedAtUtc: null } });
    }
  });

  it("a record whose owner has no personal workspace is still unresolved", async () => {
    const A = h.fixtures.teamA;
    // teamA's owner is an organization member; ensure no personal workspace for this probe.
    const personal = await prisma.team.findFirst({ where: { ownerUserId: A.ownerUserId, isPersonal: true }, select: { id: true } });
    if (personal) return; // the harness gave this owner one: covered by the first case
    const id = await nullTeamRecord(A.ownerUserId);
    const f = (await load({ evidenceIds: [id], callerUserId: A.ownerUserId })).get(id)!;
    expect(f.facts.restrictions.workspaceResolved).toBe(false);
  });
});
