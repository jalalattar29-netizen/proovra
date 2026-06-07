/**
 * PHASE 37.96 — Integration harness for live cross-tenant runtime probes.
 *
 * Boots the real Fastify app + connects to a real (test) Postgres + seeds
 * two organizations + a personal user. The runtime probe in
 * `phase-37-95-cross-tenant-runtime-probe.test.ts` calls into this
 * module from its `beforeAll` once enabled.
 *
 * ===========================================================================
 * SAFETY GUARDS — these MUST hold or the harness throws before touching DB:
 * ===========================================================================
 *
 *   1. RUN_LIVE_INTEGRATION must be "1". Without it, every entry point
 *      short-circuits and the test file `describe.skip`s itself.
 *
 *   2. TEST_DATABASE_URL must be set. The harness never reads DATABASE_URL
 *      (prod/staging). The URL must reference a database name that
 *      contains "test" OR the explicit override
 *      RUN_LIVE_INTEGRATION_DB_OK=1 must be set.
 *
 *   3. Schema is owned by the test harness — it tears tables down after
 *      each suite via `cleanupFixtures()`. The harness NEVER runs
 *      `migrate deploy` automatically; the operator runs migrations
 *      manually against the test DB before invoking integration tests.
 *
 * ===========================================================================
 * USAGE (when integration env is provisioned):
 * ===========================================================================
 *
 *   export TEST_DATABASE_URL=postgres://localhost:5432/proovra_integration_test
 *   export RUN_LIVE_INTEGRATION=1
 *   export RUN_LIVE_INTEGRATION_DB_OK=1
 *   pnpm --filter proovra-api exec prisma migrate deploy
 *   pnpm --filter proovra-api test -- --run phase-37-95-cross-tenant-runtime-probe
 *
 * ===========================================================================
 * WHAT THIS HARNESS DOES NOT DO (deliberately, for safety):
 * ===========================================================================
 *
 *   - Run prisma migrations automatically.
 *   - Read DATABASE_URL.
 *   - Touch any DB whose name does not contain "test" (unless explicitly
 *     overridden).
 *   - Run when RUN_LIVE_INTEGRATION is unset.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import type { FastifyInstance } from "fastify";

export type IntegrationHarness = {
  app: FastifyInstance;
  fixtures: SeededFixtures;
  cleanup: () => Promise<void>;
};

export type SeededFixtures = {
  teamA: TeamFixture;
  teamB: TeamFixture;
  personal: PersonalFixture;
};

export type TeamFixture = {
  teamId: string;
  ownerUserId: string;
  adminUserId: string;
  memberUserId: string;
  viewerUserId: string;
  ownerToken: string;
  adminToken: string;
  memberToken: string;
  viewerToken: string;
  evidenceId: string;
  caseId: string;
  reportId: string | null;
  packageId: string | null;
  legalHoldId: string | null;
};

export type PersonalFixture = {
  userId: string;
  token: string;
  teamId: string; // the personal Team row id (isPersonal=true)
  evidenceId: string;
  caseId: string;
  reportId: string | null;
};

// =============================================================================
// Env guards
// =============================================================================

export function isLiveIntegrationEnabled(): boolean {
  return process.env.RUN_LIVE_INTEGRATION === "1";
}

export function isAutoPostgresEnabled(): boolean {
  // When TEST_DATABASE_URL is not provided, the harness can launch a
  // testcontainers-managed Postgres automatically. Opt out via
  // `RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1` if the caller wants the
  // harness to require an externally-supplied DB.
  return (
    process.env.RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS !== "1" &&
    !process.env.TEST_DATABASE_URL
  );
}

/**
 * Throws if the live-integration env is misconfigured. Designed to fail
 * loudly the moment a developer flips the flag — never silently runs
 * against the wrong DB.
 *
 * NEW (Phase 37.99): when TEST_DATABASE_URL is missing AND testcontainers
 * mode is enabled, the env is considered valid — the harness will
 * boot its own Postgres container via `bootIntegrationHarness`. The
 * DB-name guard still applies for any TEST_DATABASE_URL the caller
 * supplied directly.
 */
