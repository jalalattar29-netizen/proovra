/**
 * ORGANIZATION INVITATION — SEAT ALLOCATION UNDER CONCURRENCY (real PostgreSQL).
 *
 * =============================================================================
 * WHAT THIS PROVES, AND WHY A UNIT TEST COULD NOT
 * =============================================================================
 * `grantWorkspaceMembership` reads the canonical seat state and then writes.
 * Between the read and the write, another acceptance can do the same — so
 * eight people accepting into a workspace with two free seats could all
 * observe `used < limit` and all be seated. Enforcement that holds under one
 * caller and fails under eight is not enforcement; it is the shape of every
 * over-allocation bug.
 *
 * The fix is `pg_try_advisory_xact_lock` on `workspace-seat:<id>` — the SAME
 * key `acceptWorkspaceInvitation` already uses, so the two acceptance paths
 * serialise against EACH OTHER and not merely against themselves — plus a
 * bounded, jittered retry outside the transaction.
 *
 * An advisory lock is a PostgreSQL behaviour. A mocked client cannot exhibit
 * it, and a test that mocked it would be asserting its own stub. So this runs
 * against a real database, through the ONE canonical harness, and drives the
 * real acceptance service.
 *
 * The race is genuine because `src/db.ts` builds its client on a pg `Pool`
 * behind the PrismaPg adapter: eight concurrent acceptances take eight
 * connections and genuinely contend, which is the same reason
 * `phase-10-concurrent-session-last-slot` lives here rather than in the unit
 * run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import {
  acquireIntegrationDatabase,
  type IntegrationDatabase,
} from "./integration-harness.js";

// A TEAM plan seats 10. The owner holds one and we pre-seat seven more, so
// exactly TWO are free when the contenders arrive.
const SEAT_LIMIT = 10;
const PRE_SEATED = 8;
const FREE_SEATS = SEAT_LIMIT - PRE_SEATED;
const CONTENDERS = 8;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("organization invite — concurrent acceptance cannot exceed the seat limit", () => {
  let database: IntegrationDatabase | undefined;
  let prisma: PrismaClient | undefined;
  let acceptOrganizationInvite:
    | typeof import("../src/services/organization/org-invite-acceptance.service.js")["acceptOrganizationInvite"]
    | undefined;

  let orgId = "";
  let workspaceId = "";
  const inviteTokens: string[] = [];
  const contenderIds: string[] = [];

  beforeAll(async () => {
    database = await acquireIntegrationDatabase();

    /**
     * The acceptance service uses the MODULE-LEVEL client from `src/db.ts`,
     * which reads `DATABASE_URL` when it is first imported. Pointing that at
     * the integration database before the dynamic import below is what makes
     * this exercise the real production client — Pool-backed, so the eight
     * acceptances genuinely race on separate connections — rather than a
     * hand-built client the service would never use.
     */
    process.env.DATABASE_URL = database.url;

    const { PrismaClient: Client } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { Pool } = await import("pg");
    prisma = new Client({
      adapter: new PrismaPg(new Pool({ connectionString: database.url })),
    });

    ({ acceptOrganizationInvite } = await import(
      "../src/services/organization/org-invite-acceptance.service.js"
    ));

    const ownerId = randomUUID();
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `owner-${ownerId}@example.test`,
        provider: "EMAIL",
        providerUserId: `owner-${ownerId}`,
      },
    });

    orgId = randomUUID();
    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Seat Concurrency Org",
        status: "ACTIVE",
      },
    });

    workspaceId = randomUUID();
    await prisma.team.create({
      data: {
        id: workspaceId,
        name: "Seat Concurrency Workspace",
        ownerUserId: ownerId,
        organizationId: orgId,
        isPersonal: false,
        billingPlan: "TEAM",
        /**
         * ACTIVE, because the plan alone is not the answer.
         * `resolveWorkspaceEffectivePlan` reads plan AND status, and the
         * column defaults to INACTIVE — which resolves to FREE, a ONE-seat
         * ceiling, and would have made this suite pass for the wrong reason:
         * nobody seated because the workspace was already over its limit,
         * rather than because the lock held.
         */
        billingStatus: "ACTIVE",
        // An ORGANIZATION workspace — the only kind an org invitation can
        // assign into. `grantWorkspaceMembership` refuses a personal space.
        workspaceKind: "ORGANIZATION",
      },
    });

    // Fill to exactly two free seats. `used` counts ACTIVE members, so this is
    // the population the gate will measure.
    await prisma.teamMember.create({
      data: { teamId: workspaceId, userId: ownerId, role: "OWNER", status: "ACTIVE" },
    });
    for (let i = 0; i < PRE_SEATED - 1; i += 1) {
      const uid = randomUUID();
      await prisma.user.create({
        data: {
          id: uid,
          email: `seated-${uid}@example.test`,
          provider: "EMAIL",
          providerUserId: `seated-${uid}`,
        },
      });
      await prisma.teamMember.create({
        data: { teamId: workspaceId, userId: uid, role: "MEMBER", status: "ACTIVE" },
      });
    }

    // Eight DISTINCT people, each with their own valid invitation carrying a
    // workspace assignment into the same full-but-for-two workspace.
    for (let i = 0; i < CONTENDERS; i += 1) {
      const uid = randomUUID();
      const email = `contender-${i}-${uid.slice(0, 8)}@example.test`;
      await prisma.user.create({
        data: { id: uid, email, provider: "EMAIL", providerUserId: uid },
      });
      contenderIds.push(uid);

      const token = `tok-${randomUUID()}`;
      inviteTokens.push(token);
      await prisma.organizationInvite.create({
        data: {
          organizationId: orgId,
          email,
          role: "ORG_MEMBER",
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByUserId: ownerId,
          workspaceAssignments: [{ teamId: workspaceId, role: "MEMBER" }],
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.release();
  });

  /**
   * THE PRECONDITION IS ASSERTED, NOT ASSUMED.
   *
   * Everything below means nothing if the fixture does not actually have two
   * free seats. A workspace that resolves to FREE (one seat) would seat nobody
   * and the over-allocation assertion would pass for entirely the wrong
   * reason — which is exactly what happened while this suite was being
   * written, twice: once because `billingStatus` defaults to INACTIVE, and
   * once because the ceiling was not the number the fixture assumed.
   */
  it("the fixture really does have exactly the free seats it claims", async () => {
    const { resolveWorkspaceSeatState } = await import(
      "../src/services/billing/workspace-seats.service.js"
    );
    const seats = await resolveWorkspaceSeatState(workspaceId);
    expect(
      { limit: seats.limit, used: seats.used, plan: seats.plan },
      "the race is only meaningful against a known ceiling",
    ).toEqual({ limit: SEAT_LIMIT, used: PRE_SEATED, plan: "TEAM" });
  }, 60_000);

  it("seats exactly the free seats and refuses the rest, with no over-allocation", async () => {
    const accept = acceptOrganizationInvite!;
    const db = prisma!;

    // All eight at once. `allSettled` because a rejection must surface as a
    // failure of THIS test rather than being swallowed into a passing count.
    const results = await Promise.allSettled(
      inviteTokens.map((t, i) =>
        accept({ tokenHash: hash(t), userId: contenderIds[i]! }),
      ),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
      "no acceptance may throw — a full workspace is an ordinary condition, not a 500",
    ).toEqual([]);

    const outcomes = results.map(
      (r) =>
        (r as PromiseFulfilledResult<{
          kind: string;
          assignedWorkspaceIds?: string[];
        }>).value,
    );

    // Nobody was told "try again": the bounded retry absorbed the contention.
    expect(
      outcomes.filter((o) => o.kind === "seat_contention").length,
      "the retry window should absorb eight contenders; a contention outcome here means it is too small",
    ).toBe(0);

    // EVERY caller becomes an organization member: a full WORKSPACE must not
    // cost somebody the GOVERNANCE membership they were validly invited to.
    expect(
      await db.organizationMembership.count({ where: { organizationId: orgId } }),
    ).toBe(CONTENDERS);

    // THE INVARIANT. Exactly the free seats were allocated — no more.
    const activeMembers = await db.teamMember.count({
      where: { teamId: workspaceId, status: "ACTIVE" },
    });
    expect(
      activeMembers,
      `workspace seats over-allocated: ${activeMembers} active against a ceiling of ${SEAT_LIMIT}`,
    ).toBe(SEAT_LIMIT);
    expect(activeMembers - PRE_SEATED).toBe(FREE_SEATS);

    // The refusals are the rest — reported, not silent.
    expect(
      outcomes.filter(
        (o) => o.kind === "ok" && (o.assignedWorkspaceIds?.length ?? 0) > 0,
      ).length,
    ).toBe(FREE_SEATS);
    expect(
      outcomes.filter(
        (o) => o.kind === "ok" && (o.assignedWorkspaceIds?.length ?? 0) === 0,
      ).length,
    ).toBe(CONTENDERS - FREE_SEATS);

    // A refused assignment leaves NO partial membership row behind.
    expect(
      await db.teamMember.count({
        where: { teamId: workspaceId, status: { not: "ACTIVE" } },
      }),
      "a refused assignment must leave no partial membership row",
    ).toBe(0);
  }, 300_000);

  it("a replayed acceptance by a seated member does not consume a second seat", async () => {
    const accept = acceptOrganizationInvite!;
    const db = prisma!;
    const before = await db.teamMember.count({
      where: { teamId: workspaceId, status: "ACTIVE" },
    });
    // Replaying a consumed invitation is idempotent, and must not re-seat.
    await accept({ tokenHash: hash(inviteTokens[0]!), userId: contenderIds[0]! });
    expect(
      await db.teamMember.count({
        where: { teamId: workspaceId, status: "ACTIVE" },
      }),
    ).toBe(before);
  }, 120_000);
});
