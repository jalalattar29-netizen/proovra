/**
 * PHASE 9 §9.8 — DB-level membership-allocation concurrency proof (LIVE).
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * ------------------------------------------------------------------------
 * This proof previously lived inside `phase-9-final-hardening.test.ts`. That
 * file `vi.mock`s `../src/db.js`, so the integration harness could never
 * reach a real Postgres from it — the block was structurally unrunnable and
 * additionally called a `grantWorkspaceMembership` signature that no longer
 * exists (the mismatch was hidden by an `as never` cast). Both defects are
 * corrected here: no db mock, and the CURRENT canonical orchestrator API.
 *
 * WHAT IS PROVEN
 * ------------------------------------------------------------------------
 * The Membership Orchestrator (`provisionMembership`) is the ONE writer for
 * workspace membership (§9.8 static rows pin that). The property that needs a
 * real database — and therefore lives here — is that two CONCURRENT grants
 * for the same subject cannot produce a duplicate or partial membership: the
 * `TeamMember(teamId, userId)` unique constraint is the DB-level authority,
 * and the orchestrator's upsert must converge on exactly one ACTIVE row with
 * exactly one Organization membership. A stub cannot exercise a unique-index
 * race, which is precisely why this is a live gate.
 *
 * CANONICAL COMMAND (external dependency: a Docker daemon for the ephemeral
 * Postgres, or a pre-provisioned TEST_DATABASE_URL):
 *
 *   RUN_LIVE_INTEGRATION=1 AUTH_JWT_SECRET=<32+ chars> \
 *     npx vitest run test/phase-9-8-live-membership-allocation.test.ts \
 *     --hookTimeout=900000 --testTimeout=300000
 */

import { describe, expect, it } from "vitest";

// PHASE 12 POINT 4 — runs unconditionally in the API integration project.
describe(
  "§9.8 — concurrent membership allocation converges on ONE row",
  () => {
    it("two concurrent orchestrator grants for the same subject → exactly one ACTIVE membership, one org membership, no partial row", async () => {
      const { bootIntegrationHarness } = await import("./integration-harness.js");
      const harness = await bootIntegrationHarness();
      try {
        const { provisionMembership } = await import(
          "../src/services/identity/membership-provisioning.service.js"
        );
        const { resolveWorkspaceSeatState } = await import(
          "../src/services/billing/workspace-seats.service.js"
        );
        const { prisma } = await import("../src/db.js");

        const teamId = harness.fixtures.teamA.teamId;
        const team = await prisma.team.findUniqueOrThrow({
          where: { id: teamId },
          select: { organizationId: true },
        });

        /**
         * COMMERCIAL CAPACITY IS A PRECONDITION HERE, NOT THE SUBJECT.
         *
         * This proof is about a UNIQUE CONSTRAINT race. `teamA` ships as a
         * FREE workspace with four ACTIVE members against a one-seat catalog
         * limit, so `grantWorkspaceMembership`'s seat gate refused BOTH
         * "concurrent" grants before either reached the upsert: the race the
         * file exists to exercise never happened, and the failure surfaced as
         * `expected [] to have a length of 1` — a message that says nothing
         * about seats.
         *
         * The workspace is given room explicitly. That is the honest fixture
         * for this proof: the gate is correct and is tested where it belongs
         * (`org-invite-seat-concurrency`), and a capacity refusal here is
         * noise that hides the property under test.
         */
        await prisma.team.update({
          where: { id: teamId },
          data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
        });

        /**
         * ASSERTED, NOT ASSUMED.
         *
         * Without this the test can pass for the wrong reason the moment the
         * fixture's commercial defaults move again — which is exactly how it
         * came to be broken. If the seat state cannot admit one more member,
         * fail HERE, naming seats, rather than three assertions later on an
         * empty array.
         */
        const seats = await resolveWorkspaceSeatState(teamId, prisma);
        expect(
          seats.remaining,
          `the race cannot be exercised without a free seat (plan=${seats.plan} used=${seats.used} limit=${seats.limit})`,
        ).toBeGreaterThanOrEqual(1);

        // A subject that is NOT yet a member of teamA — the personal-space user.
        const subjectUserId = harness.fixtures.personal.userId;

        const grant = () =>
          prisma.$transaction((tx) =>
            provisionMembership(tx, {
              // The org-scoped intent: writes BOTH the governance layer
              // (OrganizationMembership) and the workspace layer (TeamMember),
              // so one call exercises both unique constraints under the race.
              intent: "ORGANIZATION_WITH_WORKSPACE_ASSIGNMENTS",
              source: "MANUAL",
              userId: subjectUserId,
              organizationId: team.organizationId,
              organizationRole: "ORG_MEMBER",
              workspaceAssignments: [{ teamId, role: "MEMBER" }],
              accessReason: "phase-9-8-live-concurrency-proof",
            }),
          );

        const settled = await Promise.allSettled([grant(), grant()]);

        /**
         * A FULFILLED PROMISE IS NOT A GRANT.
         *
         * This guard existed to catch "a race that loses BOTH writers", and it
         * could not: `provisionMembership` reports a refused assignment in its
         * RETURN VALUE — deliberately, so that an over-limit assignment is
         * dropped while the rest of an acceptance still commits — rather than
         * by rejecting. Both grants were refused for want of a seat, both
         * promises fulfilled, and the guard passed.
         *
         * So assert on what the orchestrator SAYS it did, and print the
         * refusal reason when it says nothing was granted.
         */
        const results = settled.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : [],
        );
        expect(
          results.length,
          "both concurrent grants rejected — neither writer survived the race",
        ).toBeGreaterThan(0);
        expect(
          results.some((v) => v.workspaceGrants === 1),
          `no workspace grant landed: ${JSON.stringify(results)}`,
        ).toBe(true);

        // The DB-level guarantee: the unique constraint admits exactly one row.
        const memberRows = await prisma.teamMember.findMany({
          where: { teamId, userId: subjectUserId },
          select: { id: true, status: true },
        });
        expect(memberRows).toHaveLength(1);
        expect(memberRows[0]!.status).toBe("ACTIVE");

        const orgRows = await prisma.organizationMembership.count({
          where: { organizationId: team.organizationId, userId: subjectUserId },
        });
        expect(orgRows).toBe(1);
      } finally {
        await harness.cleanup();
      }
    });
  },
);
