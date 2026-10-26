/**
 * SECOND RE-AUDIT CT-14 — which path a personal account's billing projection
 * takes, against live PostgreSQL.
 *
 * The finding cited billing-account-projection.service.ts's SHARED-workspace
 * collaboration arm (a `teamInvite` count). That arm was unreachable:
 * `BillingAccountType` is "PERSONAL" | "ORGANIZATION", the only route parses
 * exactly those two, and ORGANIZATION returns early into
 * `buildOrganizationProjection` (whose open-invitation count is proven by
 * org-seats-canonical-projection "CT-14 — the Organization billing projection
 * counts open workspace invitations only"). The dead arm was removed; the
 * compiler now pins the narrowing (`personalAccountType`).
 *
 * What a personal account takes — proven here:
 *   1. the route refuses any account type but PERSONAL / ORGANIZATION (there is
 *      no WORKSPACE billing account to project);
 *   2. a personal PRO account reports its Collaboration Teams allowance (ACTIVE,
 *      unarchived teams of its personal workspace against the plan's limit) and
 *      NO seats block — however many invitations its personal workspace holds;
 *   3. the same reached over the real route.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type Projection = {
  collaboration?: {
    seats?: unknown;
    collaborationTeams?: { used: number; limit: number };
  };
};

describe("CT-14 — a personal account's billing projection path (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let buildBillingAccountProjection: typeof import("../src/services/billing/billing-account-projection.service.js")["buildBillingAccountProjection"];
  let getPlanCapabilities: typeof import("@proovra/shared-billing")["getPlanCapabilities"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ buildBillingAccountProjection } = await import("../src/services/billing/billing-account-projection.service.js"));
    ({ getPlanCapabilities } = await import("@proovra/shared-billing"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `ct14p-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function seedPersonalWithTeamsAndInvites() {
    const t = await seedPersonalTenant(deps, "PRO");
    const team = (archived: boolean) =>
      prisma.collaborationTeam.create({
        data: {
          workspaceId: t.personalTeamId,
          name: `ct14-${randomUUID().slice(0, 6)}`,
          createdByUserId: t.owner.userId,
          ...(archived ? { archivedAtUtc: new Date(), status: "ARCHIVED" } : {}),
        } as never,
      });
    await team(false);
    await team(true);
    const invite = (over: Record<string, unknown>) =>
      prisma.teamInvite.create({
        data: {
          teamId: t.personalTeamId,
          email: `inv-${randomUUID().slice(0, 8)}@invitee.test`,
          role: "MEMBER",
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByUserId: t.owner.userId,
          ...over,
        } as never,
      });
    await invite({});
    await invite({});
    await invite({ expiresAt: new Date(Date.now() - 60_000) });
    return t;
  }

  it("the route has no WORKSPACE billing account: anything but PERSONAL / ORGANIZATION is refused", async () => {
    const t = await seedPersonalTenant(deps, "PRO");
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/billing/accounts/WORKSPACE/${t.personalTeamId}`,
      headers: { authorization: `Bearer ${t.owner.token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_params");
  });

  it("a personal PRO account reports its Collaboration Teams allowance and no seats block", async () => {
    const t = await seedPersonalWithTeamsAndInvites();
    const projection = (await buildBillingAccountProjection({
      account: {
        type: "PERSONAL",
        id: t.owner.userId,
        displayName: "",
        capabilities: ["BILLING_ACCOUNT_VIEW"],
        billingOwnerMissing: false,
      },
      viewerUserId: t.owner.userId,
    })) as Projection;
    expect(projection.collaboration?.collaborationTeams).toEqual({
      used: 1,
      limit: getPlanCapabilities("PRO").maxCollaborationTeamsPerWorkspace,
    });
    expect(projection.collaboration?.seats).toBeUndefined();
  });

  it("the same over GET /v1/billing/accounts/PERSONAL/:id", async () => {
    const t = await seedPersonalWithTeamsAndInvites();
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/billing/accounts/PERSONAL/${t.owner.userId}`,
      headers: { authorization: `Bearer ${t.owner.token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Projection;
    expect(body.collaboration?.collaborationTeams?.used).toBe(1);
    expect(body.collaboration?.seats).toBeUndefined();
  });
});
