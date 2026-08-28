/**
 * Put the browser-verification fixture account into ONE commercial state.
 *
 *   node scripts/billing-ui-state.mjs FREE|PRO|TEAM|ORG
 *
 * The Billing page renders whatever state the signed-in account is in, so
 * moving one account through the four states exercises the same four surfaces
 * as four accounts would — and avoids re-authenticating between them, which a
 * browser profile with a pinned session cookie will not allow.
 *
 * Disposable local database only; it refuses to run against anything else.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) || !/proovra_ui/.test(url)) {
  console.error("REFUSING: DATABASE_URL must be the disposable local `proovra_ui` database.");
  process.exit(1);
}

const state = (process.argv[2] ?? "").toUpperCase();
if (!["FREE", "PRO", "TEAM", "ORG"].includes(state)) {
  console.error("usage: billing-ui-state.mjs FREE|PRO|TEAM|ORG");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: url })),
});
const EMAIL = "free@fixtures.test";
const ORG_ID = "00000000-0000-4000-8000-0000000000f1";

async function main() {
  const user = await prisma.user.findFirstOrThrow({
    where: { email: EMAIL },
    select: { id: true },
  });

  // Always start from a clean commercial slate so a previous state cannot
  // leak into the next one and be read as the page getting something wrong.
  await prisma.subscription.deleteMany({ where: { userId: user.id } });
  await prisma.organizationMembership.deleteMany({
    where: { organizationId: ORG_ID, userId: user.id },
  });

  const plan = state === "ORG" ? "FREE" : state;
  await prisma.entitlement.updateMany({
    where: { userId: user.id, active: true },
    data: { plan },
  });

  if (state === "PRO" || state === "TEAM") {
    await prisma.subscription.create({
      data: {
        userId: user.id,
        provider: "STRIPE",
        providerSubId: `fixture_ui_${state.toLowerCase()}`,
        status: "ACTIVE",
        plan: state,
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        teamId: null,
      },
    });
  }

  if (state === "ORG") {
    await prisma.organizationMembership.create({
      data: {
        organizationId: ORG_ID,
        userId: user.id,
        role: "ORG_OWNER",
        status: "ACTIVE",
      },
    });
  }

  console.log(`fixture account is now in the ${state} state`);
}

main()
  .catch((e) => {
    console.error("failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
