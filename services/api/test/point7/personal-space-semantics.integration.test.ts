/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS: the TEAM / Personal-Space semantic
 * contract, against live PostgreSQL 16.
 *
 * THE CONTRADICTION THIS CLOSES
 * ---------------------------------------------------------------------------
 * The catalog said `TEAM.allowsPersonalWorkspace = false` while the identity
 * bootstrap created a Personal Team for every authenticated user, whatever
 * they paid. One boolean was answering two different questions, and the
 * platform had already picked the wrong one twice: the structural assert
 * applied the PURCHASE rule to scope RESOLUTION, so a TEAM-plan account's own
 * Personal Space threw — and the API and the worker each papered over it by
 * resolving that space at PRO, a plan the account does not hold.
 *
 * The previous pass documented the contradiction and removed the substitutions
 * but left the field name ambiguous, which is an invitation to re-derive the
 * same mistake. The field is now `allowsPersonalWorkspacePurchase`, and this
 * suite pins the two authorities apart BEHAVIOURALLY:
 *
 *   PURCHASE TARGET     the catalog. "May this plan be bought FOR a personal
 *                       workspace?" TEAM: no.
 *   SPACE ELIGIBILITY   `resolvePersonalSpaceEligibility` — identity mode plus
 *                       the Organization's `noPersonalSpace`. Plan-independent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import {
  bootstrapPersonalSpace,
  fingerprintDelta,
  fingerprintSideEffects,
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  setAccountPlan,
  type FixtureDeps,
} from "./product-fixtures.js";
import { provenScenario, recordScenarioProof } from "./scenario-manifest.js";

const SUITE =
  "services/api/test/point7/personal-space-semantics.integration.test.ts";

