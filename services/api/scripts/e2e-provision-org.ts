/**
 * Provision an Enterprise Organization for an e2e account, through the
 * product's own provisioning authority.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `POST /v1/orgs` is RETIRED (Phase 2, 2026-07-21). It answers
 *
 *   403 org_self_service_creation_retired
 *   "Organizations are provisioned with a PROOVRA Enterprise agreement.
 *    To work with a team, create a workspace instead."
 *
 * and `POST /v1/teams` is not self-service either — measured against this
 * stack it answers `409 WORKSPACE_CREATION_NOT_SELF_SERVICE`. So there is no
 * route by which a browser suite can reach the state its org-surface specs
 * need, and those specs were reaching it through a door the product closed.
 *
 * The org-admin CONTRACTS behind that door are all still live — invites,
 * role precedence, last-owner protection, audit pagination — and they are
 * what the specs actually assert. So the fixture provisions the org the way
 * the product does, and every behavioural assertion is preserved.
 *
 * `provisionEnterpriseCustomer` is the canonical sales-led authority named by
 * the retirement note itself, and it is called here rather than reproduced:
 * a fixture that hand-wrote Organization and OrganizationMembership rows
 * would be a second provisioning implementation, and would pass while the
 * real one drifted.
 *
 * NOT A PRODUCT ROUTE, DELIBERATELY. The HTTP surface for this is
 * `POST /v1/admin/enterprise/provision` behind `requirePlatformAdmin`, and it
 * keeps that guard. This script is the disposable job's own access to its own
 * database, in the same spirit as `e2e-account.mjs`.
 *
 * REFUSES A NON-LOOPBACK DATABASE, for the same reason that one does.
 */
import { prisma } from "../src/db.js";
import { provisionEnterpriseCustomer } from "../src/services/enterprise-provisioning.service.js";

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const ownerEmail = arg("owner-email");
const organizationName = arg("name") ?? "E2E Enterprise Org";

if (!ownerEmail) {
  console.error("e2e-provision-org: --owner-email=<address> is required");
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("e2e-provision-org: DATABASE_URL is not set");
  process.exit(2);
}
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(host)) {
  console.error(
    `e2e-provision-org: REFUSED — DATABASE_URL host "${host}" is not a local ` +
      "address. This script provisions an Organization and will only do so " +
      "against a disposable local database.",
  );
  process.exit(3);
}

async function main(): Promise<void> {
  const owner = await prisma.user.findFirst({
    where: { email: ownerEmail!.trim().toLowerCase() },
    select: { id: true },
  });
  if (!owner) {
    console.error(`e2e-provision-org: no user with email ${ownerEmail}`);
    process.exit(4);
  }

  const result = await provisionEnterpriseCustomer({
    organizationName,
    ownerEmail: ownerEmail!,
    // The owner provisions their own org here. In production the actor is the
    // platform admin working the sales-led request; a fixture has no such
    // person, and attributing the action to the owner is the honest reading
    // of who it was done for.
    actorUserId: owner.id,
  });

  if (!result.provisioned) {
    console.error(
      "e2e-provision-org: owner user was not found by the provisioner, so it " +
        "created an invite instead of a workspace — the account must exist " +
        "and be verified before provisioning.",
    );
    process.exit(5);
  }

  // One line of JSON on stdout: the helper reads exactly this.
  console.log(
    JSON.stringify({
      organizationId: result.organizationId,
      workspaceId: result.workspaceId,
      ownerUserId: result.ownerUserId,
    }),
  );
}

await main()
  .catch((err) => {
    console.error(
      "e2e-provision-org: " + (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
