/**
 * PHASE 10 §2 — TRUE concurrent-last-slot race (real PostgreSQL).
 *
 * The advisory-lock serialisation in `establishOrganizationSessionContext`
 * cannot be exercised against a stub: two statements have to genuinely race on
 * separate connections. This is therefore a DATABASE test, and it lives in the
 * API integration project rather than being skipped inside the unit suite.
 *
 * PHASE 12 POINT 4 — extracted here from `phase-10-concurrent-session.test.ts`
 * (whose remaining tests are pure source contracts and stay in the unit run).
 * Two defects were fixed on the way:
 *   - it constructed `PrismaClient` with the Prisma-6 `datasourceUrl` option,
 *     removed in Prisma 7, and seeded a `Team.ownerId` column that does not
 *     exist — both concealed by `as never`, so the gate could never have run;
 *   - it read `process.env.TEST_DATABASE_URL` directly, which is `undefined`
 *     in testcontainers mode. It now acquires the database through the ONE
 *     canonical helper, so it works against the CI Postgres service and a
 *     local ephemeral container alike.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { establishOrganizationSessionContext } from "../src/services/identity/concurrent-session.service.js";
import {
  acquireIntegrationDatabase,
  type IntegrationDatabase,
} from "./integration-harness.js";

describe("Phase 10 §2 — last-slot race (real Postgres)", () => {
  let database: IntegrationDatabase | undefined;
  let prisma: PrismaClient | undefined;
  let pool: { end: () => Promise<void> } | undefined;

  beforeAll(async () => {
    database = await acquireIntegrationDatabase();
    // Constructed exactly like the production client (`src/db.ts`): a pg Pool
    // behind the PrismaPg driver adapter. The pool is what makes this a REAL
    // concurrency probe — two statements genuinely race on separate connections.
    const { PrismaClient: Client } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { Pool } = await import("pg");
    const created = new Pool({ connectionString: database.url });
    pool = created;
    prisma = new Client({ adapter: new PrismaPg(created) });
  });

  afterAll(async () => {
    // Every resource is released even when a hook or assertion threw.
    await prisma?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await database?.release();
  });

  it("two concurrent establishments for one remaining slot → exactly one succeeds", async () => {
    const db = prisma!;
    // Minimal fixtures: a CUSTOMER org with concurrentSessionLimit=2, one
    // active session already holding org context (1 slot remains), and TWO
    // fresh inventory sessions competing for it.
    const org = await db.organization.create({
      data: { name: "conc-test", kind: "CUSTOMER", status: "ACTIVE" },
    });
    const user = await db.user.create({
      data: {
        provider: "EMAIL",
        providerUserId: `conc-${org.id}`,
        email: `conc-${org.id}@x.test`,
      },
    });
    const team = await db.team.create({
      data: {
        name: "ws",
        isPersonal: false,
        organizationId: org.id,
        ownerUserId: user.id,
      },
    });
    await db.organizationSecurityPolicy.create({
      data: { teamId: team.id, organizationId: org.id, concurrentSessionLimit: 2 },
    });
    const mkSession = async (hash: string, ctx: string | null) =>
      db.authenticatedSession.create({
        data: {
          userId: user.id,
          teamId: team.id,
          sessionIdHash: hash,
          organizationContextId: ctx,
          issuedAtUtc: new Date(),
          expiresAtUtc: new Date(Date.now() + 3600_000),
        },
      });
    await mkSession("live-existing", org.id); // 1 active in-context → 1 slot left
    await mkSession("live-a", null);
    await mkSession("live-b", null);

    const [a, b] = await Promise.all([
      establishOrganizationSessionContext(
        { userId: user.id, organizationId: org.id, sessionIdHash: "live-a" },
        db,
      ),
      establishOrganizationSessionContext(
        { userId: user.id, organizationId: org.id, sessionIdHash: "live-b" },
        db,
      ),
    ]);
    const successes = [a, b].filter((r) => r.allowed).length;
    const denials = [a, b].filter((r) => !r.allowed).length;
    expect(successes).toBe(1); // exactly one won the last slot
    expect(denials).toBe(1);
    const finalCount = await db.authenticatedSession.count({
      where: {
        userId: user.id,
        organizationContextId: org.id,
        revokedAtUtc: null,
        expiresAtUtc: { gt: new Date() },
      },
    });
    expect(finalCount).toBe(2); // never exceeds the limit
  });
});