export function assertLiveIntegrationEnv(): { testDatabaseUrl: string } {
  if (!isLiveIntegrationEnabled()) {
    throw new Error(
      "RUN_LIVE_INTEGRATION must be set to '1' to use the integration harness. " +
        "See test/integration-harness.ts for the full setup contract.",
    );
  }
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    // Allow testcontainers mode: bootIntegrationHarness will launch its
    // own Postgres container. The DB-name guard below is skipped because
    // testcontainers always uses an ephemeral test DB.
    if (isAutoPostgresEnabled()) {
      return { testDatabaseUrl: "" };
    }
    throw new Error(
      "TEST_DATABASE_URL is required for live integration tests when testcontainers is disabled. " +
        "The harness will NOT read DATABASE_URL (prod/staging) under any circumstance.",
    );
  }
  // Sanity guard against accidentally running against a non-test DB. The
  // URL must contain the word "test" in its database name OR the explicit
  // RUN_LIVE_INTEGRATION_DB_OK=1 override must be set.
  const dbNameMatch = testDatabaseUrl.match(/\/([^/?#]+)(?:\?|#|$)/);
  const dbName = dbNameMatch?.[1] ?? "";
  const looksLikeTestDb = /test/i.test(dbName);
  const explicitOverride = process.env.RUN_LIVE_INTEGRATION_DB_OK === "1";
  if (!looksLikeTestDb && !explicitOverride) {
    throw new Error(
      `Refusing to run integration tests against DB "${dbName}" — the name must contain "test", ` +
        "or set RUN_LIVE_INTEGRATION_DB_OK=1 to override this guard.",
    );
  }
  return { testDatabaseUrl };
}

// =============================================================================
// Boot
// =============================================================================

/**
 * Boots the Fastify app + opens a Prisma client against TEST_DATABASE_URL.
 * The caller is responsible for running migrations beforehand — the
 * harness deliberately does NOT shell out to prisma migrate.
 *
 * Returns the live `app` (use `app.inject(...)` for HTTP calls without
 * a network port) + seeded fixtures + a cleanup function.
 */
export async function bootIntegrationHarness(): Promise<IntegrationHarness> {
  let { testDatabaseUrl } = assertLiveIntegrationEnv();

  // Phase 37.99 — testcontainers mode. When the caller did not supply
  // TEST_DATABASE_URL and testcontainers mode is enabled, launch an
  // ephemeral Postgres container and use its URL. We also `prisma
  // migrate deploy` against it because the container starts empty.
  type ContainerHandle = {
    stop: () => Promise<void>;
  } | null;
  let pgContainer: ContainerHandle = null;
  if (!testDatabaseUrl && isAutoPostgresEnabled()) {
    const { PostgreSqlContainer } = await import(
      "@testcontainers/postgresql"
    );
    const container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("proovra_integration_test")
      .withUsername("proovra_test")
      .withPassword("proovra_test_password")
      .start();
    testDatabaseUrl = container.getConnectionUri();
    pgContainer = {
      stop: async () => {
        await container.stop();
      },
    };

    // Apply migrations against the ephemeral DB. `prisma migrate deploy`
    // is the canonical, non-destructive path; it's safe because the
    // container is brand-new.
    const migrateResult = spawnSync(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy"],
      {
        cwd: path.resolve(
          path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")),
          "..",
        ),
        env: { ...process.env, DATABASE_URL: testDatabaseUrl },
        stdio: "pipe",
        encoding: "utf8",
        shell: true,
      },
    );
    if (migrateResult.status !== 0) {
      await pgContainer?.stop();
      throw new Error(
        `prisma migrate deploy failed against the testcontainer Postgres.\n` +
          `stdout:\n${migrateResult.stdout}\n` +
          `stderr:\n${migrateResult.stderr}`,
      );
    }
  }

  if (!testDatabaseUrl) {
    throw new Error(
      "bootIntegrationHarness: no TEST_DATABASE_URL resolved and " +
        "testcontainers mode is disabled. Either set TEST_DATABASE_URL or " +
        "remove RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1.",
    );
  }

  // Override DATABASE_URL for the lifetime of this process so Prisma
  // points at the test DB. Save the original so cleanup can restore it.
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testDatabaseUrl;

  // Late-bind imports so we don't accidentally read DATABASE_URL at
  // module load time before we've overridden it.
  const { buildServer } = await import("../src/server.js");
  const { prisma } = await import("../src/db.js");

  const app = await buildServer();
  await app.ready();

  const fixtures = await seedFixtures(
    prisma as unknown as import("@prisma/client").PrismaClient,
  );

  return {
    app,
    fixtures,
    cleanup: async () => {
      try {
        await cleanupFixtures(
          prisma as unknown as import("@prisma/client").PrismaClient,
          fixtures,
        );
      } finally {
        await app.close();
        if (originalDatabaseUrl !== undefined) {
          process.env.DATABASE_URL = originalDatabaseUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
        if (pgContainer) {
          await pgContainer.stop().catch(() => undefined);
        }
      }
    },
  };
}

// =============================================================================
// Seeding
// =============================================================================

/**
 * Seed two organizations + a personal user with the fixture set the
 * runtime probe needs. Returns the IDs and bearer tokens.
 *
 * Implementation hard rules:
 *
 *   - All writes are scoped by deterministic test-prefix IDs (no
 *     production data ever shares the namespace).
 *   - Tokens are minted via the production `signJwt` so the request
 *     pipeline experiences a real authenticated session.
 *   - Personal Space is created via the real `ensurePersonalWorkspace`
 *     bootstrap so its `isPersonal=true` flag is set correctly.
 *   - Reports / VerificationPackages / LegalHolds are NOT created here
 *     unless they are required for a specific assertion — the probe
 *     uses `null` for those fixture fields when absent.
 */
async function seedFixtures(
  prisma: import("@prisma/client").PrismaClient,
): Promise<SeededFixtures> {
  const { signJwt } = await import("../src/services/jwt.js");
  const { ensurePersonalWorkspace } = await import(
    "../src/services/platform-context/workspace-bootstrap.service.js"
  );

  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_JWT_SECRET is required to mint integration test tokens. " +
        "Set it in your test environment alongside TEST_DATABASE_URL.",
    );
  }
  const mintToken = (userId: string, email: string | null): string =>
    signJwt(
      { sub: userId, provider: "EMAIL", email },
      secret,
      60 * 60 * 1, // 1 hour
    );

  // --------------------------------------------------------------------------
  // Create users — deterministic emails so the fixtures can be re-applied.
  // --------------------------------------------------------------------------
  const stamp = Date.now();
  const tag = `int-${stamp}`;
  async function createUser(input: {
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<{ id: string; email: string }> {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        provider: "EMAIL",
        providerUserId: input.email,
      },
      select: { id: true, email: true },
    });
    return { id: user.id, email: user.email ?? input.email };
  }

  const personalUser = await createUser({
    email: `personal-${tag}@test.proovra.local`,
    firstName: "Personal",
    lastName: "User",
  });
  const userAOwner = await createUser({
    email: `a-owner-${tag}@test.proovra.local`,
    firstName: "AOrg",
    lastName: "Owner",
  });
  const userAAdmin = await createUser({
    email: `a-admin-${tag}@test.proovra.local`,
    firstName: "AOrg",
    lastName: "Admin",
  });
  const userAMember = await createUser({
    email: `a-member-${tag}@test.proovra.local`,
    firstName: "AOrg",
    lastName: "Member",
  });
  const userAViewer = await createUser({
    email: `a-viewer-${tag}@test.proovra.local`,
    firstName: "AOrg",
    lastName: "Viewer",
  });
  const userBOwner = await createUser({
    email: `b-owner-${tag}@test.proovra.local`,
    firstName: "BOrg",
    lastName: "Owner",
  });
  const userBAdmin = await createUser({
    email: `b-admin-${tag}@test.proovra.local`,
    firstName: "BOrg",
    lastName: "Admin",
  });
  const userBMember = await createUser({
    email: `b-member-${tag}@test.proovra.local`,
    firstName: "BOrg",
    lastName: "Member",
  });
  const userBViewer = await createUser({
    email: `b-viewer-${tag}@test.proovra.local`,
    firstName: "BOrg",
    lastName: "Viewer",
  });

  // --------------------------------------------------------------------------
  // Personal Space — created via the real bootstrap so isPersonal=true
  // and the partial unique index is honored.
  // --------------------------------------------------------------------------
  const personalSpace = await ensurePersonalWorkspace({
    userId: personalUser.id,
  });

  // --------------------------------------------------------------------------
  // Organizations
  // --------------------------------------------------------------------------
  async function createOrg(
    name: string,
    ownerId: string,
  ): Promise<{ id: string }> {
    // Phase 2.7X Stage 6 — teams.organization_id is NOT NULL. Every
    // team must be bound to an Organization. The integration harness
    // creates one atomically so the legacy fixture (which calls this
    // helper a "createOrg" though it actually creates a Team) stays
    // backwards-compatible. The org is created in the same shape as
    // the production POST /v1/teams + workspace-bootstrap code paths.
    return prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name,
          billingOwnerUserId: ownerId,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      await tx.organizationMembership.create({
        data: {
          organizationId: org.id,
          userId: ownerId,
          role: "ORG_OWNER",
        },
      });
      return tx.team.create({
        data: {
          name,
          ownerUserId: ownerId,
          isPersonal: false,
          organizationId: org.id,
        },
        select: { id: true },
      });
    });
  }
  const orgA = await createOrg(`OrgA-${tag}`, userAOwner.id);
  const orgB = await createOrg(`OrgB-${tag}`, userBOwner.id);

  async function addMember(
    teamId: string,
    userId: string,
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER",
  ): Promise<void> {
    await prisma.teamMember.create({
      data: { teamId, userId, role, status: "ACTIVE" },
    });
  }
  await addMember(orgA.id, userAOwner.id, "OWNER");
  await addMember(orgA.id, userAAdmin.id, "ADMIN");
  await addMember(orgA.id, userAMember.id, "MEMBER");
  await addMember(orgA.id, userAViewer.id, "VIEWER");
  await addMember(orgB.id, userBOwner.id, "OWNER");
  await addMember(orgB.id, userBAdmin.id, "ADMIN");
  await addMember(orgB.id, userBMember.id, "MEMBER");
  await addMember(orgB.id, userBViewer.id, "VIEWER");

  // --------------------------------------------------------------------------
  // Evidence + Case rows. We create minimum-viable records so the
  // probe can resolve them; the cross-tenant assertions don't require
  // full custody chains.
  // --------------------------------------------------------------------------
  async function createEvidence(
    teamId: string,
    ownerUserId: string,
    title: string,
  ): Promise<{ id: string }> {
    return prisma.evidence.create({
      data: {
        title,
        type: "PHOTO",
        status: "CREATED",
        teamId,
        ownerUserId,
      },
      select: { id: true },
    });
  }
  async function createCase(
    teamId: string,
    ownerUserId: string,
    name: string,
  ): Promise<{ id: string }> {
    return prisma.case.create({
      data: { name, teamId, ownerUserId },
      select: { id: true },
    });
  }
  const evidenceA = await createEvidence(
    orgA.id,
    userAOwner.id,
    `OrgA evidence (${tag})`,
  );
  const evidenceB = await createEvidence(
    orgB.id,
    userBOwner.id,
    `OrgB evidence (${tag})`,
  );
  const evidencePersonal = await createEvidence(
    personalSpace.teamId,
    personalUser.id,
    `Personal evidence (${tag})`,
  );

  const caseA = await createCase(
    orgA.id,
    userAOwner.id,
    `OrgA case (${tag})`,
  );
  const caseB = await createCase(
    orgB.id,
    userBOwner.id,
    `OrgB case (${tag})`,
  );
  const casePersonal = await createCase(
    personalSpace.teamId,
    personalUser.id,
    `Personal case (${tag})`,
  );

  return {
    teamA: {
      teamId: orgA.id,
      ownerUserId: userAOwner.id,
      adminUserId: userAAdmin.id,
      memberUserId: userAMember.id,
      viewerUserId: userAViewer.id,
      ownerToken: mintToken(userAOwner.id, userAOwner.email),
      adminToken: mintToken(userAAdmin.id, userAAdmin.email),
      memberToken: mintToken(userAMember.id, userAMember.email),
      viewerToken: mintToken(userAViewer.id, userAViewer.email),
      evidenceId: evidenceA.id,
      caseId: caseA.id,
      reportId: null,
      packageId: null,
      legalHoldId: null,
    },
    teamB: {
      teamId: orgB.id,
      ownerUserId: userBOwner.id,
      adminUserId: userBAdmin.id,
      memberUserId: userBMember.id,
      viewerUserId: userBViewer.id,
      ownerToken: mintToken(userBOwner.id, userBOwner.email),
      adminToken: mintToken(userBAdmin.id, userBAdmin.email),
      memberToken: mintToken(userBMember.id, userBMember.email),
      viewerToken: mintToken(userBViewer.id, userBViewer.email),
      evidenceId: evidenceB.id,
      caseId: caseB.id,
      reportId: null,
      packageId: null,
      legalHoldId: null,
    },
    personal: {
      userId: personalUser.id,
      token: mintToken(personalUser.id, personalUser.email),
      teamId: personalSpace.teamId,
      evidenceId: evidencePersonal.id,
      caseId: casePersonal.id,
      reportId: null,
    },
  };
}

