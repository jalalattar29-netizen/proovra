/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — fixtures for the browser
 * verification of the Billing page.
 *
 * FOUR ACCOUNT STATES, one per thing the page has to get right:
 *
 *   free@…    a Personal Workspace on FREE
 *   pro@…     the same, on PRO, with a live Stripe subscription
 *   team@…    the same, on TEAM — the tier, NOT a second workspace
 *   org@…     an ENTERPRISE Organization whose contract is SILENT on seats
 *
 * It writes ONLY to a disposable local database, and refuses to run against
 * anything that is not one. Every account is created through the real
 * registration service, so the password hash, the personal-space bootstrap and
 * the entitlement all come from production code rather than from this file.
 *
 * The commercial state on top of that is written directly, because the paths
 * that would otherwise produce it are provider-driven: a live subscription
 * comes from a Stripe webhook, and an Enterprise contract comes from
 * provisioning. Neither is available offline, and faking the provider call
 * would prove less than writing the row the provider would have produced.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) || !/proovra_ui/.test(url)) {
  console.error(
    "REFUSING: DATABASE_URL must be the disposable local `proovra_ui` database.",
  );
  process.exit(1);
}

// The repository constructs its client through the pg driver adapter
// (services/api/src/db.ts). Constructing a bare one here would be a second
// client with different connection semantics, and Prisma 7 refuses it outright.
const pool = new pg.Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const PASSWORD = "Fixture-Passw0rd!2026";

const ACCOUNTS = [
  { key: "free", email: "free@fixtures.test", name: "Freya Fixture", plan: "FREE" },
  { key: "pro", email: "pro@fixtures.test", name: "Pryia Fixture", plan: "PRO" },
  { key: "team", email: "team@fixtures.test", name: "Tomas Fixture", plan: "TEAM" },
  { key: "org", email: "org@fixtures.test", name: "Olga Fixture", plan: "FREE" },
];

async function main() {
  const { registerWithEmailPassword } = await import(
    "../dist/services/email-password-auth.service.js"
  );

  const made = {};

  for (const a of ACCOUNTS) {
    const existing = await prisma.user.findFirst({
      where: { email: a.email },
      select: { id: true },
    });

    let userId = existing?.id ?? null;
    if (!userId) {
      const res = await registerWithEmailPassword({
        email: a.email,
        password: PASSWORD,
        displayName: a.name,
      });
      userId = res?.userId ?? res?.user?.id ?? null;
      if (!userId) {
        const row = await prisma.user.findFirstOrThrow({
          where: { email: a.email },
          select: { id: true },
        });
        userId = row.id;
      }
    }

    // Email verification is a separate journey and not what is under test.
    await prisma.user.updateMany({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    }).catch(() => {});

    // The plan in force, through the entitlement the resolver reads.
    await prisma.entitlement.updateMany({
      where: { userId, active: true },
      data: { plan: a.plan },
    });

    made[a.key] = { userId, email: a.email };
  }

  // ---- PRO and TEAM each get a LIVE subscription ---------------------------
  // Without one the page shows the plan but offers a CHECKOUT rather than a
  // change, because "is there something to change" is a fact about the
  // subscription, not about the plan.
  for (const key of ["pro", "team"]) {
    const { userId } = made[key];
    const plan = key === "pro" ? "PRO" : "TEAM";
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `fixture_${key}_sub`,
        status: "ACTIVE",
        plan,
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        teamId: null,
      },
    });
  }

  // ---- The Enterprise Organization ----------------------------------------
  // Deliberately SILENT on seats: `seatCount: null` is the state that used to
  // render "N of 0", which reads as a breach and is not one.
  const org = await prisma.organization.upsert({
    where: { id: "00000000-0000-4000-8000-0000000000f1" },
    update: {},
    create: {
      id: "00000000-0000-4000-8000-0000000000f1",
      name: "Bundesanstalt für Beweismittelsicherung",
      kind: "CUSTOMER",
      status: "ACTIVE",
      billingOwnerUserId: made.org.userId,
    },
    select: { id: true },
  });

  await prisma.enterpriseContract.upsert({
    where: { organizationId: org.id },
    update: { status: "ACTIVE", seatCount: null, storageGb: 2000 },
    create: {
      organizationId: org.id,
      status: "ACTIVE",
      seatCount: null,
      storageGb: 2000,
      effectiveAtUtc: new Date("2026-01-01T00:00:00.000Z"),
    },
  }).catch(async (e) => {
    console.warn("enterpriseContract upsert skipped:", String(e).slice(0, 120));
  });

  // The viewer must hold ORG_BILLING_ADMIN or higher to see the account.
  await prisma.organizationMembership.deleteMany({
    where: { organizationId: org.id, userId: made.org.userId },
  });
  await prisma.organizationMembership.create({
    data: {
      organizationId: org.id,
      userId: made.org.userId,
      role: "ORG_OWNER",
      status: "ACTIVE",
    },
  }).catch(async (e) => {
    console.warn("org membership create:", String(e).slice(0, 160));
  });

  console.log(JSON.stringify({ password: PASSWORD, accounts: made, organizationId: org.id }, null, 1));
}

main()
  .catch((e) => {
    console.error("fixtures failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
