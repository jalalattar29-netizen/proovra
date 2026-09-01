import "../src/env.js";

/**
 * A LOCAL, PRODUCTION-SHAPED FIXTURE FOR VERIFYING THE ADMIN CONSOLE.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * The admin console could not be verified in a browser, and the stated reason
 * was that the local `.env.local` points at Production. That is a reason to
 * build a local target, not a reason to skip verification: a console whose
 * empty states, degraded states and role gates have never been LOOKED AT is a
 * console whose empty states, degraded states and role gates are unknown.
 *
 * So this seeds a local database with the populations the admin surfaces are
 * supposed to distinguish — and, just as importantly, with the populations they
 * are supposed to render as EMPTY.
 *
 * =============================================================================
 * IT IS AN EXTENSION, NOT A SECOND SEEDER
 * =============================================================================
 * `seed-home-personas.ts` already builds four PRO/TEAM personas across personal
 * and organization workspaces, and it is the seeder the Home acceptance run
 * uses. This adds what the ADMIN console needs on top and takes the same
 * approach for everything it does share: real rows through real models, no
 * bespoke shapes, no mocks.
 *
 * Run the persona seeder first if you want both. This one is independent and
 * uses its own id range, so the two do not collide.
 *
 * =============================================================================
 * WHAT IT REFUSES
 * =============================================================================
 * It will not run against a database whose name does not look local, and it
 * will not run with NODE_ENV=production. Both are checked before a single row
 * is written. A fixture seeder is the most dangerous kind of script to point at
 * the wrong database, because everything it does is a write.
 *
 * =============================================================================
 * WHAT IT SEEDS, AND WHY EACH PIECE
 * =============================================================================
 *   ROLES        platform admin, org owner, workspace admin, read-only member,
 *                and a user whose only workspace is personal. The console's
 *                authority behaviour cannot be checked with one account.
 *   PLANS        FREE, PRO, TEAM, ENTERPRISE — the billing and adoption
 *                surfaces group by plan, and a fixture with one plan makes
 *                every grouping look correct.
 *   COHORTS      evidence that overlaps: TSA-only, report-only, and BOTH. The
 *                overlap is the whole point of the cohort projection, and a
 *                fixture without an intersection cannot tell a correct union
 *                from a sum.
 *   INCIDENTS    open, acknowledged and resolved, across severities. NOT a
 *                duplicate fingerprint pair — the unique index refuses one,
 *                which is the schema working; see seedIncidents.
 *   EMPTY        one workspace deliberately left with nothing, because "healthy
 *                zero" and "no data yet" must not look the same, and the only
 *                way to see that is to have both on screen.
 *
 * Usage:
 *   DATABASE_URL=postgresql://…/proovra_admin_fixture \
 *     pnpm --filter proovra-api exec tsx scripts/seed-admin-fixture.ts
 */

import { prisma } from "../src/db.js";
import "../src/register-shared-runtime.js";

import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";
// The REAL hasher the login route verifies against. A fixture that wrote its
// own hash format would seed accounts nobody can sign in to, which is the one
// thing this fixture must not do.
import { hashPassword } from "../src/services/email-password-auth.service.js";

/**
 * One password for every fixture account.
 *
 * Local-only by construction: the seeder refuses any database that does not
 * look local, and this string is in the repository, so it is worthless
 * anywhere else. Sharing one password across the six accounts is deliberate —
 * browser verification means signing in as each role in turn, and six
 * different passwords is six chances to waste a minute.
 */
const FIXTURE_PASSWORD = "fixture-local-only-password";

// -----------------------------------------------------------------------------
// Refusals, before any write.
// -----------------------------------------------------------------------------

