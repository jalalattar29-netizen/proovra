/**
 * AUTHZ-006 — a request acts in one workspace, the one it names.
 *
 * The pointer is one column shared by every tab and device. Guards read it once
 * and handlers read it again, so moving it between the two let a VIEWER of an
 * Organization run a guard-only write there on the strength of owning Personal
 * (probe P9), and a second tab sent a form from one tenant into another.
 *
 * Real routes, real membership rows, real switches through the switch route.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedPersonalTenant,
  type FixtureDeps,
  type OrganizationTenant,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

const WORKSPACE_HEADER = "x-proovra-workspace-id";

describe("Workspace of a request (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let deps: FixtureDeps;
  const tag = `wrc-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const post = (
    url: string,
    token: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    harness.app.inject({
      method: "POST",
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });

  function mint(userId: string, email: string): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );
  }

  async function orgRecord(org: OrganizationTenant): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        ownerUserId: org.owner.userId,
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        type: "PHOTO",
      },
      select: { id: true },
    });
    return row.id;
  }

  /** A person who owns Personal and is only a VIEWER of the Organization. */
  async function viewerOf(org: OrganizationTenant): Promise<{
    person: PersonalTenant;
    token: string;
  }> {
    const person = await seedPersonalTenant(deps, "FREE");
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: person.owner.userId, role: "ORG_MEMBER" },
    });
    await prisma.teamMember.create({
      data: {
        teamId: org.workspaceId,
        userId: person.owner.userId,
        role: "VIEWER",
        status: "ACTIVE",
      },
    });
    await prisma.user.update({
      where: { id: person.owner.userId },
      data: { currentWorkspaceId: person.personalTeamId },
    });
    return { person, token: person.owner.token };
  }

  const pointTo = (userId: string, workspaceId: string) =>
    prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: workspaceId } });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    deps = { prisma: prisma as never, tag, mintToken: mint };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("the workspace on screen decides, wherever another tab left the pointer", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const personal = await bootstrapPersonalSpace(deps, org.owner.userId);
    const recordId = await orgRecord(org);
    await pointTo(org.owner.userId, personal.teamId);

    const res = await post(
      "/v1/lifecycle/archive/transition",
      org.owner.token,
      { evidenceId: recordId, toTier: "COLD" },
      { [WORKSPACE_HEADER]: org.workspaceId },
    );
    await harness.handlersSettled();
    expect(res.statusCode, res.body).not.toBe(403);
    const rows = await prisma.archiveTierTransition.findMany({
      where: { evidenceId: recordId },
      select: { teamId: true },
    });
    expect(rows).toEqual([{ teamId: org.workspaceId }]);
  });

  it("a client that names nothing still works from the pointer", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const recordId = await orgRecord(org);
    await pointTo(org.owner.userId, org.workspaceId);
    const res = await post("/v1/lifecycle/archive/transition", org.owner.token, {
      evidenceId: recordId,
      toTier: "COLD",
    });
    await harness.handlersSettled();
    expect(res.statusCode, res.body).not.toBe(403);
    expect(await prisma.archiveTierTransition.count({ where: { evidenceId: recordId } })).toBe(1);
  });

  it("a named workspace the caller is not in is refused, never swapped for one they are", async () => {
    const orgA = await seedOrganizationTenant(deps, {});
    const orgB = await seedOrganizationTenant(deps, {});
    const recordA = await orgRecord(orgA);
    await pointTo(orgA.owner.userId, orgA.workspaceId);
    const res = await post(
      "/v1/lifecycle/archive/transition",
      orgA.owner.token,
      { evidenceId: recordA, toTier: "COLD" },
      { [WORKSPACE_HEADER]: orgB.workspaceId },
    );
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.archiveTierTransition.count({ where: { evidenceId: recordA } })).toBe(0);
  });

  it("a value that cannot be a workspace id is refused rather than falling back to the pointer", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const recordId = await orgRecord(org);
    await pointTo(org.owner.userId, org.workspaceId);
    const res = await post(
      "/v1/lifecycle/archive/transition",
      org.owner.token,
      { evidenceId: recordId, toTier: "COLD" },
      { [WORKSPACE_HEADER]: "not-a-workspace" },
    );
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.archiveTierTransition.count({ where: { evidenceId: recordId } })).toBe(0);
  });

  it("a VIEWER naming the Organization is held to the Organization's permissions", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const { person, token } = await viewerOf(org);
    const recordId = await orgRecord(org);
    const res = await post(
      "/v1/lifecycle/archive/transition",
      token,
      { evidenceId: recordId, toTier: "COLD" },
      { [WORKSPACE_HEADER]: org.workspaceId },
    );
    expect(res.statusCode, res.body).toBe(403);
    expect(
      await prisma.archiveTierTransition.count({ where: { evidenceId: recordId } }),
    ).toBe(0);
    expect(person.personalTeamId).not.toBe(org.workspaceId);
  });

  it("P9: moving the pointer between the guard and the handler acts nowhere it was not checked", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const { person, token } = await viewerOf(org);
    const recordId = await orgRecord(org);

    // The request reads the pointer at Personal, where this person is OWNER, and
    // the pointer moves to the Organization before anything else happens. This
    // is the interleaving the timed race below can only hit by luck.
    const delegate = prisma.user as unknown as { findUnique: (args: unknown) => Promise<unknown> };
    const realFindUnique = delegate.findUnique;
    let moved = false;
    delegate.findUnique = async (args) => {
      const result = await realFindUnique.call(prisma.user, args);
      const select = (args as { select?: { currentWorkspaceId?: boolean } }).select;
      if (select?.currentWorkspaceId && !moved) {
        moved = true;
        await pointTo(person.owner.userId, org.workspaceId);
      }
      return result;
    };
    try {
      const res = await post("/v1/lifecycle/archive/transition", token, {
        evidenceId: recordId,
        toTier: "COLD",
      });
      await harness.handlersSettled();
      expect(moved).toBe(true);
      expect(res.statusCode, res.body).not.toBe(200);
    } finally {
      delegate.findUnique = realFindUnique;
    }
    expect(
      await prisma.archiveTierTransition.count({ where: { evidenceId: recordId } }),
    ).toBe(0);
  });

  it("P9: the timed race never lands a guard-only write in the Organization", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const { person, token } = await viewerOf(org);
    const recordId = await orgRecord(org);

    const switchTo = (workspaceId: string) =>
      post("/v1/platform/context/switch-workspace", token, { workspaceId });

    for (let round = 0; round < 25; round += 1) {
      const responses = await Promise.all([
        switchTo(org.workspaceId),
        post("/v1/lifecycle/archive/transition", token, { evidenceId: recordId, toTier: "COLD" }),
        switchTo(person.personalTeamId),
        post("/v1/lifecycle/archive/transition", token, { evidenceId: recordId, toTier: "COLD" }),
      ]);
      for (const res of responses) expect(res.statusCode).toBeLessThan(500);
    }
    await harness.handlersSettled();
    expect(
      await prisma.archiveTierTransition.count({ where: { evidenceId: recordId } }),
    ).toBe(0);
  }, 120_000);
});
