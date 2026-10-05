/**
 * INTERNAL PLAN GRANT — operator CLI. A thin wrapper over the SAME service the
 * admin route calls (services/billing/internal-plan-grant.service.ts); it
 * carries no business logic of its own.
 *
 *   pnpm --filter proovra-api ops:internal-plan-grant status --email=<email> | --user-id=<uuid>
 *   pnpm --filter proovra-api ops:internal-plan-grant apply  --email=<email> | --user-id=<uuid>
 *        --actor-user-id=<platform-admin uuid> --reason="<text>" --idempotency-key=<key>
 *        [--expires-at=<ISO-8601>] --confirm
 *   pnpm --filter proovra-api ops:internal-plan-grant revoke --email=<email> | --user-id=<uuid>
 *        --actor-user-id=<platform-admin uuid> --reason="<text>" --confirm
 *   pnpm --filter proovra-api ops:internal-plan-grant expire --actor-user-id=<platform-admin uuid> --confirm
 *
 * The plan is always TEAM (the only grantable plan). Mutations require
 * --confirm and an --actor-user-id that is a Platform Admin RIGHT NOW (the
 * same live resolver requirePlatformAdmin uses). The HTTP route additionally
 * requires a step-up approval; a CLI has no interactive session to step up,
 * so its boundary is the database credential the operator must hold plus the
 * platform-admin actor check. Output never includes an email, token or secret.
 */
import { prisma } from "../db.js";
import {
  applyInternalPlanGrant,
  expireInternalPlanGrants,
  InternalPlanGrantError,
  listInternalPlanGrants,
  revokeInternalPlanGrant,
} from "../services/billing/internal-plan-grant.service.js";
import { resolvePlatformAdmin } from "../services/platform-admin.service.js";

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function requireAdminActor(): Promise<string> {
  const actor = arg("actor-user-id");
  if (!actor) throw new InternalPlanGrantError("INVALID_REQUEST", "--actor-user-id is required for a mutation.");
  const decision = await resolvePlatformAdmin(actor);
  if (!decision.allowed) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "--actor-user-id is not a Platform Admin.");
  }
  if (!flag("confirm")) {
    throw new InternalPlanGrantError("INVALID_REQUEST", "Refusing to write without --confirm.");
  }
  return actor;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const subject = { userId: arg("user-id"), email: arg("email") };
  switch (command) {
    case "status": {
      console.log(JSON.stringify(await listInternalPlanGrants(subject), null, 2));
      return;
    }
    case "apply": {
      const actorUserId = await requireAdminActor();
      const result = await applyInternalPlanGrant({
        ...subject,
        plan: "TEAM",
        reason: arg("reason") ?? "",
        idempotencyKey: arg("idempotency-key") ?? "",
        expiresAtUtc: arg("expires-at"),
        actorUserId,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "revoke": {
      const actorUserId = await requireAdminActor();
      console.log(JSON.stringify(await revokeInternalPlanGrant({ ...subject, reason: arg("reason") ?? "", actorUserId }), null, 2));
      return;
    }
    case "expire": {
      await requireAdminActor();
      console.log(JSON.stringify(await expireInternalPlanGrants(), null, 2));
      return;
    }
    default:
      throw new InternalPlanGrantError("INVALID_REQUEST", "Command must be one of: status, apply, revoke, expire.");
  }
}

main()
  .catch((err) => {
    if (err instanceof InternalPlanGrantError) {
      console.error(`internal-plan-grant refused: ${err.code} — ${err.message}`);
    } else {
      console.error("internal-plan-grant failed:", err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