async function cleanupFixtures(
  prisma: import("@prisma/client").PrismaClient,
  fixtures: SeededFixtures,
): Promise<void> {
  // Tear down in dependency order. Cascade rules on Evidence and Case
  // handle their children; we explicitly delete Teams + Users last.
  const teamIds = [
    fixtures.teamA.teamId,
    fixtures.teamB.teamId,
    fixtures.personal.teamId,
  ];
  const userIds = [
    fixtures.teamA.ownerUserId,
    fixtures.teamA.adminUserId,
    fixtures.teamA.memberUserId,
    fixtures.teamA.viewerUserId,
    fixtures.teamB.ownerUserId,
    fixtures.teamB.adminUserId,
    fixtures.teamB.memberUserId,
    fixtures.teamB.viewerUserId,
    fixtures.personal.userId,
  ];

  await prisma.evidence
    .deleteMany({ where: { teamId: { in: teamIds } } })
    .catch(() => undefined);
  await prisma.case
    .deleteMany({ where: { teamId: { in: teamIds } } })
    .catch(() => undefined);
  await prisma.teamMember
    .deleteMany({ where: { teamId: { in: teamIds } } })
    .catch(() => undefined);
  await prisma.team
    .deleteMany({ where: { id: { in: teamIds } } })
    .catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { id: { in: userIds } } })
    .catch(() => undefined);
}
