/**
 * Test helpers for the OUTPUT-PRODUCER GUARD (2026-10-20, AUD-01/02/35).
 *
 * `createReportGenerationRequest` now REQUIRES its caller's entitlement
 * reading, and the worker claim re-asks the same decision. Suites that pin the
 * writer's or the claim's own mechanics (tenancy, idempotency, leases,
 * supersession) run against an ENTITLED record — the exact setup the
 * point5 recovery suite has always used — so those mechanics, not the
 * commercial gate, are what they measure. The commercial gate itself is pinned
 * by packages/shared/tests/output-producer-decision.test.mjs and
 * test/forward/forward-output-pipeline.integration.test.ts.
 */
type PrismaLike = {
  team: {
    update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    findUniqueOrThrow: (a: { where: { id: string }; select: { ownerUserId: true } }) => Promise<{ ownerUserId: string }>;
  };
  entitlement: {
    findFirst: (a: { where: { userId: string }; select: { id: true } }) => Promise<{ id: string } | null>;
    update: (a: { where: { id: string }; data: { plan: string } }) => Promise<unknown>;
    create: (a: { data: { userId: string; plan: string } }) => Promise<unknown>;
  };
};

/** The entitlement reading of a paid workspace that includes the report and its package. */
export const ENTITLED_FOR_TEST = async () => ({
  decision: "ENTITLED" as const,
  reportsIncluded: true,
  verificationPackageIncluded: true,
  mayIssueHistoricalFirstOutputs: true,
});

/** Put a fixture workspace on a paid, active plan whose outputs include reports and packages. */
export async function entitleFixtureWorkspace(prisma: unknown, teamId: string): Promise<void> {
  const db = prisma as PrismaLike;
  await db.team.update({ where: { id: teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  const owner = await db.team.findUniqueOrThrow({ where: { id: teamId }, select: { ownerUserId: true } });
  const ent = await db.entitlement.findFirst({ where: { userId: owner.ownerUserId }, select: { id: true } });
  if (ent) await db.entitlement.update({ where: { id: ent.id }, data: { plan: "PRO" } });
  else await db.entitlement.create({ data: { userId: owner.ownerUserId, plan: "PRO" } });
}
