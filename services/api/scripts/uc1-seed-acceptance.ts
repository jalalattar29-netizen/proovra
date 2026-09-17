/**
 * UC-1 ACCEPTANCE SEED (disposable DB only).
 *
 * Seeds exactly what the Chrome/Edge browser acceptance needs and NOTHING else:
 * one EMAIL user with the current required legal acceptances, one CUSTOMER
 * Organization + ORGANIZATION-kind Team on a paid plan (the general
 * evidence-creation eligibility the commercial gate requires — there is no
 * capture-specific plan), an OWNER membership, and a real session bearer minted
 * with the production `signJwt` (provenance PASSWORD, exactly like a logged-in
 * user). Prints `{ sessionBearer, teamId, userId, email }` as a single JSON line
 * on stdout so the orchestrator can capture it.
 *
 * SAFETY: refuses to run unless DATABASE_URL is a LOCAL host whose database name
 * marks it disposable (test/fixture/local/dev). It never touches Production and
 * writes only the rows above.
 */
import { signJwt } from "../src/services/jwt.js";
import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";

function assertDisposableDatabaseUrl(raw: string | undefined): URL {
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(host)) {
    throw new Error(`REFUSED: DATABASE_URL host '${host}' is not local. Acceptance seeds disposable DBs only.`);
  }
  const dbName = url.pathname.replace(/^\//, "").toLowerCase();
  if (!/(test|fixture|local|dev)/.test(dbName)) {
    throw new Error(
      `REFUSED: database name '${dbName}' does not read as disposable (needs test/fixture/local/dev).`,
    );
  }
  return url;
}

async function main(): Promise<void> {
  assertDisposableDatabaseUrl(process.env.DATABASE_URL);
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error("AUTH_JWT_SECRET is required to mint the acceptance session bearer");

  // Imported after the safety check so nothing connects to a non-disposable DB.
  const { prisma } = await import("../src/db.js");

  const stamp = Date.now();
  const email = `uc1-acceptance-${stamp}@test.proovra.local`;

  const seeded = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        firstName: "UC1",
        lastName: "Acceptance",
        provider: "EMAIL",
        providerUserId: email,
      },
      select: { id: true, email: true },
    });

    await tx.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "uc1-acceptance-seed",
      })),
    });

    const org = await tx.organization.create({
      data: {
        name: `UC1-Acceptance-${stamp}`,
        billingOwnerUserId: user.id,
        status: "ACTIVE",
        kind: "CUSTOMER",
      },
      select: { id: true },
    });
    await tx.organizationMembership.create({
      data: { organizationId: org.id, userId: user.id, role: "ORG_OWNER" },
    });

    const team = await tx.team.create({
      data: {
        name: `UC1-Acceptance-${stamp}`,
        ownerUserId: user.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        // The GENERAL evidence-creation eligibility the commercial gate requires
        // for ANY capture channel (not a Direct-Web-Capture-specific plan).
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      } as never,
      select: { id: true },
    });
    await tx.teamMember.create({
      data: { teamId: team.id, userId: user.id, role: "OWNER", status: "ACTIVE" },
    });

    return { userId: user.id, teamId: team.id, email: user.email ?? email };
  });

  const sessionBearer = signJwt(
    {
      sub: seeded.userId,
      provider: "EMAIL",
      email: seeded.email,
      authMethod: "PASSWORD",
      authAt: Math.floor(Date.now() / 1000),
    },
    secret,
    60 * 60 * 2, // 2 hours — long enough for a full Chrome+Edge run
  );

  process.stdout.write(
    JSON.stringify({ sessionBearer, teamId: seeded.teamId, userId: seeded.userId, email: seeded.email }) +
      "\n",
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  process.stderr.write(`uc1-seed-acceptance FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