describe("POINT 7 CORRECTIVE — TEAM / Personal-Space semantics (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let deps: FixtureDeps;

  const inject = (opts: {
    method: "GET" | "POST";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  const context = (token: string) =>
    inject({
      method: "GET",
      url: "/v1/platform/context",
      token,
      headers: { "x-platform-context-version": "3" },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { signJwt } = await import("../../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p7s-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
  });

  afterAll(async () => {
    recordScenarioProof({ suiteRelPath: SUITE, layer: "SERVER" });
    await harness?.cleanup();
  });

  // 1 + 3
  it("p7.sem.team_user_keeps_personal_space", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const ws = await seedOwnedWorkspace(deps, {
      ownerUserId: t.owner.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });

    // The Personal Space EXISTS for a TEAM account …
    expect(
      await prisma.team.count({
        where: { ownerUserId: t.owner.userId, isPersonal: true },
      }),
    ).toBe(1);

    // … resolves at the account's OWN plan, not at an invented one …
    const { getPersonalWorkspaceScope } = await import(
      "../../src/services/workspace-billing.service.js"
    );
    const personalScope = await getPersonalWorkspaceScope(t.owner.userId);
    expect(personalScope.plan).toBe("TEAM");
    expect(personalScope.billingShape).toBe("SINGLE_OCCUPANT");

    // … the commercial surface answers rather than throwing …
    const overview = await inject({
      method: "GET",
      url: "/v1/billing/overview",
      token: t.owner.token,
    });
    expect(overview.statusCode, overview.body).toBe(200);

    // … and the user can explicitly switch INTO it from the team workspace.
    await inject({
      method: "POST",
      url: "/v1/platform/context/switch-workspace",
      token: t.owner.token,
      payload: { workspaceId: ws.teamId },
    });
    const back = await inject({
      method: "POST",
      url: "/v1/platform/context/switch-workspace",
      token: t.owner.token,
      payload: { workspaceId: null },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().activeSpace.type).toBe("PERSONAL");
    provenScenario("SERVER", "p7.sem.team_user_keeps_personal_space");
  });

  // 2
  it("p7.sem.team_first_restoration_chooses_team_context", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const ws = await seedOwnedWorkspace(deps, {
      ownerUserId: t.owner.userId,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    await prisma.user.update({
      where: { id: t.owner.userId },
      data: { currentWorkspaceId: ws.teamId },
    });
    const env = (await context(t.owner.token)).json();
    // Team-first restoration lands in the team workspace — AND the Personal
    // Space is still offered. Team-first is a default, not a prohibition.
    expect(env.activeSpace.id).toBe(ws.teamId);
    expect(env.contextOptions.personalSpace).not.toBeNull();
    expect(env.personalSpaceAllowed).not.toBe(false);
    provenScenario("SERVER", "p7.sem.team_first_restoration_chooses_team_context");
  });

  // 4
  it("p7.sem.team_plan_is_not_a_personal_purchase_target", async () => {
    // The OTHER authority, still enforced — and now under a name that says
    // which question it answers.
    const { assertPlanPurchasableForWorkspaceShape, getPlanCapabilities } =
      await import("@proovra/shared-billing");
    expect(getPlanCapabilities("TEAM").allowsPersonalWorkspacePurchase).toBe(false);
    expect(() =>
      assertPlanPurchasableForWorkspaceShape({
        billingShape: "SINGLE_OCCUPANT",
        plan: "TEAM",
      }),
    ).toThrow(/personal workspace/i);
    // And the plans that CAN be bought for a personal workspace still can.
    for (const plan of ["FREE", "PAYG", "PRO", "ENTERPRISE"] as const) {
      expect(() =>
        assertPlanPurchasableForWorkspaceShape({ billingShape: "SINGLE_OCCUPANT", plan }),
      ).not.toThrow();
    }
    provenScenario("SERVER", "p7.sem.team_plan_is_not_a_personal_purchase_target");
  });

  // 5
  it("p7.sem.enterprise_no_personal_space_false_is_normal", async () => {
    const org = await seedOrganizationTenant(deps, {
      noPersonalSpace: false,
      memberCount: 1,
    });
    const member = org.members[0];
    await setAccountPlan(deps, member.userId, "FREE");
    const personal = await bootstrapPersonalSpace(deps, member.userId);
    expect(personal.teamId).toBeTruthy();
    const env = (await context(member.token)).json();
    expect(env.personalSpaceAllowed).not.toBe(false);
    expect(env.contextOptions.personalSpace?.workspaceId).toBe(personal.teamId);
    provenScenario(
      "SERVER",
      "p7.sem.enterprise_no_personal_space_false_is_normal",
    );
  });

  // 6 + 7 + 8
  it("p7.sem.no_personal_space_true_blocks_every_route", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0];
    await setAccountPlan(deps, member.userId, "FREE");
    // A grandfathered Personal Space, created before the policy was switched
    // on — the hard case, because the row exists and an id for it can be
    // stored anywhere.
    const personal = await bootstrapPersonalSpace(deps, member.userId);
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { noPersonalSpace: true },
    });

    // CREATION is refused, with zero writes.
    const { ensurePersonalWorkspace } = await import(
      "../../src/services/platform-context/workspace-bootstrap.service.js"
    );
    const before = await fingerprintSideEffects(prisma);
    await expect(
      ensurePersonalWorkspace({ userId: member.userId }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fingerprintDelta(before, await fingerprintSideEffects(prisma))).toEqual({});

    // SELECTION is refused: neither option list offers it.
    const env = (await context(member.token)).json();
    expect(env.personalSpaceAllowed).toBe(false);
    expect(env.contextOptions.personalSpace).toBeNull();
    expect(
      (env.availableWorkspaces ?? []).map((w: { id: string }) => w.id),
    ).not.toContain(personal.teamId);

    // DIRECT API use is refused — a stored/cached Personal id does not bypass
    // the policy, which is case 7 and the one a client cache would exercise.
    const explicitPersonal = await inject({
      method: "POST",
      url: "/v1/platform/context/switch-workspace",
      token: member.token,
      payload: { workspaceId: null },
    });
    expect(explicitPersonal.statusCode).toBe(403);
    expect(explicitPersonal.json().code).toBe("ORG_POLICY_NO_PERSONAL_SPACE");

    const byStoredId = await inject({
      method: "POST",
      url: "/v1/platform/context/switch-workspace",
      token: member.token,
      payload: { workspaceId: personal.teamId },
    });
    expect(byStoredId.statusCode).toBeGreaterThanOrEqual(400);

    // The row still EXISTS. A policy withholds access; it does not delete.
    expect(await prisma.team.count({ where: { id: personal.teamId } })).toBe(1);
    provenScenario("SERVER", "p7.sem.no_personal_space_true_blocks_every_route");
  });

  it("p7.sem.no_owner_plan_or_silent_personal_fallback", async () => {
    // Case 8. The stale-pointer heal is the path that used to relocate a
    // `noPersonalSpace` identity into a Personal Space and WRITE the pointer.
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const member = org.members[0];
    await setAccountPlan(deps, member.userId, "FREE");
    const personal = await bootstrapPersonalSpace(deps, member.userId);
    await prisma.organizationSecurityPolicy.update({
      where: { organizationId: org.organizationId },
      data: { noPersonalSpace: true },
    });
    await prisma.user.update({
      where: { id: member.userId },
      data: { currentWorkspaceId: org.workspaceId },
    });
    await prisma.teamMember.update({
      where: {
        teamId_userId: { teamId: org.workspaceId, userId: member.userId },
      },
      data: { status: "SUSPENDED" },
    });

    const env = (await context(member.token)).json();
    expect(env.personalSpaceAllowed).toBe(false);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: member.userId },
      select: { currentWorkspaceId: true },
    });
    expect(user.currentWorkspaceId).not.toBe(personal.teamId);
    provenScenario("SERVER", "p7.sem.no_owner_plan_or_silent_personal_fallback");
  });
});
