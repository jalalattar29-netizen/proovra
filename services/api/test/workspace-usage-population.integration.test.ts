/**
 * ET-SEC-22 — a personal workspace's storage is measured over ONE population
 * at creation and at completion. Live PostgreSQL 16.
 *
 * On a40ca76f creation passed a personal scope (teamId null: legacy NULL-team
 * rows + the personal team) and completion passed the personal TEAM id
 * (strict: team rows only), so completion undercounted by every legacy byte.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("workspace usage population (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("creation-shaped and completion-shaped scopes measure the same bytes, legacy rows included", async () => {
    const P = h.fixtures.personal;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: P.teamId }, select: { organizationId: true } });
    await prisma.evidence.create({
      data: { title: "legacy", type: "PHOTO", status: "SIGNED", teamId: null, ownerUserId: P.userId, sizeBytes: 1_000n } as never,
    });
    await prisma.evidence.create({
      data: { title: "team", type: "PHOTO", status: "SIGNED", teamId: P.teamId, organizationId: team.organizationId, ownerUserId: P.userId, sizeBytes: 500n } as never,
    });

    const { resolveEnforcementScopeForRequester } = await import("../src/services/billing-enforcement.service.js");
    const { getWorkspaceUsage } = await import("../src/services/workspace-usage.service.js");
    const atCreation = await getWorkspaceUsage(await resolveEnforcementScopeForRequester({ ownerUserId: P.userId, teamId: null }));
    const atCompletion = await getWorkspaceUsage(await resolveEnforcementScopeForRequester({ ownerUserId: P.userId, teamId: P.teamId }));
    expect(atCompletion.storageBytesUsed).toBe(atCreation.storageBytesUsed);
    expect(atCompletion.storageBytesUsed >= 1_500n).toBe(true);
  });
});
