/**
 * PRO-K1-03 (WS-ENT) — make a fixture workspace an Enterprise organization
 * workspace, the way production makes one: an ORGANIZATION workspace of a
 * CUSTOMER organization on the ENTERPRISE plan with an ACTIVE contract.
 *
 * The investigation graph, investigation diagnostics and SIU routes now ask
 * `workspaceIsEnterpriseOrganization` after membership, so suites that prove
 * those routes' own behaviour (reach, idempotency, audit) run against an
 * entitled workspace; the plan refusal itself is proven in
 * ws-ent-enterprise-surfaces.integration.test.ts.
 */
type Client = {
  team: {
    findUniqueOrThrow: (args: unknown) => Promise<{ organizationId: string | null }>;
    update: (args: unknown) => Promise<unknown>;
  };
  enterpriseContract: { upsert: (args: unknown) => Promise<unknown> };
};

export async function makeEnterpriseOrganizationWorkspace(prisma: unknown, teamId: string): Promise<void> {
  const client = prisma as Client;
  const team = await client.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  if (!team.organizationId) throw new Error("fixture workspace has no organization");
  await client.team.update({
    where: { id: teamId },
    data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE", workspaceKind: "ORGANIZATION", isPersonal: false },
  });
  await client.enterpriseContract.upsert({
    where: { organizationId: team.organizationId },
    create: { organizationId: team.organizationId, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 50 },
    update: { status: "ACTIVE", activationState: "ACTIVATED" },
  });
}