function refuse(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`seed-admin-fixture: REFUSED — ${message}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV is production.");
}

const DSN = process.env.DATABASE_URL ?? "";
if (DSN === "") refuse("DATABASE_URL is not set.");

/**
 * The database name must look local.
 *
 * Not a warning, a refusal. Everything below is a write, and the cost of being
 * wrong is a seeded fixture on top of real customer data.
 */
const DB_NAME = (() => {
  try {
    return new URL(DSN).pathname.replace(/^\//, "");
  } catch {
    refuse("DATABASE_URL is not a parseable URL.");
  }
})();

if (!/(test|fixture|local|dev)/i.test(DB_NAME)) {
  refuse(
    `database "${DB_NAME}" does not look local. Name it with test/fixture/local/dev, ` +
      `or point DATABASE_URL somewhere you are willing to have overwritten.`,
  );
}
if (/(prod|production|neondb)/i.test(DB_NAME)) {
  refuse(`database "${DB_NAME}" looks like production.`);
}

// -----------------------------------------------------------------------------
// Identities. A fixed id range so re-running is idempotent and so nothing here
// can collide with the home personas (0e00…) or with real data.
// -----------------------------------------------------------------------------

const ID = (n: string) => `0adf0000-0000-4000-8000-${n.padStart(12, "0")}`;

type Actor = {
  key: string;
  userId: string;
  email: string;
  displayName: string;
  /** `admin` makes `resolvePlatformAdmin` return true. Nothing else does. */
  platformRole: "admin" | null;
  plan: "FREE" | "PRO" | "TEAM" | "ENTERPRISE";
};

const ACTORS: readonly Actor[] = [
  {
    key: "platform-admin",
    userId: ID("1"),
    email: "platform-admin@fixture.local",
    displayName: "Platform Admin",
    platformRole: "admin",
    plan: "ENTERPRISE",
  },
  {
    key: "org-owner",
    userId: ID("2"),
    email: "org-owner@fixture.local",
    displayName: "Organization Owner",
    platformRole: null,
    plan: "TEAM",
  },
  {
    key: "workspace-admin",
    userId: ID("3"),
    email: "workspace-admin@fixture.local",
    displayName: "Workspace Admin",
    platformRole: null,
    plan: "TEAM",
  },
  {
    key: "read-only",
    userId: ID("4"),
    email: "read-only@fixture.local",
    displayName: "Read Only",
    platformRole: null,
    plan: "TEAM",
  },
  {
    key: "free-personal",
    userId: ID("5"),
    email: "free-personal@fixture.local",
    displayName: "Free Personal",
    platformRole: null,
    plan: "FREE",
  },
  {
    key: "pro-personal",
    userId: ID("6"),
    email: "pro-personal@fixture.local",
    displayName: "Pro Personal",
    platformRole: null,
    plan: "PRO",
  },
];

/** Three workspaces: populated org, EMPTY org, and a personal space. */
const ORG_POPULATED = ID("a1");
const ORG_EMPTY = ID("a2");
const WS_POPULATED = ID("b1");
const WS_EMPTY = ID("b2");
const WS_PERSONAL = ID("b3");

// -----------------------------------------------------------------------------

async function wipeFixture(): Promise<void> {
  // Only this fixture's own rows. A blanket wipe would make the script unusable
  // against a database that also holds the home personas.
  const teamIds = [WS_POPULATED, WS_EMPTY, WS_PERSONAL];
  const userIds = ACTORS.map((a) => a.userId);

  await prisma.operationalIncident.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.evidence.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
  await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
  await prisma.organization.deleteMany({
    where: { id: { in: [ORG_POPULATED, ORG_EMPTY] } },
  });
  await prisma.userLegalAcceptance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.entitlement.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seedActors(): Promise<void> {
  for (const a of ACTORS) {
    await prisma.user.create({
      data: {
        id: a.userId,
        provider: "EMAIL",
        // `loginWithEmailPassword` looks the user up by
        // (provider=EMAIL, providerUserId=<normalized email>) — NOT by the
        // email column. Seeding a slug here produced six accounts that
        // existed and could not sign in.
        providerUserId: a.email.trim().toLowerCase(),
        email: a.email,
        displayName: a.displayName,
        // `resolvePlatformAdmin` reads THIS column. The JWT role claim is
        // advisory and is deliberately not trusted on its own, so a fixture
        // that only set the claim would prove nothing about the gate.
        platformRole: a.platformRole,
        // Hashed with the same function the login route verifies with.
        passwordHash: hashPassword(FIXTURE_PASSWORD),
        emailVerifiedAt: new Date(),
        currentWorkspaceId:
          a.key === "free-personal" || a.key === "pro-personal"
            ? WS_PERSONAL
            : WS_POPULATED,
      },
    });

    await prisma.entitlement.create({
      data: { userId: a.userId, plan: a.plan, active: true },
    });

    // Without acceptance the authenticated surfaces answer 428 and every page
    // renders its degraded state, which would make the whole fixture look
    // broken for a reason that has nothing to do with the admin console.
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: a.userId,
        policyKey,
        policyVersion,
        source: "admin-fixture-seed",
      })),
      skipDuplicates: true,
    });
  }
}

async function seedWorkspaces(): Promise<void> {
  await prisma.organization.createMany({
    data: [
      { id: ORG_POPULATED, name: "Northwind Legal" },
      { id: ORG_EMPTY, name: "Quiet Chambers" },
    ],
  });

  await prisma.team.createMany({
    data: [
      {
        id: WS_POPULATED,
        name: "Northwind Legal",
        ownerUserId: ID("2"),
        organizationId: ORG_POPULATED,
        isPersonal: false,
        workspaceKind: "ORGANIZATION",
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
        evidenceWorkspaceLabel: "Northwind Legal",
      },
      {
        // Deliberately empty. "Healthy zero" and "no data yet" must not look
        // the same, and the only way to see whether they do is to have both
        // on screen at once.
        id: WS_EMPTY,
        name: "Quiet Chambers",
        ownerUserId: ID("2"),
        organizationId: ORG_EMPTY,
        isPersonal: false,
        workspaceKind: "ORGANIZATION",
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
        evidenceWorkspaceLabel: "Quiet Chambers",
      },
      {
        id: WS_PERSONAL,
        name: "Personal Space",
        ownerUserId: ID("5"),
        organizationId: ORG_POPULATED,
        isPersonal: true,
        workspaceKind: "PERSONAL",
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
        evidenceWorkspaceLabel: "Personal Space",
      },
    ],
  });

  await prisma.teamMember.createMany({
    data: [
      { teamId: WS_POPULATED, userId: ID("2"), role: "OWNER", status: "ACTIVE" },
      { teamId: WS_POPULATED, userId: ID("3"), role: "ADMIN", status: "ACTIVE" },
      // The read-only member is the account that proves a gate refuses rather
      // than that it admits.
      { teamId: WS_POPULATED, userId: ID("4"), role: "VIEWER", status: "ACTIVE" },
      { teamId: WS_POPULATED, userId: ID("1"), role: "ADMIN", status: "ACTIVE" },
      { teamId: WS_EMPTY, userId: ID("2"), role: "OWNER", status: "ACTIVE" },
      { teamId: WS_PERSONAL, userId: ID("5"), role: "OWNER", status: "ACTIVE" },
    ],
  });
}

/**
 * Evidence in overlapping cohorts.
 *
 * 3 timestamp-only, 4 report-only, 2 both. The intersection is the point: a
 * fixture with none cannot tell a measured union (9) from the sum of the two
 * raw totals (11), which is the arithmetic the cohort projection exists to
 * replace.
 */
async function seedEvidenceCohorts(): Promise<void> {
  const rows: Array<{ kind: "tsa" | "report" | "both"; n: number }> = [
    { kind: "tsa", n: 3 },
    { kind: "report", n: 4 },
    { kind: "both", n: 2 },
  ];
  let i = 0;
  for (const { kind, n } of rows) {
    for (let k = 0; k < n; k += 1) {
      i += 1;
      await prisma.evidence.create({
        data: {
          id: ID(`c${i.toString(16)}`),
          teamId: WS_POPULATED,
          organizationId: ORG_POPULATED,
          type: "PHOTO",
          ownerUserId: ID("2"),
          uploadedByUserId: ID("2"),
          status: "SIGNED",
          title: `Fixture evidence ${i} (${kind})`,
          tsaStatus: kind === "report" ? "SUCCESS" : "FAILED",
          latestReportVersion: kind === "tsa" ? 1 : null,
        },
      });
    }
  }

  // Healthy records too, so a cohort count is a fraction of something rather
  // than the whole population — a console where every record is broken cannot
  // show what "mostly fine" looks like.
  for (let k = 0; k < 12; k += 1) {
    await prisma.evidence.create({
      data: {
        id: ID(`d${k.toString(16)}`),
        teamId: WS_POPULATED,
        organizationId: ORG_POPULATED,
        type: "DOCUMENT",
        ownerUserId: ID("2"),
        uploadedByUserId: ID("2"),
        status: "SIGNED",
        title: `Fixture evidence healthy ${k}`,
        tsaStatus: "SUCCESS",
        latestReportVersion: 1,
      },
    });
  }
}

/**
 * Incidents across status and severity, plus a duplicate-fingerprint pair.
 *
 * The duplicate pair is what the identity and convergence surfaces are for; a
 * fixture without one renders those surfaces empty and proves nothing about
 * them.
 */
async function seedIncidents(): Promise<void> {
  const now = Date.now();
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000);

  const base = {
    teamId: WS_POPULATED,
    category: "REPORT" as const,
    occurrenceCount: 1,
  };

  const rows = [
    {
      ...base,
      sourceId: "pipeline.report_backlog",
      fingerprint: "dashboard:pipeline:report_backlog:fixture",
      severity: "HIGH" as const,
      status: "OPEN" as const,
      title: "Report generation backlog",
      safeSummary: "Signed evidence records have no generated report.",
      runbookSlug: "report-pipeline",
      firstSeenAtUtc: at(6),
      lastSeenAtUtc: at(0),
    },
    {
      ...base,
      category: "EVIDENCE_INTEGRITY" as const,
      sourceId: "integrity.tsa_failure",
      fingerprint: "tsa_failure:fixture",
      severity: "WARNING" as const,
      status: "ACKNOWLEDGED" as const,
      title: "Timestamp could not be obtained",
      safeSummary: "The RFC3161 timestamp failed for one or more records.",
      runbookSlug: "evidence-integrity-recovery",
      firstSeenAtUtc: at(40),
      lastSeenAtUtc: at(38),
      occurrenceCount: 4,
    },
    {
      ...base,
      category: "WORKER" as const,
      sourceId: "runtime.worker_heartbeat",
      fingerprint: "runtime:worker_heartbeat:fixture",
      severity: "CRITICAL" as const,
      status: "OPEN" as const,
      title: "Worker heartbeat stale",
      safeSummary: "A worker has not reported within its expected window.",
      // Deliberately a LABEL-only slug. The console must render it as text,
      // not as a link, and this is the row that proves it.
      runbookSlug: "worker-heartbeat",
      firstSeenAtUtc: at(1),
      lastSeenAtUtc: at(0),
      occurrenceCount: 12,
    },
    {
      ...base,
      category: "RECONCILIATION" as const,
      sourceId: "search.index_reconciliation",
      fingerprint: "search_index:fixture",
      severity: "WARNING" as const,
      status: "RESOLVED" as const,
      title: "Search index reconciliation failing",
      safeSummary: "The search index is out of step with its records.",
      runbookSlug: "search-index",
      firstSeenAtUtc: at(20),
      lastSeenAtUtc: at(15),
      resolvedAtUtc: at(14),
    },
  ];

  for (const r of rows) {
    await prisma.operationalIncident.create({ data: r });
  }

  // NO DUPLICATE PAIR, and the absence is the finding.
  //
  // The first draft of this fixture seeded two rows with one fingerprint so
  // the identity and convergence surfaces would have something to show. The
  // database refused it with a unique-constraint violation, which is the
  // schema working: workspace-scoped duplicates have always been impossible,
  // and migration 20280104000000 closed the platform-scoped hole where NULL
  // team_id made NULL distinct from NULL.
  //
  // So a local fixture CANNOT reproduce the duplicate population. Those
  // surfaces will legitimately read zero here, and that is the correct local
  // result rather than a gap in the fixture. The duplicates that exist are
  // historical rows in Production, created before the index — which is why the
  // convergence tooling exists and why its dry-run is run there, not here.
  await prisma.operationalIncident.create({
    data: {
      ...base,
      sourceId: "pipeline.package_backlog",
      fingerprint: "dashboard:pipeline:package_backlog:fixture",
      severity: "HIGH",
      status: "OPEN",
      title: "Verification package backlog",
      safeSummary: "REPORTED evidence is still missing a verification package.",
      runbookSlug: "package-pipeline",
      firstSeenAtUtc: at(9),
      lastSeenAtUtc: at(2),
    },
  });
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`seed-admin-fixture: seeding "${DB_NAME}"`);

  await wipeFixture();
  await seedActors();
  await seedWorkspaces();
  await seedEvidenceCohorts();
  await seedIncidents();

  const counts = {
    users: await prisma.user.count({ where: { id: { in: ACTORS.map((a) => a.userId) } } }),
    workspaces: await prisma.team.count({
      where: { id: { in: [WS_POPULATED, WS_EMPTY, WS_PERSONAL] } },
    }),
    evidence: await prisma.evidence.count({ where: { teamId: WS_POPULATED } }),
    incidents: await prisma.operationalIncident.count({ where: { teamId: WS_POPULATED } }),
  };

  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "  seeded:",
      `    users        ${counts.users}   (1 platform admin, 1 org owner, 1 ws admin, 1 read-only, 2 personal)`,
      `    workspaces   ${counts.workspaces}   (1 populated, 1 deliberately EMPTY, 1 personal)`,
      `    evidence     ${counts.evidence}  (3 timestamp-only + 4 report-only + 2 both + 12 healthy)`,
      `    incidents    ${counts.incidents}   (open / acknowledged / resolved; NO duplicate pair — the unique index refuses one)`,
      "",
      `  sign in as (password: ${FIXTURE_PASSWORD}):`,
      ...ACTORS.map((a) => `    ${a.email.padEnd(36)} ${a.plan}${a.platformRole === "admin" ? "  PLATFORM ADMIN" : ""}`),
      "",
    ].join("\n"),
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("seed-admin-fixture: FAILED", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
