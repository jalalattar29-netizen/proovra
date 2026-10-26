/**
 * Members audit CT-14 / re-audit defect 16 — the platform context's
 * "has a pending invitation" signal reads the WORKSPACE invitation authority.
 *
 * `operationalEligibility.collaboration.hasPendingInvitation` was computed from
 * the retired Collaboration Team invitation table, which no current writer
 * fills, so a person invited to a workspace was never told so by the envelope.
 * The canonical invitation is a `team_invites` row (written only by
 * workspace-invitation.service). This drives the real builder against a
 * disposable PostgreSQL with real invitation rows.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("CT-14 — the envelope's pending-invitation signal reads workspace invitations", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let build: typeof import("../src/services/platform-context/platform-context.service.js").buildPlatformContext;

  let inviteeUserId: string;
  let inviteeEmail: string;
  let workspaceId: string;
  let inviterUserId: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    build = (
      await import("../src/services/platform-context/platform-context.service.js")
    ).buildPlatformContext;

    // A real person in ANOTHER workspace, invited into teamA's workspace.
    inviteeUserId = h.fixtures.teamB.viewerUserId;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: inviteeUserId },
      select: { email: true },
    });
    inviteeEmail = user.email!;
    workspaceId = h.fixtures.teamA.teamId;
    inviterUserId = h.fixtures.teamA.ownerUserId;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const signal = async (): Promise<boolean> => {
    const res = await build({ userId: inviteeUserId, requestId: randomUUID() });
    expect(res.ok, "the builder must resolve for a real user").toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return res.envelope.operationalEligibility.collaboration.hasPendingInvitation;
  };

  const invite = async (over: {
    expiresAt?: Date;
    revokedAt?: Date | null;
    acceptedAt?: Date | null;
  } = {}) =>
    prisma.teamInvite.create({
      data: {
        teamId: workspaceId,
        // workspace-invitation.service stores the address trimmed + lower-cased.
        email: inviteeEmail.trim().toLowerCase(),
        role: "MEMBER",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        invitedByUserId: inviterUserId,
        expiresAt: over.expiresAt ?? new Date(Date.now() + 86_400_000),
        revokedAt: over.revokedAt ?? null,
        acceptedAt: over.acceptedAt ?? null,
      },
      select: { id: true },
    });

  it("no invitation → false; a revoked, accepted or expired one → still false", async () => {
    await prisma.teamInvite.deleteMany({ where: { email: inviteeEmail.toLowerCase() } });
    expect(await signal()).toBe(false);

    await invite({ revokedAt: new Date() });
    await invite({ acceptedAt: new Date() });
    await invite({ expiresAt: new Date(Date.now() - 60_000) });
    expect(await signal(), "only a still-actionable invitation counts").toBe(false);
  });

  it("a pending workspace invitation addressed to the person → true", async () => {
    // One open row per (workspace, address) is a unique index; clear the
    // expired one the previous case left.
    await prisma.teamInvite.deleteMany({ where: { email: inviteeEmail.toLowerCase() } });
    const row = await invite();
    expect(await signal()).toBe(true);

    // Revoking it (recorded, never deleted) withdraws the signal again.
    await prisma.teamInvite.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    expect(await signal()).toBe(false);
  });
});
