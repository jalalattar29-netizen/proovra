/**
 * A customer the way the product makes one, for the coverage suites: provisioned,
 * accepted by its owner, its contract terms stated through the operator route with
 * a real step-up. No SQL decides what the customer holds.
 */
import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { approvedStepUp, seedOperator } from "../helpers/operator-step-up.js";
import { seedUser, type FixtureDeps } from "../point7/product-fixtures.js";

type Prisma = import("@prisma/client").PrismaClient;

export type Customer = {
  orgId: string;
  workspaceId: string;
  owner: { userId: string; email: string; token: string };
};

export type CustomerKit = {
  deps: () => FixtureDeps;
  /** Provisioned by an operator, accepted through the owner's invitation. */
  customer: (seats?: number) => Promise<Customer>;
  /** `PATCH /v1/admin/orgs/:id/contract` by a fresh operator with a fresh step-up. */
  setTerms: (orgId: string, terms: Record<string, unknown>) => ReturnType<IntegrationHarness["app"]["inject"]>;
};

export async function customerKit(h: IntegrationHarness, prisma: Prisma): Promise<CustomerKit> {
  const { signJwt } = await import("../../src/services/jwt.js");
  const provisioning = await import("../../src/services/enterprise-provisioning.service.js");
  const tag = () => randomUUID().slice(0, 8);

  const deps = (): FixtureDeps => ({
    prisma: prisma as never,
    tag: `cov-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  const provisioner = await seedOperator(h, deps(), prisma, "provisioner");
  let operators = 0;

  async function customer(seats = 20): Promise<Customer> {
    const d = deps();
    const owner = await seedUser(d, "owner");
    const { result } = await provisioning.provisionEnterpriseCustomerIdempotent(
      {
        organizationName: `Customer ${tag()}`,
        ownerEmail: owner.email,
        seats,
        actorUserId: provisioner.userId,
        idempotencyKey: `cov-${randomUUID()}`,
      },
      prisma,
    );
    const token = (result as { ownerInviteToken: string }).ownerInviteToken;
    const accepted = await h.app.inject({
      method: "POST",
      url: `/v1/org-invites/${token}/accept`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const body = accepted.json() as { organizationId: string; enterpriseWorkspaceId: string };
    return { orgId: body.organizationId, workspaceId: body.enterpriseWorkspaceId, owner };
  }

  const setTerms: CustomerKit["setTerms"] = async (orgId, terms) => {
    // A fresh operator per act: the TOTP replay guard spends one code per step.
    operators += 1;
    const acting = await seedOperator(h, deps(), prisma, `operator-${operators}`);
    const challengeId = await approvedStepUp(h, acting, "CAPABILITY_GRANT", "enterprise_contract", orgId);
    return h.app.inject({
      method: "PATCH",
      url: `/v1/admin/orgs/${orgId}/contract`,
      headers: { authorization: `Bearer ${acting.token}`, "x-proovra-step-up-challenge-id": challengeId },
      payload: { teamId: acting.stepUpTeamId, ...terms },
    });
  };

  return { deps, customer, setTerms };
}
