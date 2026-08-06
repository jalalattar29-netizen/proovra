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
        const { prisma } = await import("../src/db.js");

        const teamId = harness.fixtures.teamA.teamId;
        const team = await prisma.team.findUniqueOrThrow({
          where: { id: teamId },
          select: { organizationId: true },
        });
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
        // At least one attempt must succeed — a race that loses BOTH writers
        // would be a silent allocation failure, not a safe outcome.
        expect(settled.some((r) => r.status === "fulfilled")).toBe(true);

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
